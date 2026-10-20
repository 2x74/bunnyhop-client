// Inspect authoring kit: per-bone motions of the right arm, hand, fingers and knife, on top of whatever pose the
// viewmodel already has (v_knife_t's idle with hosted content, procedural.ts's rest without, plus the knife's hold
// layer, knives/hold.ts). Everything is relative to the posed hand, so one clip works on either base and for any
// knife that shares the carrot's fist.
//
// Frames: the posed hand frame (HandFrame below): `ax` wrist -> knuckles, `w` across the palm toward the index finger,
// `n` the palm normal (the side the fingers curl to). Knife motions are written in those axes with the origin at the
// knife's held position (the grip), so "spin about the palm normal through the grip" is `X.rot(N, deg)`.
//
// All in Source viewmodel space (x forward, y left, z up), 3x4 row-major bone-to-model matrices. The left-handed
// viewmodel is a mirror of the whole pose (viewmodel.ts render), so clips never special-case it.

import { concat } from "../../player/bunny/rig";
import { rotAbout } from "../math";
import { vmRig, type VmRig } from "../rig";

export type V3 = [number, number, number];
export const D2R = Math.PI / 180;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const pos = (W: ArrayLike<number>, i: number): V3 => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]];
export const col = (W: ArrayLike<number>, i: number, k: number): V3 => [W[i * 12 + k], W[i * 12 + 4 + k], W[i * 12 + 8 + k]];

// -------------------------------------------------------------------------------------------------
// Curves

export type Ease = (x: number) => number;
const c01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const E = {
  lin: (x: number) => c01(x),
  /** smoothstep */
  io: (x: number) => ((x = c01(x)), x * x * (3 - 2 * x)),
  /** quintic smootherstep: soft ends, fast middle (spins) */
  whip: (x: number) => ((x = c01(x)), x * x * x * (x * (x * 6 - 15) + 10)),
  /** snappy start, soft landing (CS-style flicks) */
  out: (x: number) => ((x = c01(x)), 1 - (1 - x) ** 3),
  out2: (x: number) => ((x = c01(x)), 1 - (1 - x) ** 2),
  in: (x: number) => ((x = c01(x)), x * x * x),
  in2: (x: number) => ((x = c01(x)), x * x),
  /** overshoot then settle (weighty catches / regrips) */
  back: (x: number) => {
    x = c01(x);
    const s = 2.2;
    return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
  },
} satisfies Record<string, Ease>;

/** Keyframed scalar: [t, value, ease into this key]. Holds the first / last value outside. */
export type Key = [number, number, Ease?];
export function track(keys: Key[]): (t: number) => number {
  return (t: number) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, e] = keys[i];
      if (t <= t1) {
        const [t0, v0] = keys[i - 1];
        const f = t1 > t0 ? (e ?? E.io)((t - t0) / (t1 - t0)) : 1;
        return v0 + (v1 - v0) * f;
      }
    }
    return keys[keys.length - 1][1];
  };
}

/**
 * Cubic Hermite through [t, value, slope (per s)] keys: spins that leave the hand fast, cruise at a constant rate (so
 * a hold-loop segment is exactly one turn) and land with some speed left for the catch to kill.
 */
export type HKey = [number, number, number];
export function spline(keys: HKey[]): (t: number) => number {
  return (t: number) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, m1] = keys[i];
      if (t <= t1) {
        const [t0, v0, m0] = keys[i - 1];
        const h = t1 - t0;
        const x = (t - t0) / h, x2 = x * x, x3 = x2 * x;
        return (2 * x3 - 3 * x2 + 1) * v0 + (x3 - 2 * x2 + x) * h * m0 + (-2 * x3 + 3 * x2) * v1 + (x3 - x2) * h * m1;
      }
    }
    return keys[keys.length - 1][1];
  };
}

/** Damped bump: 0 at t0, a peak shortly after, back to 0 by t1 (catch impacts). */
export const bump = (t: number, t0: number, t1: number) => {
  if (t <= t0 || t >= t1) return 0;
  const x = (t - t0) / (t1 - t0);
  return Math.sin(Math.PI * x) * Math.exp(-2.2 * x) * 1.9;
};

