// Bunnyfly (balisong) inspects: Flip Check -> Flip Flops -> Aerial (tap F, re-press to chain; hold F during the Flip
// Flops to keep flipping). The Quiet inspect style plays the shared blade check (quiet.ts) first: latched, no flips.
// Original motion built on the real object's mechanism (knives/balisong.ts): every trick starts and ends open and
// latched, knocks the latch off first, and the handles only ever swing away from each other.
//
// Rig contract (knives/bunnyfly.ts, rig.ts EXTRA_BONES): Knife_Handle is the SAFE handle (the one the fist keeps),
// state.angles = [blade (pin A, relative to the safe handle), bite (pin B, relative to the blade), latch] in degrees,
// all in [0, 180]: 0 open / latched open, 180 closed / latched closed, latch 90 hanging free. The clips write those
// angles (the viewmodel solves the bones after them) and re-centre the closed bundle in the fist like the hold does
// (state.offset y = -2 pinY when closed). Without the extra bones (state null) the clips still play the arm, finger
// and whole-knife motion: the balisong just doesn't open.
//
// Hand: the fist keeps the safe handle with the thumb and the index; the middle, ring and little fingers let go while
// the handles swing (the bite handle and the blade both swing out of the fist and back into it) and close again with a
// squeeze. The wrist throws every swing: closing turns the parts one way round the pins, opening the other way, so the
// wrist's flicks alternate with them.

import { concat } from "../../player/bunny/rig";
import { biteTurn, ease, flipClear, latchFree, swing } from "../knives/balisong";
import { palmNormalLocal } from "../knives/bayonet";
import { BFLY } from "../rig";
import { openFinger, openThumb, presented, PRESENT, squeeze } from "./common";
import { col, E, hop, track, Xf, type V3 } from "./kit";
import { inspectSet, type InspectClip, type InspectCtx } from "./types";

const X = new Xf();
const BUNDLE = 2 * BFLY.pinY;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hump = (t: number, a: number, b: number) => Math.sin(Math.PI * clamp01((t - a) / (b - a))) ** 2;

/**
 * Sets the balisong angles, and moves the knife by the closed bundle's re-centring for that closedness (relative to
 * what the hold layer applied this frame: knives/bunnyfly.ts keeps the closed bundle centred in the fist).
 */
function balisong(W: Float32Array, ctx: InspectCtx, blade: number, bite: number, latch: number): void {
  const st = ctx.state;
  if (!st || st.angles.length < 3) return;
  st.angles[0] = blade;
  st.angles[1] = bite;
  st.angles[2] = latch;
  const closed = clamp01(blade / 180);
  const d = -BUNDLE * closed * closed * (3 - 2 * closed) - st.offset[1];
  if (Math.abs(d) > 1e-4) {
    const k = ctx.arm.kb * 12;
    const dx = W[k + 1] * d, dy = W[k + 5] * d, dz = W[k + 9] * d;
    for (const i of ctx.arm.knife) (W[i * 12 + 3] += dx), (W[i * 12 + 7] += dy), (W[i * 12 + 11] += dz);
  }
}

/**
 * Held in the thumb and index while the other fingers are open, the knife turns flat to the palm and rides a little
 * off it (knives/balisong.ts flipClear): the parts swinging round the heel of the hand clear the palm.
 */
const CLEAR = new Float32Array(12), KM = new Float32Array(12);
function lift(W: Float32Array, ctx: InspectCtx, k: number): void {
  if (k <= 0 || !ctx.knife) return;
  flipClear(k, palmNormalLocal(ctx.knife), CLEAR);
  for (const i of ctx.arm.knife) {
    concat(W, i * 12, CLEAR, 0, KM, 0);
    W.set(KM, i * 12);
  }
}

