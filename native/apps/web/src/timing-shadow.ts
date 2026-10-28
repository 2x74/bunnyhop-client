/** Offline/shadow policy only. No score submission, ranked integration or replay fields. */
import { RunTimer, EVENT_JUMPED, EVENT_RESPAWNED, type TickCmd, type TickState, type TimerUpdate } from "./timer";
import { playerInZone, trackOf, type Zone } from "./zones";
import type { TimingPath, TimingSegment } from "./timing-trace";

export const SHADOW_POLICY = "rule2-command-start-endpoint-boundary-path-v2";
export const STRICT_SHADOW_POLICY = "rule2-command-start-endpoint-path-v2-strict";
export type CoverageMode = "boundary" | "strict";
// These are known solver coverage limitations, not missing/corrupt observations.
const INTERIOR_LIMITATIONS = new Set(["selected-high-step", "ground-snap", "hull-transition",
  "water", "movement-mode", "mover-or-base-velocity", "recovery-or-trapped", "position-correction",
  "unsupported-branch", "unstick", "no-supported-movement"]);
const UNITS = 1_000_000;
const EVENT_TELEPORTED = 1;
export interface Anchor { tick: number; fraction: number; reason: string }
export interface ShadowSplit { index: number; anchor: Anchor | null; scoreMs: number | null }
export interface ShadowResult {
  policy: typeof SHADOW_POLICY | typeof STRICT_SHADOW_POLICY;
  coverage: Record<string, number>;
  track: number | null;
  start: Anchor | null; finish: Anchor | null;
  scoreMs: number | null; splits: ShadowSplit[]; rejected: string[];
  zeroDuration: boolean;
}
export function anchor(tick: number, phase: number, reason: string): Anchor {
  if (!Number.isSafeInteger(tick) || tick < 1 || !Number.isFinite(phase) || phase < 0 || phase > 1) throw Error("invalid event coordinate");
  const units = (tick - 1) * UNITS + Math.floor(phase * UNITS + .5);
  if (!Number.isSafeInteger(units)) throw Error("event coordinate overflow");
  return { tick: Math.floor(units / UNITS), fraction: units % UNITS, reason };
}
const coordinate = (a: Anchor) => a.tick * UNITS + a.fraction;
export function scoreMs(start: Anchor, finish: Anchor): number {
  for (const a of [start, finish]) {
    if (!Number.isSafeInteger(a.tick) || a.tick < 0 || !Number.isInteger(a.fraction) || a.fraction < 0 || a.fraction >= UNITS || !Number.isSafeInteger(coordinate(a))) throw Error("invalid event coordinate");
  }
  const elapsed = coordinate(finish) - coordinate(start);
  if (elapsed < 0) throw Error("finish-before-start");
  if (!Number.isSafeInteger(elapsed + 50_000)) throw Error("duration overflow");
  return Math.floor((elapsed + 50_000) / 100_000);
}
/** Ranking uses the visible integer score only. Equal milliseconds share rank. */
export function compareScores(a: number, b: number): number {
  if (![a, b].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error("invalid score");
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Inclusive Minkowski-expanded hull sweep, on one actual accepted solver segment. */
export function overlapInterval(s: TimingSegment, z: Zone): [number, number] | null {
  if (s.discrete) {
    // Phase changes have no elapsed movement time: only the applied destination exists.
    return playerInHullZone(s.to, s.mins, s.maxs, z) ? [s.t1, s.t1] : null;
  }
  let enter = 0, exit = 1;
  for (let i = 0; i < 3; i++) {
    const lo = z.mins[i] - s.maxs[i], hi = z.maxs[i] - s.mins[i];
    const delta = s.to[i] - s.from[i];
    if (delta === 0) { if (s.from[i] < lo || s.from[i] > hi) return null; continue; }
    let a = (lo - s.from[i]) / delta, b = (hi - s.from[i]) / delta;
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a); exit = Math.min(exit, b);
    if (enter > exit) return null;
  }
  return [s.t0 + enter * (s.t1 - s.t0), s.t0 + exit * (s.t1 - s.t0)];
}
function playerInHullZone(p: readonly number[], mins: readonly number[], maxs: readonly number[], z: Zone): boolean {
  return p.every((v,i) => v + maxs[i] >= z.mins[i] && v + mins[i] <= z.maxs[i]);
}
const equal = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);
export function validatePath(p: TimingPath): string | null {
  if (p.version !== 1 && p.version !== 2) return "trace-version";
  // A coverage limitation can omit a trajectory, but cannot excuse corrupt retained data.
  if (!Array.isArray(p.segments) || p.segments.length > 32) return "trace-length";
  for (const s of p.segments) {
    if (![s.from, s.to, s.mins, s.maxs].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
      || !Number.isFinite(s.t0) || !Number.isFinite(s.t1) || s.t0 < 0 || s.t1 < s.t0 || s.t1 > 1
      || s.discrete !== undefined && typeof s.discrete !== "boolean"
      || s.discrete && (p.version !== 2 || s.t0 !== s.t1)
      || s.mins.some((v, i) => v > s.maxs[i])) return "trace-corrupt";
  }
  if (p.unsupported) return p.unsupported;
  if (!p.segments.length || p.segments.length > 32) return "trace-length";
  let phase = 0;
  let previous: TimingSegment | null = null;
  for (const s of p.segments) {
    if (![s.t0, s.t1, ...s.from, ...s.to, ...s.mins, ...s.maxs].every(Number.isFinite)
      || s.t0 !== phase || s.t1 < s.t0 || s.t1 > 1
      || s.discrete && (p.version !== 2 || s.t0 !== s.t1)
      || s.mins.some((v, i) => v > s.maxs[i])
      || previous && (!equal(previous.to, s.from) || !s.discrete && (!equal(previous.mins, s.mins) || !equal(previous.maxs, s.maxs)))) return "trace-discontinuity";
    phase = s.t1; previous = s;
  }
  return phase === 1 ? null : "trace-incomplete";
}
function firstEntry(p: TimingPath, zones: readonly Zone[], endpoint: readonly number[], crouched: boolean): number | null {
  let earliest: number | null = null;
  // Preserve endpoint detection. A traversed thin zone is diagnostic, not a new finish.
  for (const z of zones) {
    if (!playerInZone(endpoint, crouched, z)) continue;
    for (const s of p.segments) {
      const hit = overlapInterval(s, z);
      if (hit && (earliest === null || hit[0] < earliest)) earliest = hit[0];
    }
  }
  return earliest;
}

