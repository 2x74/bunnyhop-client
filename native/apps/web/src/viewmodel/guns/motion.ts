// The gun's own feel on top of the knife viewmodel's (which the gun already rides: CS:S bob while grounded, mouse lag,
// strafe tilt, crouch, landing dip, breathing): what a gun in the hands does that a knife doesn't, sized by its weight.
//   idle     a slow, uneven drift (three incommensurate periods: it never visibly loops) about the right grip
//   speed    above running speed the gun tucks in a little (back and down), as you'd hold it at a sprint
//   vertical rising off a jump the gun trails low and its muzzle dips; falling, it floats up a touch; the jump itself
//            gives it a small downward tug and a landing an extra, weight-scaled sink (the knife feel's dip is on top)
//   strafes  the gun lags against the air strafe's sideways acceleration (in view space) and rolls into it
// Everything goes through soft springs (exact steps, feel.ts: the same curve at any frame rate) and stays small: a few tenths of a unit
// and a degree or two; the crosshair doesn't move. Bob amount scales idle / speed / vertical, sway amount the strafe
// part (Settings -> Viewmodel; 0 = off), prefers-reduced-motion scales all of it down. No allocation per frame.
//
// Output: a 3x4 matrix in viewmodel space (rotation about the gun's grip, then the offset), multiplied onto the knife
// feel by the gun viewmodel; the audited pose (guns/pose.ts) never sees it.

