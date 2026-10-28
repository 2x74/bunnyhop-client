// Online glue on top of api.ts: run submission + verification polling (reported to the HUD's end-of-run
// card) and the Discord login return toast. Identity chip and leaderboard UI live in ui/account.ts and
// ui/leaderboard.ts (pause menu). Everything no-ops when the API is unavailable (VITE_API_URL unset).

import { appHref } from "./platform/navigation";
import { api, type Submission } from "./api";
import { myProfile, refreshMyProfile } from "./ui/account";
import { forgetBoards } from "./shared-reads";
import { announce, rankGroupImproved } from "./audio";
import { celebrate } from "./ui/unlocks";
import { RANK_GROUPS } from "./ranking";
import { currentRace, currentRoom } from "./net/presence";
import { currentGauntlet, heldByGauntlet } from "./gauntlet/state";
import type { SubmissionView } from "./hud";
import { noteSubmittedRun } from "./feedback/state";
import { largePBReplays, syncPBs, rejectPBForRun } from "./pb";
import { decodeReplay, replayStyle, sha256Hex, type Replay } from "./replay";
import { formatTime } from "./timer";
import { trackName } from "./zones";
import { toast } from "./notify";
import { failureOf, failureText, KEEP_MS, LEGACY_UPLOAD_LIMIT, legacyCandidate, legacyScanKey, shouldRetry, TRACKING_SINCE_KEY, type StoredUpload } from "./uploads";
import { uploadStore } from "./upload-store";

/**
 * Delay before each status poll. Most runs are verified 2-5 s after upload, so the first seconds poll often; long runs
 * (which report progress) and slow periods settle at 1 s, then back off.
 */
const POLL_MS = [300, 300, 400, 400, 500, 500, 500, 750, 750, 1000];
const pollDelay = (i: number, elapsedMs: number) => (i < POLL_MS.length ? POLL_MS[i] : elapsedMs < 30_000 ? 1000 : elapsedMs < 90_000 ? 2000 : 5000);
/** Stop polling (and say so) after this long. */
const POLL_GIVE_UP_MS = 5 * 60_000;

/** What submitAndTrack keeps about a run if its upload fails (uploads.ts): for messages when it's retried. */
export interface RunInfo {
  map: string;
  style: string;
  track: number;
  time: number;
  /** Run-session tokens (run-clock.ts), sent with the replay and stored with it, so a retried upload still has them. */
  beats?: string[];
  gauntlet?: string | null;
  mouse?: import("./mouse-settings").MouseSettings | null;
}

/**
 * Submits a finished run and reports progress until the server verifies or rejects it.
 * `onStatus` drives the end-of-run card; `notify` (toasts) is only used for slow verifications and retries.
 * With `run`, the replay (and its run-session tokens, `run.beats`) is stored on this device until the server has it, and
 * an upload that fails for its size, the network or a closed tab is retried once (uploads.ts).
 */
export async function submitAndTrack(
  bytes: Uint8Array,
  notify: (msg: string, ms?: number) => void,
  onStatus: (s: SubmissionView) => void = () => {},
  run?: RunInfo,
): Promise<Submission | null> {
  if (!api.available()) {
    onStatus({ status: "local" });
    return null;
  }
  onStatus({ status: "submitting" });
  const gauntlet = currentGauntlet(run);
  const stored = run ? await keepUntilUploaded(bytes, { ...run, gauntlet }) : null;
  let sub: Submission;
  try {
    sub = await api.submitRun(bytes, { room: currentRoom(), race: currentRace(run), gauntlet, beats: run?.beats, mouse: run?.mouse });
  } catch {
    if (!stored) {
      onStatus({ status: "error", reason: "leaderboard offline" });
      return null;
    }
    await uploadStore.fail(stored, "network").catch(() => {});
    onStatus({ status: "unsent", failure: "network" });
    retrySoon(notify);
    return null;
  }
  const failure = failureOf(sub);
  if (stored && failure) {
    await uploadStore.fail(stored, failure).catch(() => {});
    onStatus({ status: "unsent", failure });
    return sub;
  }
  if (stored) await uploadStore.remove(stored).catch(() => {});
  onStatus(sub);
  noteSubmittedRun(sub.id); // the feedback form attaches it
  if (sub.status === "rejected" && !sub.id) return sub; // refused at upload (e.g. unranked map); card explains
  return trackVerdict(sub, onStatus, notify);
}

