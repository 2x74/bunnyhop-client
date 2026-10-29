// The bunny's rig: the CS:S player skeleton (ValveBiped bone names, hierarchy and bind pose, baked into skeleton.json
// by tools/model/skeleton.ts) plus four bunny-only ear bones under the head and the knife bone under the right hand. The mesh (mesh.ts) is authored in this
// bind pose, so the CS:S animations (models/player/cs_player_shared.mdl, through studio/animstate.ts + pose.ts) pose
// it exactly like a CS:S player model.
//
// Conventions: Source model space (x, y, z; z up). In the bind pose the character faces -Y with its left side at +X
// (that's how the ValveBiped reference pose is authored; the animations turn the pelvis to face +X). Matrices are 3x4
// row-major like pose.ts.

import skeleton from "./skeleton.json";

export type V3 = [number, number, number];

export const EAR_BONES = ["bunny.EarL", "bunny.EarL2", "bunny.EarR", "bunny.EarR2"] as const;
/**
 * The blade's bone (after the ears): child of R_Hand with R_Hand's bind, so it follows the hand exactly (BunnyModel
 * copies the hand's matrix) until an inspect spins / tosses the knife on its own (viewmodel/inspects/third.ts).
 */
export const KNIFE_BONE = "bunny.Knife";

export interface Rig {
  names: string[];
  parent: Int16Array;
  /** Bind pose, bone-to-model (3x4 per bone). */
  bind: Float32Array;
  /** CS:S bones (the skeleton.json part); ear bones follow. */
  csBones: number;
  index(name: string): number;
  /** Bind-pose position of a bone ("L_Thigh" is short for "ValveBiped.Bip01_L_Thigh"). */
  at(name: string): V3;
  bone(name: string): number;
}

/** Ear base / mid joint positions (bind pose), and the ears' rest direction. Shared by mesh.ts and the animator. */
export const EAR = {
  base: [2.25, 1.35, 74.3] as V3,
  /** Unit rest direction of the ear's first segment (left ear; mirror x for the right). */
  dir: [0.27, 0.36, 0.893] as V3,
  /** Length of the first segment (base -> mid joint) and of the whole ear. */
  seg: 4.4,
  length: 9.6,
};

/**
 * The ears with the hood down (a wig on: mesh.ts hoodDown): coming off the outside of the lowered hood on the upper
 * back, out and down, then drooping; carried by the upper spine instead of the head. Base and rest direction of the left
 * ear (mirror x); the tip direction it droops to. Same lengths as EAR.
 */
export const EAR_DOWN = {
  base: [2.3, 9.9, 60.2] as V3,
  dir: [0.3, 0.62, -0.72] as V3,
  tip: [0.3, 0.06, -0.95] as V3,
  carrier: "Spine4",
};

/** 3x4 from a quaternion (xyzw) and position. */
export function quatMat(q: ArrayLike<number>, p: ArrayLike<number>, out: Float32Array | number[], o = 0): void {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  out[o] = 1 - 2 * y * y - 2 * z * z;
  out[o + 1] = 2 * x * y - 2 * w * z;
  out[o + 2] = 2 * x * z + 2 * w * y;
  out[o + 3] = p[0];
  out[o + 4] = 2 * x * y + 2 * w * z;
  out[o + 5] = 1 - 2 * x * x - 2 * z * z;
  out[o + 6] = 2 * y * z - 2 * w * x;
  out[o + 7] = p[1];
  out[o + 8] = 2 * x * z - 2 * w * y;
  out[o + 9] = 2 * y * z + 2 * w * x;
  out[o + 10] = 1 - 2 * x * x - 2 * y * y;
  out[o + 11] = p[2];
}

/** Inverse of a rigid 3x4. */
export function invert34(m: Float32Array | number[], mo: number, out: Float32Array | number[], oo: number): void {
  const r00 = m[mo], r01 = m[mo + 1], r02 = m[mo + 2], tx = m[mo + 3];
  const r10 = m[mo + 4], r11 = m[mo + 5], r12 = m[mo + 6], ty = m[mo + 7];
  const r20 = m[mo + 8], r21 = m[mo + 9], r22 = m[mo + 10], tz = m[mo + 11];
  out[oo] = r00, out[oo + 1] = r10, out[oo + 2] = r20, out[oo + 3] = -(r00 * tx + r10 * ty + r20 * tz);
  out[oo + 4] = r01, out[oo + 5] = r11, out[oo + 6] = r21, out[oo + 7] = -(r01 * tx + r11 * ty + r21 * tz);
  out[oo + 8] = r02, out[oo + 9] = r12, out[oo + 10] = r22, out[oo + 11] = -(r02 * tx + r12 * ty + r22 * tz);
}