/** Ballistic hop: 0 at t0 and t1, `h` at the apex (a parabola, so the toss reads as thrown and caught). */
export const hop = (t: number, t0: number, t1: number, h: number) => {
  if (t <= t0 || t >= t1) return 0;
  const x = (t - t0) / (t1 - t0);
  return 4 * h * x * (1 - x);
};

// -------------------------------------------------------------------------------------------------
// Transforms in hand coordinates

/** A rigid transform built in hand coordinates (ax, w, n; origin at the grip), composed left to right in time. */
export class Xf {
  readonly m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  private t = new Float32Array(12);
  private u = new Float32Array(12);

  reset(): this {
    this.m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    return this;
  }

  /** Then rotate by `deg` about `axis` (hand coords) through `pivot` (hand coords). */
  rot(axis: V3, deg: number, pivot: V3 = [0, 0, 0]): this {
    if (!deg) return this;
    rotAbout(norm(axis), deg * D2R, pivot, this.t);
    concat(this.t, 0, this.m, 0, this.u, 0);
    this.m.set(this.u);
    return this;
  }

  /** Then translate (hand coords). */
  move(v: V3): this {
    this.m[3] += v[0];
    this.m[7] += v[1];
    this.m[11] += v[2];
    return this;
  }
}

/** Hand axes in hand coordinates (for Xf): AX (toward the knuckles), W (toward the index side), N (palm normal). */
export const AX: V3 = [1, 0, 0];
export const W_: V3 = [0, 1, 0];
export const N: V3 = [0, 0, 1];

// -------------------------------------------------------------------------------------------------
// The right arm

export type Finger = "index" | "middle" | "ring" | "pinky" | "thumb";
export const FINGERS: readonly Finger[] = ["index", "middle", "ring", "pinky", "thumb"];

export interface HandFrame {
  wrist: V3;
  elbow: V3;
  /** Forearm direction (elbow -> wrist). */
  fore: V3;
  ax: V3;
  w: V3;
  n: V3;
  palmL: number;
  /** Knife origin (Knife_Handle) in this pose. */
  grip: V3;
}

/** Bone groups and per-frame helpers for one rig (one per inspect runtime). */
export class Arm {
  readonly r: VmRig;
  /** Forearm bones (rotate with the elbow / roll, not with the wrist). */
  readonly forearm: number[];
  /** Wrist twist helper (half the wrist bend). */
  readonly helper: number[];
  /** Hand + fingers. */
  readonly hand: number[];
  /** knife_Parent + Knife_Handle (extra knife bones are solved from Knife_Handle afterwards). */
  readonly knife: number[];
  /** Everything that moves with the arm. */
  readonly all: number[];
  readonly fingers: Record<Finger, number[]>;
  readonly kb: number;
  readonly handBone: number;
  readonly armBone: number;
  private T = new Float32Array(12);
  private T2 = new Float32Array(12);
  private T3 = new Float32Array(12);
  private H = new Float32Array(12);
  private Hi = new Float32Array(12);
  /** Handedness of (ax, w, n) on this rig: n = sign * (ax x w), fixed from the bind pose (the thumb can move). */
  private nSign = 1;

  constructor(r: VmRig = vmRig()) {
    this.r = r;
    const B = (n: string) => r.bone(n);
    this.forearm = ["Root36", "Right_Arm", "eff18", "Root23"].map(B);
    this.helper = ["Root98", "R_wrist_helper"].map(B);
    this.handBone = B("Right_Hand");
    this.armBone = B("Right_Arm");
    this.hand = r.subtree(this.handBone);
    this.kb = B("Knife_Handle");
    this.knife = [B("knife_Parent"), this.kb];
    this.all = [...this.forearm, ...this.helper, ...this.hand, ...this.knife];
    const f = (n: string) => [1, 2, 3].map((k) => B(`Right_${n}0${k}`));
    this.fingers = { index: f("Index"), middle: f("Middle"), ring: f("Ring"), pinky: f("Pinky"), thumb: f("Thumb") };
    const b = this.frame(r.bind);
    this.nSign = dot(cross(b.ax, b.w), sub(pos(r.bind, this.fingers.thumb[1]), b.wrist)) < 0 ? -1 : 1;
  }