/** Middle / ring / little fingers let go over [o, c] (the index and thumb keep the safe handle; `all` frees them too); the knife lifts off the palm with them. */
function release(W: Float32Array, ctx: InspectCtx, t: number, spans: [number, number][], all = false): void {
  const hf = ctx.arm.frame(W);
  let k = 0, closing = false;
  for (const [o, c] of spans) {
    if (t >= o && t < c) k = Math.max(k, E.out((t - o) / 0.07));
    else if (t >= c && t < c + 0.16) {
      k = Math.max(k, 1 - squeeze((t - c) / 0.16));
      closing = true;
    }
  }
  if (!k) return;
  if (!all) lift(W, ctx, k);
  (["middle", "ring", "pinky"] as const).forEach((f) => openFinger(ctx, W, hf, f, k, undefined, undefined, 0, closing));
  if (all) {
    openFinger(ctx, W, hf, "index", k, undefined, undefined, 0, closing);
    openThumb(ctx, W, hf, k, closing);
  } else {
    openFinger(ctx, W, hf, "index", k * 0.8, undefined, undefined, 0, closing);
    // The thumb lifts off its base while the parts swing past it (the knife rides in the index's crook).
    openThumb(ctx, W, hf, k * 0.7, closing);
  }
}

/** The presented arm, plus a roll / pitch, and the wrist: flex, and `turn` about the pin axis (deg, + = the opening way round). */
function arm(W: Float32Array, ctx: InspectCtx, p: number, roll: number, pitch: number, flex: number, turn: number, shift: V3 = [0, 0, 0]): void {
  const s = PRESENT.shift;
  ctx.arm.arm(W, PRESENT.roll * 0.7 * p + roll, PRESENT.pitch * p + pitch, PRESENT.yaw * p, [s[0] * p + shift[0], s[1] * p + shift[1], s[2] * p + shift[2]]);
  // Wrist deviation turns the knife about its pin axis (~0.82 deg per deg on this hold).
  ctx.arm.wrist(W, flex, turn / 0.82);
}

/** A latch track: locked open until `off` (knocked off over 0.06 s), hanging free, swung home over [home, home + 0.08]. */
function latchTrack(t: number, off: number, home: number, turn: (t: number) => number, closedHome?: [number, number]): number {
  if (t < off) return 0;
  const free = () => latchFree(t, turn);
  if (t < off + 0.06) return ease(t, off, off + 0.06, 0, free());
  if (closedHome && t >= closedHome[0] && t < closedHome[1]) {
    // Locked across the closed bundle for a beat, then knocked off again.
    const [a, b] = closedHome;
    if (t < a + 0.08) return ease(t, a, a + 0.08, free(), 180);
    if (t < b - 0.06) return swing(t, a, a + 0.08, 90, 180, 5);
    return ease(t, b - 0.06, b, 180, free());
  }
  if (t < home) return free();
  if (t < home + 0.08) return ease(t, home, home + 0.08, free(), 0);
  return swing(t, home, home + 0.08, 90, 0, 5);
}

// -------------------------------------------------------------------------------------------------
// Flip Check (base): the latch knocked off, a basic closing (the blade swings down into the safe handle with the bite
// handle riding on it, then the bite handle wraps round onto the closed blade), the closed bundle latched and turned
// to show it, then a basic opening and the latch home; the hand turns the open knife to show its face.

const FC = { len: 3.1, enter: 0.32, exit: 2.55, open: 0.55 };
const fcBlade = (t: number) => (t < 1.5 ? swing(t, 0.46, 0.58, 0, 180) : swing(t, 1.78, 1.9, 180, 0));
const fcBite = (t: number) => (t < 1.5 ? swing(t, 0.62, 0.74, 0, 180) : swing(t, 1.62, 1.74, 180, 0));
const fcTurn = (t: number) => biteTurn(fcBlade(t), fcBite(t));

