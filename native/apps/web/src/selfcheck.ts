// Client self-check + diagnostics for submitted runs (session.ts finish()).
//
// The upload goes out at once, exactly as before (nothing here waits on it or delays it). Alongside, the replay is
// re-simulated in a worker (map-physics.ts: the map's one off-thread core, shared with the race ghosts) with the
// verifier the server runs, and once both are done a small diagnostics object is attached to the submitted run
// (api.runDiagnostics, apps/api src/diagnostics.ts): the self-check outcome, browser, sim / web build, fps over the run,
// the input stats summary, tab switches during the run and the device fingerprint's components (device.ts; the hash
// itself goes with every write), and the player's side of the run for its stats card (RunPlay: attempts and time on the
// map, frame cap, turn speed). The server stays authoritative; a client-side mismatch is only flagged ("client desync" in the admin Runs view), which
// separates "this browser disagrees with its own recording" from "the server disagrees with the client".

import { untrustedInputEvents } from "./input-trust";
import { api } from "./api";
import type { Input } from "./input";
import { summary as inputSummary } from "./input-debug";
import { RunPollRate } from "./mouse-filter";
import { ownBuild } from "./update";
import { VERSION } from "./version";
import { fingerprint } from "./device";
import { nativeClient } from "./client-bridge";
import { runClientInfo } from "./client-identity";

export interface SelfCheckResult {
  /** "na": not checked (a big map on a low-memory device, map-physics.ts; apps/api src/diagnostics.ts SELF_CHECKS). */
  selfCheck: "ok" | "mismatch" | "error" | "na";
  firstMismatchTick?: number;
  problems?: string[];
  checkMs?: number;
}

/**
 * Frames and tab switches during a timed run (start() when the timer starts, stop() at the finish), and a clock
 * tripwire: the elapsed requestAnimationFrame time and performance.now time, each against Date.now's. A hooked frame
 * timestamp (a "timescale": the sim runs on it) shows as a ratio far from 1. Spoofable; review only (apps/api
 * src/integrity-rules.ts clock-skew).
 */
export class RunWatch {
  private running = false;
  private startAt = 0;
  private dateAt = 0;
  private rafFirst: number | null = null;
  private rafLast = 0;
  private frames = 0;
  private hidden = 0;
  private hiddenMs = 0;
  private hiddenAt: number | null = null;
  private blurs = 0;
  /** input-trust.ts's count when the run started. */
  private untrustedAt = 0;
  /** The run's polling rate (mouse-filter.ts), from the input's stats while the run is on. */
  private readonly poll = new RunPollRate();
  private pollSource: ((now: number, windowMs: number) => number) | null = null;

  constructor() {
    addEventListener("visibilitychange", () => {
      if (!this.running) return;
      if (document.hidden) {
        this.hidden++;
        this.hiddenAt = performance.now();
      } else if (this.hiddenAt !== null) {
        this.hiddenMs += performance.now() - this.hiddenAt;
        this.hiddenAt = null;
      }
    });
    addEventListener("blur", () => this.running && this.blurs++);
  }

  start(pollHz?: (now: number, windowMs: number) => number): void {
    this.running = true;
    this.untrustedAt = untrustedInputEvents();
    this.poll.reset();
    this.pollSource = pollHz ?? null;
    this.startAt = performance.now();
    this.dateAt = Date.now();
    this.rafFirst = null;
    this.frames = this.hidden = this.hiddenMs = this.blurs = 0;
    this.hiddenAt = document.hidden ? this.startAt : null;
  }

  /** Every rendered frame (`raf`: its requestAnimationFrame timestamp). */
  frame(raf?: number): void {
    if (!this.running) return;
    this.frames++;
    if (this.pollSource) this.poll.sample(performance.now(), this.pollSource);
    if (raf !== undefined) {
      this.rafFirst ??= raf;
      this.rafLast = raf;
    }
  }

  stop(): { fps: number; visibility: { hidden: number; hiddenMs: number; blurs: number }; clock?: { raf: number; perf: number; secs: number }; pollHz?: number; untrusted?: number } {
    const now = performance.now();
    this.running = false;
    const hiddenMs = this.hiddenMs + (this.hiddenAt !== null ? now - this.hiddenAt : 0);
    const secs = (now - this.startAt) / 1000;
    const wall = Date.now() - this.dateAt;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const clock = wall > 0 && this.rafFirst !== null ? { raf: r2((this.rafLast - this.rafFirst) / wall), perf: r2((now - this.startAt) / wall), secs: Math.round(wall / 100) / 10 } : undefined;
    const pollHz = this.poll.hz();
    const untrusted = untrustedInputEvents() - this.untrustedAt;
    return { fps: secs > 0 ? Math.round((this.frames / secs) * 10) / 10 : 0, visibility: { hidden: this.hidden, hiddenMs: Math.round(hiddenMs), blurs: this.blurs }, ...(clock ? { clock } : {}), ...(pollHz ? { pollHz } : {}), ...(untrusted ? { untrusted } : {}) };
  }
}

/**
 * The player's side of a run, for its stats card on the boards (apps/api src/diagnostics.ts `play`, src/run-stats.ts):
 * the run's attempt on the map on this device and the time played there (map-time.ts), its attempt on the board this
 * session (attempts.ts), the frame cap, the turn speed and the mouse's polling rate over the run (RunWatch).
 */
export interface RunPlay {
  attempt?: number;
  seconds?: number;
  session?: number;
  sessionSeconds?: number;
  frameCap?: { limit: number; vsync: boolean };
  turn?: { yawSpeed: number; angleSpeedKey: number };
  pollHz?: number;
  /** The vertical mouse sensitivity in effect (the separate one when it's on, else the sensitivity), v0.0.36+. */
  vsens?: number;
  /** Mouse Y inverted (m_pitch < 0). */
  invertY?: boolean;
}

/** RunPlay's vertical look (mouse-settings.ts, DOM-free so it can be tested). */
export { pitchPlay } from "./mouse-settings";

/**
 * After a submitted run: waits for the self-check and the upload (its run id; "" = not stored: offline, refused at
 * upload), then attaches the diagnostics. Fire and forget.
 */
export async function reportRun(o: { check: Promise<SelfCheckResult>; upload: Promise<string>; watched: ReturnType<RunWatch["stop"]>; input: Input; wasm: string; play?: RunPlay }): Promise<void> {
  const [check, id, fp] = await Promise.all([o.check, o.upload, fingerprint().catch(() => null)]);
  if (!id) return;
  await api.runDiagnostics(id, {
    ...check,
    ua: navigator.userAgent,
    client: runClientInfo(nativeClient(), typeof navigator === "undefined" ? "" : navigator.userAgent),
    wasm: o.wasm,
    web: ownBuild() ?? "dev",
    version: VERSION,
    fps: o.watched.fps,
    input: inputSummary(o.input),
    visibility: o.watched.visibility,
    ...(o.watched.clock ? { clock: o.watched.clock } : {}),
    ...(o.watched.untrusted ? { untrusted: o.watched.untrusted } : {}),
    ...(fp ? { fp: fp.components } : {}),
    ...(o.play ? { play: o.play } : {}),
  });
}
