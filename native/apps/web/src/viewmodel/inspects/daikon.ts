// Daikon-tana inspects: Twirl -> Blade Check -> Reverse Sheath (tap F, re-press to chain; hold F during the twirl to
// keep it turning). Original motion; katana flourishes in general were the reference for the beats.
//
//   Twirl           the fingers let go, the sword turns once flat over the open hand (palm normal axis, lifted clear
//                   of the fingers, the plane tilted up over the cuff), regrip, a roll to show the blade.
//   Blade Check     the blade comes up level across the screen, flat to the camera; a slow look along the edge, the
//                   forearm turns it over to the other face, back.
//   Reverse Sheath  half a turn over the open hand into a reverse grip, the arm draws back as if sheathing it along
//                   the forearm, holds, and half a turn back into the forward grip.

import { hands, presented, PRESENT } from "./common";
import { bump, E, N, spline, track, W_, Xf, type V3 } from "./kit";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";

const X = new Xf();

function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, yaw: number, shift: V3, flex: number, dev: number): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * 0.8 * p + roll, PRESENT.pitch * 0.6 * p + pitch, PRESENT.yaw * p + yaw, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * 0.5 * p + shift[2]]);
  ctx.arm.wrist(W, flex, dev);
}

/** Flat turn of the sword about the palm normal, lifted by h, the plane leaning up over the wrist while airborne. */
function turn(W: Float32Array, ctx: InspectCtx, deg: number, h: number): void {
  if (!deg && !h) return;
  const air = Math.min(1, h * 0.8);
  X.reset().rot(N, deg).rot(W_, 14 * air).move([0, 0, h]);
  ctx.arm.knifeXf(W, X);
}

// -------------------------------------------------------------------------------------------------

const TW = { len: 2.6, enter: 0.32, exit: 2.05, open: 0.5, release: 0.4, per: 0.46 };
const twF = TW.release + 0.06;
const twLand = twF + TW.per;
const twSpin = spline([
  [TW.release, 0, 0],
  [twF - 0.035, 10, 0],
  [twF, 0, -360 / TW.per],
  [twLand, -360, -360 / TW.per],
  [twLand + 0.07, -364, 0],
  [twLand + 0.2, -360, 0],
]);
const twHop = track([
  [twF - 0.07, 0],
  [twF, 1.6, E.out],
  [twLand, 1.6],
  [twLand + 0.1, 0.3, E.in2],
  [twLand + 0.22, 0, E.io],
]);

export const twirl: InspectClip = {
  id: "twirl",
  name: "Twirl",
  len: TW.len,
  enter: TW.enter,
  exit: TW.exit,
  open: TW.open,
  loop: [twF, twLand],
  free: [[twF - 0.06, twLand + 0.1]],
  cues: [
    { t: twF, type: "flip" },
    { t: twF + TW.per / 2, type: "spin" },
    { t: twLand, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, TW.enter, TW.exit, TW.len);
    const dip = bump(t, twLand - 0.02, twLand + 0.45);
    const ext = track([[twF - 0.04, 0], [twF + 0.1, 1, E.out], [twLand - 0.04, 1], [twLand + 0.1, 0, E.io]])(t);
    const roll = track([[1.3, 0], [1.6, -75, E.whip], [1.75, -75], [2.05, 0, E.io]])(t);
    arm(W, ctx, p, roll, -6 * dip, 0, [0, 0, -0.5 * dip], 10 * dip - 12 * ext, 0);
    hands(W, ctx, t, TW.release - 0.04, twLand + 0.1);
    turn(W, ctx, twSpin(t), twHop(t));
  },
};

// -------------------------------------------------------------------------------------------------

const BC = { len: 3.1, enter: 0.32, exit: 2.6, open: 9 };

export const bladeCheck: InspectClip = {
  id: "blade-check",
  name: "Blade Check",
  len: BC.len,
  enter: BC.enter,
  exit: BC.exit,
  open: BC.open,
  cues: [
    { t: 0.5, type: "spin" },
    { t: 1.55, type: "spin" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, BC.enter, BC.exit, BC.len);
    // Up level across the screen (the fist comes in, the wrist lays the blade flat), a slow slide along the edge.
    const level = track([[0.36, 0], [0.7, 1, E.out], [2.25, 1], [2.6, 0, E.io]])(t);
    const look = track([[0.75, 0], [1.4, 1, E.io], [1.5, 1], [2.2, 0, E.io]])(t);
    const over = track([[1.42, 0], [1.72, 1, E.whip], [2.05, 1], [2.3, 0, E.io]])(t);
    arm(W, ctx, p, -40 * level + 170 * over, 8 * level, 18 * level + 6 * look, [-0.8 * look, 1.2 * look, 0.6 * level], 0, -55 * level);
  },
};

// -------------------------------------------------------------------------------------------------

const RS = { len: 3.3, enter: 0.32, exit: 2.75, open: 9 };
const rsSpin = spline([
  [0.4, 0, 0],
  [0.46, 8, 0],
  [0.5, 0, -900],
  [0.7, -180, -500],
  [0.78, -182, 0],
  [0.86, -180, 0],
  [1.9, -180, 0],
  [1.96, -188, 0],
  [2.0, -180, 900],
  [2.2, 0, 500],
  [2.28, 2, 0],
  [2.36, 0, 0],
]);
const rsHop = track([
  [0.48, 0],
  [0.55, 1.6, E.out],
  [0.66, 1.6],
  [0.74, 0, E.io],
  [1.98, 0],
  [2.05, 1.6, E.out],
  [2.16, 1.6],
  [2.24, 0, E.io],
]);

export const reverseSheath: InspectClip = {
  id: "reverse-sheath",
  name: "Reverse Sheath",
  len: RS.len,
  enter: RS.enter,
  exit: RS.exit,
  open: RS.open,
  free: [
    [0.5, 0.72],
    [2.0, 2.22],
  ],
  cues: [
    { t: 0.5, type: "flip" },
    { t: 0.72, type: "catch" },
    { t: 2.0, type: "flip" },
    { t: 2.22, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, RS.enter, RS.exit, RS.len);
    // The sheathing draw: the fist pulls back and down, the reverse blade lying along the forearm.
    const sheath = track([[0.85, 0], [1.25, 1, E.io], [1.6, 1], [1.9, 0, E.io]])(t);
    const dip = bump(t, 0.7, 1.1) + bump(t, 2.2, 2.6);
    arm(W, ctx, p, 60 * sheath, -10 * sheath - 5 * dip, -12 * sheath, [-2.2 * sheath, -0.6 * sheath, -1.6 * sheath], 8 * dip, 0);
    hands(W, ctx, t, 0.44, 0.74);
    hands(W, ctx, t, 1.94, 2.24);
    turn(W, ctx, rsSpin(t), rsHop(t));
  },
};

export const DAIKON_INSPECTS = inspectSet("daikon", [twirl, bladeCheck, reverseSheath]);
