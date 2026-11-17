// Moving back items (player/bunny/backs.ts), folded into the player materials (player/materials.ts) like the hats'
// motion (hat-fx.ts): no extra textures or draw calls. Each vertex of a back item carries `backfx`:
//
//   x  what it does (the codes below), plus a fraction (< 0.5): shade, drawn darker by up to a third (creases, the
//      undersides and recesses a builder wants in shadow)
//   y  how far along its chain it is, 0 (held at uBackPivot) .. 1 (the free end): how much of the swing it takes
//   z  how much of the bounce it takes (0..1)
//   w  spare
//
//   1  still (straps, housings); swings with its chain weight if it has one (a tassel, leaves, a string, a stick)
//   2  spins about uBackAxis through uBackPivot2 by uBack.x, then swings with its chain weight (the wind-up key's bow,
//      the pinwheel's sails on their stick)
//   3  cloth (the cape): bent about its top hem (uBackPivot; uBackAxis.x its length) by the swing, more toward the hem,
//      a ripple running down its lower part as fast as uBack.w says; its normals are taken from the bent surface
//   5  a jet flame: stretched from its nozzle (uBackPivot2, mirrored in x for the right one) along uBackAxis by
//      uBack.w, self-lit
//   6  a wing: about its root (uBackPivot, mirrored for the right wing), folded back by uBack.y, raised by the flap
//      (uBack.w at the root, uBackTip.x at the tip), the inner wing of a turn folded a little more (uBack.z)
//   8  the balloon: tilted about its neck (uBackPivot2) by uBack.x / uBack.w, then carried on its string's end
//
// The motion is two vec4 per player, worked out on the CPU from what the renderer already knows about the player (the
// velocity in the body's frame, so things stream the right way in sideways travel; the eye yaw's turn; the body's
// acceleration; hops), never from the simulation:
//
//   uBack     x spin (rad) / the balloon's tilt, y pitch (rad), z side (rad), w flare / flutter / flap
//   uBackTip  x the free end's pitch, y the free end's side (it follows the root late and overshoots: the lag at the
//             ends), z bounce (units down: a strapped pack sinks on a takeoff and floats in the air)
//
// A chain bends by pitch * w at its root going over to the tip's angle at its end. Potato (cosmeticsStill) holds the
// pose still. Cost: a few springs per player on the CPU, a branch per vertex, nothing per pixel except the flame.

import { rig, type V3 } from "./bunny/rig";

/** What a back item does (backs.ts BACK_KIND): how advanceBack reads the player. */
export type BackKind = "still" | "key" | "pinwheel" | "cape" | "balloon" | "jet" | "wings" | "pack" | "blade" | "robe" | "medal";

export interface BackMotion {
  /** The spin: the key's place in its ratchet (clicks), the pinwheel's angle (rad) and its rate (rad/s). */
  spin: number;
  spinV: number;
  pitch: number;
  pitchV: number;
  side: number;
  sideV: number;
  /** The free end's angles: they follow pitch / side on their own softer spring. */
  tipP: number;
  tipPV: number;
  tipS: number;
  tipSV: number;
  /** The cape's middle: between the shoulders and the hem, on its own spring (the wave that runs down a long cape). */
  midP: number;
  midPV: number;
  midS: number;
  midSV: number;
  /** Seconds since the last landing or hop (the settle wave that runs down a long cape), and the last fall speed. */
  land: number;
  vzPrev: number;
  /** Bounce (units down) and its rate. */
  bounce: number;
  bounceV: number;
  /** A hop's flare (1 on the hop, decaying). */
  flare: number;
  /** Low-passed forward speed (u/s): the wings' fold. */
  fold: number;
  /** Low-passed body velocity (Source axes) for the acceleration; last yaw (rad) and low-passed yaw rate. */
  vf: [number, number, number];
  yaw: number;
  yawRate: number;
  time: number;
  initialized: boolean;
}
export const backMotion = (): BackMotion => ({ spin: 0, spinV: 0, pitch: 0, pitchV: 0, side: 0, sideV: 0, tipP: 0, tipPV: 0, tipS: 0, tipSV: 0, midP: 0, midPV: 0, midS: 0, midSV: 0, land: 10, vzPrev: 0, bounce: 0, bounceV: 0, flare: 0, fold: 0, vf: [0, 0, 0], yaw: 0, yawRate: 0, time: 0, initialized: false });

/**
 * The wind-up key turns in clicks, like a toy running down: KEY_STEP (rad) a click (half a turn, so between clicks its
 * bow always lies level, the way it reads best from behind), KEY_RATE clicks a second at rest and the most speed adds,
 * over the speed scale (u/s). Each click flips round (time constant KEY_SNAP, s) and springs a little past and back
 * (ringing at KEY_RING rad/s).
 */
export const KEY_STEP = Math.PI;
const KEY_RATE: [number, number, number] = [0.45, 1.9, 650];
const KEY_SNAP = 0.07, KEY_RING = 15;
/**
 * The pinwheel has a little weight: its rate (rad/s) runs up to the wind's in PIN_UP (s) and coasts down in PIN_DOWN.
 * PIN_RATE: at rest, the most speed adds, the speed scale (u/s).
 */
const PIN_RATE: [number, number, number] = [0.7, 9.5, 520];
const PIN_UP = 0.3, PIN_DOWN = 1.7;

