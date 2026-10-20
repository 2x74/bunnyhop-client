// Finger joint angles of the viewmodel hands, anatomical limits, and a safety clamp.
//
// Every finger joint is read in the hand's own frame (the posed palm: `ax` wrist -> knuckles, `n` the palm normal on
// the side the fingers curl to, `c = ax x n` the curl axis):
//   MCP (joint 1)  flexion = signed angle from the palm axis to the first segment about c (+ = toward the palm),
//                  abduction = sideways angle of the first segment out of the curl plane, relative to the bind pose
//   PIP (joint 2)  flexion between the first and second segments about c
//   DIP (joint 3)  flexion between the second segment and the fingertip (the third bone's x axis, as mesh.ts builds it)
//   thumb          CMC: angle of the first segment away from its bind direction; MCP / IP flexion about the thumb's
//                  own hinge axis (its bind axis carried by the hand)
// Negative flexion = the joint bent backwards (hyperextension).
//
// LIMITS are generous anatomical ranges (a finger may straighten a little past flat, never fold backwards).
// clampFingers() rotates any joint past a limit back onto it, proximal to distal (each correction carries the rest of
// the finger with it), so nothing renders backwards even if an animation or a blend goes wrong. It runs every frame
// after the inspect and the knife hold (viewmodel.ts pose()); ~60 vector ops per hand when nothing is out of range.
//
// Source viewmodel space, 3x4 row-major bone-to-model matrices, like the rest of viewmodel/.

import { concat } from "../player/bunny/rig";
import { rotAbout } from "./math";
import type { VmRig } from "./rig";

type V3 = [number, number, number];
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type Digit = "index" | "middle" | "ring" | "pinky" | "thumb";
export const DIGITS: readonly Digit[] = ["index", "middle", "ring", "pinky", "thumb"];

export interface Range {
  min: number;
  max: number;
}

/**
 * Degrees. Fingers: [MCP flex, PIP flex, DIP flex], MCP abduction; thumb: [CMC deviation, MCP flex, IP flex]. MCP is read
 * against the wrist -> knuckles line, which runs ~20-30 degrees off the metacarpals of the rig's cupped bind hand, hence
 * the high MCP maximum (a tight fist reads ~120).
 */
export const LIMITS = {
  finger: { flex: [{ min: -15, max: 125 }, { min: -10, max: 115 }, { min: -15, max: 95 }] as Range[], abd: { min: -25, max: 25 } as Range },
  thumb: { flex: [{ min: 0, max: 70 }, { min: -15, max: 75 }, { min: -20, max: 95 }] as Range[] },
};

export interface JointReading {
  side: "R" | "L";
  digit: Digit;
  /** 1 = MCP / CMC, 2 = PIP / thumb MCP, 3 = DIP / thumb IP; "abd" = MCP abduction. */
  joint: 1 | 2 | 3 | "abd";
  deg: number;
  range: Range;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pos = (W: ArrayLike<number>, i: number): V3 => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]];
const xAxis = (W: ArrayLike<number>, i: number): V3 => norm([W[i * 12], W[i * 12 + 4], W[i * 12 + 8]]);

/** Signed angle from a to b about axis c (both projected onto the plane perpendicular to c), degrees. */
function hinge(a: V3, b: V3, c: V3): number {
  const pa = sub(a, [c[0] * dot(a, c), c[1] * dot(a, c), c[2] * dot(a, c)]);
  const pb = sub(b, [c[0] * dot(b, c), c[1] * dot(b, c), c[2] * dot(b, c)]);
  return Math.atan2(dot(cross(pa, pb), c), dot(pa, pb)) * R2D;
}

interface HandFrameLite {
  wrist: V3;
  ax: V3;
  w: V3;
  n: V3;
  c: V3;
}

interface Side {
  side: "R" | "L";
  hand: number;
  chains: Record<Digit, number[]>;
  /** n = sign * (ax x w), fixed from the bind pose. */
  nSign: number;
  /** Bind MCP abduction per finger (deg). */
  abd0: Record<Digit, number>;
  /** Bind thumb first-segment direction and hinge axis, in hand coordinates (ax, w, n). */
  thumbD1: V3;
  thumbAxis: V3;
}

const sides = new WeakMap<VmRig, Side[]>();

