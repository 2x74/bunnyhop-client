// Carrot Blade inspects: Hop Flip -> Double Flip -> Toss & Catch (combo chain: tap F for the Hop Flip, tap again during
// it for the Double Flip, again for the Toss). Original motion, authored per bone (kit.ts); CS2's butterfly / flip /
// classic inspects were only a reference for the rhythm (research/COSMETICS-PLAN.md §1.1).
//
// The fingers drive the trick: the thumb loads against the pommel and snaps off it, the index lets go first and the
// other fingers open after it as the carrot leaves the palm, the carrot spins flat above the open hand (the palm
// normal is the spin axis, so the blade sweeps over the fingers, never through them), and the fingers close back
// around the grip on the catch with a squeeze (overshoot) while the wrist dips under the weight.
//
// Clearance: tools/inspects/clearance (and apps/api/test/inspect-combo.test.ts) sweep every clip at 240 Hz against
// the capsule hand (clearance.ts): no new contact between the carrot and the hand at any frame.

import { hands, presented, PRESENT } from "./common";
import { AX, bump, E, hop, N, spline, track, W_, Xf, type V3 } from "./kit";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";

const X = new Xf();

/** Arm + wrist for a trick: the presented pose (0..1), extra roll / pitch / yaw (deg), shift (view units), wrist. */
function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, yaw: number, shift: V3, flex: number, dev: number): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * p + roll, PRESENT.pitch * p + pitch, PRESENT.yaw * p + yaw, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * p + shift[2]]);
  ctx.arm.wrist(W, flex, dev);
}

// -------------------------------------------------------------------------------------------------
// Hop Flip (base): present, thumb flick, the carrot hops off the palm and spins flat twice (hold F: it keeps
// spinning), drops back into the fingers, the forearm rolls to show the other face, settle.

const HF = { len: 2.85, enter: 0.34, exit: 2.25, open: 0.5, release: 0.38, catch: 1.2, loop: [0.6, 0.9] as [number, number] };
/** Spin (deg about the palm normal; negative = the blade swings toward the knuckles first, away from the thumb). */
const hfSpin = spline([
  [0.48, 0, 0],
  [0.6, -70, -1200],
  [0.9, -430, -1200],
  [1.18, -720, -260],
  [1.27, -723, 0],
  [1.38, -720, 0],
]);
/** Height of the grip above the palm (hand units along the palm normal). */
const hfHop = track([
  [0.48, 0],
  [0.6, 1.95, E.out],
  [0.9, 1.95],
  [1.18, 0.3, E.in],
  [1.36, 0, E.io],
]);
const hfRoll = track([
  [1.34, 0],
  [1.72, -128, E.whip],
  [1.98, -128],
  [2.25, 0, E.io],
]);

export const hopFlip: InspectClip = {
  id: "hop-flip",
  name: "Hop Flip",
  len: HF.len,
  enter: HF.enter,
  exit: HF.exit,
  open: HF.open,
  loop: HF.loop,
  free: [[0.48, HF.catch - 0.02]],
  cues: [
    { t: 0.45, type: "flip" },
    { t: 0.75, type: "spin" },
    { t: HF.catch, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, HF.enter, HF.exit, HF.len);
    const load = track([[0.34, 0], [0.43, 1, E.io], [0.5, -0.7, E.out], [0.7, 0, E.io]])(t);
    const dip = bump(t, HF.catch - 0.03, HF.catch + 0.42);
    const admire = track([[1.76, 0], [1.96, 1, E.io], [2.25, 0, E.io]])(t);
    // The wrist extends while the carrot is up (drops the cuff away from the spin plane).
    const ext = track([[0.46, 0], [0.62, 1, E.out], [1.08, 1], [1.2, 0, E.io]])(t);
    arm(W, ctx, p, hfRoll(t), 3 * load - 6 * dip, 0, [0, 0, -0.5 * dip], 10 * load + 9 * dip - 12 * ext, 9 * admire);
    hands(W, ctx, t, HF.release, HF.catch + 0.03, 7, HF.loop);
    const a = hfSpin(t), h = hfHop(t);
    if (a || h) {
      // Spin about the palm normal through the grip, lifted off the palm; airborne, the spin plane leans up toward the
      // wrist (clears the cuff) and precesses a little.
      const air = Math.min(1, (h / 1.95) * 1.6);
      const wob = 6 * Math.sin(((t - HF.loop[0]) / (HF.loop[1] - HF.loop[0])) * Math.PI * 2) * air;
      X.reset().rot(N, a).rot(AX, wob).rot(W_, 12 * air).move([0, 0, h]);
      ctx.arm.knifeXf(W, X);
    }
  },
};

// -------------------------------------------------------------------------------------------------
// Double Flip (chain 1): from the presented pose, a quick single flip that bounces off the palm, then a higher
// double flip, a heavier catch, a roll to admire, settle.

