// The gun's own feel on top of the knife viewmodel's (which the gun already rides: CS:S bob while grounded, mouse lag,
// strafe tilt, crouch, landing dip, breathing): what a gun in the hands does that a knife doesn't, sized by its weight.
//   idle     a slow, uneven drift (three incommensurate periods: it never visibly loops) about the right grip
//   speed    above running speed the gun tucks in a little (back and down), as you'd hold it at a sprint
//   vertical rising off a jump the gun trails low and its muzzle dips; falling, it floats up a touch; the jump itself
//            gives it a small downward tug and a landing an extra, weight-scaled sink (the knife feel's dip is on top)
//   strafes  the gun lags against the air strafe's sideways acceleration (in view space) and rolls into it
// Everything goes through soft springs (no step, no jitter at any frame rate) and stays small: a few tenths of a unit
// and a degree or two; the crosshair doesn't move. Bob amount scales idle / speed / vertical, sway amount the strafe
// part (Settings -> Viewmodel; 0 = off), prefers-reduced-motion scales all of it down. No allocation per frame.
//
// Output: a 3x4 matrix in viewmodel space (rotation about the gun's grip, then the offset), multiplied onto the knife
// feel by the gun viewmodel; the audited pose (guns/pose.ts) never sees it.

import { angleMatrix } from "../math";
import type { GunDef } from "./types";

/** What the gun feel reads each frame (main.ts passes the knife viewmodel's ViewmodelInput). */
export interface GunMotionInput {
  /** Velocity, Source units/s (world). */
  velocity: ArrayLike<number>;
  grounded: boolean;
  /** Vertical speed of a landing since the last frame (negative, units/s), or 0. */
  landed: number;
  /** View yaw (deg). */
  yaw: number;
}

/** Weight per class (scales every response; long guns swing more, pistols less). */
const WEIGHT: Record<GunDef["cls"], number> = { pistol: 0.8, smg: 1, shotgun: 1.15, rifle: 1.15, sniper: 1.3 };
const D2R = Math.PI / 180;

const reducedMotion = (): boolean => {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === "function" && mm("(prefers-reduced-motion: reduce)").matches;
};

export class GunMotion {
  /** The output matrix (3x4, viewmodel space). */
  readonly M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  /** Bob and sway amounts (Settings -> Viewmodel), set by the viewmodel each frame. */
  bob = 1;
  sway = 1;
  private t = 0;
  // Springs: offset forward / left / up, angles pitch / yaw / roll (value, velocity).
  private x = new Float64Array(6);
  private v = new Float64Array(6);
  private wasGrounded = true;
  private lastVel = new Float64Array(3);
  private haveVel = false;
  private latAcc = 0;
  private motion = reducedMotion() ? 0.45 : 1;

  reset(): void {
    this.x.fill(0);
    this.v.fill(0);
    this.haveVel = false;
    this.latAcc = 0;
  }