function frameOf(W: ArrayLike<number>, s: Pick<Side, "hand" | "chains" | "nSign">): HandFrameLite {
  const wrist = pos(W, s.hand);
  const r = (["index", "middle", "ring", "pinky"] as const).map((d) => pos(W, s.chains[d][0]));
  const kc: V3 = [(r[0][0] + r[1][0] + r[2][0] + r[3][0]) / 4, (r[0][1] + r[1][1] + r[2][1] + r[3][1]) / 4, (r[0][2] + r[1][2] + r[2][2] + r[3][2]) / 4];
  const ax = norm(sub(kc, wrist));
  let w = sub(r[0], r[3]);
  const k = dot(w, ax);
  w = norm([w[0] - ax[0] * k, w[1] - ax[1] * k, w[2] - ax[2] * k]);
  const nn = cross(ax, w);
  const n: V3 = [nn[0] * s.nSign, nn[1] * s.nSign, nn[2] * s.nSign];
  return { wrist, ax, w, n, c: norm(cross(ax, n)) };
}

const toHand = (f: HandFrameLite, d: V3): V3 => [dot(d, f.ax), dot(d, f.w), dot(d, f.n)];
const fromHand = (f: HandFrameLite, d: V3): V3 => [
  f.ax[0] * d[0] + f.w[0] * d[1] + f.n[0] * d[2],
  f.ax[1] * d[0] + f.w[1] * d[1] + f.n[1] * d[2],
  f.ax[2] * d[0] + f.w[2] * d[1] + f.n[2] * d[2],
];

function sidesOf(r: VmRig): Side[] {
  let s = sides.get(r);
  if (s) return s;
  s = [];
  for (const [side, p, thumb] of [
    ["R", "Right_", ["Right_Thumb01", "Right_Thumb02", "Right_Thumb03"]],
    ["L", "Left_", ["Left_Thumb01", "Left_Thumb_02", "Left_Thumb03"]],
  ] as const) {
    const B = (n: string) => r.bone(n);
    const chain = (f: string) => [1, 2, 3].map((k) => B(`${p}${f}0${k}`));
    const chains = { index: chain("Index"), middle: chain("Middle"), ring: chain("Ring"), pinky: chain("Pinky"), thumb: thumb.map(B) };
    const base = { hand: B(`${p}Hand`), chains, nSign: 1 };
    const f0 = frameOf(r.bind, base);
    // The palm normal points to the side the thumb sits on (the fingers curl that way).
    base.nSign = dot(f0.n, sub(pos(r.bind, chains.thumb[1]), f0.wrist)) < 0 ? -1 : 1;
    const f = frameOf(r.bind, base);
    const abd0 = {} as Record<Digit, number>;
    for (const d of DIGITS) {
      const c = chains[d];
      abd0[d] = Math.asin(Math.max(-1, Math.min(1, dot(norm(sub(pos(r.bind, c[1]), pos(r.bind, c[0]))), f.c)))) * R2D;
    }
    const td = norm(sub(pos(r.bind, chains.thumb[1]), pos(r.bind, chains.thumb[0])));
    s.push({ side, ...base, abd0, thumbD1: toHand(f, td), thumbAxis: toHand(f, norm(cross(td, f.n))) });
  }
  sides.set(r, s);
  return s;
}

/** Every joint reading of both hands (right first). */
export function readFingers(W: ArrayLike<number>, r: VmRig, out: JointReading[] = []): JointReading[] {
  out.length = 0;
  for (const s of sidesOf(r)) {
    const f = frameOf(W, s);
    for (const d of DIGITS) {
      const c = s.chains[d];
      const p = c.map((i) => pos(W, i));
      const d1 = norm(sub(p[1], p[0])), d2 = norm(sub(p[2], p[1])), d3 = xAxis(W, c[2]);
      if (d === "thumb") {
        const ta = norm(fromHand(f, s.thumbAxis));
        const cmc = Math.acos(Math.max(-1, Math.min(1, dot(d1, norm(fromHand(f, s.thumbD1)))))) * R2D;
        out.push({ side: s.side, digit: d, joint: 1, deg: cmc, range: LIMITS.thumb.flex[0] });
        out.push({ side: s.side, digit: d, joint: 2, deg: hinge(d1, d2, ta), range: LIMITS.thumb.flex[1] });
        out.push({ side: s.side, digit: d, joint: 3, deg: hinge(d2, d3, ta), range: LIMITS.thumb.flex[2] });
      } else {
        const L = LIMITS.finger;
        out.push({ side: s.side, digit: d, joint: 1, deg: hinge(f.ax, d1, f.c), range: L.flex[0] });
        out.push({ side: s.side, digit: d, joint: 2, deg: hinge(d1, d2, f.c), range: L.flex[1] });
        out.push({ side: s.side, digit: d, joint: 3, deg: hinge(d2, d3, f.c), range: L.flex[2] });
        const abd = Math.asin(Math.max(-1, Math.min(1, dot(d1, f.c)))) * R2D - s.abd0[d];
        out.push({ side: s.side, digit: d, joint: "abd", deg: abd, range: L.abd });
      }
    }
  }
  return out;
}

