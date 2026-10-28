// Gauntlet mode (research/GAUNTLETS.md): the game opened with ?gauntlet=<attemptId>. main.ts calls resolveGauntlet()
// before it loads a map (a reload or an old link goes to the attempt's current map; a finished attempt to its result),
// then startGauntletMode() once the session exists:
//   - runs on this map in Normal style on the main track are submitted with ?gauntlet= (state.ts tag, online.ts);
//   - the style and track are locked (session.modeLock); practice mode and third person are off (main.ts);
//   - the HUD shows one line under the timer: the total so far and the live delta to your PB's split (hud.ts);
//   - the attempt is pinged every minute (the server expires it after 10 minutes without: the grace period, state.ts
//     GRACE_MS); a failed ping tries again after RETRY_MS, and nothing ends on a network error. A page that can't reach
//     the server on load plays on in the attempt as this browser last had it (offlineResume) until a ping gets through;
//   - the first finish on the map is the candidate (state.ts SplitGate); if its upload fails for the connection it is
//     sent again every RETRY_MS (from the upload store, so a reload or a crash keeps it) until the server has it, and no
//     later finish here is tagged meanwhile;
//   - the next map's BSP is prefetched with the URL the loader uses (content/map-url.ts), so its load is a cache hit;
//   - a finish the server takes as the split says so in one line under the result, then the next map loads after
//     NEXT_MAP_MS (Enter or a click goes at once); the last one goes to the result page (ui/gauntlets.ts). A refused run
//     says why in one line and the player goes again on the same map.

import { appHref } from "../platform/navigation";
import { api, ApiError, type GauntletAttempt } from "../api";
import { fetchBytes } from "../content/fetch";
import { bspUrl, indexSha } from "../content/map-url";
import { nativeClient } from "../client-bridge";
import type { SubmissionView } from "../hud";
import { toast } from "../notify";
import { allowLeave } from "../play-lock";
import { debugHookOptIn, type RunSession } from "../session";
import { resendGauntletRun, storedGauntletRun, submitAndTrack } from "../online";
import { decodeReplay } from "../replay";
import { h } from "../ui/dom";
import { fetchMapIndex } from "../ui/maps";
import {
  endedText,
  forgetAttempt,
  GAUNTLET_STYLE,
  gauntletPath,
  gauntletUrl,
  isAttemptId,
  NEXT_MAP_MS,
  offlineResume,
  PING_MS,
  progressOf,
  rememberAttempt,
  resumeTarget,
  RETRY_MS,
  savedAttempt,
  setGauntletTag,
  setLiveGauntlet,
  SplitGate,
  splitLine,
  submissionOutcome,
  type GauntletProgress,
  type SplitOutcome,
} from "./state";

export interface GauntletStart {
  attempt: GauntletAttempt;
  /** The map to play (the attempt's next) and its index. */
  map: string;
  idx: number;
  /** The server couldn't be reached: `attempt` is this browser's saved copy, until a ping gets through. */
  offline?: boolean;
}

const navigating = () => new Promise<never>(() => {});

function dropParam(): void {
  const url = new URL(appHref());
  if (!url.searchParams.has("gauntlet")) return;
  url.searchParams.delete("gauntlet");
  history.replaceState(history.state, "", url);
}

/**
 * The page's ?gauntlet=<id>, before any map loads: the attempt to play, or null (no attempt, or it can't be played: the
 * parameter is dropped and a toast says why). Navigates (and never resolves) when the page is on the wrong map or the
 * attempt is finished.
 */
export async function resolveGauntlet(params: URLSearchParams): Promise<GauntletStart | null> {
  const id = params.get("gauntlet");
  if (id === null) return null;
  if (!isAttemptId(id) || !api.available()) {
    dropParam();
    return null;
  }
  let a: GauntletAttempt;
  try {
    a = await api.gauntletAttempt(id);
  } catch (e) {
    const gone = e instanceof ApiError && (e.status === 404 || e.status === 401);
    // A blip (offline, a 5xx): play on in the attempt as this browser last had it, within the grace period.
    const saved = gone ? null : savedAttempt(id);
    const play = offlineResume(saved, id, params.get("map"));
    if (saved && play) return { attempt: saved.a, map: play.map, idx: play.idx, offline: true };
    dropParam();
    if (gone) forgetAttempt(id);
    toast(gone ? endedText("unknown") : "Couldn't reach the gauntlet, so this map is played on its own.", { ms: 6000 });
    return null;
  }
  const r = resumeTarget(a, params.get("map"));
  if (r.kind === "go" || r.kind === "result") {
    allowLeave();
    location.replace(r.url);
    return navigating();
  }
  if (r.kind === "ended") {
    dropParam();
    forgetAttempt(id);
    toast(endedText(r.state), { ms: 6000 });
    return null;
  }
  return { attempt: a, map: r.map, idx: r.idx };
}

export class GauntletMode {
  private active = true;
  /** A finished run of this map was tagged for the attempt: its time, until the upload's answer comes. */
  private awaiting: { time: number } | null = null;
  private progress: GauntletProgress;
  private gate: SplitGate;
  private pingTimer = 0;
  private resendTimer = 0;
  private goTimer = 0;
  private unlisten: (() => void) | null = null;

