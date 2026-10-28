// Replay playback on the viewer's own physics-only sim instance (never the live game's core).
//
// Opening a replay runs ONE full re-simulation through sim.ts simulate() (so the style filter, timer, prespeed
// clamp and checkpoints are exactly what the verifier uses) and caches every tick: position, velocity, view angles,
// stepped command, events, and the timer-derived HUD values. Rendering, the HUD, the timeline and the MP4 export
// all read that cache, so they can show any fractional time without stepping anything.
//
// The core itself is only needed for what isn't cached (brush entity origins: doors, bhop blocks, platforms) and for
// camera collision traces against the world as it is at that tick. It is kept in sync with the displayed tick:
// forward by stepping (sim.ts replayStep, the same code simulate() runs), anywhere else by restoring the nearest
// keyframe — a full sim snapshot (core state_snapshot: player, entities, triggers, I/O queue) plus clones of the
// JS-side timer and style filter — and stepping at most one keyframe interval. Restore + step is bit-exact
// (crates/core/tests/snapshot.rs); every stepped tick is also checked against the cache.

import { freeState, hasStateSnapshots, restoreState, snapshotBytes, snapshotState, type Core, type PlayerState } from "../core";
import { EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED, type BrushTransform } from "../core";
import type { Replay } from "../replay";
import { replayStep, simulate } from "../sim";
import type { StyleFilter } from "../styles";
import type { RunTimer, Split } from "../timer";

export const F_CROUCHED = 1;
export const F_GROUNDED = 2;
export const F_TELEPORTED = 4;
export const F_JUMPED = 8;
export const F_LANDED = 16;
export const F_RESTARTED = 32;
/** On a ladder after the tick (jump stats skip ladder ticks, ssj/stats.ts). */
export const F_LADDER = 64;

export const STATUS_IDLE = 0;
export const STATUS_RUNNING = 1;
export const STATUS_FINISHED = 2;

/** Everything the viewer shows, per tick t = 0..n (t = 0: after reset/spawn; t: after command t - 1). */
export interface RunData {
  replay: Replay;
  n: number;
  /** Canonical (f32) tick interval and rate. */
  interval: number;
  tickrate: number;
  pos: Float32Array;
  vel: Float32Array;
  viewZ: Float32Array;
  /** Stepped command's yaw/pitch (row 0: the first command's, like simulate frames). */
  view: Float32Array;
  flags: Uint8Array;
  /** Stepped (style-filtered) command that produced tick t (row 0: zeros). */
  buttons: Uint16Array;
  forward: Int16Array;
  side: Int16Array;
  /** Horizontal speed. */
  speed: Float32Array;
  status: Uint8Array;
  runTicks: Int32Array;
  /** A finished run's time in whole milliseconds (run-timing.ts, what the boards show), 0 while not finished. */
  finishMs: Int32Array;
  jumps: Uint16Array;
  strafes: Uint16Array;
  sync: Float32Array;
  perf: Float32Array;
  perfectTick: Int32Array;
  track: Uint8Array;
  inStart: Uint8Array;
  splitCount: Uint8Array;
  /** Ticks of every jump (all, idle included), splits of the final run, timer starts/restarts. */
  jumpTicks: number[];
  splits: (Split & { tick: number })[];
  starts: number[];
  /** Final run (as simulate reports it): start / end tick (0 = never / unfinished) and track. */
  startTick: number;
  endTick: number;
  runTrack: number;
  maxSpeed: number;
  desyncTick: number | null;
  styleViolations: number;
}

interface Keyframe {
  tick: number;
  handle: number;
  timer: RunTimer;
  filter: StyleFilter;
  state: PlayerState;
}

/** Shallow class clone (RunTimer / StyleFilter only hold plain fields; splits are copied). */
function cloneObj<T extends object>(o: T): T {
  const c = Object.assign(Object.create(Object.getPrototypeOf(o)) as T, o);
  const s = (c as unknown as { splits?: Split[] }).splits;
  if (Array.isArray(s)) (c as unknown as { splits: Split[] }).splits = s.map((x) => ({ ...x }));
  return c;
}