/** Polls a submission until it has a verdict (or POLL_GIVE_UP_MS passes), reporting each status. */
async function trackVerdict(sub: Submission, onStatus: (s: SubmissionView) => void, notify: (msg: string, ms?: number) => void): Promise<Submission> {
  const t0 = performance.now();
  for (let i = 0; sub.status === "queued" || sub.status === "verifying"; i++) {
    const elapsed = performance.now() - t0;
    if (elapsed > POLL_GIVE_UP_MS) {
      notify("Still checking your run. It'll show on the board.", 5000);
      return sub;
    }
    await new Promise((r) => setTimeout(r, pollDelay(i, elapsed)));
    try {
      sub = await api.submission(sub.id);
      onStatus(sub);
      if (sub.status === "verified") {
        if (sub.announcer) announce(sub.announcer, sub.id);
        refreshMyProfile(); // level / rank / suggestions changed
        forgetBoards(); // and maybe a board's top rows
        // The WR banner, level-up and achievement celebrations (with their sounds) come from the end card (hud.ts);
        // a better overall rank title gets its own celebration after them.
        void myProfile().then((p) => {
          if (!p?.mine) return;
          const i = RANK_GROUPS.findIndex((g) => g.id === p.rank.group.id);
          if (!rankGroupImproved(p.player.id, i < 0 ? RANK_GROUPS.length : i)) return; // unranked sorts below every group
          const g = RANK_GROUPS[i];
          celebrate({ stage: true, title: g.name, detail: p.rank.rank ? `New rank, #${p.rank.rank} overall` : "New rank", mood: "proud", color: g.color, sound: "rank_up", confetti: 70, priority: 45, key: `rank-${g.id}` });
        });
      }
    } catch {
      /* transient; keep polling */
    }
  }
  if (sub.status === "verified") void syncPBs(true);
  return sub;
}

/** Stores the replay before its upload ("uploading"); its sha256, or null if storing failed (then it isn't kept). */
async function keepUntilUploaded(bytes: Uint8Array, run: RunInfo): Promise<string | null> {
  try {
    noteTrackingStart();
    const sha = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    const account = (await api.me())?.id ?? null;
    await uploadStore.put({ sha, bytes, ...run, account, state: "uploading", retried: false, at: Date.now() });
    return sha;
  } catch {
    return null;
  }
}

/** The first load that records upload failures (uploads.ts TRACKING_SINCE_KEY): PB replays from before it are legacy. */
function noteTrackingStart(): number {
  const v = Number(localStorage.getItem(TRACKING_SINCE_KEY));
  if (v > 0) return v;
  const now = Date.now();
  localStorage.setItem(TRACKING_SINCE_KEY, String(now));
  return now;
}

let retryTimer = 0;
/** After a network failure: the one retry, 30 s later in this session (or on the next load if the tab goes first). */
function retrySoon(notify: (msg: string, ms?: number) => void): void {
  if (retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    void retryStoredUploads(notify);
  }, 30_000);
}

const runLabel = (u: Pick<StoredUpload, "time" | "map" | "track">) => `${formatTime(u.time)} run on ${u.map}${u.track ? ` (${trackName(u.track)})` : ""}`;
/** A retry that failed or was refused: an error Notice (red, its own sound), not the plain line the callers' toasts give. */
const bad = (msg: string, ms = 8000) => toast(msg, { ms, tone: "bad" });
let retrying = false;

/**
 * Sends every stored run due its one retry (uploads.ts shouldRetry) for the signed-in account, and first, once per
 * account, queues pre-v0.0.10 PB replays over the old upload cap (the legacy path). Says what happened in a toast for
 * each: uploaded and verified, rejected, or failed again. Called on load (mountOnlinePanel) and 30 s after a network
 * failure. Never throws.
 */