/** Point through a 3x4. */
export function xform(m: ArrayLike<number>, o: number, p: ArrayLike<number>): V3 {
  return [
    m[o] * p[0] + m[o + 1] * p[1] + m[o + 2] * p[2] + m[o + 3],
    m[o + 4] * p[0] + m[o + 5] * p[1] + m[o + 6] * p[2] + m[o + 7],
    m[o + 8] * p[0] + m[o + 9] * p[1] + m[o + 10] * p[2] + m[o + 11],
  ];
}

let cached: Rig | null = null;

export function rig(): Rig {
  if (cached) return cached;
  const bones = (skeleton as { bones: { name: string; parent: number; pos: number[]; quat: number[] }[] }).bones;
  const n = bones.length + EAR_BONES.length + 1;
  const names = [...bones.map((b) => b.name), ...EAR_BONES, KNIFE_BONE];
  const parent = new Int16Array(n);
  const bind = new Float32Array(n * 12);
  const local = new Float32Array(12);
  bones.forEach((b, i) => {
    parent[i] = b.parent;
    quatMat(b.quat, b.pos, local);
    if (b.parent < 0) bind.set(local, i * 12);
    else concat(bind, b.parent * 12, local, 0, bind, i * 12);
  });
  const head = names.indexOf("ValveBiped.Bip01_Head1");
  // Ear bones: identity rotation in model space, at the ear joints.
  const ear = (side: number): [V3, V3] => {
    const base: V3 = [EAR.base[0] * side, EAR.base[1], EAR.base[2]];
    const mid: V3 = [base[0] + EAR.dir[0] * side * EAR.seg, base[1] + EAR.dir[1] * EAR.seg, base[2] + EAR.dir[2] * EAR.seg];
    return [base, mid];
  };
  const [lb, lm] = ear(1);
  const [rb, rm] = ear(-1);
  [lb, lm, rb, rm].forEach((p, k) => {
    const i = bones.length + k;
    parent[i] = k % 2 === 0 ? head : i - 1;
    quatMat([0, 0, 0, 1], p, bind, i * 12);
  });
  {
    const hand = names.indexOf("ValveBiped.Bip01_R_Hand");
    parent[n - 1] = hand;
    bind.copyWithin((n - 1) * 12, hand * 12, hand * 12 + 12);
  }
  const idx = new Map(names.map((nm, i) => [nm.toLowerCase(), i]));
  const index = (name: string) => idx.get(name.toLowerCase()) ?? -1;
  const bone = (name: string) => {
    const i = index(name.includes(".") ? name : `ValveBiped.Bip01_${name}`);
    if (i < 0) throw new Error(`bunny rig: no bone ${name}`);
    return i;
  };
  cached = {
    names,
    parent,
    bind,
    csBones: bones.length,
    index,
    bone,
    at: (name) => {
      const i = bone(name);
      return [bind[i * 12 + 3], bind[i * 12 + 7], bind[i * 12 + 11]];
    },
  };
  return cached;
}

/** out (3x4) = a (3x4) * b (3x4); out may alias neither input. */
export function concat(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, out: Float32Array | number[], oo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4], a1 = a[ao + r * 4 + 1], a2 = a[ao + r * 4 + 2], a3 = a[ao + r * 4 + 3];
    out[oo + r * 4] = a0 * b[bo] + a1 * b[bo + 4] + a2 * b[bo + 8];
    out[oo + r * 4 + 1] = a0 * b[bo + 1] + a1 * b[bo + 5] + a2 * b[bo + 9];
    out[oo + r * 4 + 2] = a0 * b[bo + 2] + a1 * b[bo + 6] + a2 * b[bo + 10];
    out[oo + r * 4 + 3] = a0 * b[bo + 3] + a1 * b[bo + 7] + a2 * b[bo + 11] + a3;
  }
}