  constructor(
    private o: { start: GauntletStart; session: RunSession },
  ) {
    const { attempt: a, map, idx } = o.start;
    const s = o.session;
    s.modeLock = "Gauntlets are Normal style on the main track.";
    // Saved with when the server said so (a page started from the saved copy leaves it as it is).
    if (!o.start.offline) this.save();
    this.progress = progressOf(a, idx, null);
    s.hud.setGauntlet(this.progress);
    this.gate = new SplitGate(a.id, map);
    setLiveGauntlet({ id: a.id, map });
    setGauntletTag((run) => {
      const id = this.active ? this.gate.tag(run) : null;
      if (id) this.awaiting = { time: run.time ?? s.timer.time() };
      return id;
    });
    const prev = s.onSubmission;
    s.onSubmission = (st) => {
      prev?.(st);
      this.onSubmission(st);
    };
    this.schedulePing(o.start.offline ? RETRY_MS : PING_MS);
    // A finish here from an earlier page whose upload never got through (a reload, a crash) is still the candidate.
    void this.resend();
    void this.loadPB();
    window.setTimeout(() => void this.prefetchNext(), 4000);
    void s.refreshMenu();
    // Automated checks (the dev server, or the debug opt-in): submit a replay of this map as if it had just been run
    // here (pointer lock, so real play, can't happen in automation). The answer goes through the same path as a finish.
    if (import.meta.env.DEV || debugHookOptIn()) Object.assign(window, { __gauntlet: { submit: (b64: string) => this.submitForTest(b64), attempt: () => this.attempt } });
  }

  private async submitForTest(b64: string): Promise<unknown> {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hd = (await decodeReplay(bytes)).header;
    const time = (hd.endTick - hd.startTick) * Math.fround(hd.settings.tickInterval);
    const s = this.o.session;
    return submitAndTrack(bytes, (m, ms) => s.hud.toast(m, ms), (st) => {
      s.hud.setSubmission(st);
      s.onSubmission?.(st);
    }, { map: hd.map, style: GAUNTLET_STYLE, track: hd.track ?? 0, time });
  }

  private get attempt(): GauntletAttempt {
    return this.o.start.attempt;
  }

  /** The attempt as the server last had it, for a reload that can't reach it (state.ts offlineResume). */
  private save(): void {
    rememberAttempt(this.attempt.gauntlet.slug, this.attempt.id, { a: this.attempt, at: Date.now() });
  }

  private schedulePing(ms: number): void {
    clearTimeout(this.pingTimer);
    this.pingTimer = window.setTimeout(() => void this.ping(), ms);
  }

  /** Sends the held candidate (or one an earlier page left in the upload store) again; its answer as a finish's. */
  private async resend(): Promise<void> {
    clearTimeout(this.resendTimer);
    this.resendTimer = 0;
    if (!this.active || !this.gate.resendable) return;
    const u = await storedGauntletRun(this.attempt.id, this.o.start.map);
    if (!this.active || !this.gate.resendable) return;
    if (!u) {
      if (this.gate.state === "held") this.show({ kind: "refused", reason: "the run didn't upload" }, 0);
      return;
    }
    // Held before it's sent: no later finish here takes its place meanwhile.
    this.gate.answer({ kind: "held" });
    const r = await resendGauntletRun(u);
    if (!this.active) return;
    if (r === "network") this.resendTimer = window.setTimeout(() => void this.resend(), RETRY_MS);
    else this.show(r ? submissionOutcome(r, this.attempt.maps.length) : { kind: "refused", reason: "the run didn't upload" }, u.time);
  }

  /** Your gauntlet PB's split on this map, for the HUD's delta. */
  private async loadPB(): Promise<void> {
    try {
      const d = await api.gauntlet(this.attempt.gauntlet.slug);
      if (!this.active) return;
      this.progress = progressOf(this.attempt, this.o.start.idx, d.me);
      this.o.session.hud.setGauntlet(this.progress);
    } catch {
      /* no delta without it */
    }
  }

  private async ping(): Promise<void> {
    if (!this.active) return;
    try {
      const r = await api.pingGauntlet(this.attempt.id);
      if (!this.active) return;
      this.schedulePing(PING_MS);
      // A response can be lost after the server advanced the split, and stored uploads retry in the background.
      // Reconcile on the next ping so reconnecting never strands the player on a completed step.
      if ((r.state === "open" && r.step > this.o.start.idx) || r.state === "finished_pending" || r.state === "complete") {
        const a = await api.gauntletAttempt(this.attempt.id);
        if (!this.active) return;
        const target = resumeTarget(a, this.o.start.map);
        if (target.kind === "go" || target.kind === "result" || (target.kind === "play" && target.idx > this.o.start.idx)) {
          this.active = false;
          this.goTo(target.kind === "play" ? gauntletUrl(target.map, a.id) : target.url);
          return;
        }
      }
      if (r.state !== "open" && r.state !== "finished_pending" && r.state !== "complete") return this.end(endedText(r.state));
      this.save();
      if (this.o.start.offline) {
        this.o.start.offline = false;
        void this.loadPB();
      }
      // Back online: the held candidate goes now.
      if (this.gate.state === "held" && this.resendTimer) void this.resend();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return this.end(endedText("unknown"));
      // Offline (or the server's busy): the attempt waits out the grace period on the server; try again soon.
      this.schedulePing(e instanceof ApiError ? PING_MS : RETRY_MS);
    }
  }