  /** The posed hand frame. */
  frame(W: ArrayLike<number>, out?: HandFrame): HandFrame {
    const wrist = pos(W, this.handBone);
    const elbow = pos(W, this.armBone);
    const roots = (["index", "middle", "ring", "pinky"] as const).map((f) => pos(W, this.fingers[f][0]));
    const kc = mul(add(add(roots[0], roots[1]), add(roots[2], roots[3])), 0.25);
    const ax = norm(sub(kc, wrist));
    let w = sub(roots[0], roots[3]);
    w = norm(sub(w, mul(ax, dot(w, ax))));
    const n = mul(cross(ax, w), this.nSign);
    const o = out ?? ({} as HandFrame);
    o.wrist = wrist;
    o.elbow = elbow;
    o.fore = norm(sub(wrist, elbow));
    o.ax = ax;
    o.w = w;
    o.n = n;
    o.palmL = Math.hypot(kc[0] - wrist[0], kc[1] - wrist[1], kc[2] - wrist[2]);
    o.grip = pos(W, this.kb);
    return o;
  }

  /** W[i] = M * W[i] for each bone. */
  rigid(W: Float32Array, M: Float32Array, bones: readonly number[]): void {
    for (const i of bones) {
      concat(M, 0, W, i * 12, this.T3, 0);
      W.set(this.T3, i * 12);
    }
  }

  /**
   * Arm motion, CS-inspect style: the forearm rolls about its own axis (pronation, + turns the palm up for the right
   * hand), then the whole arm swings about the elbow (pitch + raises the fist, yaw + brings it toward the centre) and
   * shifts (forward, left, up).
   */
  arm(W: Float32Array, roll: number, pitch: number, yaw: number, shift: V3 = [0, 0, 0]): void {
    if (!roll && !pitch && !yaw && !shift[0] && !shift[1] && !shift[2]) return;
    const f = this.frame(W);
    rotAbout(f.fore, roll * D2R, f.wrist, this.T);
    // Elbow swing: yaw about view-up, then pitch about the horizontal axis across the forearm.
    rotAbout([0, 0, 1], yaw * D2R, f.elbow, this.T2);
    concat(this.T2, 0, this.T, 0, this.H, 0);
    const side = norm(cross(f.fore, [0, 0, 1]));
    rotAbout(side, pitch * D2R, f.elbow, this.T2);
    concat(this.T2, 0, this.H, 0, this.T, 0);
    this.T[3] += shift[0];
    this.T[7] += shift[1];
    this.T[11] += shift[2];
    this.rigid(W, this.T, this.all);
  }

  /** Wrist bend about the wrist: flex (+ curls the palm in, about the finger curl axis), deviation (about n). */
  wrist(W: Float32Array, flex: number, dev: number): void {
    if (!flex && !dev) return;
    const f = this.frame(W);
    const curlAxis = norm(cross(f.ax, f.n));
    rotAbout(curlAxis, flex * D2R, f.wrist, this.T);
    rotAbout(f.n, dev * D2R, f.wrist, this.T2);
    concat(this.T2, 0, this.T, 0, this.H, 0);
    this.rigid(W, this.H, this.hand);
    this.rigid(W, this.H, this.knife);
    rotAbout(curlAxis, flex * 0.5 * D2R, f.wrist, this.T);
    rotAbout(f.n, dev * 0.5 * D2R, f.wrist, this.T2);
    concat(this.T2, 0, this.T, 0, this.H, 0);
    this.rigid(W, this.H, this.helper);
  }

  /**
   * Adds curl (deg per joint: proximal, middle, distal; + toward the palm) to a finger, and an optional spread about the
   * palm normal at its root (+ toward the index side). Thumb: + folds across the palm.
   */
  curl(W: Float32Array, finger: Finger, d: V3 | number[], spread = 0, f: HandFrame = this.frame(W)): void {
    const chain = this.fingers[finger];
    let axis: V3;
    if (finger === "thumb") {
      const td = norm(sub(pos(W, chain[1]), pos(W, chain[0])));
      axis = norm(cross(td, f.n));
    } else axis = norm(cross(f.ax, f.n));
    if (spread) {
      rotAbout(f.n, spread * D2R, pos(W, chain[0]), this.T);
      this.rigid(W, this.T, chain);
    }
    for (let k = 0; k < 3; k++) {
      if (!d[k]) continue;
      rotAbout(axis, d[k] * D2R, pos(W, chain[k]), this.T);
      this.rigid(W, this.T, chain.slice(k));
    }
  }