/**
 * A swinging part: a root spring and a softer one for its free end.
 *   hz, zeta        the root's natural frequency (Hz) and damping ratio
 *   tipHz, tipZeta  the free end's, following the root
 *   lift, liftV     how far travelling forward streams it back (rad, at full wind) and the speed scale (u/s)
 *   sideLift        how far travelling sideways streams it to the side (rad, at full wind)
 *   kFwd, kUp, kSide  coupling to the body's acceleration forward / back, up / down (free fall floats a hanging thing
 *                   up; a takeoff drops it) and side to side
 *   turn            how far a turn swings it out (rad per rad/s)
 *   pitch, side     the limits (rad)
 *   idle            the sway at rest (rad)
 */
interface Swing { hz: number; zeta: number; tipHz: number; tipZeta: number; lift: number; liftV: number; sideLift: number; kFwd: number; kUp: number; kSide: number; turn: number; pitch: [number, number]; side: number; idle: number }
const SWING: Partial<Record<BackKind, Swing>> = {
  // Cloth with some weight: slow, well damped at the shoulders, the hem late and overshooting.
  cape: { hz: 1.1, zeta: 0.46, tipHz: 1.0, tipZeta: 0.42, lift: 0.8, liftV: 800, sideLift: 0.75, kFwd: 0.00032, kUp: 0.00026, kSide: 0.0002, turn: 0.035, pitch: [0.02, 1.12], side: 0.9, idle: 0.022 },
  // It stays high: it leans back at most ~40 degrees, so it never sits between the chase camera and the head.
  balloon: { hz: 0.85, zeta: 0.3, tipHz: 0.75, tipZeta: 0.2, lift: 0.55, liftV: 600, sideLift: 0.5, kFwd: 0.0004, kUp: 0.00005, kSide: 0.0007, turn: 0.05, pitch: [-0.22, 0.6], side: 0.55, idle: 0.07 },
  // A springy stick: quick, small.
  pinwheel: { hz: 3.1, zeta: 0.22, tipHz: 2.6, tipZeta: 0.2, lift: 0.12, liftV: 900, sideLift: 0.1, kFwd: 0.00007, kUp: 0, kSide: 0.00012, turn: 0.012, pitch: [-0.1, 0.22], side: 0.16, idle: 0.008 },
  // The carrot's leaves.
  pack: { hz: 2.3, zeta: 0.22, tipHz: 1.9, tipZeta: 0.2, lift: 0.55, liftV: 700, sideLift: 0.4, kFwd: 0.0003, kUp: 0.00012, kSide: 0.0004, turn: 0.03, pitch: [-0.3, 0.8], side: 0.55, idle: 0.03 },
  // The blade's cord and charm: a light pendulum, lively.
  blade: { hz: 1.8, zeta: 0.16, tipHz: 1.7, tipZeta: 0.16, lift: 0.95, liftV: 650, sideLift: 0.7, kFwd: 0.0004, kUp: 0.0004, kSide: 0.0007, turn: 0.07, pitch: [0, 1.2], side: 0.8, idle: 0.05 },
  // The key's shaft has a little play: it nods on a takeoff.
  key: { hz: 4.5, zeta: 0.22, tipHz: 4.5, tipZeta: 0.3, lift: 0, liftV: 700, sideLift: 0, kFwd: 0, kUp: 0.00009, kSide: 0.00006, turn: 0, pitch: [-0.16, 0.16], side: 0.12, idle: 0 },
  // The Robe's body (robe-fx.ts): a jacket's weight of cloth, shorter than a cape and held at the shoulders, so it
  // streams less far and settles sooner. (Tied, robeSwing: only the skirt below the sash moves, less again.)
  robe: { hz: 1.3, zeta: 0.5, tipHz: 1.2, tipZeta: 0.4, lift: 0.4, liftV: 900, sideLift: 0.36, kFwd: 0.00022, kUp: 0.00016, kSide: 0.00018, turn: 0.028, pitch: [0, 0.58], side: 0.46, idle: 0.016 },
  // The Daily Medal on its ribbon (backs.ts medal): a small weight hanging on the CHEST, so its pitch is how far it
  // stands off the chest (0 = lying on it; it can't swing into the body, so that is its limit). Forward speed presses
  // it on (no lift), slowing down throws it out (kFwd is the other way round from the things on the back), a takeoff
  // presses it on and it floats off in the air and taps back on the landing; turns and side steps slide it across.
  medal: { hz: 2.2, zeta: 0.2, tipHz: 2.5, tipZeta: 0.24, lift: 0, liftV: 700, sideLift: 0, kFwd: -0.00022, kUp: 0.00023, kSide: 0.00035, turn: 0.04, pitch: [0, 0.45], side: 0.28, idle: 0.012 },
  // The wings' beat (pitch is the flap, + up): a takeoff presses them down, they recover past rest and float up in the
  // air, the tips late.
  wings: { hz: 2.1, zeta: 0.3, tipHz: 1.9, tipZeta: 0.22, lift: 0, liftV: 700, sideLift: 0, kFwd: 0, kUp: 0.00034, kSide: 0, turn: 0, pitch: [-0.5, 0.5], side: 0.01, idle: 0.035 },
};

/**
 * The Cape at `len` times the short cape's length (loadout.capeLength / 100): a longer cape is heavier. It swings slower
 * (frequencies over sqrt(len), as a pendulum's), streams less far at speed and to the side, and stops short of level, so
 * a full-length cape never lies flat out behind the bunny toward a camera following it.
 */
