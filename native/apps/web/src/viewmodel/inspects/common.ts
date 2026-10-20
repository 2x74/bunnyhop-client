// Shared inspect pieces: the presented pose every chained trick passes through, and finger opening relative to the
// knife's hold (knives/hold.ts; the carrot's fist by default).

import { CARROT_HOLD } from "../knives/hold";
import type { HoldSpec } from "../knives/types";
import { D2R, E, pos, type Finger, type HandFrame, type V3 } from "./kit";
import { flexAt, hingeAxis, LIMITS } from "../fingers";
import { rotAbout } from "../math";
import type { InspectCtx } from "./types";

/**
 * The presented pose (CS: "raise and centre"): the forearm rolls the palm up toward the camera, the fist comes up and
 * in about the elbow. Chained tricks start and end here, so a combo flows without dropping back to idle.
 */
export const PRESENT = { roll: 62, pitch: 13, yaw: 15, shift: [1.0, 1.4, 1.3] as V3 };

/** 0 at rest -> 1 presented over [0, enter] (snappy start), 1 -> 0 over [exit, len] (settle). */
export function presented(t: number, enter: number, exit: number, len: number): number {
  if (t <= 0 || t >= len) return 0;
  if (t < enter) return E.out(t / enter);
  if (t > exit) return 1 - E.io((t - exit) / (len - exit));
  return 1;
}

/**
 * The thumb's root swing off the grip, as a curl of its first joint in the hold spec's terms (knives/types.ts Curl; the
 * thumb is never moved by the hold's wrap solver, so its spec is what is posed). Its MCP / IP open by measured angle.
 */
const THUMB_ROOT_OPEN = -50;
/**
 * The open thumb's swing about the palm normal (deg, + toward the index side), relative to the hold's spread: with the
 * carrot's thumb along the grip below the guard (knives/hold.ts CARROT_HOLD), it swings out toward the pommel side so
 * it never sweeps through the guard.
 */
export const THUMB_SWING = { root: -35, spread: -15, detour: -65 };
const NO_SWING = { root: THUMB_ROOT_OPEN, spread: 0, detour: 0 };

export function holdOf(ctx: InspectCtx): HoldSpec {
  return ctx.knife?.hold ?? CARROT_HOLD;
}

/**
 * The open hand as anatomical joint angles (deg, read like fingers.ts: MCP against the wrist -> knuckles line, PIP /
 * DIP between segments): nearly straight, a touch more bend toward the pinky.
 */
export const OPEN_ANAT: Record<Exclude<Finger, "thumb">, V3> = {
  index: [4, 8, 4],
  middle: [6, 9, 6],
  ring: [12, 11, 7],
  pinky: [12, 14, 9],
};

/**
 * Opens finger `f` by `k` from whatever it holds now (0 = unchanged, 1 = OPEN_ANAT / `target`, NaN entries = keep that
 * joint; k < 0 squeezes it
 * tighter, never past its joint limits), plus an extra curl `d` (deg). Each joint is driven by its measured angle
 * (fingers.ts flexAt), so it works on any hold (the carrot fist, a knife's wrapped grip, v_knife_t's idle) and can't
 * overshoot backwards. The root leads both ways: opening, the finger lifts off before its tip straightens; closing
 * (`closing`), it swings in before the tip hooks (a tip curling in place drags through whatever the fist holds).
 */
export function openFinger(ctx: InspectCtx, W: Float32Array, hf: HandFrame, f: Finger, k: number, target?: V3, d: V3 = [0, 0, 0], spread = 0, closing = false): void {
  if (f === "thumb") return openThumb(ctx, W, hf, k, closing);
  const r = ctx.arm.r;
  const tg = target ?? OPEN_ANAT[f];
  // Opening: the tip uncurls with the root (a curled tip lifted by its root alone hooks up through the grip it was
  // wrapped round). Closing: the root leads, the tip hooks in last. A squeeze (k < 0) only presses the root joint.
  const a = k <= 0 ? k : closing ? Math.max(0, (k - 0.3) / 0.7) : k;
  const b = k <= 0 ? 0 : closing ? Math.min(1, k / 0.75) : k;
  if (spread && k > 0) ctx.arm.curl(W, f, [0, 0, 0], spread * Math.min(1, k), hf);
  const lim = LIMITS.finger.flex;
  for (const j of [0, 1, 2] as const) {
    const amt = j === 0 ? a : b;
    if ((!amt && !d[j]) || Number.isNaN(tg[j])) continue; // NaN target: leave that joint as held
    const cur = flexAt(W, r, f, j);
    let delta = (tg[j] - cur) * amt + d[j];
    // A squeeze (k < 0) or a ripple never takes a joint past its anatomical range.
    delta = Math.max(lim[j].min + 2 - cur, Math.min(lim[j].max - 3 - cur, delta));
    const c = [0, 0, 0] as V3;
    c[j] = delta;
    if (Math.abs(delta) > 1e-4) ctx.arm.curl(W, f, c, 0, hf);
  }
}