import { angleMatrix } from "../math";
import { follow, landImpact, softLimit, springRamp } from "../feel";
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
/** The strafe acceleration's smoothing rate (1/s). */
const LAT_K = 8;

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
  /** The springs' targets at the last update (each step ramps from these to this frame's). */
  private u = new Float64Array(6);
  private wasGrounded = true;
  /** Seconds on the ground (a bhop touches it for a tick; a real jump starts from standing or running). */
  private groundT = 1;
  /** The velocity low-passed at LAT_K (world x, y): its rate of change is the smoothed acceleration, exactly. */
  private sv = new Float64Array(2);
  private lastVel = new Float64Array(2);
  private haveVel = false;
  private latAcc = 0;
  private motion = reducedMotion() ? 0.45 : 1;
  private out = new Float64Array(6);

  /** Back to rest with no history (a replay seek, an export's start): springs, the idle clock, contact and velocity. */
  reset(): void {
    this.x.fill(0);
    this.v.fill(0);
    this.u.fill(0);
    this.out.fill(0);
    this.t = 0;
    this.wasGrounded = true;
    this.groundT = 1;
    this.sv.fill(0);
    this.lastVel.fill(0);
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
    let jumped = false, landed = 0, tug = 1;
    if (input && dt > 0) {
      const vx = input.velocity[0], vy = input.velocity[1], vz = input.velocity[2];
      const hs = Math.hypot(vx, vy);
      // Tuck in at speed (bhop speeds: from about running speed, fully by ~1000 u/s): held a little closer, back and
      // down, the muzzle dipping a touch, like a gun carried at a sprint.
      const sp = smooth(300, 1000, hs);
      tf -= 0.55 * sp * bob;
      tu -= 0.25 * sp * bob;
      tp += 0.5 * sp * bob;
      // Airborne: trail the vertical speed (rising: low, muzzle down; falling: up a touch). Faded out at bhop speeds:
      // every hop rises and falls the same, so a per-hop trail just pumps the gun up and down with the rhythm.
      if (!input.grounded) {
        const k = clamp(vz / 300, -1, 1) * (1 - 0.9 * sp);
        tu -= 0.35 * k * bob;
        tp += 0.8 * k * bob;
      }
      // Jump / landing kicks: after the springs below (at the end of the frame that shows them). The jump's tug is for
      // a jump from the ground (standing or running); a bhop's one-tick touch gives a little of it.
      jumped = this.wasGrounded && !input.grounded && vz > 80;
      tug = this.groundT > 0.15 ? 1 : 0.15;
      this.groundT = input.grounded ? this.groundT + dt : 0;
      landed = input.landed;
      this.wasGrounded = input.grounded;
      // Strafes: the sideways (view-left) acceleration, smoothed; the gun lags against it and rolls into it. The
      // smoothed acceleration is k (v - s) for s the velocity low-passed at k (the same filter as a finite difference
      // smoothed at k, but solved exactly for a velocity moving linearly over the frame: no 1/dt, the same at any rate).
      if (!this.haveVel) (this.sv[0] = this.lastVel[0] = vx), (this.sv[1] = this.lastVel[1] = vy), (this.haveVel = true);
      this.sv[0] = follow(this.sv[0], this.lastVel[0], vx, LAT_K, dt);
      this.sv[1] = follow(this.sv[1], this.lastVel[1], vy, LAT_K, dt);
      this.lastVel[0] = vx;
      this.lastVel[1] = vy;
      const yaw = input.yaw * D2R;
      const lat = LAT_K * (-Math.sin(yaw) * (vx - this.sv[0]) + Math.cos(yaw) * (vy - this.sv[1]));
      this.latAcc = clamp(lat, -3000, 3000);
      const la = clamp(this.latAcc / 1500, -1, 1);
      tl -= 0.45 * la * sway;
      tr -= 1.8 * la * sway;
    }
    // Springs toward the targets (soft, slightly underdamped: a gun has some mass), stepped exactly (feel.ts), the
    // targets ramping from last frame's (they come from smooth movement, so a ramp is closer than a step).
    const W = Math.sqrt(90), Z = 0.7, u = this.u;
    const T0 = tf, T1 = tl, T2 = tu, T3 = tp, T5 = tr;
    springRamp(this.x, this.v, 0, u[0], T0, W, Z, dt);
    springRamp(this.x, this.v, 1, u[1], T1, W, Z, dt);
    springRamp(this.x, this.v, 2, u[2], T2, W, Z, dt);
    springRamp(this.x, this.v, 3, u[3], T3, W, Z, dt);
    springRamp(this.x, this.v, 4, 0, 0, W, Z, dt);
    springRamp(this.x, this.v, 5, u[5], T5, W, Z, dt);
    if (dt > 0) (u[0] = T0), (u[1] = T1), (u[2] = T2), (u[3] = T3), (u[5] = T5);
    // Jump: a tug down as you leave the ground; landing: a sink by how hard (the knife feel dips too).
    if (jumped) {
      this.v[2] -= 5 * bob * tug;
      this.v[3] += 22 * bob * tug;
    }
    if (landed < 0) {
      // By how hard (feel.ts): a flat bhop landing ~0.16, a big drop up to 2 (was linear in the speed up to 2.2).
      const hard = landImpact(landed) * 2;
      this.v[2] -= 4.5 * hard * bob;
      this.v[3] += 16 * hard * bob;
    }
    // Limits: a nudge, never a swing (soft, on the output: clamping the springs' state each frame made a big landing
    // depend on the frame rate).
    const X = this.out;
    for (let i = 0; i < 3; i++) X[i] = softLimit(this.x[i], 1.2);
    for (let i = 3; i < 6; i++) X[i] = softLimit(this.x[i], 3);
    // Idle drift (on top, not through the springs: it is already smooth).
    const t = this.t, ib = this.bob * w;
    const ip = (0.22 * Math.sin(t * 1.46) + 0.08 * Math.sin(t * 2.71 + 1.3)) * ib;
    const iy = (0.28 * Math.sin(t * 1.03 + 0.7) + 0.06 * Math.sin(t * 2.33)) * ib;
    const ir = 0.35 * Math.sin(t * 1.21 + 2.1) * ib;
    const iu = 0.05 * Math.sin(t * 1.46 + 0.5) * ib;
    compose(X[3] + ip, X[4] + iy, X[5] + ir, X[0], X[1], X[2] + iu, pivot, this.M);
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
