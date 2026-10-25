// Gauntlets in the game (research/GAUNTLETS.md; the server: apps/api src/gauntlets.ts). `/?map=<map>&gauntlet=<id>` is a
// session in a gauntlet attempt: its runs are submitted with ?gauntlet=, a finish the server takes as the split moves
// on to the next map (a full page load, gauntlet/mode.ts), and the last one goes to the result (/g/<slug>?attempt=<id>,
// ui/gauntlets.ts). This file is the DOM-free part: URLs, where a reload resumes, the HUD line and the split line, and
// the tag online.ts reads when it submits a run (like net/presence.ts currentRace). Tests: apps/web/test/gauntlet.test.ts.

import type { GauntletAttempt, GauntletSplitResult } from "../api";
import type { SubmissionView } from "../hud";
import { formatTime } from "../timer";

/** Gauntlets are Normal style (autohop) on main tracks only (owner decision). */
export const GAUNTLET_STYLE = "autohop";
/** The client pings the attempt this often while in gauntlet mode (the server expires it after 10 minutes without). */
export const PING_MS = 60_000;
/** After a split: this long before the next map loads (Enter or a click goes at once). */
export const NEXT_MAP_MS = 2000;
/**
 * The grace period: the server's ping timeout (apps/api src/gauntlets.ts PING_TIMEOUT_MS). An attempt nobody pinged for
 * this long expires; until then a dropped connection, a reload or a crash picks it up at its current map. Real time and
 * the attempt's cap run on through the gap (they count from the server's start), and the board ranks run times only,
 * so a break is never a free pause.
 */
export const GRACE_MS = 10 * 60_000;
/** After a failed ping or upload: try again this soon, so a reconnect is noticed in seconds. */
export const RETRY_MS = 10_000;

/** The game on `map` in attempt `id`. */
export function gauntletUrl(map: string, id: string): string {
  const q = new URLSearchParams({ map, gauntlet: id });
  return `/?${q}`;
}

/** A gauntlet's page; with `attempt`, that attempt's result on top. */
export function gauntletPath(slug: string, attempt?: string | null): string {
  return `/g/${encodeURIComponent(slug)}${attempt ? `?attempt=${encodeURIComponent(attempt)}` : ""}`;
}

/** Attempt ids are 16 url-safe characters (the server's randomToken(12)). */
export const isAttemptId = (v: string | null | undefined): v is string => !!v && /^[\w-]{16}$/.test(v);

export type Resume =
  /** Play this map in the attempt. */
  | { kind: "play"; map: string; idx: number }
  /** The page is on another map than the attempt's next one (a reload, an old link): go there. */
  | { kind: "go"; url: string }
  /** The attempt has all its splits (or is decided): its result. */
  | { kind: "result"; url: string }
  /** Expired, abandoned or failed: play on without the gauntlet. */
  | { kind: "ended"; state: GauntletAttempt["state"] };

/** Where a page opened with ?gauntlet=<id> (and ?map=, maybe none) goes, given the attempt. */
export function resumeTarget(a: Pick<GauntletAttempt, "id" | "state" | "next" | "gauntlet">, urlMap: string | null): Resume {
  if (a.state === "finished_pending" || a.state === "complete") return { kind: "result", url: gauntletPath(a.gauntlet.slug, a.id) };
  if (a.state !== "open" || !a.next) return { kind: "ended", state: a.state };
  if (urlMap !== a.next.map) return { kind: "go", url: gauntletUrl(a.next.map, a.id) };
  return { kind: "play", map: a.next.map, idx: a.next.idx };
}

/** The attempt as this browser last had it from the server (rememberAttempt), and when (ms). */
export interface SavedAttempt {
  a: GauntletAttempt;
  at: number;
}

/**
 * A page opened with ?gauntlet=<id> while the server can't be reached: play on in the attempt as saved, if it was heard
 * from within GRACE_MS, is still open on this map and under its cap. Runs are tagged as usual and the server decides
 * whether they're splits; the first ping that gets through reconciles (gauntlet/mode.ts). Else null (play on alone).
 */
export function offlineResume(saved: SavedAttempt | null, id: string, urlMap: string | null, now = Date.now()): Extract<Resume, { kind: "play" }> | null {
  if (!saved) return null;
  const a = saved.a;
  if (a.id !== id || a.state !== "open" || !a.next || a.next.map !== urlMap) return null;
  if (now - saved.at >= GRACE_MS || now >= a.startedAt + a.gauntlet.maxMs) return null;
  return { kind: "play", map: a.next.map, idx: a.next.idx };
}

