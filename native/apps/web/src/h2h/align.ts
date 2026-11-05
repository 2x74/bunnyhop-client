// Head to head (/h2h/<a>/<b>): two runs of one map on one clock. DOM-free, tested under bun (apps/web/test/h2h.test.ts).
//
// The viewer's display time is run A's tick (the primary, the left view). Both timers start together: run B's tick at
// A's tick t is B.startTick + (t - A.startTick) * A.interval / B.interval. The shared timeline runs until the later of
// the two replays ends, so the slower run can finish on screen.
//
// Time gap: the viewer's compare ghost measure (viewer.ts setCompare, ghost.ts split): for each of A's ticks, where on
// B's route A is (closest-pos.ts, the search that stays near the last match), and A's run time minus B's run time at
// that point. Negative: A got there first (A is ahead). After A finishes it holds the final difference.

import { ClosestPos } from "../closest-pos";
import { EVENT_JUMPED, EVENT_TELEPORTED } from "../core";
import { FRAME_STRIDE } from "../sim";

/** RunData bits (viewer/player.ts F_*), repeated here so this file needs no viewer import. */
const F_CROUCHED = 1;
const F_GROUNDED = 2;
const F_LADDER = 64;
const F_TELEPORTED = 4;
const F_JUMPED = 8;

/** What the clock needs of a run (viewer/player.ts RunData fits). */
export interface RunClock {
  /** Ticks the timer started / finished (0: never). */
  startTick: number;
  endTick: number;
  /** Last tick of the replay. */
  n: number;
  /** Seconds per tick. */
  interval: number;
}

/** What the time gap needs of a run (RunData fits). */
export interface RunPath extends RunClock {
  pos: Float32Array;
  view: Float32Array;
  flags: Uint8Array;
  speed: Float32Array;
}

/** Run B's (fractional) tick at run A's tick t, both timers started together. Not clamped. */
export function partnerTick(a: RunClock, b: RunClock, t: number): number {
  return b.startTick + ((t - a.startTick) * a.interval) / b.interval;
}

/** Run A's tick at run B's tick u (the inverse of partnerTick). */
export function primaryTick(a: RunClock, b: RunClock, u: number): number {
  return a.startTick + ((u - b.startTick) * b.interval) / a.interval;
}

/** The last display tick (A's clock): A's last tick or B's, whichever comes later. */
export function sharedEnd(a: RunClock, b: RunClock): number {
  return Math.max(a.n, Math.ceil(primaryTick(a, b, b.n)));
}

/** Run time of a finished run (s), else null. */
export function runSeconds(r: RunClock): number | null {
  return r.startTick && r.endTick ? (r.endTick - r.startTick) * r.interval : null;
}

/** Final difference, A minus B (s; negative: A is faster). Null unless both finished. */
export function finalGap(a: RunClock, b: RunClock): number | null {
  const ta = runSeconds(a);
  const tb = runSeconds(b);
  return ta === null || tb === null ? null : ta - tb;
}

/**
 * Ghost frames (sim.ts FRAME_STRIDE layout) and frame events from a run's cached ticks, so a run already loaded in the
 * viewer can be shown as a ghost without simulating it again.
 */
export function runFrames(d: Pick<RunPath, "n" | "pos" | "view" | "flags">): { frames: Float32Array; events: Uint8Array } {
  const frames = new Float32Array((d.n + 1) * FRAME_STRIDE);
  const events = new Uint8Array(d.n + 1);
  for (let t = 0; t <= d.n; t++) {
    const o = t * FRAME_STRIDE;
    frames[o] = d.pos[t * 3];
    frames[o + 1] = d.pos[t * 3 + 1];
    frames[o + 2] = d.pos[t * 3 + 2];
    frames[o + 3] = d.flags[t] & (F_CROUCHED | F_GROUNDED | F_LADDER); // FRAME_CROUCHED / _GROUNDED / _LADDER are the same bits
    frames[o + 4] = d.view[t * 2];
    frames[o + 5] = d.view[t * 2 + 1];
    events[t] = (d.flags[t] & F_TELEPORTED ? EVENT_TELEPORTED : 0) | (d.flags[t] & F_JUMPED ? EVENT_JUMPED : 0);
  }
  return { frames, events };
}

export interface GapSeries {
  /** A-tick-indexed time gap (s; negative: A ahead), NaN before A's start. */
  delta: Float32Array;
  /** A-tick-indexed speed difference, A minus B at the matched point (u/s), NaN where there is none. */
  speedDiff: Float32Array;
  /** Final difference when both finished (s), else null. */
  final: number | null;
}

/** The time gap and speed difference of run A against run B, per A tick (see the header). */
export function gapSeries(a: RunPath, b: RunPath, bFrames = runFrames(b)): GapSeries {
  const delta = new Float32Array(a.n + 1).fill(NaN);
  const speedDiff = new Float32Array(a.n + 1).fill(NaN);
  const final = finalGap(a, b);
  if (!a.startTick || !b.startTick) return { delta, speedDiff, final };
  const search = new ClosestPos(bFrames.frames, b.startTick, b.endTick || b.n, b.interval, bFrames.events);
  search.build();
  const end = a.endTick || a.n;
  let last = NaN;
  for (let i = a.startTick; i <= end; i++) {
    const x = a.pos[i * 3];
    const y = a.pos[i * 3 + 1];
    const z = a.pos[i * 3 + 2];
    if (search.find(x, y, z)) {
      last = (i - a.startTick) * a.interval - (search.tick - b.startTick) * b.interval;
      if (i > a.startTick && !(a.flags[i] & F_TELEPORTED) && Number.isFinite(search.speed)) speedDiff[i] = a.speed[i] - search.speed;
    }
    delta[i] = last;
  }
  if (a.endTick && final !== null) for (let i = a.endTick; i <= a.n; i++) delta[i] = final;
  return { delta, speedDiff, final };
}

/** A series sampled on the shared run clock: `count` points from run time 0 to `seconds`, NaN outside the run. */
export function onRunClock(r: RunClock, values: ArrayLike<number>, seconds: number, count: number): Float32Array {
  const out = new Float32Array(count).fill(NaN);
  if (!r.startTick) return out;
  const end = r.endTick || r.n;
  for (let k = 0; k < count; k++) {
    const t = r.startTick + ((k / Math.max(1, count - 1)) * seconds) / r.interval;
    if (t > end + 1e-3) break;
    const i = Math.min(values.length - 1, Math.floor(t));
    const f = t - i;
    const v0 = values[i];
    const v1 = values[Math.min(values.length - 1, i + 1)];
    out[k] = Number.isFinite(v1) ? v0 + (v1 - v0) * f : v0;
  }
  return out;
}