  /** Moves the knife by X (hand coordinates, origin at the knife's current position: see Xf). */
  knifeXf(W: Float32Array, X: Xf, f: HandFrame = this.frame(W)): void {
    this.handMatrix(f, this.H, this.Hi);
    concat(this.H, 0, X.m, 0, this.T, 0);
    concat(this.T, 0, this.Hi, 0, this.T2, 0);
    this.rigid(W, this.T2, this.knife);
  }

  /** H (hand coords -> model, origin at the grip) and its inverse. */
  handMatrix(f: HandFrame, H: Float32Array, Hi: Float32Array): void {
    const { ax, w, n, grip: o } = f;
    H.set([ax[0], w[0], n[0], o[0], ax[1], w[1], n[1], o[1], ax[2], w[2], n[2], o[2]]);
    Hi.set([ax[0], ax[1], ax[2], -dot(ax, o), w[0], w[1], w[2], -dot(w, o), n[0], n[1], n[2], -dot(n, o)]);
  }

  /** A point in hand coordinates (origin at the grip) -> model. */
  toModel(f: HandFrame, p: V3): V3 {
    return [
      f.grip[0] + f.ax[0] * p[0] + f.w[0] * p[1] + f.n[0] * p[2],
      f.grip[1] + f.ax[1] * p[0] + f.w[1] * p[1] + f.n[1] * p[2],
      f.grip[2] + f.ax[2] * p[0] + f.w[2] * p[1] + f.n[2] * p[2],
    ];
  }

  /** A model point -> hand coordinates (origin at the grip). */
  toHand(f: HandFrame, p: V3): V3 {
    const d = sub(p, f.grip);
    return [dot(d, f.ax), dot(d, f.w), dot(d, f.n)];
  }
}

// -------------------------------------------------------------------------------------------------
// Pose blending

const qa = new Float64Array(4), qb = new Float64Array(4);

