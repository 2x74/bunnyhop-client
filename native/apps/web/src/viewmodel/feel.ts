// Shared motion helpers for the first-person feel (viewmodel.ts, guns/motion.ts) and the third-person bunny. Pure maths,
// no allocation, no clock: the same input sequence gives (nearly) the same pose whatever the frame rate. "Nearly": the
// springs and filters are exact for their inputs over a frame, but inputs are still sampled once per frame (a ground
// tick or key change shows on the next frame) and the lag's renormalised direction is not a linear system.
//
//   springStep   a damped spring advanced by its exact solution over dt (target held for the step), so 60 fps and
//                240 fps land on the same curve, instead of semi-implicit Euler in fixed sub-steps
//   springRamp   the same with the target moving in a straight line over the step (first-order hold)
//   landImpact   how hard a landing reads, 0..1 from the vertical speed: a routine bhop landing (~300 u/s) barely
//                registers, a real drop (700+) does, and it saturates instead of growing without bound
//   softLimit    a smooth cap (tanh): small values pass almost unchanged, big ones level off at `limit`
//   ViewFeel     the knife viewmodel's bob, lag, tilt, crouch, landing dip and breathing (viewmodel.ts)

import { angleMatrix } from "./math";

/**
 * Advances spring `i` of (x, v) toward `target` by dt: angular frequency `omega` (1/s), damping ratio `zeta` (1 =
 * critical, < 1 overshoots). Exact for any dt (the target is held over the step).
 */
export function springStep(x: Float64Array, v: Float64Array, i: number, target: number, omega: number, zeta: number, dt: number): void {
  if (dt <= 0) return;
  const y0 = x[i] - target, v0 = v[i];
  let y: number, vy: number;
  if (zeta < 0.9999) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * omega * dt);
    const c = Math.cos(wd * dt), s = Math.sin(wd * dt);
    const b = (v0 + zeta * omega * y0) / wd;
    y = e * (y0 * c + b * s);
    // d/dt of e (y0 c + b s)
    vy = e * (-zeta * omega * (y0 * c + b * s) - y0 * wd * s + b * wd * c);
  } else if (zeta <= 1.0001) {
    const e = Math.exp(-omega * dt);
    const b = v0 + omega * y0;
    y = (y0 + b * dt) * e;
    vy = (b - omega * (y0 + b * dt)) * e;
  } else {
    const r = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + r, r2 = -zeta * omega - r;
    const c2 = (v0 - r1 * y0) / (r2 - r1), c1 = y0 - c2;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    y = c1 * e1 + c2 * e2;
    vy = c1 * r1 * e1 + c2 * r2 * e2;
  }
  x[i] = target + y;
  v[i] = vy;
}

/**
 * springStep with the target moving linearly from u0 to u1 over dt: exact (a ramp's steady state trails it by
 * 2 zeta r / omega; the rest is the held-target solution about that).
 */
export function springRamp(x: Float64Array, v: Float64Array, i: number, u0: number, u1: number, omega: number, zeta: number, dt: number): void {
  if (dt <= 0) return;
  const r = (u1 - u0) / dt, lag = (2 * zeta * r) / omega;
  // In the frame moving with the ramp's steady state, it's a held-target spring toward 0.
  x[i] -= u0 - lag;
  v[i] -= r;
  springStep(x, v, i, 0, omega, zeta, dt);
  x[i] += u1 - lag;
  v[i] += r;
}

/** The game's reduced-motion policy (as guns/motion.ts, guns/anim.ts): prefers-reduced-motion scales motion to 45%. */
export const REDUCED_MOTION = 0.45;
let reducedQuery: { matches: boolean } | null | undefined;
/** 1, or REDUCED_MOTION under prefers-reduced-motion (read live; no DOM: 1). */
export function motionScale(): number {
  if (reducedQuery === undefined) {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    reducedQuery = typeof mm === "function" ? mm("(prefers-reduced-motion: reduce)") : null;
  }
  return reducedQuery?.matches ? REDUCED_MOTION : 1;
}