export const flipCheck: InspectClip = {
  id: "flip-check",
  name: "Flip Check",
  len: FC.len,
  enter: FC.enter,
  exit: FC.exit,
  open: FC.open,
  cues: [
    { t: 0.46, type: "flip" },
    { t: 0.58, type: "catch" },
    { t: 0.74, type: "catch" },
    { t: 1.62, type: "flip" },
    { t: 1.74, type: "catch" },
    { t: 1.9, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, FC.enter, FC.exit, FC.len);
    // Wrist throws: closing turns the parts the negative way, opening the positive way; each throw leads its swing.
    const turn = -12 * hump(t, 0.4, 0.56) - 10 * hump(t, 0.56, 0.72) + 12 * hump(t, 1.56, 1.72) + 13 * hump(t, 1.72, 1.88) - 5 * hump(t, 1.88, 2.02);
    const roll = track([[0.98, 0], [1.22, -48, E.io], [1.36, -48], [1.56, 0, E.io], [2.12, 0], [2.36, -70, E.io], [2.5, -70], [2.72, 0, E.io]])(t);
    const settle = hump(t, 0.74, 0.9) + hump(t, 1.9, 2.06);
    arm(W, ctx, p, roll, -3 * settle, 4 * settle, turn);
    release(W, ctx, t, [[0.4, 0.8], [1.56, 1.92]]);
    balisong(W, ctx, fcBlade(t), fcBite(t), latchTrack(t, 0.36, 1.96, fcTurn, [0.82, 1.56]));
  },
};

// -------------------------------------------------------------------------------------------------
// Flip Flops (chain 1): basic closings and openings back to back, the handles clacking at each stop (hold F: it keeps
// flipping); then the latch home.

const FF = { len: 2.85, enter: 0.32, exit: 2.22, open: 0.6, t0: 0.44, P: 0.76, n: 2 };
const ffEnd = FF.t0 + FF.P * FF.n;
/**
 * One cycle's phase (s into it), or -1 outside the cycles. A cycle starts and ends at rest, open (every throw and its
 * bounces fit inside it), so the hold loop's seam is invisible.
 */
const ffPh = (t: number) => (t >= FF.t0 && t <= ffEnd ? (t - FF.t0) % FF.P : -1);
function ffBlade(t: number): number {
  const u = ffPh(t);
  if (u < 0) return 0;
  return u < 0.4 ? swing(u, 0.06, 0.18, 0, 180) : swing(u, 0.5, 0.62, 180, 0);
}
function ffBite(t: number): number {
  const u = ffPh(t);
  if (u < 0) return 0;
  return u < 0.33 ? swing(u, 0.2, 0.32, 0, 180) : swing(u, 0.36, 0.48, 180, 0);
}
const ffTurn = (t: number) => biteTurn(ffBlade(t), ffBite(t));

export const flipFlops: InspectClip = {
  id: "flip-flops",
  name: "Flip Flops",
  len: FF.len,
  enter: FF.enter,
  exit: FF.exit,
  open: FF.open,
  loop: [FF.t0 + FF.P, FF.t0 + 2 * FF.P],
  cues: Array.from({ length: FF.n }, (_, i) => FF.t0 + i * FF.P).flatMap((c) => [
    { t: c + 0.06, type: "flip" as const },
    { t: c + 0.18, type: "catch" as const },
    { t: c + 0.32, type: "catch" as const },
    { t: c + 0.48, type: "catch" as const },
    { t: c + 0.62, type: "catch" as const },
  ]),
  apply(W, t, ctx) {
    const p = presented(t, FF.enter, FF.exit, FF.len);
    const u = ffPh(t);
    // Each throw: the wrist leads its swing (closing negative, opening positive), a small pump between.
    const turn = u < 0 ? 0 : -11 * hump(u, 0.02, 0.18) - 9 * hump(u, 0.16, 0.32) + 9 * hump(u, 0.33, 0.48) + 11 * hump(u, 0.47, 0.62) - 3 * hump(u, 0.62, 0.74);
    const end = hump(t, ffEnd, ffEnd + 0.3);
    arm(W, ctx, p, -8 * end, -3 * end, 5 * end, turn);
    release(W, ctx, t, [[FF.t0 - 0.06, ffEnd + 0.02]]);
    balisong(W, ctx, ffBlade(t), ffBite(t), latchTrack(t, FF.t0 - 0.08, ffEnd + 0.04, ffTurn));
  },
};