  /** Advances by dt; `pivot` is the right grip in viewmodel space (rotations are about it). */
  update(dt: number, def: GunDef, input: GunMotionInput | null, pivot: ArrayLike<number>): void {
    const w = WEIGHT[def.cls] * this.motion;
    const bob = this.bob * w, sway = this.sway * w;
    this.t += dt;
    // Targets (offset fwd / left / up, pitch / yaw / roll) from the movement, before the springs.
    let tf = 0, tl = 0, tu = 0, tp = 0, tr = 0;
    if (input && dt > 0) {
      const vx = input.velocity[0], vy = input.velocity[1], vz = input.velocity[2];
      const hs = Math.hypot(vx, vy);
      // Tuck in at speed (bhop speeds: from about running speed, fully by ~1000 u/s).
      const sp = smooth(300, 1000, hs);
      tf -= 0.45 * sp * bob;
      tu -= 0.2 * sp * bob;
      tp += 0.4 * sp * bob;
      // Airborne: trail the vertical speed (rising: low, muzzle down; falling: up a touch).
      if (!input.grounded) {
        const k = clamp(vz / 300, -1, 1);
        tu -= 0.35 * k * bob;
        tp += 0.8 * k * bob;
      }
      // Jump: a tug down as you leave the ground; landing: a sink by how hard (the knife feel dips too).
      if (this.wasGrounded && !input.grounded && vz > 80) {
        this.v[2] -= 5 * bob;
        this.v[3] += 22 * bob;
      }
      if (input.landed < -50) {
        const hard = clamp(-input.landed / 300, 0, 2.2);
        this.v[2] -= 4.5 * hard * bob;
        this.v[3] += 16 * hard * bob;
      }
      this.wasGrounded = input.grounded;
      // Strafes: the sideways (view-left) acceleration, smoothed; the gun lags against it and rolls into it.
      if (this.haveVel) {
        const ax = (vx - this.lastVel[0]) / dt, ay = (vy - this.lastVel[1]) / dt;
        const yaw = input.yaw * D2R;
        const lat = -Math.sin(yaw) * ax + Math.cos(yaw) * ay;
        this.latAcc += (clamp(lat, -3000, 3000) - this.latAcc) * (1 - Math.exp(-dt * 8));
      }
      this.lastVel[0] = vx;
      this.lastVel[1] = vy;
      this.lastVel[2] = vz;
      this.haveVel = true;
      const la = clamp(this.latAcc / 1500, -1, 1);
      tl -= 0.45 * la * sway;
      tr -= 1.8 * la * sway;
    }
    // Springs toward the targets (soft, slightly underdamped: a gun has some mass).
    const K = 90, C = 2 * Math.sqrt(K) * 0.7;
    const steps = Math.ceil(dt / (1 / 240));
    const h = steps ? dt / steps : 0;
    const tgt0 = tf, tgt1 = tl, tgt2 = tu, tgt3 = tp, tgt5 = tr;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < 6; i++) {
        const target = i === 0 ? tgt0 : i === 1 ? tgt1 : i === 2 ? tgt2 : i === 3 ? tgt3 : i === 5 ? tgt5 : 0;
        this.v[i] += (-K * (this.x[i] - target) - C * this.v[i]) * h;
        this.x[i] += this.v[i] * h;
      }
    }
    // Clamp: a nudge, never a swing.
    for (let i = 0; i < 3; i++) this.x[i] = clamp(this.x[i], -1.2, 1.2);
    for (let i = 3; i < 6; i++) this.x[i] = clamp(this.x[i], -3, 3);
    // Idle drift (on top, not through the springs: it is already smooth).
    const t = this.t, ib = this.bob * w;
    const ip = (0.22 * Math.sin(t * 1.46) + 0.08 * Math.sin(t * 2.71 + 1.3)) * ib;
    const iy = (0.28 * Math.sin(t * 1.03 + 0.7) + 0.06 * Math.sin(t * 2.33)) * ib;
    const ir = 0.35 * Math.sin(t * 1.21 + 2.1) * ib;
    const iu = 0.05 * Math.sin(t * 1.46 + 0.5) * ib;
    compose(this.x[3] + ip, this.x[4] + iy, this.x[5] + ir, this.x[0], this.x[1], this.x[2] + iu, pivot, this.M);
  }
}

/** out = T(offset) * R(pitch, yaw, roll about pivot) (Source angles, degrees; viewmodel space x fwd, y left, z up). */
function compose(pitch: number, yaw: number, roll: number, ox: number, oy: number, oz: number, piv: ArrayLike<number>, out: Float32Array): void {
  angleMatrix(pitch, yaw, roll, 0, 0, 0, out);
  const px = piv[0], py = piv[1], pz = piv[2];
  out[3] = px - (out[0] * px + out[1] * py + out[2] * pz) + ox;
  out[7] = py - (out[4] * px + out[5] * py + out[6] * pz) + oy;
  out[11] = pz - (out[8] * px + out[9] * py + out[10] * pz) + oz;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