const DF = { len: 2.75, enter: 0.34, exit: 2.15, open: 0.62, release: 0.35, f2: 0.84, catch: 1.4 };
const dfSpin = spline([
  [0.42, 0, 0],
  [0.47, 6, 0],
  [0.62, -255, -1300],
  [0.8, -360, -350],
  [0.86, -372, -350],
  [1.0, -560, -1550],
  [1.38, -1080, -380],
  [1.47, -1083, 0],
  [1.58, -1080, 0],
]);
/** Two hops: a low one that comes back down onto the open fingers (a bounce, not a catch), then a high one. */
const dfHop = track([
  [0.45, 0],
  [0.6, 1.7, E.out],
  [0.8, 0.5, E.in2],
  [0.84, 0.45],
  [1.04, 2.7, E.out],
  [1.38, 0.3, E.in],
  [1.55, 0, E.io],
]);
const dfRoll = track([
  [1.6, 0],
  [1.88, 95, E.whip],
  [1.98, 95],
  [2.15, 0, E.io],
]);

export const doubleFlip: InspectClip = {
  id: "double-flip",
  name: "Double Flip",
  len: DF.len,
  enter: DF.enter,
  exit: DF.exit,
  open: DF.open,
  free: [[0.46, DF.catch - 0.02]],
  cues: [
    { t: 0.46, type: "flip" },
    { t: DF.f2, type: "flip" },
    { t: 1.12, type: "spin" },
    { t: DF.catch, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, DF.enter, DF.exit, DF.len);
    const kick = bump(t, 0.44, 0.74) + 1.3 * bump(t, DF.f2 - 0.02, DF.f2 + 0.3);
    const tapDip = bump(t, 0.78, 0.98);
    const dip = bump(t, DF.catch - 0.02, DF.catch + 0.48);
    const ext = track([[0.44, 0], [0.6, 1, E.out], [1.28, 1], [1.4, 0, E.io]])(t);
    arm(W, ctx, p, dfRoll(t), 4 * kick - 3 * tapDip - 8 * dip, 0, [0, 0, 0.3 * kick - 0.7 * dip], -8 * kick + 4 * tapDip + 12 * dip - 12 * ext, 0);
    hands(W, ctx, t, DF.release, DF.catch + 0.03, 5, [0.9, 1.2]);
    const a = dfSpin(t), h = dfHop(t);
    if (a || h) {
      const air = Math.min(1, (h / 1.95) * 1.6);
      X.reset().rot(N, a).rot(W_, 12 * air).move([0, 0, h]);
      ctx.arm.knifeXf(W, X);
    }
  },
};

// -------------------------------------------------------------------------------------------------
// Toss & Catch (chain 2, the cap): a dip to load, the carrot thrown up out of the open hand tumbling end over end
// (one full turn, blade down only at the top of the arc), the hand rises to meet it, a heavy catch, admire, settle.

const TC = { len: 3.0, enter: 0.34, exit: 2.35, open: 9, toss: 0.56, catch: 1.42 };
/** Flight in hand coordinates: up the blade axis (out of the top of the fist) and toward the camera side. */
const tcUp = (t: number) => hop(t, TC.toss, TC.catch, 12);
const tcOut = (t: number) => (t <= TC.toss || t >= TC.catch ? 0 : 4.4 * Math.sqrt(Math.sin((Math.PI * (t - TC.toss)) / (TC.catch - TC.toss))));
/** One end-over-end turn, only while the carrot is well clear of the hand (it rises and falls upright). */
const tcTumble = spline([
  [0.76, 0, 0],
  [0.99, 180, 1350],
  [1.22, 360, 0],
]);
const tcRoll = track([
  [1.62, 0],
  [1.95, -120, E.whip],
  [2.12, -120],
  [2.35, 0, E.io],
]);

export const tossCatch: InspectClip = {
  id: "toss-catch",
  name: "Toss & Catch",
  len: TC.len,
  enter: TC.enter,
  exit: TC.exit,
  open: TC.open,
  free: [[TC.toss, TC.catch]],
  cues: [
    { t: TC.toss, type: "flip" },
    { t: 0.99, type: "spin" },
    { t: TC.catch, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, TC.enter, TC.exit, TC.len);
    const load = track([[0.34, 0], [0.52, 1, E.io], [0.6, -0.8, E.out], [0.85, 0, E.io]])(t);
    const dip = bump(t, TC.catch - 0.02, TC.catch + 0.55);
    const ext = track([[0.56, 0], [0.7, 1, E.out], [1.3, 1], [1.42, 0, E.io]])(t);
    arm(W, ctx, p, tcRoll(t), 6 * load - 11 * dip, 0, [0, 0, -0.9 * load - 1.0 * dip], 14 * load + 14 * dip - 14 * ext, 0);
    hands(W, ctx, t, TC.toss - 0.07, TC.catch + 0.04);
    const up = tcUp(t), out = tcOut(t), a = tcTumble(t);
    if (up || a) {
      // Tumble about the knuckle axis (blade over toward the camera), then the flight offset.
      X.reset().rot(AX, a).move([0, up, out]);
      ctx.arm.knifeXf(W, X);
    }
  },
};

export const CARROT_INSPECTS = inspectSet("carrot", [hopFlip, doubleFlip, tossCatch]);