function quat(m: ArrayLike<number>, o: number, q: Float64Array): void {
  const m00 = m[o], m01 = m[o + 1], m02 = m[o + 2], m10 = m[o + 4], m11 = m[o + 5], m12 = m[o + 6], m20 = m[o + 8], m21 = m[o + 9], m22 = m[o + 10];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[3] = 0.25 * s, q[0] = (m21 - m12) / s, q[1] = (m02 - m20) / s, q[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q[3] = (m21 - m12) / s, q[0] = 0.25 * s, q[1] = (m01 + m10) / s, q[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q[3] = (m02 - m20) / s, q[0] = (m01 + m10) / s, q[1] = 0.25 * s, q[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q[3] = (m10 - m01) / s, q[0] = (m02 + m20) / s, q[1] = (m12 + m21) / s, q[2] = 0.25 * s;
  }
}

/**
 * A[i] = blend(A[i], B[i], w) per bone: rotations by normalised quaternion lerp (shortest arc), translations linearly.
 * Spins blend through the short way, so a cancelled 720-degree flip never unwinds.
 */
export function blendPose(A: Float32Array, B: Float32Array, w: number, bones: Iterable<number>): void {
  if (w <= 0) return;
  for (const i of bones) {
    const o = i * 12;
    if (w >= 1) {
      A.set(B.subarray(o, o + 12), o);
      continue;
    }
    quat(A, o, qa);
    quat(B, o, qb);
    const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
    let x = qa[0] + (qb[0] * s - qa[0]) * w, y = qa[1] + (qb[1] * s - qa[1]) * w, z = qa[2] + (qb[2] * s - qa[2]) * w, q = qa[3] + (qb[3] * s - qa[3]) * w;
    const l = Math.hypot(x, y, z, q) || 1;
    x /= l, y /= l, z /= l, q /= l;
    const tx = A[o + 3] + (B[o + 3] - A[o + 3]) * w, ty = A[o + 7] + (B[o + 7] - A[o + 7]) * w, tz = A[o + 11] + (B[o + 11] - A[o + 11]) * w;
    A[o] = 1 - 2 * (y * y + z * z), A[o + 1] = 2 * (x * y - z * q), A[o + 2] = 2 * (x * z + y * q), A[o + 3] = tx;
    A[o + 4] = 2 * (x * y + z * q), A[o + 5] = 1 - 2 * (x * x + z * z), A[o + 6] = 2 * (y * z - x * q), A[o + 7] = ty;
    A[o + 8] = 2 * (x * z - y * q), A[o + 9] = 2 * (y * z + x * q), A[o + 10] = 1 - 2 * (x * x + y * y), A[o + 11] = tz;
  }
}

const LA = new Float32Array(12), LB = new Float32Array(12), PI = new Float32Array(12);
let locA = new Float32Array(0), locB = new Float32Array(0), origA = new Float32Array(0);

/**
 * A = blend(A, B, w) through the hierarchy: each bone's transform relative to its parent (parentOf; -1 or a bone
 * outside `bones` = blended in model space) is blended (quaternion nlerp + translation lerp) and the chain recomposed
 * root to tip. Blending model-space matrices independently (blendPose) lerps joint positions in straight lines, which
 * stretches and kinks fingers when the arm moves a lot during the blend (an attack cancel out of a raised inspect);
 * this keeps every bone length and only interpolates joint angles. `bones` must list parents before children.
 * `fingers` blends those bones (parent-relative) with their own weight (e.g. fingers that lag behind the knife).
 */
export function blendPoseH(A: Float32Array, B: Float32Array, w: number, bones: readonly number[], parentOf: (i: number) => number, fingers?: { bones: Set<number>; w: number }): void {
  if (w <= 0 && !(fingers && fingers.w > 0)) return;
  const n = A.length;
  if (locA.length < n) (locA = new Float32Array(n)), (locB = new Float32Array(n)), (origA = new Float32Array(n));
  origA.set(A);
  const inSet = new Set(bones);
  for (const i of bones) {
    const p = parentOf(i);
    const o = i * 12;
    if (p >= 0 && inSet.has(p)) {
      invertRigid(origA, p * 12, PI);
      concat(PI, 0, origA, o, locA, o);
      invertRigid(B, p * 12, PI);
      concat(PI, 0, B, o, locB, o);
    } else {
      locA.set(origA.subarray(o, o + 12), o);
      locB.set(B.subarray(o, o + 12), o);
    }
  }
  if (fingers) {
    blendPose(locA, locB, w, bones.filter((i) => !fingers.bones.has(i)));
    blendPose(locA, locB, fingers.w, bones.filter((i) => fingers.bones.has(i)));
  } else blendPose(locA, locB, w, bones);
  for (const i of bones) {
    const p = parentOf(i);
    const o = i * 12;
    if (p >= 0 && inSet.has(p)) {
      LA.set(locA.subarray(o, o + 12));
      concat(A, p * 12, LA, 0, LB, 0);
      A.set(LB, o);
    } else A.set(locA.subarray(o, o + 12), o);
  }
}

function invertRigid(m: ArrayLike<number>, o: number, out: Float32Array): void {
  const r00 = m[o], r01 = m[o + 1], r02 = m[o + 2], tx = m[o + 3];
  const r10 = m[o + 4], r11 = m[o + 5], r12 = m[o + 6], ty = m[o + 7];
  const r20 = m[o + 8], r21 = m[o + 9], r22 = m[o + 10], tz = m[o + 11];
  out[0] = r00, out[1] = r10, out[2] = r20, out[3] = -(r00 * tx + r10 * ty + r20 * tz);
  out[4] = r01, out[5] = r11, out[6] = r21, out[7] = -(r01 * tx + r11 * ty + r21 * tz);
  out[8] = r02, out[9] = r12, out[10] = r22, out[11] = -(r02 * tx + r12 * ty + r22 * tz);
}
