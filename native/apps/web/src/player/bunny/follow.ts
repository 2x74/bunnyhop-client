// The bunny's follow-through (v0.0.42; player/bunny/model.ts): the upper body answering what the legs do, on top of
// the CS:S animations, which hold the chest and arms rigid through a hop.
//
//   load      one damped spring fed by upward jolts of the body's vertical speed (a jump, a bhop's bounce, a landing,
//             a booster). It peaks ~80 ms after the jolt (1 at a bhop's bounce, about half that for a standing jump or
//             a plain landing) and swings back through a fifth of that the other way before it rests: the chest nods
//             forward and comes back a little past upright, the arms sink and float back up, the head keeps most of
//             its place. Gravity and other smooth accelerations feed nothing.
//   breath    standing still, a slow breath: the chest rises and tips back a fraction of a degree, the head stays.
//             On the visual clock with the model's seed: the same in every replay, never in step between bunnies.
//
// Presentation only; the spring is stepped exactly in dt (viewmodel/feel.ts springStep), so 60 and 240 fps agree.
// Reduced motion scales both (feel.ts motionScale). No allocation per frame.

import { motionScale, springStep } from "../../viewmodel/feel";
import { type Rig } from "./rig";
import { turnLevel } from "./posture";

export const FOLLOW = {
  /** The spring: angular frequency (1/s), damping ratio, and the load's speed per u/s of jolt (604 u/s, a bhop's bounce, peaks at 1). */
  omega: 16,
  zeta: 0.45,
  gain: 0.0462,
  /** Upward acceleration below this (u/s^2) is not a jolt (lifts, ladders, water). */
  smooth: 1500,
  /** Most the load reaches (a hard landing). */
  max: 1.6,
  /** Degrees at load 1: the chest forward, the arms down at the shoulders, and the share of the nod the head gives back. */
  chest: 4.5,
  arms: 8,
  head: 0.6,
  /** The breath: period (s), the chest's tip back (deg) and rise (units) at its top. */
  breathPeriod: 3.6,
  breathTip: 0.7,
  breathRise: 0.14,
};

const X = new Float64Array(1), V = new Float64Array(1);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class FollowThrough {
  /** Debug / tests: the load now (+ = compressed), and the breath (-1..1, 0 when moving). */
  load = 0;
  breath = 0;

  private vel = 0;
  private vz = NaN;
  private onW = 0;
  private idleW = 0;
  private spine1: number;
  private spine2: number;
  private head: number;
  private sub1: number[];
  private sub2: number[];
  private subHead: number[];
  private arms: { bone: number; sub: number[] }[];

  constructor(private r: Rig, private seed = 0) {
    const sub = (root: number) => {
      const out = [root];
      for (let i = root + 1; i < r.csBones; i++) if (out.includes(r.parent[i])) out.push(i);
      return out;
    };
    this.spine1 = r.bone("Spine1");
    this.spine2 = r.bone("Spine2");
    this.head = r.bone("Head1");
    this.sub1 = sub(this.spine1);
    this.sub2 = sub(this.spine2);
    this.subHead = sub(this.head);
    this.arms = ["L_UpperArm", "R_UpperArm"].map((n) => ({ bone: r.bone(n), sub: sub(r.bone(n)) }));
  }

  /** `vz`: the body's vertical speed (u/s); `time`: the visual clock (s). */
  update(dt: number, snap: boolean, on: boolean, vz: number, grounded: boolean, speed: number, time: number): void {
    if (snap || dt <= 0 || Number.isNaN(this.vz)) {
      this.vz = vz;
      if (snap) (this.load = this.vel = 0), (this.onW = on ? 1 : 0), (this.idleW = grounded && speed < 40 ? 1 : 0);
    } else {
      // The spring over the step, then the jolt (the speed sampled now is the state at this frame's time).
      const jolt = Math.max(0, vz - this.vz - FOLLOW.smooth * dt);
      this.vz = vz;
      (X[0] = this.load), (V[0] = this.vel);
      springStep(X, V, 0, 0, FOLLOW.omega, FOLLOW.zeta, dt);
      (this.load = clamp(X[0], -FOLLOW.max, FOLLOW.max)), (this.vel = V[0] + jolt * FOLLOW.gain);
      this.onW += ((on ? 1 : 0) - this.onW) * (1 - Math.exp(-4 * dt));
      this.idleW += ((grounded && speed < 40 ? 1 : 0) - this.idleW) * (1 - Math.exp(-(grounded && speed < 40 ? 1.5 : 8) * dt));
    }
    this.breath = this.idleW * Math.sin((time / FOLLOW.breathPeriod + this.seed) * Math.PI * 2);
  }

  /** Applies both to the skinning matrices S (model space: z up). */
  apply(S: Float32Array): void {
    const k = this.onW * motionScale();
    const load = this.load * k, breath = this.breath * k;
    if (Math.abs(load) < 1e-4 && Math.abs(breath) < 1e-4) return;
    // The level axis across the chest (posture.ts): a positive turn raises the chest's forward.
    const o = this.spine2 * 12;
    const fx = -S[o + 1], fy = -S[o + 5];
    const fh = Math.hypot(fx, fy);
    if (fh < 1e-4) return;
    const ax = fy / fh, ay = -fx / fh, r = this.r;
    const nod = -load * FOLLOW.chest + breath * FOLLOW.breathTip;
    turnLevel(S, r, this.sub1, this.spine1, ax, ay, nod);
    if (load) for (const a of this.arms) turnLevel(S, r, a.sub, a.bone, ax, ay, -load * FOLLOW.arms);
    // The head gives most of the nod back (the eyes stay on the route), and all of the breath's tip.
    turnLevel(S, r, this.subHead, this.head, ax, ay, load * FOLLOW.chest * FOLLOW.head - breath * FOLLOW.breathTip);
    if (breath) {
      const rise = breath * FOLLOW.breathRise;
      for (const i of this.sub2) S[i * 12 + 11] += rise;
    }
  }
}
