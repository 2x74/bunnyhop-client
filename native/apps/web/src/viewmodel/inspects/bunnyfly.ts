// Bunnyfly (balisong) inspects: Flick Flip -> Fan Flips -> Aerial (tap F, re-press to chain; hold F during the fan
// flips to keep flipping). The Bunnyfly idles open (knives/bunnyfly.ts), so every trick starts and ends open: it only
// closes inside them. Original motion; CS2's butterfly inspect (flick open, fan spins, pinch hold) was only a
// reference for the rhythm (research/COSMETICS-PLAN.md §1.1).
//
// Rig contract (knives/bunnyfly.ts, rig.ts EXTRA_BONES): Knife_Handle is the SAFE handle (the one the fist keeps),
// v_weapon.Bfly_Blade turns about pin A relative to it and v_weapon.Bfly_Bite about pin B relative to the blade, by
// KnifeState.angles = [blade, bite] (deg; 0 open, 180 closed). The clips write those angles (the viewmodel re-solves
// the two bones after the inspect, KnifeHold.solve) and re-centre the closed bundle in the fist like the hold does
// (state.offset y = -2 pinY when closed). Without the extra bones (state null, e.g. an older rig) the clips still play
// the arm / finger / whole-knife motion: the balisong just doesn't open (the stub path).
//
// The fist keeps the safe handle with the thumb and the index (lifted a little off it, so its tip clears the blade
// swinging over); the middle, ring and little fingers let go while the blade swings shut over them and back (the bite
// handle stays in the palm, its angle the blade's negative), and close on both handles again.

import { BFLY } from "../rig";
import { openFinger, openThumb, presented, PRESENT, squeeze } from "./common";
import { AX, bump, E, hop, N, spline, track, Xf, type V3 } from "./kit";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";

const X = new Xf();
const BUNDLE = 2 * BFLY.pinY;

/** Sets the balisong angles, and moves the knife by the closed bundle's re-centring for that closedness (relative to
 * what the hold layer applied this frame: knives/bunnyfly.ts keeps the closed bundle centred in the fist). */
function balisong(W: Float32Array, ctx: InspectCtx, blade: number, bite: number): void {
  const st = ctx.state;
  if (!st || st.angles.length < 2) return;
  st.angles[0] = blade;
  st.angles[1] = bite;
  const closed = Math.min(1, Math.abs(blade) / 180);
  const d = -BUNDLE * closed * closed * (3 - 2 * closed) - st.offset[1];
  if (Math.abs(d) > 1e-4) {
    const k = ctx.arm.kb * 12;
    const dx = W[k + 1] * d, dy = W[k + 5] * d, dz = W[k + 9] * d;
    for (const i of ctx.arm.knife) (W[i * 12 + 3] += dx), (W[i * 12 + 7] += dy), (W[i * 12 + 11] += dz);
  }
}

/** Middle / ring / little fingers let go over [o, c] (the index and thumb keep the safe handle; `all` frees them too). */
function release(W: Float32Array, ctx: InspectCtx, t: number, spans: [number, number][], all = false): void {
  const hf = ctx.arm.frame(W);
  let k = 0, closing = false;
  for (const [o, c] of spans) {
    if (t >= o && t < c) k = Math.max(k, E.out((t - o) / 0.08));
    else if (t >= c && t < c + 0.16) {
      k = Math.max(k, 1 - squeeze((t - c) / 0.16));
      closing = true;
    }
  }
  if (!k) return;
  (["middle", "ring", "pinky"] as const).forEach((f) => openFinger(ctx, W, hf, f, k, undefined, undefined, 0, closing));
  if (all) {
    openFinger(ctx, W, hf, "index", k, undefined, undefined, 0, closing);
    openThumb(ctx, W, hf, k, closing);
  } else openFinger(ctx, W, hf, "index", k * 0.6, undefined, undefined, 0, closing);
}

function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, flex: number, dev: number, shift: V3 = [0, 0, 0]): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * 0.7 * p + roll, PRESENT.pitch * p + pitch, PRESENT.yaw * p, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * p + shift[2]]);
  ctx.arm.wrist(W, flex, dev);
}

// -------------------------------------------------------------------------------------------------
// Flick Flip (base): from the open idle the blade flicks shut over the bite handle (it swings round outside the
// fingers), a beat closed, then flicks open again and the bite handle drops back and latches; the hand turns the open
// knife both ways to show it.

const FO = { len: 2.85, enter: 0.32, exit: 2.3, open: 0.5 };
// (Negative: the blade swings shut over the fingers' side, which let go for it, not round the heel of the hand.)
const foBlade = track([
  [0.4, 0],
  [0.56, -180, E.out],
  [0.86, -180],
  [1.02, 0, E.out],
]);
// The bite handle stays in the hand while the blade swings round onto it (bite = -blade keeps it still: the angles are
// relative to the blade); closed is (-180, 180), the same bundle as (180, 180).
const foBite = (t: number) => -foBlade(t);

export const flickOpen: InspectClip = {
  id: "flick-open",
  name: "Flick Flip",
  len: FO.len,
  enter: FO.enter,
  exit: FO.exit,
  open: FO.open,
  cues: [
    { t: 0.4, type: "flip" },
    { t: 0.62, type: "catch" },
    { t: 0.86, type: "flip" },
    { t: 1.2, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, FO.enter, FO.exit, FO.len);
    const flick = bump(t, 0.38, 0.66) + bump(t, 0.84, 1.12);
    const latch = bump(t, 0.6, 0.9) + bump(t, 1.18, 1.5);
    const roll = track([[1.3, 0], [1.55, -85, E.whip], [1.72, -85], [1.95, 35, E.whip], [2.12, 0, E.io]])(t);
    arm(W, ctx, p, roll, 4 * flick - 5 * latch, -14 * flick + 8 * latch, 8 * flick);
    release(W, ctx, t, [
      [0.38, 0.62],
      [0.84, 1.2],
    ]);
    balisong(W, ctx, foBlade(t), foBite(t));
  },
};