const capeSwings = new Map<number, Swing>();
function capeSwing(len: number): Swing {
  const l = Math.min(2.6, Math.max(1, fin(len) || 1));
  let sw = capeSwings.get(l);
  if (!sw) {
    const b = SWING.cape!, g = (l - 1) / 1.6, f = 1 / Math.sqrt(l);
    sw = { ...b, hz: b.hz * f, tipHz: b.tipHz * f, lift: b.lift - 0.2 * g, sideLift: b.sideLift - 0.3 * g, pitch: [b.pitch[0], b.pitch[1] - 0.32 * g], side: b.side - 0.35 * g, turn: b.turn * (1 - 0.3 * g) };
    capeSwings.set(l, sw);
  }
  return sw;
}
/** The Robe tied (robe-fx.ts): the short skirt below the sash, quicker and held closer. */
const ROBE_TIED: Swing = { ...SWING.robe!, hz: 1.7, tipHz: 1.55, lift: 0.46, sideLift: 0.36, pitch: [0, 0.62], side: 0.46 };
/** How far the open fronts fly apart (0..1) at full forward speed, its speed scale (u/s), and what a hop adds. */
const ROBE_FLARE = 0.8, ROBE_FLARE_V = 520, ROBE_FLARE_HOP = 0.16;
/** The cape's middle follows its top at MID_HZ times the hem's frequency. */
const MID_HZ = 1.55;

/** Bounce: a strapped pack's spring (Hz, damping ratio) and how far a unit of the body's acceleration moves it (units). */
const BOUNCE: Partial<Record<BackKind, [number, number, number]>> = { jet: [3.4, 0.3, 0.0006], pack: [3.0, 0.34, 0.00075] };
const BOUNCE_MAX = 1.6;

/** Wings: how far speed folds them back (rad) and its speed scale; how much more the inner wing of a turn folds. */
const WING_FOLD = 0.62, WING_FOLD_V = 700, WING_TURN = 0.06;
/** Jet: the pilot glow at rest and at full speed (its scale u/s), and how fast a hop's flare fades (s). */
const JET_IDLE = 0.2, JET_SPEED = 0.2, JET_SPEED_V = 800, FLARE_T = 0.2;
const ACC_TAU = 0.06, ACC_SAT = 1400;

const fin = (x: number) => (Number.isFinite(x) ? x : 0);
const clampN = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** The wind's pull on a swinging part: [pitch, side] it rests at for a velocity in the body's frame (left, forward). */
function windRest(sw: Swing, left: number, fwd: number): [number, number] {
  const speed = Math.hypot(left, fwd);
  if (speed < 1) return [0, 0];
  const wind = 1 - Math.exp(-speed / sw.liftV);
  // Travelling backwards presses it onto the back: no lift. Travelling to the left blows it to the right (+ side).
  return [sw.lift * wind * Math.max(0, fwd / speed), sw.sideLift * wind * (left / speed)];
}

/**
 * Steps one player's back item by dt (s): `vel` (Source u/s, world), the eye yaw (degrees), and whether they hopped this
 * frame. `snap`: a teleport or the first frame (start from rest); `still`: Potato (hold the pose, keep the inputs so
 * resuming isn't a kick). `len`: the Cape's length over the short cape's (capeSwing). Deterministic for the same inputs.
 */
