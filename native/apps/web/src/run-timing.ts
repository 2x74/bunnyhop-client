// Sub-tick run timing (shavit-timer zone offsets, research/MS-TIMING.md). DOM-free and deterministic like timer.ts:
// only + - * / and comparisons on f32-exact inputs, so the browser, the native client's page and the verifier agree.
//
// A run is timed from the moment the player left the start zone to the moment they entered the end zone, inside the
// tick each happened in. bhoptimer (shavit-core CalculateTickIntervalOffset) traces the player's hull along the straight
// line between the last two origins; here the core's accepted movement path for the tick (timing-trace.ts, the solver's
// own collision segments) is used when it is complete, and the same straight hull trace otherwise.
//
// Tick k moves the player during [k - 1, k] (in ticks), so with the run's first tick S and its finishing tick E:
//   time = (E - 1 + entry) - (S - 1 + exit) ticks
// where `entry` is the phase in tick E at which the hull first touched the end zone, and `exit` is the phase in tick S
// at which it stopped touching the start zone on a walk-out (0 when the run began with a jump, a ledge drop or speed
// inside the zone: under timer rules 2 the run starts on that tick, before the zone is left). The old tick timer counted
// E - S, which is this time with exit = 0 and entry = 0.
//
// Phases are quantised half up to millionths of a tick, and the duration is rounded once, half up, to whole
// milliseconds: the score boards rank and show. Equal milliseconds tie.

import type { TimingPath, TimingSegment } from "./timing-trace";
import { HULL_HALF_WIDTH, HULL_HEIGHT, HULL_HEIGHT_DUCKED, playerInZone, type Zone } from "./zones";

/** Timing policy recorded with every verified run (runs.timing_policy). Bump when the measurement changes. */
export const TIMING_POLICY = 1;
/** Phase quantum: millionths of a tick (10 ns at 100 tick). */
export const FRACTION_UNITS = 1_000_000;

/** How a boundary phase was measured. */
export type CrossingMethod =
  /** The core's accepted movement path for the tick. */
  | "path"
  /** Straight hull trace between the tick's start and touch positions (bhoptimer's method). */
  | "chord"
  /** At a tick boundary by rule: a jump / ledge / speed start, or entering by teleport (the end of the tick). */
  | "boundary"
  /** Not measurable (no previous position): the conservative boundary (start 0, finish 1: never faster). */
  | "fallback";

export interface Crossing {
  /** Phase inside the tick, quantised: 0..FRACTION_UNITS. */
  fraction: number;
  method: CrossingMethod;
}

/** Lazily reads the accepted path of the tick just stepped (null when the core didn't observe it). */
export type PathSource = () => TimingPath | null;

export const quantizePhase = (phase: number): number => Math.min(FRACTION_UNITS, Math.max(0, Math.floor(phase * FRACTION_UNITS + 0.5)));

/** Run length in phase units from the first tick `startTick` (exit phase `startFraction`) to the finish. */
export function timeUnits(startTick: number, startFraction: number, endTick: number, endFraction: number): number {
  const units = (endTick - startTick) * FRACTION_UNITS + endFraction - startFraction;
  return units > 0 ? units : 0;
}

/** Phase units per millisecond at this tick interval (100 000 at 100 tick). */
function unitsPerMs(tickInterval: number): number {
  const tickUs = Math.round(Math.fround(tickInterval) * 1e6);
  return (FRACTION_UNITS * 1000) / tickUs;
}

/** Whole milliseconds, rounded half up once. */
export function unitsToMs(units: number, tickInterval: number): number {
  const per = unitsPerMs(tickInterval);
  return Math.floor((units + per / 2) / per);
}

/** The run time the old tick timer gave (E - S ticks), in milliseconds: boards' value for runs not yet re-timed. */
export function tickMs(ticks: number, tickInterval = 0.01): number {
  return Math.round(ticks * Math.round(Math.fround(tickInterval) * 1e6) / 1000);
}

/**
 * The timer's player box (zones.ts playerInZone) for a crouch state, as mins/maxs around the feet origin. Crossings use
 * this box, not the physics hull, so a crossing phase always agrees with the timer's own in/out test.
 */
function timerBox(crouched: boolean): { mins: readonly number[]; maxs: readonly number[] } {
  const h = crouched ? HULL_HEIGHT_DUCKED : HULL_HEIGHT;
  return { mins: [-HULL_HALF_WIDTH, -HULL_HALF_WIDTH, 0], maxs: [HULL_HALF_WIDTH, HULL_HALF_WIDTH, h] };
}

/** The physics hull of a path segment is crouched (36 tall) rather than standing (72): the midpoint splits them. */
const segmentCrouched = (s: TimingSegment): boolean => s.maxs[2] - s.mins[2] < 54;

/**
 * Phase interval [enter, exit] during which a box moving from `from` to `to` over [t0, t1] touches the zone (touching
 * counts, like playerInZone), or null. A discrete segment (a solver phase change) has no elapsed movement: only its
 * destination at t1 is tested.
 */
