// Inspects for the v0.0.38 garden knives (knives/carrotbayonet.ts, parsnip.ts, radish.ts, leek.ts, sprouts.ts): one
// trick of their own each (the chain's first, a tap of F), then a trick from an existing set that suits the shape.
//
//   bayonet  Present Arms -> Thorn Toss -> Double Toss    (bayonets.ts tosses)
//   parsnip  Needle Roll  -> Pinwheel -> Backspin          (bayonets.ts finger spins)
//   radish   Weight Check -> Hop Flip                      (carrot.ts)
//   leek     Salute       -> Twirl                         (daikon.ts)
//   sprouts  Pinwheel     -> Backspin                      (the twin points pinwheel)
//
// Grounded, original beats; no tosses above the hand except where the knife is light (the stiletto's roll is in the
// fingers). The quiet style plays the shared Quiet Check first (quiet.ts) for every one.

import { hands, presented, PRESENT, openFinger } from "./common";
import { bump, col, E, hop, pos, track, Xf, type V3 } from "./kit";
import type { InspectClip, InspectCtx } from "./types";

const X = new Xf();

function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, yaw: number, shift: V3, flex: number, dev: number): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * p + roll, PRESENT.pitch * p + pitch, PRESENT.yaw * p + yaw, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * p + shift[2]]);
  ctx.arm.wrist(W, flex, dev);
}

/** The held knife's long axis (z) in hand coordinates and a point at knife-local z on it. */
function knifeZ(W: Float32Array, ctx: InspectCtx, z: number): { z: V3; at: V3 } {
  const a = ctx.arm, f = a.frame(W);
  const kz = col(W, a.kb, 2), o = pos(W, a.kb);
  const d: V3 = [kz[0] * f.ax[0] + kz[1] * f.ax[1] + kz[2] * f.ax[2], kz[0] * f.w[0] + kz[1] * f.w[1] + kz[2] * f.w[2], kz[0] * f.n[0] + kz[1] * f.n[1] + kz[2] * f.n[2]];
  return { z: d, at: a.toHand(f, [o[0] + kz[0] * z, o[1] + kz[1] * z, o[2] + kz[2] * z]) };
}

// -------------------------------------------------------------------------------------------------
// Present Arms (Carrot Bayonet): the fist comes up square, the blade upright in front; the forearm turns the edge to
// you crisply, holds a beat, turns the flat back, and it returns. Drill-square: quick moves, still holds.

const PA = { len: 2.5, enter: 0.3, exit: 1.95, open: 0.5 };
export const presentArms: InspectClip = {
  id: "present-arms",
  name: "Present Arms",
  len: PA.len,
  enter: PA.enter,
  exit: PA.exit,
  open: PA.open,
  cues: [{ t: 0.62, type: "catch" }, { t: 1.42, type: "catch" }],
  apply(W, t, ctx) {
    const p = presented(t, PA.enter, PA.exit, PA.len);
    const edge = track([[0.45, 0], [0.62, -78, E.out], [1.25, -78], [1.42, 0, E.out]])(t);
    const tap = bump(t, 0.6, 0.85) + bump(t, 1.4, 1.65);
    arm(W, ctx, p, edge, -8 * p - 2 * tap, -6 * p, [0, 0, 0.4 * p], 2 * tap, 0);
  },
};

// -------------------------------------------------------------------------------------------------
// Needle Roll (Parsnip Stiletto): the fingers ease and the stiletto rolls once about its own length between the thumb
// and fingers (its four edges catching the light), then the wrist brings the point toward you for a look along it.