/** What the HUD needs for the attempt's current map. */
export interface GauntletProgress {
  /** This map's index (0-based) and the gauntlet's map count. */
  idx: number;
  maps: number;
  /** Sum of the earlier splits' run times (s). */
  before: number;
  /** Your gauntlet PB's split on this map (s), or null (no PB). */
  pbSplit: number | null;
}

export function progressOf(a: Pick<GauntletAttempt, "maps" | "splits">, idx: number, pb: { splits: { idx: number; time: number }[] } | null): GauntletProgress {
  return {
    idx,
    maps: a.maps.length,
    before: a.splits.filter((s) => s.idx < idx).reduce((t, s) => t + s.time, 0),
    pbSplit: pb?.splits.find((s) => s.idx === idx)?.time ?? null,
  };
}

/**
 * The HUD line: "Gauntlet 2/3 · 1:02.340" (the total so far: earlier splits plus this run's time while it runs) and the
 * live delta to your PB's split on this map while a run is going (negative: ahead).
 */
export function hudLine(p: GauntletProgress, run: { running: boolean; time: number }): { text: string; delta: number | null } {
  const total = p.before + (run.running ? run.time : 0);
  return {
    text: `Gauntlet ${p.idx + 1}/${p.maps} · ${formatTime(total)}`,
    delta: run.running && p.pbSplit !== null ? run.time - p.pbSplit : null,
  };
}

/** Next step after a submission's reply. */
export type SplitOutcome =
  /** Split `idx` is in; `last`: that was the final map. */
  | { kind: "split"; idx: number; last: boolean }
  /** Not a split (the reason, in words); the attempt is still open, so the player can go again here. */
  | { kind: "refused"; reason: string }
  /** The attempt is over (expired, abandoned, failed); gauntlet mode ends. */
  | { kind: "ended"; reason: string }
  /** The upload failed for the connection: the run is kept and sent again until the server has it (it's the candidate). */
  | { kind: "held" };

/** The server's reasons (src/gauntlets.ts checkSplit / acceptSplit) in the game's words. */
function reasonText(r: string | undefined): string {
  if (!r) return "the server didn't take it";
  if (r === `gauntlets are ${GAUNTLET_STYLE} style only`) return "gauntlets are Normal style only";
  if (r === "not this step's map") return "this isn't the attempt's current map";
  return r;
}

export function splitOutcome(g: GauntletSplitResult | undefined, maps: number): SplitOutcome {
  if (!g) return { kind: "refused", reason: "the run wasn't submitted" };
  if (g.split !== null) return { kind: "split", idx: g.split, last: g.state === "finished_pending" || g.split + 1 >= maps };
  if (g.state && g.state !== "open") return { kind: "ended", reason: g.state === "expired" ? "the attempt expired" : g.state === "abandoned" ? "the attempt was abandoned" : `the attempt is ${g.state.replace("_", " ")}` };
  if (g.reason === "not your attempt") return { kind: "ended", reason: "this attempt isn't yours" };
  return { kind: "refused", reason: reasonText(g.reason) };
}

/** The outcome of a finished run's submission as the end card got it (online.ts submitAndTrack). */
export function submissionOutcome(st: SubmissionView, maps: number): SplitOutcome {
  if ("gauntlet" in st && st.gauntlet) return splitOutcome(st.gauntlet, maps);
  if (st.status === "unsent" && st.failure === "network") return { kind: "held" };
  if (st.status === "rejected") return { kind: "refused", reason: "reason" in st && st.reason ? `the run was refused (${st.reason})` : "the run was refused" };
  if (st.status === "unsent" || st.status === "error" || st.status === "local") return { kind: "refused", reason: "the run didn't upload" };
  return splitOutcome(undefined, maps);
}

/** "12.345", "1:02.340": a time in a sentence (no leading zeros). */
export function shortTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = String(ms % 1000).padStart(3, "0");
  return m ? `${m}:${String(s).padStart(2, "0")}.${frac}` : `${s}.${frac}`;
}

/** The one line under the result for a split: "Map 1 of 3 done in 12.345. bhop_x is next." */
export function splitLine(o: SplitOutcome, time: number, maps: number, nextMap: string | null): string {
  if (o.kind === "split") return o.last ? `Map ${o.idx + 1} of ${maps} done in ${shortTime(time)}. That's the whole gauntlet.` : `Map ${o.idx + 1} of ${maps} done in ${shortTime(time)}. ${nextMap ?? "The next map"} is next.`;
  if (o.kind === "ended") return `Not a split: ${o.reason}.`;
  if (o.kind === "held") return "No connection. This run counts once it uploads.";
  return `Not a split: ${o.reason}. Go again on this map.`;
}