export function sweep(from: readonly number[], to: readonly number[], t0: number, t1: number, discrete: boolean, crouched: boolean, z: Zone): [number, number] | null {
  if (discrete) return playerInZone(to, crouched, z) ? [t1, t1] : null;
  const box = timerBox(crouched);
  let enter = 0;
  let exit = 1;
  for (let i = 0; i < 3; i++) {
    const lo = z.mins[i] - box.maxs[i];
    const hi = z.maxs[i] - box.mins[i];
    const delta = to[i] - from[i];
    if (delta === 0) {
      if (from[i] < lo || from[i] > hi) return null;
      continue;
    }
    let a = (lo - from[i]) / delta;
    let b = (hi - from[i]) / delta;
    if (a > b) [a, b] = [b, a];
    if (a > enter) enter = a;
    if (b < exit) exit = b;
    if (enter > exit) return null;
  }
  return [t0 + enter * (t1 - t0), t0 + exit * (t1 - t0)];
}

const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * A complete accepted path for the tick that ends where the timer looked (`end`, crouched `crouched`): contiguous
 * segments covering phases 0..1, finite, at most 32. Anything else (an unsupported solver branch, a reset, an absent
 * observation) is null and the crossing falls back to the straight trace.
 */
export function completePath(path: TimingPath | null, end: readonly number[], crouched: boolean): TimingSegment[] | null {
  if (!path || path.unsupported || !Array.isArray(path.segments)) return null;
  const segs = path.segments;
  if (segs.length < 1 || segs.length > 32) return null;
  let phase = 0;
  let prev: TimingSegment | null = null;
  for (const s of segs) {
    const nums = [s.t0, s.t1, ...s.from, ...s.to, ...s.mins, ...s.maxs];
    if (nums.length !== 14 || !nums.every(Number.isFinite)) return null;
    if (s.t0 !== phase || s.t1 < s.t0 || s.t1 > 1 || (s.discrete && s.t0 !== s.t1)) return null;
    if (prev && !same(prev.to, s.from)) return null;
    phase = s.t1;
    prev = s;
  }
  const last = segs[segs.length - 1];
  if (phase !== 1 || !same(last.to, end) || segmentCrouched(last) !== crouched) return null;
  return segs;
}

interface Movement {
  /** Accepted path segments, or null for the straight trace. */
  path: TimingSegment[] | null;
  /** Feet position before the tick's move (straight trace start), null if unknown. */
  from: readonly number[] | null;
  /** Where the timer tested the zones after the move (the touch position) and the crouch state there. */
  to: readonly number[];
  crouched: boolean;
}

/** Overlap intervals of the tick's movement with zone `z`, each [enter, exit] in tick phase. */
function overlaps(m: Movement, z: Zone): [number, number][] | null {
  if (m.path) {
    const out: [number, number][] = [];
    for (const s of m.path) {
      const hit = sweep(s.from, s.to, s.t0, s.t1, !!s.discrete, segmentCrouched(s), z);
      if (hit) out.push(hit);
    }
    return out;
  }
  if (!m.from) return null;
  const hit = sweep(m.from, m.to, 0, 1, false, m.crouched, z);
  return hit ? [hit] : [];
}

/**
 * Finish: the first phase of the tick at which the box touched one of `zones` that contains the end point (a zone only
 * passed through during the tick isn't the one the timer finished in). Falls back to 1, the end of the tick.
 */
export function entryCrossing(m: Movement, zones: readonly Zone[]): Crossing {
  let best: number | null = null;
  let measured = false;
  for (const z of zones) {
    if (!playerInZone(m.to, m.crouched, z)) continue;
    const hits = overlaps(m, z);
    if (!hits) continue;
    measured = true;
    for (const [a] of hits) if (best === null || a < best) best = a;
  }
  if (best === null) return { fraction: FRACTION_UNITS, method: measured ? "boundary" : "fallback" };
  return { fraction: quantizePhase(best), method: m.path ? "path" : "chord" };
}

/**
 * Start (walk-out): the last phase of the tick at which the box touched any of `zones`. Falls back to 0, the start of
 * the tick (the old timer's start, never faster).
 */
export function exitCrossing(m: Movement, zones: readonly Zone[]): Crossing {
  let best: number | null = null;
  let measured = false;
  for (const z of zones) {
    const hits = overlaps(m, z);
    if (!hits) continue;
    measured = true;
    for (const [, b] of hits) if (best === null || b > best) best = b;
  }
  if (best === null) return { fraction: 0, method: measured ? "boundary" : "fallback" };
  return { fraction: quantizePhase(best), method: m.path ? "path" : "chord" };
}

export function movement(path: TimingPath | null, from: readonly number[] | null, to: readonly number[], crouched: boolean): Movement {
  return { path: completePath(path, to, crouched), from, to, crouched };
}

/** What a finished run's sub-tick timing was measured from (runs.timing_detail; diagnostics only). */
export interface RunTiming {
  policy: number;
  startTick: number;
  endTick: number;
  start: Crossing;
  end: Crossing;
  /** Duration in phase units, and rounded to milliseconds (the score). */
  units: number;
  ms: number;
}

/** Compact JSON for runs.timing_detail: start / end as [phase in millionths of a tick, method], duration in units. */
export function timingDetailJson(t: RunTiming): string {
  return JSON.stringify({ p: t.policy, s: [t.startTick, t.start.fraction, t.start.method], e: [t.endTick, t.end.fraction, t.end.method], u: t.units });
}