const NR = { len: 2.7, enter: 0.3, exit: 2.15, open: 0.55, r0: 0.5, r1: 1.05 };
export const needleRoll: InspectClip = {
  id: "needle-roll",
  name: "Needle Roll",
  len: NR.len,
  enter: NR.enter,
  exit: NR.exit,
  open: NR.open,
  cues: [{ t: NR.r0, type: "spin" }, { t: NR.r1, type: "catch" }],
  apply(W, t, ctx) {
    const p = presented(t, NR.enter, NR.exit, NR.len);
    const look = track([[1.25, 0], [1.6, 1, E.io], [1.85, 1], [2.1, 0, E.io]])(t);
    arm(W, ctx, p, 0, -4 * look, 10 * look, [0, 0, 0], 4 * look, -22 * look);
    // Fingers ease (not let go) for the roll.
    const ease = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - NR.r0 + 0.08) / (NR.r1 - NR.r0 + 0.16)))) ** 2;
    if (ease > 0) {
      const hf = ctx.arm.frame(W);
      for (const f of ["middle", "ring", "pinky"] as const) openFinger(ctx, W, hf, f, 0.45 * ease, undefined, undefined, 0, t > (NR.r0 + NR.r1) / 2);
    }
    const roll = 360 * E.io(Math.min(1, Math.max(0, (t - NR.r0) / (NR.r1 - NR.r0))));
    if (roll > 0 && roll < 360) {
      const { z, at } = knifeZ(W, ctx, 0);
      X.reset().rot(z, roll, at);
      ctx.arm.knifeXf(W, X);
    }
  },
};

// -------------------------------------------------------------------------------------------------
// Weight Check (Radish Kukri): presented, the fingers open and the kukri hops a little out of the palm twice (no
// spin: it's heavy), landing with a dip each time; then the forearm turns it to show the bend and it settles.

const WC = { len: 2.8, enter: 0.3, exit: 2.25, open: 0.6, h1: [0.5, 0.78] as [number, number], h2: [0.98, 1.24] as [number, number] };
export const weightCheck: InspectClip = {
  id: "weight-check",
  name: "Weight Check",
  len: WC.len,
  enter: WC.enter,
  exit: WC.exit,
  open: WC.open,
  free: [WC.h1, WC.h2],
  cues: [{ t: WC.h1[1], type: "catch" }, { t: WC.h2[1], type: "catch" }],
  apply(W, t, ctx) {
    const p = presented(t, WC.enter, WC.exit, WC.len);
    const dip = bump(t, WC.h1[1] - 0.02, WC.h1[1] + 0.3) + bump(t, WC.h2[1] - 0.02, WC.h2[1] + 0.35);
    const lift = bump(t, WC.h1[0] - 0.1, WC.h1[0] + 0.05) + bump(t, WC.h2[0] - 0.1, WC.h2[0] + 0.05);
    const show = track([[1.45, 0], [1.75, -70, E.io], [1.95, -70], [2.2, 0, E.io]])(t);
    arm(W, ctx, p, show, -6 * dip + 3 * lift, 0, [0, 0, -0.5 * dip + 0.2 * lift], 6 * dip, 0);
    hands(W, ctx, t, WC.h1[0] - 0.05, WC.h2[1] + 0.02);
    const h = hop(t, WC.h1[0], WC.h1[1], 1.1) + hop(t, WC.h2[0], WC.h2[1], 0.8);
    if (h > 0) {
      const tilt = 6 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - WC.h1[0]) / (WC.h2[1] - WC.h1[0]))));
      const { z, at } = knifeZ(W, ctx, 0);
      // Up the palm normal (out of the palm), a slight nose-down tilt in the air from the forward weight.
      X.reset().rot([z[1], -z[0], 0], tilt, at).move([0, 0, h]);
      ctx.arm.knifeXf(W, X);
    }
  },
};

// -------------------------------------------------------------------------------------------------
// Salute (Leek Saber): the arm brings the hilt up before the face, the blade upright; a beat; the blade sweeps down
// and out to the side, point low; a beat; and back to the carry. All arm, the wrist firm.

const SA = { len: 3.0, enter: 0.45, exit: 2.4, open: 0.6 };
export const salute: InspectClip = {
  id: "salute",
  name: "Salute",
  len: SA.len,
  enter: SA.enter,
  exit: SA.exit,
  open: SA.open,
  cues: [{ t: 1.25, type: "spin" }],
  apply(W, t, ctx) {
    const up = track([[0.05, 0], [0.5, 1, E.io], [1.0, 1], [1.4, 0, E.io]])(t);
    const down = track([[1.0, 0], [1.4, 1, E.io], [1.95, 1], [2.45, 0, E.io]])(t);
    // Up: the elbow lifts the fist toward the centre, the blade near vertical. Down: the arm swings out and down to
    // the side, the point low; the forearm turns the edge down.
    ctx.arm.arm(W, -10 * up + 18 * down, -16 * up + 22 * down, 22 * up - 12 * down, [0.6 * up + 0.8 * down, 1.8 * up - 0.6 * down, 1.6 * up - 0.6 * down]);
  },
};
