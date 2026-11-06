// The Bunnyfly's balisong mechanism (knives/bunnyfly.ts mesh, inspects/bunnyfly.ts tricks): three rigid parts on pins,
// driven by KnifeState.angles = [blade, bite, latch] (degrees; rig.ts EXTRA_BONES, each turns by -angle about its
// local x, the pin axis):
//
//   blade  Bfly_Blade about pin A relative to the SAFE handle (Knife_Handle, the one the fist keeps): 0 open, 180 closed
//   bite   Bfly_Bite about pin B relative to the blade: 0 open, 180 closed over the edge
//   latch  Bfly_Latch about its hinge on the bite handle's butt: 0 locked across the butts with the knife open, 90
//          hanging free, 180 locked across them with the knife closed
//
// Why every angle stays in [0, 180]: in the blade's frame the safe handle hangs from pin A (y = +pinY) and the bite
// handle from pin B (y = -pinY), each a pair of liners no wider than its pin's distance from the centre line, with the
// pin end rounded about the pin. Turning blade in [0, 180] swings the safe handle through the +y side, bite in
// [0, 180] the bite handle through the -y side: they never cross y = 0, so they can't touch each other, whatever the
// two angles are (and any blend of two valid poses is valid: the box is convex). The blade turns between the liners
// (|x| < LINER_IN), and its tip never reaches the spacer at the far end of either handle. The latch hangs below the
// butts at every angle. Past 0 / 180 the handles would pass through each other (the old Fan Flips did): the stops
// (the tang's kicker, the handles meeting) are where the swings bounce. tests: apps/api/test/balisong.test.ts.
//
// Motion: everything here is a pure function of time (no springs, no state), so a seek, a replay or an export poses
// the same frame every time, at any frame rate.

import { BFLY } from "../rig";

/** Joint order in KnifeState.angles (bunnyfly.joints). */
export const BJ = { blade: 0, bite: 1, latch: 2 } as const;

/** Liner inner / outer face (|x|), handle half width (y, about its pin's line), handle ends (z). */
export const LINER_IN = 0.135, LINER_OUT = 0.33, HANDLE_HW = BFLY.pinY * 0.94, HANDLE_BOT = -2.8, HANDLE_TOP = BFLY.pinZ;
/** The latch hinge under the bite handle's butt (knife-local z) and the arm's reach across both butts. */
export const LATCH_Z = BFLY.latchZ, LATCH_REACH = 4 * BFLY.pinY - 0.2;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** How long a stop's bounces last (s). */
export const BOUNCE_END = 0.13;

/**
 * A hinged part flung from `a` to `b` over [t0, t1]: it leaves at rest, gathers speed (constant angular acceleration:
 * the flick / its own weight), arrives at full speed against its stop and bounces back off it a few degrees (two
 * quick, damped bounces, more for a faster swing), then rests on it. Pure in t.
 */
export function swing(t: number, t0: number, t1: number, a: number, b: number, bounce?: number): number {
  if (t <= t0) return a;
  if (t < t1) {
    const x = (t - t0) / (t1 - t0);
    return a + (b - a) * x * x;
  }
  const speed = (2 * Math.abs(b - a)) / Math.max(1e-3, t1 - t0);
  const amp = bounce ?? clamp(0.0024 * speed, 0, 7);
  const u = t - t1;
  // (Faded out by BOUNCE_END: after it the part rests exactly on its stop, so a loop can start from there.)
  if (u >= BOUNCE_END || amp <= 0) return b;
  const fade = 1 - (u / BOUNCE_END) ** 2;
  return b + Math.sign(a - b) * amp * fade * Math.exp(-u / 0.035) * Math.abs(Math.sin((Math.PI * u) / 0.055));
}

/** Eased move (no impact): for the latch being pushed home and parts guided by a finger. */
export function ease(t: number, t0: number, t1: number, a: number, b: number): number {
  const x = clamp((t - t0) / (t1 - t0), 0, 1);
  return a + (b - a) * x * x * (3 - 2 * x);
}

/** The bite handle's turn in the safe handle's frame (deg about the pin axis) for these joint angles. */
export const biteTurn = (blade: number, bite: number) => -(blade + bite);

/** Impulse response of the hanging latch (a damped pendulum, ~6 Hz, half-damped) to its handle's turning. */
const LP = { w: 2 * Math.PI * 6, z: 0.5, span: 0.36, h: 1 / 240, gain: 0.55, max: 55 };

/**
 * The free latch: hangs at 90 and swings behind its handle when the handle turns (a damped pendulum driven by the
 * handle's angular acceleration), within +-LP.max so it never reaches the butts. `turn(t)` = the bite handle's turn
 * (biteTurn) at time t. Pure in t: it convolves the handle's recent motion (the last LP.span s) with the pendulum's
 * response.
 */
export function latchFree(t: number, turn: (t: number) => number): number {
  const { w, z, span, h, gain } = LP;
  const wd = w * Math.sqrt(1 - z * z);
  // phi(t) = -int g'(s) turn'(t - s) ds, g(s) = e^{-z w s} sin(wd s) / wd (g(0) = 0).
  let phi = 0;
  let prev = turn(t);
  for (let s = h; s <= span; s += h) {
    const cur = turn(t - s);
    const vel = (prev - cur) / h; // turn'(t - s + h/2)
    const sm = s - h / 2;
    const g1 = Math.exp(-z * w * sm) * (Math.cos(wd * sm) - ((z * w) / wd) * Math.sin(wd * sm));
    phi -= g1 * vel * h;
    prev = cur;
  }
  // The latch lags (turns the other way relative to the handle): its bone angle goes up as the handle turns positive.
  return 90 + clamp(-gain * phi, -LP.max, LP.max);
}

/** Valid joint angles (the stops): what any authored pose is clamped to. */
export function clampJoints(a: number[]): void {
  for (let i = 0; i < 3 && i < a.length; i++) a[i] = clamp(a[i], 0, 180);
}

/**
 * While the fingers are open for a flip (k 0..1), the thumb and index roll the knife about its long axis so the plane
 * the handles swing in lies flat to the palm (on this hold the pin axis is ~35 deg off the palm normal, so a part
 * swinging round the heel of the hand would climb into the palm), and hold it a little off the palm. Knife-local
 * transform (KnifeState.local / post-multiplied onto Knife_Handle). `n`: the palm normal, knife-local.
 */
export function flipClear(k: number, n: readonly number[], out: Float32Array): Float32Array {
  const a = Math.atan2(n[1], n[0]) * k, c = Math.cos(a), s = Math.sin(a), d = FLIP_LIFT * k;
  out[0] = c, out[1] = -s, out[2] = 0, out[3] = n[0] * d;
  out[4] = s, out[5] = c, out[6] = 0, out[7] = n[1] * d;
  out[8] = 0, out[9] = 0, out[10] = 1, out[11] = n[2] * d;
  return out;
}
/** How far off the palm (units) the knife rides while the fingers are open for a flip. */
export const FLIP_LIFT = 0.45;