const T = new Float32Array(12), M = new Float32Array(12);

function rotChain(W: Float32Array, chain: number[], from: number, axis: V3, deg: number, pivot: V3): void {
  rotAbout(axis, deg * D2R, pivot, T);
  for (let k = from; k < chain.length; k++) {
    const i = chain[k];
    concat(T, 0, W, i * 12, M, 0);
    W.set(M, i * 12);
  }
}

const over = (v: number, r: Range) => (v < r.min ? r.min - v : v > r.max ? r.max - v : 0);

/**
 * Safety clamp: rotates every finger / thumb joint past its limit back onto it (both hands). Returns how many joints
 * it corrected (0 in a clean pose).
 */
export function clampFingers(W: Float32Array, r: VmRig, hands: "R" | "both" = "R"): number {
  let fixed = 0;
  for (const s of sidesOf(r)) {
    if (hands === "R" && s.side !== "R") continue;
    const f = frameOf(W, s);
    for (const d of DIGITS) {
      const c = s.chains[d];
      if (d === "thumb") {
        const ta = norm(fromHand(f, s.thumbAxis));
        for (const k of [1, 2] as const) {
          const p = c.map((i) => pos(W, i));
          const a = norm(sub(p[1], p[0])), b = norm(sub(p[2], p[1]));
          const deg = k === 1 ? hinge(a, b, ta) : hinge(b, xAxis(W, c[2]), ta);
          const e = over(deg, LIMITS.thumb.flex[k]);
          if (Math.abs(e) > 1e-3) {
            rotChain(W, c, k, ta, e, p[k]);
            fixed++;
          }
        }
        continue;
      }
      // MCP abduction (about the palm normal), then flexion joint by joint (about the curl axis).
      {
        const p0 = pos(W, c[0]);
        const d1 = norm(sub(pos(W, c[1]), p0));
        const abd = Math.asin(Math.max(-1, Math.min(1, dot(d1, f.c)))) * R2D - s.abd0[d];
        const e = over(abd, LIMITS.finger.abd);
        if (Math.abs(e) > 1e-3) {
          // A rotation about n moves the segment along n x d1; pick the sign that moves it along +c by e.
          const sgn = dot(cross(f.n, d1), f.c) >= 0 ? 1 : -1;
          rotChain(W, c, 0, f.n, e * sgn, p0);
          fixed++;
        }
      }
      for (let k = 0; k < 3; k++) {
        const p = c.map((i) => pos(W, i));
        const prev = k === 0 ? f.ax : norm(sub(p[k], p[k - 1]));
        const cur = k < 2 ? norm(sub(p[k + 1], p[k])) : xAxis(W, c[2]);
        const e = over(hinge(prev, cur, f.c), LIMITS.finger.flex[k]);
        if (Math.abs(e) > 1e-3) {
          rotChain(W, c, k, f.c, e, p[k]);
          fixed++;
        }
      }
    }
  }
  return fixed;
}

/**
 * Right hand, for animation code that drives joints to anatomical targets: the hinge axes (fingers: the curl axis c;
 * thumb: its bind hinge carried by the hand) and the current flexion of joint k (0 = MCP, 1 = PIP / thumb MCP,
 * 2 = DIP / thumb IP; the thumb's k = 0 is not a hinge and reads NaN), measured exactly as readFingers() does.
 */
export function hingeAxis(W: ArrayLike<number>, r: VmRig, digit: Digit): V3 {
  const s = sidesOf(r)[0];
  const f = frameOf(W, s);
  return digit === "thumb" ? norm(fromHand(f, s.thumbAxis)) : f.c;
}

export function flexAt(W: ArrayLike<number>, r: VmRig, digit: Digit, k: 0 | 1 | 2): number {
  const s = sidesOf(r)[0];
  const f = frameOf(W, s);
  const c = s.chains[digit];
  const p = c.map((i) => pos(W, i));
  const seg = (j: number): V3 => (j < 2 ? norm(sub(p[j + 1], p[j])) : xAxis(W, c[2]));
  if (digit === "thumb") return k === 0 ? NaN : hinge(seg(k - 1), seg(k), norm(fromHand(f, s.thumbAxis)));
  return hinge(k === 0 ? f.ax : seg(k - 1), seg(k), f.c);
}

/** Bind-pose MCP flexion of a right finger (deg), as flexAt reads it: the rig's cupped rest. */
export function bindFlex(r: VmRig, digit: Digit, k: 0 | 1 | 2): number {
  return flexAt(r.bind, r, digit, k);
}
