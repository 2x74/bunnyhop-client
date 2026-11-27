// A verified run's speed and gain summary, for the leaderboards' stats card (apps/api src/run-stats.ts, migration 0110):
// start speed, top speed, average speed and mean gain. Collected by the verifier while it re-simulates the replay
// (apps/api src/verify.ts passes `record` as part of simulate's onTick): no second pass over the run.
//
// The definitions are the replay viewer's, so the card and the viewer's Stats panel agree for the same run:
//   speed    horizontal speed after each tick, as viewer/player.ts RunData.speed (the panel's speed line);
//            start = at the tick the timer started, top and average = over the timed ticks (start to finish);
//   gain     the game's own jump stats (!ssj "every jump", ssj/stats.ts) fed tick by tick the way viewer/replay-ssj.ts
//            feeds them, then the mean over the timed jumps that have a gain: h2h/jumps.ts jumpRows + meanGain, the
//            number viewer/h2h-panel.ts prints.
// DOM-free and binding-free. Nothing here is evidence: the anticheat never reads it (it has its own measurements).

import { EVENT_JUMPED, type PlayerState } from "./core";
import type { SimTickContext } from "./sim";
import { SsjTracker } from "./ssj/stats";

export interface RunSummary {
  /** Horizontal speed (u/s) at the tick the timer started. */
  startSpeed: number;
  /** Highest and mean horizontal speed over the timed ticks. */
  topSpeed: number;
  avgSpeed: number;
  /** Mean gain (%) over the timed jumps that have one; null when none does. */
  gain: number | null;
}

/** Bytes this keeps per replay tick (the speed after each tick), for the verifier's memory estimate; 0 with `velocity`. */
export const SUMMARY_BYTES_PER_TICK = 4;

/**
 * The horizontal velocity after each tick, recorded by someone else in the same pass (the API's input-analysis trace,
 * apps/api src/input-analysis.ts InputTrace: float32, ticks 1..totalTicks), so the summary needn't keep its own speeds.
 */
export interface VelocityTrace {
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

export class RunSummaryTrace {
  /** Speed after each tick (float32), or null: read from `velocity`. */
  private readonly speed: Float32Array | null;
  private readonly tracker = new SsjTracker("every");
  // The timed-run gain needs each jump's tick and gain only (not its whole report): parallel arrays, no object a jump.
  private readonly jumpTicks: number[] = [];
  private readonly jumpGains: (number | null)[] = [];
  // The state before the tick being recorded: the spawn (standing still on the ground) before the first.
  private readonly pre = { position: [0, 0, 0], velocity: [0, 0, 0], grounded: true, onLadder: false };
  private preStart = false;
  private preRunning = false;
  private preTicks = 0;
  private first = true;
  private readonly cmd = { forward: 0, side: 0, yaw: 0, buttons: 0 };
  // (One object for every tick's timer facts: nothing is allocated per tick.)
  private readonly at: { jumped: boolean; inStart: boolean; time: number | null } = { jumped: false, inStart: false, time: null };

  /**
   * `totalTicks`: the replay's command count (its header's). `interval`: the canonical tick interval (s). `velocity`: the
   * same run's velocity trace, recorded in the same onTick pass (the speeds are then computed from it on read, the same
   * float32 values: 4 bytes a tick less for the verifier).
   */
  constructor(totalTicks: number, private readonly interval: number, private readonly velocity: VelocityTrace | null = null) {
    this.speed = velocity ? null : new Float32Array(Math.max(0, totalTicks) + 1);
    this.ticks = Math.max(0, totalTicks) + 1;
  }

  /** Ticks with a speed slot (0..totalTicks). */
  private readonly ticks: number;

  /** The speed after `t` (1 <= t <= totalTicks when read from `velocity`). */
  private speedAt(t: number): number {
    if (this.speed) return this.speed[t];
    const { vx, vy } = this.velocity!;
    return Math.fround(Math.sqrt(vx[t] * vx[t] + vy[t] * vy[t]));
  }

  /** simulate's onTick. */
  readonly record = (tick: number, s: PlayerState, events: number, ctx: SimTickContext): void => {
    if (this.speed && tick >= 0 && tick < this.speed.length) this.speed[tick] = Math.sqrt(s.velocity[0] * s.velocity[0] + s.velocity[1] * s.velocity[1]);
    const pre = this.pre;
    if (this.first) {
      // (The spawn's position isn't given to onTick: where the first tick ended is as good for the tracker, which
      // samples velocities.)
      for (let a = 0; a < 3; a++) pre.position[a] = s.position[a];
      this.first = false;
    }
    const c = this.cmd;
    c.forward = ctx.cmd.forward;
    c.side = ctx.cmd.side;
    c.yaw = ctx.cmd.yaw;
    c.buttons = ctx.cmd.buttons;
    const at = this.at;
    at.jumped = (events & EVENT_JUMPED) !== 0;
    at.inStart = this.preStart;
    at.time = this.preRunning ? this.preTicks * this.interval : null;
    const r = this.tracker.tick(pre, c, at);
    if (r) (this.jumpTicks.push(tick), this.jumpGains.push(r.gain));
    for (let a = 0; a < 3; a++) (pre.position[a] = s.position[a]), (pre.velocity[a] = s.velocity[a]);
    pre.grounded = s.grounded;
    pre.onLadder = !!s.onLadder;
    this.preStart = ctx.timer.inStart;
    this.preRunning = ctx.timer.status === "running";
    this.preTicks = ctx.timer.ticks();
  };

  /** The summary of the timed run `startTick`..`endTick` (the verifier's result), or null for a run that never finished. */
  summary(startTick: number, endTick: number): RunSummary | null {
    if (!startTick || endTick <= startTick || endTick >= this.ticks) return null;
    let top = 0;
    let sum = 0;
    for (let t = startTick; t <= endTick; t++) {
      const v = this.speedAt(t);
      if (v > top) top = v;
      sum += v;
    }
    let gain = 0;
    let gains = 0;
    for (let k = 0; k < this.jumpTicks.length; k++) {
      const g = this.jumpGains[k];
      if (this.jumpTicks[k] >= startTick && this.jumpTicks[k] <= endTick && g !== null) (gain += g), gains++;
    }
    return { startSpeed: this.speedAt(startTick), topSpeed: top, avgSpeed: sum / (endTick - startTick + 1), gain: gains ? gain / gains : null };
  }
}