export async function retryStoredUploads(notify: (msg: string, ms?: number) => void): Promise<void> {
  if (retrying || !api.available()) return;
  retrying = true;
  try {
    const me = await api.me();
    if (!me) return;
    await queueLegacyPBs(me.id, me.name);
    const now = Date.now();
    const all = await uploadStore.all();
    for (const u of all) if (u.retried && now - u.at > KEEP_MS) await uploadStore.remove(u.sha);
    // A run gauntlet mode holds for its attempt is sent from there (resendGauntletRun), as often as it takes.
    for (const u of all.filter((x) => shouldRetry(x, me.id, now) && !heldByGauntlet(x))) {
      // Used before sending: a crash or a closed tab mid-retry doesn't earn another one.
      await uploadStore.put({ ...u, retried: true });
      let sub: Submission;
      try {
        // With the run-session tokens it was played with (uploads.ts StoredUpload.beats), checked like a first upload.
        // Only for the account that recorded it: tokens are issued to one player, and another's would fail the check.
        sub = await api.submitRun(u.bytes, { beats: u.account === me.id ? u.beats : undefined, mouse: u.mouse, gauntlet: u.account === me.id ? u.gauntlet : undefined });
      } catch {
        await uploadStore.put({ ...u, retried: true, state: "failed", failure: "network", at: Date.now() });
        bad(`Your earlier ${runLabel(u)} still hasn't uploaded.`);
        continue;
      }
      const failure = failureOf(sub);
      if (failure) {
        await uploadStore.put({ ...u, retried: true, state: "failed", failure, at: Date.now() });
        bad(`Your earlier ${runLabel(u)} still hasn't uploaded: ${failureText(failure)}.`);
        continue;
      }
      await uploadStore.remove(u.sha);
      if (!sub.id) {
        if (sub.status === "rejected") rejectPBForRun(u.map, u.style, u.track, u.time, u.account);
        bad(`Your earlier ${runLabel(u)} wasn't accepted: ${sub.reason ?? "refused"}.`);
        continue;
      }
      noteSubmittedRun(sub.id);
      notify(`Your earlier ${runLabel(u)} is uploaded. Checking it now.`, 5000);
      const v = await trackVerdict(sub, () => {}, notify);
      if (v.status === "verified") notify(`Your earlier ${runLabel(u)} is on the board${v.rank ? ` at #${v.rank}` : ""}.`, 8000);
      else if (v.status === "rejected") {
        rejectPBForRun(u.map, u.style, u.track, u.time, u.account);
        bad(`Your earlier ${runLabel(u)} wasn't accepted: ${v.reason ?? "rejected"}.`);
      }
      else if (v.status === "error") notify(`Your earlier ${runLabel(u)} is waiting for review.`, 8000);
    }
  } catch (e) {
    console.warn("stored upload retry failed", e);
  } finally {
    retrying = false;
  }
}

/**
 * Gauntlet mode (gauntlet/mode.ts): the stored run tagged for `attemptId` on `map` that never reached the server (its
 * upload failed for the connection, or a reload or a crash cut it off), oldest first, or null.
 */
export async function storedGauntletRun(attemptId: string, map: string): Promise<StoredUpload | null> {
  const sendable = (x: StoredUpload) => x.state === "uploading" || x.failure === "network" || x.failure === "interrupted";
  try {
    return (await uploadStore.all()).filter((x) => x.gauntlet === attemptId && x.map === map && sendable(x)).sort((a, b) => a.at - b.at)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Sends a stored gauntlet run (storedGauntletRun) again, whether or not its one automatic retry is used: while the
 * attempt is open, that finish is the map's candidate until the server has it. Its reply, "network" (still no
 * connection), or null (another account's run, or a failure a retry can't fix).
 */
export async function resendGauntletRun(u: StoredUpload): Promise<Submission | "network" | null> {
  if (!api.available()) return null;
  let sub: Submission;
  try {
    const me = await api.me();
    if (u.account !== null && u.account !== me?.id) return null;
    sub = await api.submitRun(u.bytes, { beats: u.beats, mouse: u.mouse, gauntlet: u.gauntlet });
  } catch {
    await uploadStore.put({ ...u, state: "failed", failure: "network" }).catch(() => {});
    return "network";
  }
  const failure = failureOf(sub);
  if (failure) {
    await uploadStore.put({ ...u, state: "failed", failure, at: Date.now() }).catch(() => {});
    return null;
  }
  await uploadStore.remove(u.sha).catch(() => {});
  if (sub.id) {
    noteSubmittedRun(sub.id);
    void trackVerdict(sub, () => {}, () => {});
  }
  return sub;
}

/**
 * The legacy path (uploads.ts): once per account, stored local PB replays over the old 1 MiB cap, recorded before this
 * browser started tracking failures and under this player's name, are queued as too_large (if not already stored).
 */
async function queueLegacyPBs(account: string, name: string): Promise<void> {
  const flag = legacyScanKey(account);
  if (localStorage.getItem(flag)) return;
  const since = noteTrackingStart();
  for (const { bytes } of await largePBReplays(LEGACY_UPLOAD_LIMIT)) {
    let replay: Replay;
    try {
      replay = await decodeReplay(bytes);
    } catch {
      continue;
    }
    const h = replay.header;
    if (!legacyCandidate(bytes.byteLength, h, name, since)) continue;
    const sha = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    if (await uploadStore.get(sha)) continue;
    const time = (h.endTick - h.startTick) * Math.fround(h.settings.tickInterval);
    await uploadStore.put({ sha, bytes, map: h.map, style: replayStyle(h), track: h.track ?? 0, time, account, state: "failed", failure: "too_large", retried: false, legacy: true, at: Date.now() });
  }
  localStorage.setItem(flag, String(Date.now()));
}

/** Strips ?login / ?login_error left by the Discord callback; returns a message to show, if any. */
function consumeLoginParams(): { msg: string; ok: boolean } | null {
  const url = new URL(appHref());
  const ok = url.searchParams.get("login");
  const err = url.searchParams.get("login_error");
  if (!ok && !err) return null;
  url.searchParams.delete("login");
  url.searchParams.delete("login_error");
  history.replaceState(null, "", url);
  if (err) console.warn("Discord sign-in:", err);
  return ok ? { msg: "Discord linked. Your runs are saved to your account.", ok: true } : { msg: "Discord sign-in didn't finish.", ok: false };
}

/** Session startup hook: shows the Discord login result and warms the guest identity. */
export async function mountOnlinePanel(_map: string, _style: string, notify: (msg: string, ms?: number) => void): Promise<void> {
  if (!api.available()) return;
  const login = consumeLoginParams();
  if (login) login.ok ? notify(login.msg, 6000) : bad(login.msg, 6000);
  await api.me();
  // Runs whose upload failed earlier get their one retry once the game has loaded (uploads.ts).
  window.setTimeout(() => void retryStoredUploads(notify), 4000);
}
