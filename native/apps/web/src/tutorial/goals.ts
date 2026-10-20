// Lesson goals and the strafe meter, from sim state only (DOM-free). The client feeds every simulated tick (the
// exact command the core stepped, the pre- and post-tick player state, the step's events); tools/tutorial/demos.ts
// feeds the demo bot's ticks through the same code to prove each lesson can be completed.

import type { LessonGeometry, LessonId } from "./data";
import { inBox } from "./data";

export const EVENT_TELEPORTED = 1 << 0;
export const EVENT_JUMPED = 1 << 1;

/** CS:S air control: the wish speed is capped at 30 u/s in the air (PM_AirAccelerate). */
export const AIR_CAP = 30;

export interface TickCmd {
  forward: number;
  side: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export interface TickState {
  position: readonly number[];
  velocity: readonly number[];
  grounded: boolean;
}

export interface TickInfo {
  cmd: TickCmd;
  pre: TickState;
  post: TickState;
  events: number;
}

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const hspeed = (v: readonly number[]) => Math.hypot(v[0], v[1]);

/**
 * Per-tick strafe numbers for the guide and the goals:
 *  - key: -1 = left (A), +1 = right (D), 0 = none; turn: yaw change this tick (degrees, + = left)
 *  - angle: between the horizontal velocity and the wish direction (degrees); 90 is the most gain per tick,
 *    90 - asin(30 / speed) .. 90 + asin(30 / speed) still gains, below that the mouse is too slow, above it too fast
 *  - gain: horizontal speed change this tick (air only); sync: % of turning air ticks whose key pushes the way the
 *    mouse turns (the timer's definition); hop chain and speed gained per hop
 */
export class StrafeMeter {
  airborne = false;
  speed = 0;
  key: -1 | 0 | 1 = 0;
  turn = 0;
  /** Smoothed turn rate (degrees per second, + = left). */
  turnRate = 0;
  angle = 90;
  /** The same angle, + when the wish direction is left of the velocity (A side), - when right. */
  signedAngle = 0;
  /** Edge of the gain band either side of 90 degrees: asin(30 / speed). */
  edge = 90;
  /** Holding forward / back in the air (costs speed while strafing). */
  forwardInAir = false;
  /** Signed position in the gain band: 0 = perfect (90 degrees), -1 / +1 = the band's edges, beyond = no gain. */
  band = 0;
  gain = 0;
  syncGood = 0;
  syncTotal = 0;
  /** Consecutive hops landed and jumped within `tolerance` ground ticks. */
  chain = 0;
  bestChain = 0;
  /** Speed gained between the last two jumps (u/s), null before the second. */
  hopGain: number | null = null;
  lastHopSpeed: number | null = null;
  jumps = 0;
  /** Times a hop chain broke (landed and stayed on the ground). */
  breaks = 0;
  /** Ticks on the ground since the last landing. */
  groundTicks = 0;
  grounded = true;
  private prevYaw = NaN;

  constructor(public tolerance = 2) {}

  reset(): void {
    this.prevYaw = NaN;
    this.groundTicks = 0;
    this.chain = 0;
    this.hopGain = null;
    this.lastHopSpeed = null;
    this.syncGood = this.syncTotal = 0;
    this.turnRate = 0;
  }

  get sync(): number {
    return this.syncTotal ? (100 * this.syncGood) / this.syncTotal : 0;
  }