/** Keyframes every second; thinned (doubling the interval) if their memory exceeds the budget. */
const KEYFRAME_TICKS = 100;
const KEYFRAME_BUDGET = 160 << 20;

export class ReplayPlayer {
  readonly data: RunData;
  private keyframes: Keyframe[] = [];
  /** Core tick (the core's state is "after tick cur"); -1 = unknown (core used for something else). */
  private cur = -1;
  private timer!: RunTimer;
  private filter!: StyleFilter;
  private pre!: PlayerState;
  private warned = false;
  /** ms the initial pass took, and the keyframe interval in use (diagnostics). */
  readonly stats = { prepassMs: 0, keyframeTicks: KEYFRAME_TICKS, keyframes: 0, keyframeBytes: 0, lastSeekMs: 0 };

  constructor(
    readonly core: Core,
    readonly replay: Replay,
  ) {
    const t0 = performance.now();
    const h = replay.header;
    const n = h.totalTicks;
    const interval = Math.fround(h.settings.tickInterval);
    const d: RunData = {
      replay,
      n,
      interval,
      tickrate: Math.round(1 / interval),
      pos: new Float32Array((n + 1) * 3),
      vel: new Float32Array((n + 1) * 3),
      viewZ: new Float32Array(n + 1),
      view: new Float32Array((n + 1) * 2),
      flags: new Uint8Array(n + 1),
      buttons: new Uint16Array(n + 1),
      forward: new Int16Array(n + 1),
      side: new Int16Array(n + 1),
      speed: new Float32Array(n + 1),
      status: new Uint8Array(n + 1),
      runTicks: new Int32Array(n + 1),
      finishMs: new Int32Array(n + 1),
      jumps: new Uint16Array(n + 1),
      strafes: new Uint16Array(n + 1),
      sync: new Float32Array(n + 1),
      perf: new Float32Array(n + 1).fill(NaN),
      perfectTick: new Int32Array(n + 1).fill(-1),
      track: new Uint8Array(n + 1),
      inStart: new Uint8Array(n + 1),
      splitCount: new Uint8Array(n + 1),
      jumpTicks: [],
      splits: [],
      starts: [],
      startTick: 0,
      endTick: 0,
      runTrack: h.track ?? 0,
      maxSpeed: 0,
      desyncTick: null,
      styleViolations: 0,
    };
    this.data = d;
    const snapshots = hasStateSnapshots(core);
    let kfBytes = 0;
    const put = (t: number, s: PlayerState, events: number, timer: RunTimer | null) => {
      d.pos.set(s.position, t * 3);
      d.vel.set(s.velocity, t * 3);
      d.viewZ[t] = s.viewOffsetZ;
      const sp = Math.sqrt(s.velocity[0] * s.velocity[0] + s.velocity[1] * s.velocity[1]);
      d.speed[t] = sp;
      d.flags[t] =
        (s.crouched ? F_CROUCHED : 0) | (s.grounded ? F_GROUNDED : 0) | (events & EVENT_TELEPORTED ? F_TELEPORTED : 0) | (events & EVENT_JUMPED ? F_JUMPED : 0) | (events & EVENT_LANDED ? F_LANDED : 0) | (s.onLadder ? F_LADDER : 0);
      if (!timer) return;
      d.status[t] = timer.status === "running" ? STATUS_RUNNING : timer.status === "finished" ? STATUS_FINISHED : STATUS_IDLE;
      d.runTicks[t] = timer.ticks();
      d.finishMs[t] = timer.status === "finished" ? timer.timeMs() : 0;
      d.jumps[t] = timer.jumps;
      d.strafes[t] = timer.strafes;
      d.sync[t] = timer.syncPercent();
      d.perf[t] = timer.measuredJumps ? timer.perfPercent() : NaN;
      d.perfectTick[t] = timer.lastPerfectTick;
      d.track[t] = timer.track;
      d.inStart[t] = timer.inStart ? 1 : 0;
      d.splitCount[t] = timer.splits.length;
    };

    // Tick 0 (reset + start-zone restart point): simulate's own prologue.
    const zero = simulate(core, replay, h.zones, { untilTick: 0 });
    put(0, zero.final, 0, zero.timer);
    d.view[0] = n > 0 ? replay.yaw[0] : zero.final.teleportAngles[1];
    d.view[1] = n > 0 ? replay.pitch[0] : zero.final.teleportAngles[0];

    let runSplits: (Split & { tick: number })[] = [];
    const sim = simulate(core, replay, h.zones, {
      onTick: (t, s, events, ctx) => {
        put(t, s, events, ctx.timer);
        d.view[t * 2] = ctx.cmd.yaw;
        d.view[t * 2 + 1] = ctx.cmd.pitch;
        d.buttons[t] = ctx.cmd.buttons;
        d.forward[t] = ctx.cmd.forward;
        d.side[t] = ctx.cmd.side;
        if (d.speed[t] > d.maxSpeed) d.maxSpeed = d.speed[t];
        if (events & EVENT_JUMPED) d.jumpTicks.push(t);
        if (ctx.update.started) (d.starts.push(t), (runSplits = []));
        if (ctx.update.restarted) (d.flags[t] |= F_RESTARTED), (runSplits = []);
        if (ctx.update.split) runSplits.push({ ...ctx.update.split, tick: t });
        if (snapshots && t % KEYFRAME_TICKS === 0 && t < n) {
          const handle = snapshotState(core);
          if (handle) {
            kfBytes += snapshotBytes(core, handle);
            this.keyframes.push({ tick: t, handle, timer: cloneObj(ctx.timer), filter: cloneObj(ctx.filter), state: s });
          }
        }
      },
    });
    d.splits = runSplits;
    d.startTick = sim.startTick;
    d.endTick = sim.endTick;
    if (sim.startTick) d.runTrack = sim.track;
    d.desyncTick = sim.checkpointsMatch ? null : sim.firstMismatchTick;
    d.styleViolations = sim.styleViolations;
    this.timer = sim.timer;
    this.filter = sim.filter;
    this.pre = sim.final;
    this.cur = n;
    // Thin keyframes until they fit the memory budget.
    let every = KEYFRAME_TICKS;
    while (kfBytes > KEYFRAME_BUDGET && this.keyframes.length > 1) {
      every *= 2;
      const keep: Keyframe[] = [];
      kfBytes = 0;
      for (const k of this.keyframes) {
        if (k.tick % every === 0) (keep.push(k), (kfBytes += snapshotBytes(core, k.handle)));
        else freeState(core, k.handle);
      }
      this.keyframes = keep;
    }
    this.stats.keyframeTicks = every;
    this.stats.keyframes = this.keyframes.length;
    this.stats.keyframeBytes = kfBytes;
    this.stats.prepassMs = performance.now() - t0;
  }