export function advanceBack(s: BackMotion, kind: BackKind, vel: ArrayLike<number>, yawDeg: number, jumped: boolean, dt: number, snap = false, still = false, len = 1, tied = false): void {
  const h = Math.max(0, Math.min(fin(dt), 0.1));
  const v: [number, number, number] = [fin(vel[0]), fin(vel[1]), fin(vel[2])];
  const yaw = fin(yawDeg) * (Math.PI / 180);
  const speed = Math.hypot(v[0], v[1]);
  // World (Source: yaw 0 = +x forward) into the body's frame: left, forward.
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const left = -sy * v[0] + cy * v[1], fwd = cy * v[0] + sy * v[1];
  const sw = kind === "cape" ? capeSwing(len) : kind === "robe" && tied ? ROBE_TIED : SWING[kind];
  if (still || snap || !s.initialized) {
    if (!still) {
      s.spin = s.spinV = s.pitch = s.pitchV = s.side = s.sideV = s.tipPV = s.tipSV = s.midPV = s.midSV = s.bounce = s.bounceV = s.flare = 0;
      if (sw) {
        const [p, q] = windRest(sw, left, fwd);
        s.pitch = clampN(p, sw.pitch[0], sw.pitch[1]);
        s.side = clampN(q, -sw.side, sw.side);
      }
      s.tipP = s.midP = s.pitch;
      s.tipS = s.midS = s.side;
      if (kind === "pinwheel") s.spinV = PIN_RATE[0] + PIN_RATE[1] * (1 - Math.exp(-speed / PIN_RATE[2]));
      s.fold = Math.max(0, fwd);
      s.time = 0;
      s.land = 10;
    }
    s.vzPrev = v[2];
    s.vf = v;
    s.yaw = yaw;
    s.yawRate = 0;
    s.initialized = true;
    return;
  }
  if (h <= 0) return;
  s.time = (s.time + h) % (Math.PI * 200);
  s.flare = Math.max(jumped ? 1 : 0, s.flare * Math.exp(-h / FLARE_T));
  // A landing: a hop, or a fall that stops.
  s.land = jumped || (s.vzPrev < -120 && v[2] > s.vzPrev + 150) ? 0 : Math.min(10, s.land + h);
  s.vzPrev = v[2];
  if (kind === "key") s.spin = (s.spin + (KEY_RATE[0] + KEY_RATE[1] * (1 - Math.exp(-speed / KEY_RATE[2]))) * h) % 4096;
  else if (kind === "pinwheel") {
    const want = PIN_RATE[0] + PIN_RATE[1] * (1 - Math.exp(-speed / PIN_RATE[2]));
    s.spinV += (want - s.spinV) * (1 - Math.exp(-h / (want > s.spinV ? PIN_UP : PIN_DOWN)));
    s.spin = (s.spin + s.spinV * h) % (Math.PI * 2);
  }
  s.fold += (Math.max(0, fwd) - s.fold) * (1 - Math.exp(-h / 0.18));
  const bo = BOUNCE[kind];
  if (!sw && !bo) return;
  // The body's acceleration in its own frame, low-passed and softly saturated (a hop's velocity step gives the same kick
  // at any frame rate); free fall reads as down, so a hanging thing floats in the air and drops on takeoff.
  const k = 1 - Math.exp(-h / ACC_TAU);
  const a = [0, 1, 2].map((i) => ((v[i] - s.vf[i]) * k) / h);
  for (let i = 0; i < 3; i++) s.vf[i] += (v[i] - s.vf[i]) * k;
  const sat = (x: number) => ACC_SAT * Math.tanh(x / ACC_SAT);
  let dyaw = yaw - s.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  s.yaw = yaw;
  s.yawRate += (dyaw / h - s.yawRate) * (1 - Math.exp(-h / 0.05));
  const aLeft = sat(-sy * a[0] + cy * a[1]), aFwd = sat(cy * a[0] + sy * a[1]), aUp = sat(a[2]);
  // (The medal is light and quick: finer steps keep its swing the same from 60 to 240 frames a second.)
  const n = Math.max(1, Math.ceil(h / (kind === "medal" ? 1 / 240 : 1 / 120)));
  const dh = h / n;
  if (bo) {
    const w0 = 2 * Math.PI * bo[0], kk = w0 * w0, c = 2 * bo[1] * w0;
    for (let i = 0; i < n; i++) {
      s.bounceV += (kk * (bo[2] * aUp - s.bounce) - c * s.bounceV) * dh;
      s.bounce += s.bounceV * dh;
      if (Math.abs(s.bounce) > BOUNCE_MAX) (s.bounce = Math.sign(s.bounce) * BOUNCE_MAX), (s.bounceV *= -0.2);
    }
  }
  if (!sw) return;
  // Where the wind and the idle sway rest it; speeding up, a takeoff and a turn swing it from there.
  const [pW, sW] = windRest(sw, left, fwd);
  const idle = sw.idle * Math.exp(-speed / 120);
  const pT = pW + idle * 0.6 * Math.sin(s.time * 1.7);
  // (A turn to the left leaves it behind to the right: + side.)
  const sT = sW + idle * Math.sin(s.time * 1.1) + sw.turn * clampN(s.yawRate, -4, 4);
  const fP = sw.kFwd * aFwd - sw.kUp * aUp;
  const fS = sw.kSide * aLeft;
  const w0 = 2 * Math.PI * sw.hz, kk = w0 * w0, c = 2 * sw.zeta * w0;
  const w1 = 2 * Math.PI * sw.tipHz, kt = w1 * w1, ct = 2 * sw.tipZeta * w1;
  const slackP = 0.25 * (sw.pitch[1] - sw.pitch[0]), slackS = 0.25 * sw.side;
  const w2 = w1 * MID_HZ, km = w2 * w2, cm = (sw.zeta + sw.tipZeta) * w2;
  for (let i = 0; i < n; i++) {
    s.pitchV += (kk * (fP + pT - s.pitch) - c * s.pitchV) * dh;
    s.sideV += (kk * (fS + sT - s.side) - c * s.sideV) * dh;
    s.pitch += s.pitchV * dh;
    s.side += s.sideV * dh;
    if (s.pitch < sw.pitch[0]) (s.pitch = sw.pitch[0]), (s.pitchV = Math.max(0, s.pitchV) * 0.3);
    if (s.pitch > sw.pitch[1]) (s.pitch = sw.pitch[1]), (s.pitchV = Math.min(0, s.pitchV) * 0.3);
    if (Math.abs(s.side) > sw.side) (s.side = Math.sign(s.side) * sw.side), (s.sideV *= -0.2);
    // The free end follows the root, late; it may run a little past the root's limits.
    s.tipPV += (kt * (s.pitch - s.tipP) - ct * s.tipPV) * dh;
    s.tipSV += (kt * (s.side - s.tipS) - ct * s.tipSV) * dh;
    s.tipP = clampN(s.tipP + s.tipPV * dh, sw.pitch[0] - slackP, sw.pitch[1] + slackP);
    s.tipS = clampN(s.tipS + s.tipSV * dh, -sw.side - slackS, sw.side + slackS);
    if (kind === "cape" || kind === "robe") {
      s.midPV += (km * (s.pitch - s.midP) - cm * s.midPV) * dh;
      s.midSV += (km * (s.side - s.midS) - cm * s.midSV) * dh;
      s.midP = clampN(s.midP + s.midPV * dh, sw.pitch[0] - slackP, sw.pitch[1] + slackP);
      s.midS = clampN(s.midS + s.midSV * dh, -sw.side - slackS, sw.side + slackS);
    }
  }
}

/** The key's angle (rad) at a place in its ratchet: whole clicks, the current one snapped round and springing back. */
export function keyAngle(clicks: number, rate: number): number {
  const whole = Math.floor(clicks);
  // Seconds since this click began.
  const u = (clicks - whole) / Math.max(rate, 1e-3);
  const e = 1 - Math.exp(-u / KEY_SNAP) * Math.cos(KEY_RING * u);
  return KEY_STEP * (whole + e);
}