  update(t: TickInfo): void {
    const { cmd, pre, post, events } = t;
    if (events & EVENT_TELEPORTED) {
      this.reset();
      this.prevYaw = cmd.yaw;
      this.speed = hspeed(post.velocity);
      return;
    }
    this.speed = hspeed(post.velocity);
    this.airborne = !pre.grounded && !post.grounded;
    this.key = cmd.side < 0 ? -1 : cmd.side > 0 ? 1 : 0;
    this.turn = this.prevYaw === this.prevYaw ? wrap(cmd.yaw - this.prevYaw) : 0;
    this.prevYaw = cmd.yaw;
    this.turnRate += (this.turn * 100 - this.turnRate) * 0.15;
    // Wish direction (Source: forward = (cos, sin), right = (sin, -cos), sidemove > 0 = right).
    const yr = (cmd.yaw * Math.PI) / 180;
    const wx = cmd.forward * Math.cos(yr) + cmd.side * Math.sin(yr);
    const wy = cmd.forward * Math.sin(yr) - cmd.side * Math.cos(yr);
    const wl = Math.hypot(wx, wy);
    const v = pre.velocity;
    const vl = hspeed(v);
    if (wl > 0 && vl > 1) {
      const p = (v[0] * wx + v[1] * wy) / wl; // dot(velocity, wishdir)
      this.angle = (Math.acos(Math.max(-1, Math.min(1, p / vl))) * 180) / Math.PI;
      const edge = (Math.asin(Math.min(1, AIR_CAP / vl)) * 180) / Math.PI;
      this.edge = edge;
      this.band = (this.angle - 90) / edge;
      this.signedAngle = v[0] * wy - v[1] * wx >= 0 ? this.angle : -this.angle;
    } else {
      this.angle = 90;
      this.band = Number.NaN;
    }
    this.gain = this.airborne ? this.speed - vl : 0;
    this.forwardInAir = this.airborne && cmd.forward !== 0;
    if (this.airborne && this.turn !== 0 && wl > 0) {
      this.syncTotal++;
      const cross = v[0] * wy - v[1] * wx; // > 0: wish is left of travel
      if ((this.turn > 0 && cross > 0) || (this.turn < 0 && cross < 0)) this.syncGood++;
    }
    // Hops in a row: each jump within `tolerance` ground ticks of landing continues the chain.
    this.grounded = post.grounded;
    if (post.grounded) this.groundTicks++;
    if (events & EVENT_JUMPED) {
      this.chain = this.groundTicks <= this.tolerance || this.chain === 0 ? this.chain + 1 : 1;
      this.bestChain = Math.max(this.bestChain, this.chain);
      this.jumps++;
      const s = hspeed(pre.velocity);
      this.hopGain = this.lastHopSpeed === null ? null : s - this.lastHopSpeed;
      this.lastHopSpeed = s;
      this.groundTicks = 0;
    } else if (this.groundTicks > Math.max(this.tolerance, 8)) {
      if (this.chain > 0) this.breaks++;
      this.chain = 0;
      this.lastHopSpeed = null;
      this.hopGain = null;
    }
  }
}

export interface Goal {
  id: string;
  value: number;
  target: number;
  /** Lower is better (a time goal). */
  lower?: boolean;
  done: boolean;
}

/** Air ticks of each strafe (key + mouse the same way, gaining speed) that lesson 2 asks for. */
export const STRAFE_TICKS = 80;
/** Lesson 3's goal (u/s). The gates (300 / 400 / 500) light up as you reach their speed. */
export const SPEED_GOAL = 400;

/**
 * One lesson's goal. Every lesson has one thing to do; lesson 2 does it twice (left, then right), so it has two
 * steps. Progress is the best this visit. The final course also has the gold time (optional, lower is better).
 */
export class LessonGoals {
  readonly goals: Goal[];
  /** Lesson 3: which gates' speeds have been reached this visit. */
  readonly gatesLit: boolean[];
  private leftTicks = 0;
  private rightTicks = 0;
  private finishedAt: number | null = null;

  constructor(
    readonly lesson: LessonGeometry,
    opts: { goldSeconds?: number } = {},
  ) {
    const g = (id: string, target: number, lower = false): Goal => ({ id, value: lower ? Infinity : 0, target, lower, done: false });
    const by: Record<LessonId, Goal[]> = {
      jump: [g("hops", 5)],
      strafe: [g("left", STRAFE_TICKS), g("right", STRAFE_TICKS)],
      speed: [g("speed", SPEED_GOAL)],
      final: [g("finish", 1), g("gold", opts.goldSeconds ?? 20, true)],
    };
    this.goals = by[lesson.id];
    this.gatesLit = (lesson.gates ?? []).map(() => false);
  }

  get done(): boolean {
    return this.goals.every((g) => g.done || g.lower);
  }

  /** The step being worked on (lesson 2: "left" then "right"), or null when done. */
  get current(): Goal | null {
    return this.goals.find((g) => !g.done && !g.lower) ?? null;
  }

  private set(id: string, value: number): void {
    const goal = this.goals.find((x) => x.id === id);
    if (!goal) return;
    goal.value = goal.lower ? Math.min(goal.value, value) : Math.max(goal.value, value);
    goal.done = goal.lower ? goal.value <= goal.target : goal.value >= goal.target;
  }

  /** The final course's timer finished (seconds), from the run timer. */
  finish(seconds: number): void {
    this.finishedAt = seconds;
    this.set("finish", 1);
    this.set("gold", seconds);
  }

  /** Steps one tick. Returns the index of a gate lit this tick (lesson 3), else -1. */
  update(t: TickInfo, m: StrafeMeter): number {
    const L = this.lesson;
    const p = t.post.position;
    let lit = -1;
    switch (L.id) {
      case "jump":
        this.set("hops", m.bestChain);
        break;
      case "strafe": {
        if (m.airborne && m.gain > 0) {
          // Left first, then right (a right strafe before the left one is done still counts).
          if (m.key < 0 && m.turn > 0) this.leftTicks++;
          if (m.key > 0 && m.turn < 0) this.rightTicks++;
        }
        this.set("left", this.leftTicks);
        this.set("right", this.rightTicks);
        break;
      }
      case "speed": {
        this.set("speed", Math.floor(m.speed));
        (L.gates ?? []).forEach((g, i) => {
          if (!this.gatesLit[i] && m.speed >= g.speed) {
            this.gatesLit[i] = true;
            lit = i;
          }
        });
        break;
      }
      case "final":
        // Without a timer (the demo bot), the finish box counts.
        if (this.finishedAt === null && L.checkpoints?.[0] && inBox(p, L.checkpoints[0])) this.set("finish", 1);
        break;
    }
    return lit;
  }
}