  get tick(): number {
    return this.cur;
  }

  /** The core no longer holds this replay's state (it was used to simulate something else). */
  invalidate(): void {
    this.cur = -1;
  }

  /** Brings the core to "after tick t" (0..n). Cheap for small forward steps; otherwise keyframe restore + step. */
  seek(t: number): void {
    const d = this.data;
    t = Math.max(0, Math.min(d.n, Math.floor(t)));
    if (t === this.cur) return;
    const t0 = performance.now();
    const gap = this.stats.keyframeTicks;
    if (!(this.cur >= 0 && t > this.cur && t - this.cur <= gap)) {
      let kf: Keyframe | null = null;
      for (const k of this.keyframes) if (k.tick <= t) kf = k;
      if (kf && restoreState(this.core, kf.handle)) {
        this.timer = cloneObj(kf.timer);
        this.filter = cloneObj(kf.filter);
        this.pre = kf.state;
        this.cur = kf.tick;
      } else {
        // Start: simulate()'s own prologue (reset, restart point, fresh timer and filter).
        const z = simulate(this.core, this.replay, this.replay.header.zones, { untilTick: 0 });
        this.timer = z.timer;
        this.filter = z.filter;
        this.pre = z.final;
        this.cur = 0;
      }
    }
    while (this.cur < t) {
      const r = replayStep(this.core, this.timer, this.filter, this.replay, this.cur, this.pre);
      this.pre = r.state;
      this.cur++;
      if (!this.warned) {
        const o = this.cur * 3;
        const p = r.state.position;
        if (!Object.is(Math.fround(p[0]), d.pos[o]) || !Object.is(Math.fround(p[1]), d.pos[o + 1]) || !Object.is(Math.fround(p[2]), d.pos[o + 2])) {
          this.warned = true;
          console.warn(`replay viewer: playback diverged from the initial pass at tick ${this.cur}`);
        }
      }
    }
    this.stats.lastSeekMs = performance.now() - t0;
  }