/**
 * Landing strength 0..1 from the vertical speed just before touching down (u/s, negative = falling): nothing up to
 * 250 u/s, ~0.08 for a flat bhop landing (~300), ~0.5 at 700, ~0.7 at 1000, ~0.9 at 1500, then levelling off.
 */
export function landImpact(vz: number): number {
  const over = -vz - 250;
  return over > 0 ? 1 - Math.exp(-over / 600) : 0;
}

/**
 * First-order lag x' = k (u - x) over dt with its input moving in a straight line from u0 to u1 (first-order hold):
 * exact for a steadily moving input, so a view turning at a steady rate lags the same at any frame rate.
 */
export function follow(x: number, u0: number, u1: number, k: number, dt: number): number {
  if (dt <= 0) return x;
  const kd = k * dt, e = Math.exp(-kd);
  return e * x + (1 - e) * u0 + (u1 - u0) * (1 - (1 - e) / kd);
}

/**
 * How hard a landing is for the hard-landing responses (the viewmodel's settle, the optional camera settle,
 * eye-feel.ts), 0..1 from the vertical speed before touchdown (u/s, < 0): nothing below ~650 u/s, full by ~1200.
 */
export function hardLanding(vz: number): number {
  const x = Math.min(1, Math.max(0, (-vz - 650) / 550));
  return x * x * (3 - 2 * x);
}

/** Smooth cap: ~x for |x| well under `limit`, levelling off at ±limit. */
export function softLimit(x: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(x / limit) : 0;
}

// -------------------------------------------------------------------------------------------------------------------
// The knife viewmodel's movement feel (viewmodel.ts; the gun viewmodel rides its matrix too)

/** What the feel reads each frame (viewmodel.ts ViewmodelInput). */
export interface FeelInput {
  /** Interpolated velocity, Source units/s. */
  velocity: ArrayLike<number>;
  grounded: boolean;
  /** Eye height above the feet (64 standing, 46 ducked). */
  viewOffsetZ: number;
  /** Commanded side move (±450). */
  sidemove: number;
  /** View angles, degrees (Source). */
  yaw: number;
  pitch: number;
  /** Vertical speed of a landing since the last frame (negative, units/s), or 0. */
  landed: number;
}

/**
 * Most the mouse lag may offset the hands (units, before Sway): CS:S's offset is 5 x the lag (up to 7.5 units at its
 * max lag), which a bhop strafe sweep (~200 deg/s) pushes to ~3.4 units, a third of the screen. softLimit keeps small
 * aim moves as they were (a 1-unit lag gives 0.92) and levels big sweeps off at this.
 */
export const LAG_LIMIT = 2;
/** Landing dip spring (units of dip; view-space z = 0.7 x dip, pitch = 1.6 deg per unit) and its kick at landImpact 1. */
const DIP_OMEGA = 11, DIP_ZETA = 0.72, DIP_KICK = 48;
/**
 * Hard-landing settle (genuinely hard falls only: eye-feel.ts hardLanding, nothing below ~650 u/s): the hands drop a
 * little further and come straight back, on top of the dip. Fast and critically damped (no bounce): peaks ~50 ms after
 * touchdown at up to HARD_MAX units (soft-capped), settled by ~0.3 s.
 */
const HARD_OMEGA = 20, HARD_MAX = 0.9;
const D2R = Math.PI / 180;
const clampN = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

/**
 * From the SDK 2013 viewmodel code, all in view space: CS:S bob (CWeaponCSBase::CalcViewmodelBob / AddViewmodelBob:
 * cl_bobcycle 0.8, cl_bobup 0.5, speed-limited, only while grounded here), viewmodel lag (CBaseViewModel::CalcViewModelLag:
 * the last-facing vector catching up at 5/s, max lag 1.5, plus the pitch offset), a strafe tilt, a crouch offset, a
 * landing dip and a little breathing. `bob` scales the bob, dip and breathing, `sway` the lag and tilt (Settings ->
 * Viewmodel). Everything is smoothed exactly (exponentials, springStep), so the same inputs at the same times give the
 * same matrix at 60 fps or 360. No allocation per frame. Output: V (3x4, view space).
 */