/** Why an attempt the page was opened with can't be played on (a toast). */
export function endedText(state: GauntletAttempt["state"] | "unknown"): string {
  if (state === "expired") return "That gauntlet attempt expired.";
  if (state === "failed") return "That gauntlet attempt failed: one of its runs didn't verify.";
  if (state === "abandoned") return "That gauntlet attempt was given up.";
  if (state === "unknown") return "That gauntlet attempt isn't yours.";
  return "That gauntlet attempt has ended.";
}

// --- the submission tag (online.ts) ----------------------------------------------------------------------------------

/** A finished run as online.ts submits it (RunInfo): its board and time (s). */
export interface TaggedRun {
  map: string;
  style: string;
  track: number;
  time?: number;
}

let tag: ((run: TaggedRun) => string | null) | null = null;

/** gauntlet/mode.ts: the attempt id for runs that can be its split (this map, Normal, main track). */
export function setGauntletTag(f: typeof tag): void {
  tag = f;
}

/** The attempt a finished run is submitted for (POST /runs?gauntlet=), or null. */
export function currentGauntlet(run: TaggedRun | null | undefined): string | null {
  return run && tag ? tag(run) : null;
}

/**
 * Which finish on the map being played is the attempt's candidate (gauntlet/mode.ts): the first one, until the server
 * answers. One whose upload failed for the connection stays the candidate (held: sent again until the server has it),
 * so a later finish there is never tagged in its place: losing the connection can't swap a slow run for a better one.
 * A refusal opens the map again; a split (or the attempt's end) closes it.
 */
export class SplitGate {
  state: "open" | "sent" | "held" | "closed" = "open";

  constructor(
    private id: string,
    private map: string,
  ) {}

  /** The tag for a finished run (setGauntletTag): the attempt id for the candidate, else null. */
  tag(run: TaggedRun): string | null {
    if (this.state !== "open" || run.map !== this.map || run.style !== GAUNTLET_STYLE || run.track !== 0) return null;
    this.state = "sent";
    return this.id;
  }

  /** A stored candidate may be sent now: nothing else is out, and the map isn't done. */
  get resendable(): boolean {
    return this.state === "open" || this.state === "held";
  }

  answer(o: SplitOutcome): void {
    this.state = o.kind === "held" ? "held" : o.kind === "refused" ? "open" : "closed";
  }
}

let live: { id: string; map: string } | null = null;

/** gauntlet/mode.ts: the attempt and map being played (null: none). */
export function setLiveGauntlet(v: typeof live): void {
  live = v;
}

/** A stored upload gauntlet mode sends itself (this attempt's run on this map): online.ts's one retry leaves it be. */
export function heldByGauntlet(u: { gauntlet?: string | null; map: string }): boolean {
  return !!live && u.gauntlet === live.id && u.map === live.map;
}

// --- the attempt this browser is in, per gauntlet (the page's Resume) -------------------------------------------------

const KEY = "bunnyhop:gauntlet-attempt";

/** With `saved`: the attempt as the server last gave it, and when (offlineResume). */
export function rememberAttempt(slug: string, id: string, saved?: SavedAttempt): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ slug, id, ...saved }));
  } catch {
    /* storage blocked */
  }
}

/** The saved attempt `id` (rememberAttempt with `saved`), or null. */
export function savedAttempt(id: string): SavedAttempt | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SavedAttempt> & { id?: string } | null;
    return v?.id === id && v.a?.id === id && typeof v.at === "number" ? { a: v.a, at: v.at } : null;
  } catch {
    return null;
  }
}

/** The attempt last played on `slug` in this browser (it may have ended since). */
export function rememberedAttempt(slug: string): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { slug?: string; id?: string } | null;
    return v?.slug === slug && isAttemptId(v.id) ? v.id : null;
  } catch {
    return null;
  }
}

export function forgetAttempt(id?: string): void {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { id?: string } | null;
    if (!id || v?.id === id) localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

/** "1:02:03" for real time (ms): hours only when there are some. */
export function formatReal(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Time left until `end` (ms since the epoch), to the minute: "2d 4h", "5h 12m", "12m", "under a minute"; null once it's
 * over. The weekly's "Ends in …" (ui/gauntlets.ts, home.ts), redrawn each minute. */
export function formatCountdown(end: number, now = Date.now()): string | null {
  const left = end - now;
  if (left <= 0) return null;
  const min = Math.floor(left / 60_000);
  if (min < 1) return "under a minute";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** A gauntlet total (seconds): formatTime under an hour, "3:53:32.400" from there (the classic runs for hours). */
export function gauntletTime(seconds: number): string {
  if (seconds < 3600) return formatTime(seconds);
  const h = Math.floor(seconds / 3600);
  const rest = formatTime(seconds - h * 3600);
  return `${h}:${rest}`;
}