/**
 * Opens the thumb by k (0 = the hold, 1 = swung off, nearly straight), root first both ways: the thumb swings off the pommel before
 * its tip straightens, and swings back before the tip hooks over the guard (otherwise the tip drags through it).
 */
export function openThumb(ctx: InspectCtx, W: Float32Array, hf: HandFrame, k: number, closing = false): void {
  if (!k) return;
  const h = holdOf(ctx).thumb.c;
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  const a = k < 0 ? k : closing ? cl((k - 0.4) / 0.6) : cl(k / 0.6);
  const b = k < 0 ? k : closing ? cl(k / 0.6) : cl((k - 0.4) / 0.6);
  // The root swings by the hold's own spec (the wrap solver never moves the thumb); the two distal joints go to their
  // anatomical targets by measured angle, about the thumb's own hinge, so they can't bend backwards on any base.
  const hs = holdOf(ctx).thumb.spread ?? 0;
  // Spread first (with a detour away from the guard mid-swing), then the root.
  const sa = Math.abs(a);
  // Thumbs that lie across the front of the fist under the guard (the carrot and the straight knives since v0.0.6,
  // knives/hold.ts) swing out toward the pommel side; others straight off.
  const sw = holdOf(ctx).thumb.c[0] > 0 ? THUMB_SWING : NO_SWING;
  ctx.arm.curl(W, "thumb", [0, 0, 0], (sw.spread - hs) * a + sw.detour * Math.sin(Math.PI * Math.min(1, sa)) * Math.sign(a), hf);
  ctx.arm.curl(W, "thumb", [(sw.root - h[0]) * a, 0, 0], 0, hf);
  const r = ctx.arm.r, chain = ctx.arm.fingers.thumb, lim = LIMITS.thumb.flex;
  const ax = hingeAxis(W, r, "thumb");
  for (const j of [1, 2] as const) {
    const cur = flexAt(W, r, "thumb", j);
    let delta = (THUMB_OPEN[j - 1] - cur) * b;
    delta = Math.max(lim[j].min + 2 - cur, Math.min(lim[j].max - 3 - cur, delta));
    if (Math.abs(delta) < 1e-4) continue;
    rotAbout(ax, delta * D2R, pos(W, chain[j]), TT);
    ctx.arm.rigid(W, TT, chain.slice(j));
  }
}

/** Open thumb's MCP / IP flexion (deg, fingers.ts thumb hinge). */
const THUMB_OPEN = [10, 8];
const TT = new Float32Array(12);

/** Regrip ease: a short overshoot into a squeeze (gentler than E.back so fingertips don't sink into the grip). */
export const squeeze = (x: number) => {
  x = Math.min(1, Math.max(0, x));
  const s = 1.3;
  return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
};

/**
 * Fingers for a release / regrip: the thumb lifts off the pommel first (loads), the index lets go at `open` and the
 * others follow 20 ms apart; on the regrip (`close`) the pinky closes first and the index last, with a squeeze.
 * `ripple` (deg) waves through the open fingers while the knife spins (periodic over `loop`).
 */
const FAN = [-7, -2.5, 2.5, 6];

export function hands(W: Float32Array, ctx: InspectCtx, t: number, open: number, close: number, ripple = 0, loop?: [number, number]): void {
  const hf = ctx.arm.frame(W);
  const order = ["index", "middle", "ring", "pinky"] as const;
  order.forEach((f, i) => {
    const o0 = open + i * 0.012, c0 = close - i * 0.012;
    let k = 0;
    const closing = t >= c0;
    if (t >= o0 && t < c0) k = E.out((t - o0) / 0.09);
    else if (t >= c0 && t < c0 + 0.16) k = 1 - squeeze((t - c0) / 0.16);
    let d: V3 = [0, 0, 0];
    if (ripple && loop && t > o0 + 0.1 && t < c0) {
      const ph = ((t - loop[0]) / (loop[1] - loop[0])) * Math.PI * 2 - i * 0.9;
      const a = ripple * Math.sin(ph);
      d = [a, a * 0.6, a * 0.3];
    }
    // The open fingers fan a little (the index away from the guard).
    openFinger(ctx, W, hf, f, k, undefined, d, FAN[i] * Math.max(0, Math.min(1, k)), closing);
  });
  // Thumb: lifts off the pommel to load, snaps fully open with the release, comes back over the grip on the regrip.
  let k = 0;
  if (t > open - 0.1 && t < open) k = 0.5 * E.io((t - (open - 0.1)) / 0.1);
  else if (t >= open && t < close + 0.06) k = 0.5 + 0.5 * E.out((t - open) / 0.06);
  else if (t >= close + 0.06 && t < close + 0.26) k = 1 - squeeze((t - (close + 0.06)) / 0.2);
  openThumb(ctx, W, hf, k, t >= close + 0.06);
}

