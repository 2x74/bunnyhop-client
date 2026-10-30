// Whirligig inspects (knives/whirligig.ts): Flick -> Pinwheel -> Backspin (tap F, re-press to chain; hold F in the
// Pinwheel and it keeps spinning, the spinner too). Original motion.
//
//   Flick      present with the flat of the blade to you, the thumb lifts off the grip and flicks the spinner (it
//              races, then spins down while you look at it), a second, lighter flick, a turn of the wrist to show the
//              other plate, settle.
//   Pinwheel   the Thistle's finger spin (inspects/bayonets.ts) round the index finger, the spinner racing the other
//              way while the knife turns.
//   Backspin   the Thistle's two fast turns and one back, the spinner kicked on the hitch.
//
// The spinner (KnifeState.angles[0], the Whirl_Spin bone) already turns on the wall clock (the hold's pose); these add
// to it. Every addition ends on a whole number of thirds of a turn (the spinner is three-fold symmetric), so a trick
// cancelled or finished never shows it jump.

import { openThumb, presented, PRESENT } from "./common";
import { E, track, type V3 } from "./kit";
import { backspin, pinwheel } from "./bayonets";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";
import { whirlKick } from "../knives/whirligig";

/** Adds `spin(t)` (deg) to the spinner after `clip` has posed the frame. */
function withSpinner(clip: InspectClip, id: string, spin: (t: number) => number): InspectClip {
  return {
    ...clip,
    id,
    apply(W, t, ctx) {
      clip.apply(W, t, ctx);
      if (ctx.state?.angles.length) ctx.state.angles[0] += spin(t);
    },
  };
}

/** The spinner's turn for a flick at t0: `thirds` thirds of a turn, most of it in the first half second. */
const flickSpin = (t: number, t0: number, thirds: number, dur = 1.6) => whirlKick(t, t0, dur, thirds);

const FL = { len: 3.2, enter: 0.34, exit: 2.62, open: 0.7, flick: 0.62, flick2: 1.5 };
/** The thumb's flick: lifts (wind-up), snaps across the spinner, back onto the grip. */
const thumbFlick = (t: number, t0: number) => track([[t0 - 0.2, 0], [t0 - 0.06, 0.55, E.out], [t0, 0.9, E.in], [t0 + 0.14, 0.35, E.out], [t0 + 0.34, 0, E.io]])(t);

export const flick: InspectClip = {
  id: "whirl-flick",
  name: "Flick",
  len: FL.len,
  enter: FL.enter,
  exit: FL.exit,
  open: FL.open,
  cues: [
    { t: FL.flick, type: "spin" },
    { t: FL.flick2, type: "spin" },
  ],
  apply(W: Float32Array, t: number, ctx: InspectCtx) {
    const a = ctx.arm;
    const p = presented(t, FL.enter, FL.exit, FL.len);
    // Present, but the forearm rolls the other way from the usual present (the flat of the blade and the front plate to you),
    // the fist a little higher and nearer the middle; a nod on each flick, a turn of the wrist to the back plate late.
    const nod = 3 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - FL.flick) / 0.3))) + 2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - FL.flick2) / 0.3)));
    const turn = track([[1.95, 0], [2.2, 1, E.io], [2.42, 1], [2.62, 0, E.io]])(t);
    const s: V3 = PRESENT.shift;
    a.arm(W, -8 * p - 48 * turn * p, 10 * p + nod, 14 * p, [s[0] * p, s[1] * p * 0.7, s[2] * p + 0.5 * p]);
    a.wrist(W, -8 * p, 6 * p);
    // The thumb: off the grip and across the spinner, twice (the second lighter).
    const hf = a.frame(W);
    const k = 0.5 * Math.max(thumbFlick(t, FL.flick), 0.7 * thumbFlick(t, FL.flick2));
    openThumb(ctx, W, hf, k, t > FL.flick && t < FL.flick + 0.34);
    if (ctx.state?.angles.length) ctx.state.angles[0] += flickSpin(t, FL.flick, 12) + flickSpin(t, FL.flick2, 6, 1.1);
  },
};

/**
 * A spin that runs up from t0 to `loop`'s start, turns `per` deg (a whole number of thirds) on every pass of the hold
 * loop, and after it slows to a stop on a whole number of thirds: seamless when the loop wraps and when it ends.
 */
export function loopedSpin(t: number, t0: number, loop: readonly [number, number], per: number): number {
  const [a, b] = loop;
  const w = per / (b - a), r = a - t0, A = (w * r) / 2;
  if (t <= t0) return 0;
  if (t < a) return (w * (t - t0) ** 2) / (2 * r);
  if (t <= b) return A + w * (t - a);
  const at = A + per;
  const target = Math.sign(per) * Math.ceil((Math.abs(at) + Math.abs(w) * 0.35) / 120) * 120;
  const X = target - at, d = (2 * X) / w;
  const u = Math.min(1, (t - b) / d);
  return at + X * (1 - (1 - u) ** 2);
}

/** Pinwheel: the spinner races against the knife's turn while it's on the finger, a third of a turn per loop pass. */
export const whirlPinwheel = withSpinner(pinwheel, "whirl-pinwheel", (t) => loopedSpin(t, 0.62, pinwheel.loop ?? [0.77, 1.03], -240));
/** Backspin: a kick as it leaves the fist and another on the hitch (1.1 - 1.24). */
export const whirlBackspin = withSpinner(backspin, "whirl-backspin", (t) => flickSpin(t, 0.6, 9, 0.9) + flickSpin(t, 1.18, -6, 1.2));

export const WHIRLIGIG_INSPECTS = inspectSet("whirligig", [flick, whirlPinwheel, whirlBackspin]);