/** The uBack vector for an item's motion state: [spin, pitch, side, flare / flutter / flap]. */
export function backUniform(s: BackMotion, kind: BackKind, speed: number): [number, number, number, number] {
  const sp = Math.max(0, fin(speed));
  switch (kind) {
    case "key":
      return [keyAngle(s.spin, KEY_RATE[0] + KEY_RATE[1] * (1 - Math.exp(-sp / KEY_RATE[2]))), s.pitch, s.side, 0];
    case "jet":
      return [0, 0, 0, JET_IDLE + JET_SPEED * (1 - Math.exp(-sp / JET_SPEED_V)) + s.flare];
    case "wings":
      return [0, WING_FOLD * (1 - Math.exp(-s.fold / WING_FOLD_V)), WING_TURN * clampN(s.yawRate, -4, 4), s.pitch];
    case "cape":
    case "blade":
      return [0, s.pitch, s.side, 1 - Math.exp(-sp / 700)];
    case "medal":
      // (Off the chest is toward the front: the other way from a hanging thing's lift on the back.)
      return [0, -Math.max(0, s.pitch), s.side, 0];
    case "robe":
      // (x: the open fronts' flare, from the low-passed forward speed and the last hop.)
      return [ROBE_FLARE * (1 - Math.exp(-s.fold / ROBE_FLARE_V)) + ROBE_FLARE_HOP * s.flare, s.pitch, s.side, 1 - Math.exp(-sp / 700)];
    case "balloon":
      // It rises from its knot, so lagging back and out is the other way round from a hanging cape's. The balloon
      // itself stays more upright than its string (it floats), and rocks on its neck when the string's end is late.
      return [0.55 * s.tipP + 0.6 * (s.pitch - s.tipP), -s.pitch, -s.side, 0.55 * s.tipS + 0.6 * (s.side - s.tipS)];
    case "pinwheel":
    case "pack":
      // Standing things, as the balloon.
      return [s.spin, -s.pitch, -s.side, 0];
    default:
      return [0, 0, 0, 0];
  }
}

/** The uBackTip vector: [the free end's pitch, its side, bounce, 0]. */
export function backUniformTip(s: BackMotion, kind: BackKind): [number, number, number, number] {
  switch (kind) {
    case "cape":
    case "blade":
    case "robe":
      return [s.tipP, s.tipS, 0, 0];
    case "medal":
      // (The free end's overshoot never goes behind the chest.)
      return [-Math.max(0, s.tipP), s.tipS, 0, 0];
    case "balloon":
    case "pinwheel":
      return [-s.tipP, -s.tipS, 0, 0];
    case "pack":
      return [-s.tipP, -s.tipS, s.bounce, 0];
    case "wings":
      return [s.tipP, 0, 0, 0];
    case "key":
      return [s.pitch, s.side, 0, 0];
    case "jet":
      return [0, 0, s.bounce, 0];
    default:
      return [0, 0, 0, 0];
  }
}

/**
 * The uBackMid vector: the middle of a chain's [pitch, side], then the Cape's [twist, seconds since a landing]. Only
 * the Cape has a middle of its own; for every other kind it is the root's (uBack.yz), which makes the chain's curve what
 * it is without a middle. `len`: the Cape's length over the short cape's.
 */