export class ViewFeel {
  readonly V = new Float32Array(12);
  private bobTime = 0;
  private bobSpeed = 0;
  private vBob = 0;
  private lBob = 0;
  /** CS:S m_vecLastFacing, and the view's forward at the last update (the lag's input moves from it to this frame's). */
  private lf = new Float64Array(3);
  private pf = new Float64Array(3);
  private haveLf = false;
  private duckIn = 0;
  private haveDuck = false;
  private lag = new Float64Array(3);
  private tilt = 0;
  private shift = 0;
  private duck = 0;
  /** Landing dip spring: value, velocity. */
  private dipX = new Float64Array(1);
  private dipV = new Float64Array(1);
  /** Hard-landing settle spring: value (units, <= 0), velocity. */
  private hardX = new Float64Array(1);
  private hardV = new Float64Array(1);

  /** Back to rest (a replay seek, a jump): no lag, dip, tilt or bob carried over from before the jump. */
  reset(): void {
    this.bobTime = this.bobSpeed = this.vBob = this.lBob = 0;
    this.haveLf = this.haveDuck = false;
    this.lag.fill(0);
    this.tilt = this.shift = this.duck = 0;
    this.dipX[0] = this.dipV[0] = this.hardX[0] = this.hardV[0] = 0;
  }