// -------------------------------------------------------------------------------------------------
// Aerial (chain 2, the cap): a quick closing in the hand, the closed bundle tossed up turning end over end; the
// handles swing open in the air, and the open hand catches it by both handles, low enough to stay in view.

const AE = { len: 2.9, enter: 0.32, exit: 2.3, open: 9, toss: 0.72, catch: 1.32 };
const aeBlade = (t: number) => (t < AE.toss ? swing(t, 0.44, 0.54, 0, 180) : ease(t, 0.86, 1.14, 180, 0));
const aeBite = (t: number) => (t < AE.toss ? swing(t, 0.56, 0.66, 0, 180) : ease(t, 0.84, 1.1, 180, 0));
const aeTurn = (t: number) => biteTurn(aeBlade(t), aeBite(t)) + (t > AE.toss && t < AE.catch ? aeTumble(t) : t >= AE.catch ? 360 : 0);
/** One turn end over end, the opening way round, fastest at the top. */
const aeTumble = (t: number) => 360 * E.io(clamp01((t - AE.toss - 0.02) / (AE.catch - AE.toss - 0.06)));
const aeUp = (t: number) => hop(t, AE.toss, AE.catch, 6.5);
const aeOut = (t: number) => (t <= AE.toss || t >= AE.catch ? 0 : 2.2 * Math.sin((Math.PI * (t - AE.toss)) / (AE.catch - AE.toss)));

export const aerial: InspectClip = {
  id: "aerial",
  name: "Aerial",
  len: AE.len,
  enter: AE.enter,
  exit: AE.exit,
  open: AE.open,
  free: [[AE.toss, AE.catch]],
  cues: [
    { t: 0.44, type: "flip" },
    { t: 0.54, type: "catch" },
    { t: 0.66, type: "catch" },
    { t: AE.toss, type: "spin" },
    { t: AE.catch, type: "catch" },
  ],
  apply(W, t, ctx) {
    const p = presented(t, AE.enter, AE.exit, AE.len);
    const load = track([[0.6, 0], [0.7, 1, E.io], [0.76, -0.7, E.out], [0.96, 0, E.io]])(t);
    const dip = Math.max(0, Math.exp(-(t - AE.catch) / 0.12) * Math.sin(Math.PI * clamp01((t - AE.catch) / 0.2))) * (t > AE.catch ? 1 : 0);
    const roll = track([[1.62, 0], [1.86, -64, E.io], [1.98, -64], [2.2, 0, E.io]])(t);
    const turn = -11 * hump(t, 0.4, 0.52) - 9 * hump(t, 0.52, 0.64);
    arm(W, ctx, p, roll, 5 * load - 9 * dip, 10 * load + 10 * dip, turn, [0, 0, -0.7 * load - 0.8 * dip]);
    release(W, ctx, t, [[0.4, 0.66]]);
    release(W, ctx, t, [[AE.toss - 0.05, AE.catch + 0.02]], true);
    balisong(W, ctx, aeBlade(t), aeBite(t), latchTrack(t, 0.36, AE.catch + 0.1, aeTurn));
    const up = aeUp(t), out = aeOut(t), a = t > AE.toss && t < AE.catch ? aeTumble(t) : 0;
    if (up || a) {
      // Turn about the knife's own pin axis (in hand coordinates), through the bundle.
      const f = ctx.arm.frame(W);
      const kx = col(W, ctx.arm.kb, 0);
      const ax: V3 = [kx[0] * f.ax[0] + kx[1] * f.ax[1] + kx[2] * f.ax[2], kx[0] * f.w[0] + kx[1] * f.w[1] + kx[2] * f.w[2], kx[0] * f.n[0] + kx[1] * f.n[1] + kx[2] * f.n[2]];
      X.reset().rot(ax, a).move([0, up, out]);
      ctx.arm.knifeXf(W, X, f);
    }
  },
};

export const BUNNYFLY_INSPECTS = inspectSet("bunnyfly", [flipCheck, flipFlops, aerial], 8);