export function backUniformMid(s: BackMotion, kind: BackKind, root: readonly number[], len = 1): [number, number, number, number] {
  // (The Robe: its middle, and the seconds since a landing for its settle wave.)
  if (kind === "robe") return [s.midP, s.midS, 0, s.land];
  if (kind !== "cape") return [root[1], root[2], 0, 0];
  // A long cape's two corners lag differently: a twist across it from how far its hem and middle are behind its top
  // in a swing to the side (none on the short cape); and the time since a landing, for its settle wave.
  const g = Math.min(1, Math.max(0, (fin(len) - 1) / 1.6));
  const twist = clampN(g * (1.4 * (s.tipS - s.midS) + 0.9 * (s.midS - s.side) + 0.4 * s.side), -0.45, 0.45);
  return [s.midP, s.midS, twist, s.land];
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linHex = (hex: number): V3 => [lin(((hex >> 16) & 255) / 255), lin(((hex >> 8) & 255) / 255), lin((hex & 255) / 255)];
const lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** The Cape's own colours (backs.ts cape): its binding, collar and hop mark; its lining, in shade; its clasp. */
const CAPE_IVORY = linHex(0xf3ecdc), CAPE_IVORY_SHADE = linHex(0xcdbfa6), CAPE_GOLD = linHex(0xe6b54a);
/** A picked colour is kept between near-black and near-white (linear), so folds still shade on both. */
const TONE_MIN = 0.012, TONE_MAX = 0.88;
/** The least contrast ((Y1 + 0.05) / (Y2 + 0.05), as WCAG's) between the cape's trim and its outside. */
const TRIM_CONTRAST = 1.8;
/**
 * The Cape's four tones (linear RGB, in CAPE_ROLE order: outside, trim, lining, clasp) for a colourway's accent
 * (linear) and the colours its owner picked (sRGB 0xRRGGBB; absent = the default). With nothing picked it is exactly
 * the built cape: the accent, ivory trim, the ivory lining in shade, a gold clasp. With a pick:
 *   - the outside is the picked colour (or the accent), the lining the picked lining a fifth darker (or ivory in shade);
 *   - the trim (binding, collar, the sewn hop mark) is the lining's colour, moved lighter or darker until it stands
 *     TRIM_CONTRAST from the outside, so the mark and the edge read on any pair, black on black and white on white too;
 *   - the clasp stays gold unless a lining was picked: then it is the trim's tone as metal, never darker than a dark
 *     steel.
 */
export function capeTones(accent: V3, outer?: number | null, lining?: number | null): [V3, V3, V3, V3] {
  const picked = outer != null || lining != null;
  if (!picked) return [accent, CAPE_IVORY, CAPE_IVORY_SHADE, CAPE_GOLD];
  const keep = (c: V3): V3 => [clampN(c[0], TONE_MIN, TONE_MAX), clampN(c[1], TONE_MIN, TONE_MAX), clampN(c[2], TONE_MIN, TONE_MAX)];
  // (An accent that isn't picked stays exactly the colourway's: it has to match the hoodie's own accent parts.)
  const out = outer != null ? keep(linHex(outer)) : accent;
  const base = keep(lining != null ? linHex(lining) : CAPE_IVORY);
  const yo = lum(out), yb = lum(base);
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  let trim = base;
  if (ratio(yo, yb) < TRIM_CONTRAST) {
    const lighter = (yo + 0.05) * TRIM_CONTRAST - 0.05, darker = (yo + 0.05) / TRIM_CONTRAST - 0.05;
    // The way it already leans, if there is room that way; else the other.
    const up = yb >= yo ? lighter <= TONE_MAX : darker < TONE_MIN;
    if (up) {
      const t = clampN((lighter - yb) / Math.max(1e-4, 1 - yb), 0, 1);
      trim = [base[0] + (1 - base[0]) * t, base[1] + (1 - base[1]) * t, base[2] + (1 - base[2]) * t];
    } else {
      const k = clampN(darker / Math.max(1e-4, yb), 0, 1);
      trim = [base[0] * k, base[1] * k, base[2] * k];
    }
  }
  const inner: V3 = lining != null ? [base[0] * 0.8, base[1] * 0.8, base[2] * 0.8] : CAPE_IVORY_SHADE;
  const yt = lum(trim);
  const clasp: V3 = lining == null ? CAPE_GOLD : yt >= 0.12 ? trim : [trim[0] + (0.12 - yt), trim[1] + (0.12 - yt), trim[2] + (0.12 - yt)];
  return [out, trim, inner, clasp];
}

/**
 * Where an item's motion pivots and turns (bind space), per fit: backs.ts puts it on the geometry. `pivot`: where its
 * chain is held (the cape's top hem, the balloon's knot, the stick's foot, a wing's root); `pivot2` and `axis`: the
 * spin's centre and axis (the key, the pinwheel's hub), the left flame's nozzle and its way out, the balloon's neck.
 * The cape's axis is [its length, 0 (the short cape) .. 1 (the longest), its hem's half-width]. `hang`: a cape that reaches below the hips: [the height it leaves the body at and
 * hangs by its own weight from, the ground's height under the feet] (model space, z up).
 */
export interface BackRig {
  pivot: V3;
  axis: V3;
  pivot2?: V3;
  hang?: [number, number];
  /** (The Robe's axis: [its free cloth's length, the hip line it hangs by its own weight below, units round to a side seam].) */
  /** The Robe (bunny/robe.ts): how far its sleeves hang below the arm's line, and their length along it. */
  robe?: { drop: number; sleeve: number; radius: number; from: number };
}

/** The legs a long cape hangs round, from the rig: [bone, a point in its bind space] per joint, left then right. */
const R = rig();
const joint = (bone: string, p: V3 = R.at(bone)) => `(getBoneMatrix(${R.bone(bone).toFixed(1)}) * vec4(${p.map((x) => x.toFixed(3)).join(", ")}, 1.0)).xyz`;
const legGlsl = (side: "L" | "R") => {
  const foot = R.at(`${side}_Foot`), toe = R.at(`${side}_Toe0`);
  // The heel behind the ankle and the shoe's tip past the ball of the foot, on the foot's and the toe's bones.
  const heel: V3 = [foot[0], foot[1] + 3.3, 2.6], tip: V3 = [toe[0], toe[1] - 4.2, 1.6];
  return `bkLeg(${joint(`${side}_Thigh`)}, ${joint(`${side}_Calf`)}, ${joint(`${side}_Foot`)}, ${joint(`${side}_Foot`, heel)}, ${joint(`${side}_Toe0`, tip)}, Sd, B, xs, transformed.z, need);`;
};

/** Vertex declarations. */
export const BACK_FX_VERTEX_PARS = /* glsl */ `
attribute vec4 backfx;
uniform vec4 uBack, uBackTip, uBackMid, uCape;
uniform vec3 uBackPivot, uBackPivot2, uBackAxis;
uniform vec3 uCapeTones[4];
// The bind-space position after the item's motion (before skinning).
vec3 bkBind;
varying float vBackFx;
// Rodrigues: v turned about the unit axis k by a.
vec3 bkRot(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
float bkCode() { return floor(backfx.x + 0.5); }
// A chain's angles (pitch, side) at weight w: the root's at first, through its middle's, going over to the free end's
// (with the middle at the root's, uBackMid = uBack.yz: root * w + (tip - root) * w^3).
vec2 bkAng(float w) { float v = 1.0 - w; return w * (uBack.yz * v * v + uBackMid.xy * 2.0 * w * v + uBackTip.xy * w * w); }
// The swing of a hanging point: side to side in the body's plane while it hangs, lifted back (+y) about the x axis,
// and the side going over to a (smaller) turn about the vertical as it streams out behind (a point toward -x for
// + side).
vec3 bkSwing(vec3 d, float pitch, float side) {
  float cp = cos(pitch), sp = sin(pitch);
  float c = cos(side * cp), s = sin(side * cp);
  d = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  c = cos(side * sp * 0.65); s = sin(side * sp * 0.65);
  return vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
// The cape at a bind-space point: 0 at its top hem .. 1 at the bottom; the hem takes the most swing, and a ripple runs
// down its lower part (more at its side edges). A long cape (uBackAxis.y, 0..1) is no board: at speed it fills (its
// middle bellies out behind its edges, breathing, and its hem spreads), long slow waves run down it out of step at its
// two sides, its corners flap each in its own time and lift unevenly (uBackMid.z, the twist), and a landing sends a
// soft wave down it (uBackMid.w, the seconds since).
vec3 bkCloth(vec3 p) {
  float s = clamp((uBackPivot.z - p.z) / uBackAxis.x, 0.0, 1.0);
  float w = pow(s, 1.3);
  float low = smoothstep(0.3, 1.0, s);
  float g = uBackAxis.y;
  p.y += uBack.w * low * (0.5 + 0.035 * min(p.x * p.x, 80.0)) * 0.62 * sin(p.z * 0.62 + p.x * 0.2 + uFinTime * 10.0);
  vec2 a = bkAng(w);
  if (g > 0.001) {
    float un = clamp(p.x / max(uBackAxis.z, 1.0), -1.0, 1.0), f = uBack.w, e = un * un * abs(un);
    p.y += g * f * low * (1.0 - un * un) * (2.6 + 0.8 * sin(uFinTime * 2.9));
    p.x *= 1.0 + g * f * low * (0.12 + 0.04 * sin(uFinTime * 3.7));
    p.y += g * f * low * low * 1.6 * sin(p.z * 0.24 + uFinTime * 6.3 + un * 1.9);
    p.y += g * f * low * e * 2.2 * sin(uFinTime * 7.9 + sign(un) * 2.1 + p.z * 0.31);
    float tw = uBackMid.w;
    float d = (s - 0.08 - tw * 1.5) / 0.17;
    p.y += g * 2.4 * exp(-d * d) * max(0.0, 1.0 - tw / 0.75) * (0.55 + 0.45 * (1.0 - un * un));
    a.x += (uBackMid.z * un + g * f * 0.07 * un * sin(uFinTime * 1.9)) * w;
  }
  return uBackPivot + bkSwing(p - uBackPivot, a.x, a.y);
}
// A wing about its root: raised by the flap (the root's going over to the tip's), then folded back; sx -1 is the right
// wing, mirrored. In a turn the inner wing folds a little more.
vec3 bkWing(vec3 d, float sx, float w) {
  float a = -sx * (uBack.w + (uBackTip.x - uBack.w) * w * w);
  float c = cos(a), s = sin(a);
  d = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
  a = sx * uBack.y * (1.0 + 0.3 * w) + uBack.z;
  c = cos(a); s = sin(a);
  return vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
vec3 bkMirror(vec3 p, float sx) { return vec3(sx * p.x, p.y, p.z); }
#ifdef USE_SKINNING
// A long cape hangs round the legs: each leg as a chain of balls from the hip to the knee, the ankle, the heel and the
// shoe's tip. Sd / B: the body's side and back directions (level); (xs, z): the cloth point across and up; need: how
// far back it has to be to clear the balls so far. The cloth lies over a ball like a tent: round over its top, falling
// away from it at a slope to the sides and above, and hanging straight down from it below (a foot kicked back holds
// out everything under it, not a pouch round the shoe).
void bkBall(vec3 c, float r, vec2 Sd, vec2 B, float xs, float z, inout float need) {
  float dx = xs - dot(c.xy, Sd), dz = max(z - c.z, 0.0), rho = sqrt(dx * dx + dz * dz);
  need = max(need, dot(c.xy, B) + (rho < r ? sqrt(r * r - rho * rho) : (r - rho) * 1.3));
}
void bkLeg(vec3 hip, vec3 knee, vec3 ankle, vec3 heel, vec3 tip, vec2 Sd, vec2 B, float xs, float z, inout float need) {
  for (int i = 0; i < 5; i++) {
    float t = float(i) / 4.0;
    bkBall(mix(hip, knee, t), mix(5.6, 4.7, t), Sd, B, xs, z, need);
    bkBall(mix(knee, ankle, t), mix(4.7, 3.9, t), Sd, B, xs, z, need);
  }
  for (int i = 0; i < 4; i++) bkBall(mix(heel, tip, float(i) / 3.0), 4.6, Sd, B, xs, z, need);
}
#endif`;

/**
 * Vertex, after <skinning_vertex>: a cape that reaches below the hips (uCape.x; BackRig.hang). Below the height it
 * leaves the body at (uCape.y) it hangs straight down from that line, whatever way the hips tip (a crouch, a tucked
 * hop); it is kept behind the legs and the shoes, which push it out as they swing back; and what would go below the
 * ground under the feet (uCape.z) lies along it, trailing behind.
 */
export const BACK_FX_VERTEX_SKINNED = /* glsl */ `
#ifdef USE_SKINNING
  if (uCape.x > 0.5 && backfx.x > 2.5 && backfx.x < 3.5) {
    mat4 bkM = boneMatX * skinWeight.x + boneMatY * skinWeight.y + boneMatZ * skinWeight.z + boneMatW * skinWeight.w;
    float below = uCape.y - bkBind.z;
    if (below > 0.0) transformed = (bkM * vec4(bkBind.xy, uCape.y, 1.0)).xyz - vec3(0.0, 0.0, below);
    vec2 B = (bkM * vec4(0.0, 1.0, 0.0, 0.0)).xy;
    B = dot(B, B) > 1e-6 ? normalize(B) : vec2(0.0, 1.0);
    vec2 Sd = vec2(B.y, -B.x);
    // Its layers keep their order where they are pushed together: the lining 0.3 under the outside; on an edge turned
    // back over the cape (there the bind normal of the outside faces the body and the lining's faces out) both lie on top.
    float faces = smoothstep(-0.3, 0.3, normal.y);
    float layer = backfx.w > 2.5 && backfx.w < 3.5 ? mix(-0.3, 1.3, faces) : mix(1.0, 0.0, faces);
    float yb = dot(transformed.xy, B), xs = dot(transformed.xy, Sd), base = yb - layer, need = base;
    ${legGlsl("L")}
    ${legGlsl("R")}
    // (A little air between the cloth and what holds it out.)
    transformed.xy += B * (need - base + (need > base + 1e-4 ? 0.5 : 0.0));
    float under = uCape.z - transformed.z;
    if (under > 0.0) {
      transformed.z = uCape.z + 0.3 + 0.25 * layer;
      transformed.xy += B * under * 0.85;
    }
  }
#endif`;

/** Vertex, after <beginnormal_vertex> (before skinning): the normal turns with the part. */
export const BACK_FX_VERTEX_NORMAL = /* glsl */ `
  if (backfx.x > 1.5 || backfx.y > 0.0) {
    float bc = bkCode();
    if (bc == 3.0) {
      // The bent cloth's own normal: across two steps along its surface.
      vec3 t1 = normalize(cross(objectNormal, abs(objectNormal.z) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
      vec3 t2 = cross(objectNormal, t1);
      vec3 p0 = bkCloth(position);
      objectNormal = normalize(cross(bkCloth(position + t1 * 0.35) - p0, bkCloth(position + t2 * 0.35) - p0));
    } else if (bc == 6.0) objectNormal = bkWing(objectNormal, position.x < 0.0 ? -1.0 : 1.0, backfx.y);
    else {
      if (bc == 2.0) objectNormal = bkRot(objectNormal, uBackAxis, uBack.x);
      else if (bc == 8.0) objectNormal = bkSwing(objectNormal, uBack.x, uBack.w);
      if (backfx.y > 0.0) { vec2 a = bkAng(backfx.y); objectNormal = bkSwing(objectNormal, a.x, a.y); }
    }
  }`;

/** Vertex, after <begin_vertex> (before skinning): the motion in bind space. */
export const BACK_FX_VERTEX_POSITION = /* glsl */ `
  vBackFx = backfx.x;
  if (backfx.x > 0.5) {
    float bc = bkCode();
    if (bc == 3.0) transformed = bkCloth(transformed);
    else if (bc == 6.0) {
      float sx = transformed.x < 0.0 ? -1.0 : 1.0;
      vec3 root = bkMirror(uBackPivot, sx);
      transformed = root + bkWing(transformed - root, sx, backfx.y);
    } else {
      if (bc == 2.0) transformed = uBackPivot2 + bkRot(transformed - uBackPivot2, uBackAxis, uBack.x);
      else if (bc == 8.0) transformed = uBackPivot2 + bkSwing(transformed - uBackPivot2, uBack.x, uBack.w);
      else if (bc == 5.0) {
        // From the nozzle the flame stretches with the flare and swells a little; it never burns quite steadily.
        float sx = transformed.x < 0.0 ? -1.0 : 1.0;
        vec3 nz = bkMirror(uBackPivot2, sx), ax = bkMirror(uBackAxis, sx);
        vec3 d = transformed - nz;
        float f = uBack.w * (1.0 + 0.09 * sin(uFinTime * 41.0 + sx * 1.7) + 0.06 * sin(uFinTime * 67.0 + sx));
        float al = dot(d, ax);
        transformed = nz + (d - ax * al) * (0.72 + 0.34 * f) + ax * al * (0.42 + 1.35 * f);
      }
      if (backfx.y > 0.0) { vec2 a = bkAng(backfx.y); transformed = uBackPivot + bkSwing(transformed - uBackPivot, a.x, a.y); }
    }
    transformed.z -= uBackTip.z * backfx.z;
  }
  bkBind = transformed;`;

/** Fragment declarations. */
export const BACK_FX_FRAGMENT_PARS = /* glsl */ `
varying float vBackFx;
uniform vec4 uBack;
bool bkFlame() { return vBackFx > 4.5 && vBackFx < 5.5; }`;

/** Fragment (solid), after the hat fx: the jet flame is self-lit, brighter in a flare; the shade in creases. */
export const BACK_FX_FRAGMENT_SOLID = /* glsl */ `
  if (bkFlame()) col = vColor * (0.95 + 0.9 * uBack.w) + vec3(0.12, 0.06, 0.0) * uBack.w;
  else if (vBackFx > 0.5) col *= 1.0 - 0.75 * max(0.0, vBackFx - floor(vBackFx + 0.03));`;

/** Fragment (ghost): the flame glows like the visor. */
export const BACK_FX_FRAGMENT_GHOST = /* glsl */ `
  if (bkFlame()) { col += mix(uGhost, vec3(1.0), 0.5) * (0.4 + 0.6 * uBack.w); a = max(a, uOpacity * 0.6); }`;