// -------------------------------------------------------------------------------------------------
// Fan Flips (chain 1): three close-open flips in a row from the open knife, the wrist whipping each one round (hold F:
// it keeps flipping), then it settles open.

const FF = { len: 2.9, enter: 0.32, exit: 2.3, open: 0.6, t0: 0.42, P: 0.42, n: 3 };
const ffEnd = FF.t0 + FF.P * FF.n;

export const fanFlips: InspectClip = {
  id: "fan-flips",
  name: "Fan Flips",
  len: FF.len,
  enter: FF.enter,
  exit: FF.exit,
  open: FF.open,
  loop: [FF.t0 + FF.P, FF.t0 + 2 * FF.P],
  cues: [
    ...Array.from({ length: FF.n }, (_, i) => ({ t: FF.t0 + i * FF.P, type: "flip" as const })),
    { t: FF.t0 + FF.P * 1.5, type: "spin" as const },
    { t: ffEnd, type: "catch" as const },
  ],
  apply(W, t, ctx) {
    const p = presented(t, FF.enter, FF.exit, FF.len);
    const ph = t > FF.t0 && t < ffEnd ? ((t - FF.t0) / FF.P) % 1 : 0;
    const s = Math.sin(ph * Math.PI * 2);
    // Each flip: the blade swings shut over the (open) fingers and back out (0 -> -180 -> 0); the bite handle stays
    // in the palm (relative angle = -blade), so it never sweeps the heel of the hand.
    const blade = -(90 - 90 * Math.cos(ph * Math.PI * 2));
    const bite = -blade;
    const on = t > FF.t0 - 0.05 && t < ffEnd + 0.1 ? 1 : 0;
    const settle = bump(t, ffEnd - 0.02, ffEnd + 0.4);
    arm(W, ctx, p, 20 * s * on, 3 * Math.abs(s) * on - 5 * settle, -10 * s * on + 7 * settle, 12 * Math.cos(ph * Math.PI * 2) * on - 12 * on);
    release(W, ctx, t, [[FF.t0 - 0.06, ffEnd]]);
    balisong(W, ctx, blade, bite);
  },
};

// -------------------------------------------------------------------------------------------------
// Aerial (chain 2, the cap): the knife flicks shut, the closed bundle is thrown up out of the open hand, tumbling end
// over end and flicking open in the air; the fist catches it open by the safe handle.

const AE = { len: 2.8, enter: 0.32, exit: 2.25, open: 9, toss: 0.52, catch: 1.36 };
const aeUp = (t: number) => hop(t, AE.toss, AE.catch, 10);
const aeOut = (t: number) => (t <= AE.toss || t >= AE.catch ? 0 : 3.6 * Math.sqrt(Math.sin((Math.PI * (t - AE.toss)) / (AE.catch - AE.toss))));
const aeTumble = spline([
  [0.72, 0, 0],
  [0.94, 180, 1400],
  [1.16, 360, 0],
]);
const aeBlade = track([
  [0.2, 0],
  [0.36, -180, E.out],
  [0.8, -180],
  [1.0, 0, E.out],
]);
const aeBite = track([
  [0.24, 0],
  [0.42, 180, E.in2],
  [0.95, 180],
  [1.18, 0, E.io],
]);

export const aerial: InspectClip = {
  id: "aerial",
  name: "Aerial",
  len: AE.len,
  enter: AE.enter,
  exit: AE.exit,
  open: AE.open,
  free: [[AE.toss, AE.catch]],
  cues: [
    { t: AE.toss, type: "flip" },
    { t: 0.94, type: "spin" },
    { t: AE.catch, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, AE.enter, AE.exit, AE.len);
    const load = track([[0.32, 0], [0.48, 1, E.io], [0.56, -0.8, E.out], [0.8, 0, E.io]])(t);
    const dip = bump(t, AE.catch - 0.02, AE.catch + 0.55);
    const ext = track([[0.52, 0], [0.66, 1, E.out], [1.24, 1], [1.36, 0, E.io]])(t);
    const roll = track([[1.6, 0], [1.85, -70, E.whip], [1.96, -70], [2.1, 0, E.io]])(t);
    const shut = bump(t, 0.18, 0.46);
    arm(W, ctx, p, roll, 6 * load - 11 * dip, 14 * load + 14 * dip - 14 * ext - 10 * shut, 6 * shut, [0, 0, -0.9 * load - 1.0 * dip]);
    release(W, ctx, t, [[0.16, 0.5], [AE.toss - 0.07, AE.catch + 0.04]], true);
    // (Shut in the hand like the Flick Flip, the bite handle staying in the palm; it opens fully in the air.)
    balisong(W, ctx, aeBlade(t), t < AE.toss ? -aeBlade(t) : aeBite(t));
    const up = aeUp(t), out = aeOut(t), a = aeTumble(t);
    if (up || a) {
      X.reset().rot(AX, a).move([0, up, out]);
      ctx.arm.knifeXf(W, X);
    }
  },
};
void N;

export const BUNNYFLY_INSPECTS = inspectSet("bunnyfly", [flickOpen, fanFlips, aerial], 8);