  /** `time`: the viewmodel clock (s), for the breathing. */
  update(dt: number, s: FeelInput, bobK: number, swayK: number, time: number): Float32Array {
    // --- CS:S bob (CalcViewmodelBob), only while grounded.
    const hs = s.grounded ? Math.sqrt(s.velocity[0] * s.velocity[0] + s.velocity[1] * s.velocity[1]) : 0;
    // The bob speed moves toward the target at 320 u/s per second (CS:S); the bob time integrates it exactly, the ramp
    // and, if it reaches the target within the frame, the rest of the frame at the target.
    const target = clampN(hs, -320, 320), s0 = this.bobSpeed;
    const reach = Math.abs(target - s0) / 320;
    let speed: number;
    if (reach >= dt) {
      speed = s0 + Math.sign(target - s0) * 320 * dt;
      this.bobTime += (dt * (speed + s0)) / 640;
    } else {
      speed = target;
      this.bobTime += (reach * (s0 + target) * 0.5 + (dt - reach) * target) / 320;
    }
    this.bobSpeed = speed;
    const v = speed * 0.005;
    this.vBob = clampN(v * 0.3 + v * 0.7 * Math.sin(bobPhase(this.bobTime, 0.8)), -7, 4) * bobK;
    this.lBob = clampN(v * 0.3 + v * 0.7 * Math.sin(bobPhase(this.bobTime, 1.6)), -7, 4) * bobK;

    // --- Lag (CalcViewModelLag), world space -> view space.
    const cy = Math.cos(s.yaw * D2R), sy = Math.sin(s.yaw * D2R), cp = Math.cos(s.pitch * D2R), sp = Math.sin(s.pitch * D2R);
    const f0 = cp * cy, f1 = cp * sy, f2 = -sp;
    const lf = this.lf, pf = this.pf;
    // A view snapped (nearly) straight around (a teleport or restart turning 180°) would leave the lag direction
    // antiparallel and stuck at full strength, pulling the viewmodel into the camera: start the lag over instead.
    if (!this.haveLf || len3(f0 - lf[0], f1 - lf[1], f2 - lf[2]) > 1.9) {
      (lf[0] = pf[0] = f0), (lf[1] = pf[1] = f1), (lf[2] = pf[2] = f2);
      this.haveLf = true;
    }
    if (dt > 0) {
      // Catch up at 5/s (faster past the max lag). CS:S steps it once per frame, which lags more at low frame rates;
      // here it follows the view's path over the frame exactly (follow), so the lag is the same at any frame rate.
      let k = 5;
      const before = len3(f0 - lf[0], f1 - lf[1], f2 - lf[2]);
      if (before > 1.5) k *= before / 1.5;
      lf[0] = follow(lf[0], pf[0], f0, k, dt);
      lf[1] = follow(lf[1], pf[1], f1, k, dt);
      lf[2] = follow(lf[2], pf[2], f2, k, dt);
      const ll = len3(lf[0], lf[1], lf[2]) || 1;
      (lf[0] /= ll), (lf[1] /= ll), (lf[2] /= ll);
    }
    (pf[0] = f0), (pf[1] = f1), (pf[2] = f2);
    const dx = f0 - lf[0], dy = f1 - lf[1], dz = f2 - lf[2];
    const diff = len3(dx, dy, dz);
    // CS:S offsets by 5 x the lag; levelled off at LAG_LIMIT (same direction, smaller when it's big).
    const lagScale = diff > 1e-6 ? (softLimit(5 * diff, LAG_LIMIT) / diff) * swayK : 0;
    const ox = -dx * lagScale, oy = -dy * lagScale, oz = -dz * lagScale;
    // Onto the view axes: forward, left (-sy, cy, 0), up (sp cy, sp sy, cp).
    this.lag[0] = ox * f0 + oy * f1 + oz * f2;
    this.lag[1] = -ox * sy + oy * cy;
    this.lag[2] = ox * sp * cy + oy * sp * sy + oz * cp;

    // --- Strafe tilt + slight counter-shift, crouch, landing dip, breathing.
    const side = clampN(s.sidemove / 450, -1, 1);
    const kT = 1 - Math.exp(-dt * 7);
    this.tilt += (side * 3.2 * swayK - this.tilt) * kT;
    this.shift += (side * 0.35 * swayK - this.shift) * kT;
    const duckTarget = clampN((64 - s.viewOffsetZ) / 18, 0, 1);
    if (!(dt > 0) || !this.haveDuck) (this.duckIn = duckTarget), (this.haveDuck = true);
    this.duck = follow(this.duck, this.duckIn, duckTarget, 10, dt);
    this.duckIn = duckTarget;
    // Landing: a downward kick by how hard it was (landImpact), then a slightly underdamped spring back to 0.
    // (The kick lands at the end of the frame that shows the landing, after the step: the same timing at any frame rate.)
    springStep(this.dipX, this.dipV, 0, 0, DIP_OMEGA, DIP_ZETA, dt);
    springStep(this.hardX, this.hardV, 0, 0, HARD_OMEGA, 1, dt);
    if (s.landed < 0) {
      this.dipV[0] -= landImpact(s.landed) * DIP_KICK * bobK;
      // Critically damped: a kick v peaks at v / (omega e).
      this.hardV[0] -= hardLanding(s.landed) * HARD_MAX * HARD_OMEGA * Math.E * Math.min(1, bobK / 0.5);
    }
    const dip = clampN(this.dipX[0], -4, 2);
    const hard = softLimit(this.hardX[0], HARD_MAX);
    const breathe = Math.sin(time * ((2 * Math.PI) / 3.8)) * bobK;

    const pitch = s.pitch > 180 ? s.pitch - 360 : s.pitch;
    // AddViewmodelBob (scaled down to 40%) + the lag pitch offset (forward, right, up = -pitch * 0.035 / 0.03 / 0.02).
    const fx = this.vBob * 0.4 + this.lag[0] - pitch * 0.035 - this.duck * 0.4;
    const fy = -this.lBob * 0.2 + this.lag[1] + pitch * 0.03 + this.shift + this.duck * 0.25;
    const fz = this.vBob * 0.1 + this.lag[2] - pitch * 0.02 - this.duck * 0.55 + dip * 0.7 + breathe * 0.07 + hard;
    const aP = -this.vBob * 0.4 + breathe * 0.12 + dip * -1.6 - hard * 1.4;
    const aY = -this.lBob * 0.3;
    const aR = this.vBob * 0.5 + this.tilt - this.duck * 1.5;
    angleMatrix(aP, aY, aR, fx, fy, fz, this.V);
    return this.V;
  }
}

/** cl_bob's cycle phase (radians) for bob time `t` and cycle length `len` (cl_bobup 0.5: rise and fall halves). */
function bobPhase(t: number, len: number): number {
  const UP = 0.5;
  const c = (t % len) / len;
  return c < UP ? (Math.PI * c) / UP : Math.PI + (Math.PI * (c - UP)) / (1 - UP);
}