  /** The next map's BSP into the HTTP cache (the desktop client: its own cache), while this map is played. */
  private async prefetchNext(): Promise<void> {
    const next = this.attempt.maps.find((m) => m.idx === this.o.start.idx + 1);
    if (!next || !this.active) return;
    try {
      const entry = (await fetchMapIndex()).find((m) => m.name === next.map);
      const sha = indexSha(entry);
      const url = bspUrl(next.map, sha);
      if (nativeClient() && sha) {
        await fetchBytes(url, { cacheSha256: sha, attempts: 2, resume: true, sha256: sha });
        return;
      }
      const res = await fetch(url, { priority: "low" } as RequestInit);
      const reader = res.ok ? res.body?.getReader() : null;
      if (!reader) return;
      while (!(await reader.read()).done) {
        /* drained into the cache */
      }
    } catch {
      /* the load downloads it as usual */
    }
  }

  private onSubmission(st: SubmissionView): void {
    if (!this.awaiting || st.status === "submitting") return;
    const { time } = this.awaiting;
    this.awaiting = null;
    this.show(submissionOutcome(st, this.attempt.maps.length), time);
  }

  private show(outcome: SplitOutcome, time: number): void {
    const a = this.attempt;
    const hud = this.o.session.hud;
    const next = outcome.kind === "split" && !outcome.last ? (a.maps.find((m) => m.idx === outcome.idx + 1)?.map ?? null) : null;
    const line = splitLine(outcome, time, a.maps.length, next);
    if (hud.cardShown) {
      hud.setCardExtra(h(`div.endcard-sub.${outcome.kind === "split" ? "ok" : "dim"}`, null, line));
      if (outcome.kind === "split") hud.setCardHint(null);
    } else hud.toast(line, outcome.kind === "split" ? NEXT_MAP_MS + 1000 : 5000, "gauntlet");
    this.gate.answer(outcome);
    if (outcome.kind === "ended") return this.end(null);
    if (outcome.kind === "held") {
      if (!this.resendTimer) this.resendTimer = window.setTimeout(() => void this.resend(), RETRY_MS);
      return;
    }
    if (outcome.kind !== "split") return;
    // This map is done: no more splits here (the server would refuse them), on to the next one.
    this.active = false;
    clearTimeout(this.resendTimer);
    a.splits = [...a.splits.filter((s) => s.idx !== outcome.idx), { idx: outcome.idx, map: a.maps[outcome.idx]?.map ?? "", runId: "", ticks: 0, time, arrivedAt: Date.now(), verified: false }];
    // As the server has it now, for a reload that can't reach it.
    a.step = outcome.idx + 1;
    a.next = next ? { idx: outcome.idx + 1, map: next } : null;
    if (outcome.last) a.state = "finished_pending";
    this.save();
    hud.setGauntlet({ ...this.progress, before: this.progress.before + time });
    this.goTo(outcome.last ? gauntletPath(a.gauntlet.slug, a.id) : gauntletUrl(next!, a.id));
  }

  /** The next page after NEXT_MAP_MS, or at once on Enter or a click. */
  private goTo(url: string): void {
    const go = () => {
      this.unlisten?.();
      clearTimeout(this.goTimer);
      clearTimeout(this.pingTimer);
      clearTimeout(this.resendTimer);
      allowLeave();
      location.href = url;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "NumpadEnter") (e.preventDefault(), go());
    };
    const onClick = (e: MouseEvent) => e.button === 0 && go();
    addEventListener("keydown", onKey, true);
    addEventListener("mousedown", onClick, true);
    this.unlisten = () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("mousedown", onClick, true);
    };
    this.goTimer = window.setTimeout(go, NEXT_MAP_MS);
  }

  /** The attempt is over (expired, abandoned, failed): the map plays on by itself. `text`: a toast saying so. */
  end(text: string | null): void {
    if (!this.active && !this.pingTimer) return;
    this.active = false;
    this.awaiting = null;
    clearTimeout(this.pingTimer);
    clearTimeout(this.resendTimer);
    this.pingTimer = 0;
    this.resendTimer = 0;
    setGauntletTag(null);
    setLiveGauntlet(null);
    const s = this.o.session;
    s.hud.setGauntlet(null);
    s.modeLock = null;
    dropParam();
    forgetAttempt(this.attempt.id);
    if (text) toast(text, { ms: 6000 });
    void s.refreshMenu();
  }
}

export function startGauntletMode(start: GauntletStart, session: RunSession): GauntletMode {
  return new GauntletMode({ start, session });
}