/** Feed after the SAME rules-2 timer used to apply old prehop/cap order. */
export class ShadowTiming {
  constructor(readonly coverageMode: CoverageMode = "boundary") { this.value = this.empty(); }
  private value: ShadowResult;
  private lastTick = 0;
  private empty(): ShadowResult { return { policy: this.coverageMode === "strict" ? STRICT_SHADOW_POLICY : SHADOW_POLICY, coverage: {}, track: null, start: null, finish: null, scoreMs: null, splits: [], rejected: [], zeroDuration: false }; }
  reset(): void { this.value = this.empty(); this.lastTick = 0; }
  result(): ShadowResult { return structuredClone(this.value); }
  private reject(reason: string): void { if (!this.value.rejected.includes(reason)) this.value.rejected.push(reason); }
  update(timer: RunTimer, update: TimerUpdate, cmd: TickCmd, events: number, pre: TickState, post: TickState, path: TimingPath): void {
    if (Math.fround(timer.tickInterval) !== Math.fround(0.01)) throw Error("shadow timing requires 100 Hz");
    if (timer.rules !== 2) throw Error("shadow requires rules 2 eligibility observer");
    if (post.tick !== this.lastTick + 1) throw Error("nonconsecutive shadow ticks; reset evaluator");
    this.lastTick = post.tick;
    if (update.restarted || timer.status === "idle" && !timer.started) this.value = this.empty();
    if (!this.value.start && (timer.started || update.started)) {
      // pendingStart is announced on exit; record its first command now, while still inside.
      this.value = this.empty();
      const reason = events & EVENT_JUMPED ? "jump" : pre.grounded && !post.grounded ? "ledge" : !timer.inStart ? "walk-exit" : "eligibility-loss";
      this.value.start = anchor(post.tick, 0, reason);
      this.value.track = timer.track;
    }
    if (!this.value.start || this.value.finish) return;
    if (timer.track !== this.value.track) this.reject("track-change-without-rearm");
    if (events & EVENT_RESPAWNED) this.reject("respawn");
    const invalid = validatePath(path);
    if (invalid) {
      this.value.coverage[invalid] = (this.value.coverage[invalid] ?? 0) + 1;
      if (this.coverageMode === "strict" || !INTERIOR_LIMITATIONS.has(invalid)) this.reject(invalid);
    }
    // Unsupported collectors may omit pre/post corrections or hull changes. Their endpoints
    // are not asserted as complete paths; boundary ticks still require a valid full path.
    if (!invalid && path.segments.length && !equal(path.segments[0].from, pre.position)) this.reject("pre-move-discontinuity");
    const touch = post.touchPosition ?? post.position;
    if (!invalid && path.segments.length && !equal(path.segments.at(-1)!.to, touch)) this.reject("touch-discontinuity");
    if (!equal(post.position, touch) && !(events & EVENT_TELEPORTED)) this.reject("post-touch-discontinuity");
    if (post.touchCrouched !== undefined && post.touchCrouched !== post.crouched) this.reject("post-touch-hull-change");
    if (update.split) {
      const selected = timer.zones.find(z => trackOf(z) === timer.track && z.kind === update.split!.kind && (z.index ?? 0) === update.split!.index && playerInZone(post.position, post.crouched, z));
      const zones = selected ? [selected] : [];
      // A teleport destination is not an accepted movement endpoint.
      const phase = !invalid && equal(post.position, touch) ? firstEntry(path, zones, post.position, post.crouched) : null;
      const at = phase === null ? null : anchor(post.tick, phase, "split");
      this.value.splits.push({ index: update.split.index, anchor: at, scoreMs: at ? scoreMs(this.value.start, at) : null });
      if (!at) this.reject("unmeasured-split");
    }
    if (update.finished) {
      const ends = timer.zones.filter(z => z.kind === "end" && trackOf(z) === timer.track);
      const phase = invalid || events & EVENT_RESPAWNED ? null : firstEntry(path, ends, touch, post.touchCrouched ?? post.crouched);
      if (phase === null) this.reject("unmeasured-finish");
      else {
        this.value.finish = anchor(post.tick, phase, "accepted-path-entry");
        try {
          const score = scoreMs(this.value.start, this.value.finish);
          this.value.zeroDuration = coordinate(this.value.finish) === coordinate(this.value.start);
          if (!this.value.rejected.length) this.value.scoreMs = score;
        } catch { this.reject("finish-before-start"); }
      }
    }
    void cmd; // Observed command reserved for future policy diagnostics; never an input timestamp.
  }
}