  /** Brush entity model origins at the core's current tick. */
  brushOrigins(): Map<number, BrushTransform> {
    return this.core.brushOrigins();
  }

  /** Frees the keyframes (the core instance is reused for the next replay). */
  dispose(): void {
    for (const k of this.keyframes) freeState(this.core, k.handle);
    this.keyframes = [];
    this.cur = -1;
  }
}

// ---------------------------------------------------------------------------------------------
// Sampling at fractional ticks

export interface ViewSample {
  /** Fractional tick. */
  t: number;
  /** Feet position (Source). */
  pos: [number, number, number];
  vel: [number, number, number];
  /** Eye height above the feet. */
  viewZ: number;
  yaw: number;
  pitch: number;
  speed: number;
  crouched: boolean;
  grounded: boolean;
  forward: number;
  side: number;
  /** Integer tick the sample is based on (floor of t). */
  i: number;
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Interpolated state at fractional tick t (no interpolation across teleports). */
export function sampleAt(d: RunData, t: number, out?: ViewSample): ViewSample {
  t = Math.max(0, Math.min(d.n, t));
  const i = Math.min(d.n, Math.floor(t));
  const j = Math.min(d.n, i + 1);
  const a = j === i || d.flags[j] & F_TELEPORTED ? 0 : t - i;
  const s: ViewSample = out ?? { t, pos: [0, 0, 0], vel: [0, 0, 0], viewZ: 64, yaw: 0, pitch: 0, speed: 0, crouched: false, grounded: true, forward: 0, side: 0, i };
  s.t = t;
  s.i = i;
  for (let k = 0; k < 3; k++) {
    s.pos[k] = d.pos[i * 3 + k] + (d.pos[j * 3 + k] - d.pos[i * 3 + k]) * a;
    s.vel[k] = d.vel[i * 3 + k] + (d.vel[j * 3 + k] - d.vel[i * 3 + k]) * a;
  }
  s.viewZ = d.viewZ[i] + (d.viewZ[j] - d.viewZ[i]) * a;
  s.yaw = d.view[i * 2] + wrap180(d.view[j * 2] - d.view[i * 2]) * a;
  s.pitch = d.view[i * 2 + 1] + (d.view[j * 2 + 1] - d.view[i * 2 + 1]) * a;
  s.speed = d.speed[i] + (d.speed[j] - d.speed[i]) * a;
  s.crouched = (d.flags[i] & F_CROUCHED) !== 0;
  s.grounded = (d.flags[i] & F_GROUNDED) !== 0 || (d.flags[j] & F_GROUNDED) !== 0;
  s.forward = d.forward[j];
  s.side = d.side[j];
  return s;
}

/** Run timer seconds at fractional tick t (advances smoothly between ticks while running). */
/** The final run's time in seconds (milliseconds, as the boards show it), or null when it didn't finish. */
export function finalRunTime(d: RunData): number | null {
  if (!d.endTick) return null;
  return d.finishMs[d.endTick] > 0 ? d.finishMs[d.endTick] / 1000 : (d.endTick - d.startTick) * d.interval;
}

export function runTimeAt(d: RunData, t: number): number {
  const i = Math.max(0, Math.min(d.n, Math.floor(t)));
  // The running clock counts ticks; a finished run shows its millisecond time.
  if (d.status[i] === STATUS_FINISHED && d.finishMs[i] > 0) return d.finishMs[i] / 1000;
  const running = d.status[i] === STATUS_RUNNING;
  return (d.runTicks[i] + (running && i < d.n ? t - i : 0)) * d.interval;
}
