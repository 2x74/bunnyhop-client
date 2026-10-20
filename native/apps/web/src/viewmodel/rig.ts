// The first-person viewmodel rig: the CS:S knife viewmodel skeleton (models/weapons/v_knife_t.mdl bone names, hierarchy
// and bind pose, baked into skeleton.json by tools/model/viewmodel-skeleton.ts; structural data only). The bunny's
// gloved hands, hoodie sleeves and carrot blade (mesh.ts) are authored in this bind pose, so v_knife_t's sequences
// (loaded at runtime from the hosted content) pose them bone-for-bone, the way the third-person bunny runs the CS:S
// player animations.
//
// Conventions: Source viewmodel space (x forward from the eye, y left, z up; units). In the bind pose both arms point
// along -Y (to the right) with the hands at y ~ -12..-17; the knife lies further out along -Y. Matrices are 3x4
// row-major like player/studio/pose.ts.
//
// Extra bones (ours, not in v_knife_t; appended after skeleton.json's 60 so every existing index is unchanged): the
// knife parts that move relative to Knife_Handle (see EXTRA_BONES). v_knife_t's sequences don't know them, so the
// viewmodel poses them every frame from their parent + an angle (knives/hold.ts KnifeHold.solve), after the inspect.

import skeleton from "./skeleton.json";
import { concat, invert34, quatMat, type V3 } from "../player/bunny/rig";

/**
 * Bunnyfly (balisong) pivots, in Knife_Handle's local frame (z along the blade, y across its width, x through its
 * thickness = the pin axis). Knife_Handle itself is the SAFE handle (the one the fist holds); the pins sit at the top of
 * the grip, y = +pinY (safe handle / blade) and y = -pinY (bite handle / blade).
 */
export const BFLY = { pinZ: 2.35, pinY: 0.3 } as const;

/**
 * Extra bones, parent-local bind (translation only, identity rotation, so each bone's local x is the pin axis):
 *   v_weapon.Bfly_Blade  parent Knife_Handle, at pin A (0, +pinY, pinZ): the blade, rotating about pin A relative to the
 *                        safe handle. Angle 0 = open (blade out of the fist along +z), 180 = closed (folded into the
 *                        handles); it rotates by -angle about local x.
 *   v_weapon.Bfly_Bite   parent Bfly_Blade, at pin B (0, -2 pinY, 0) from pin A: the bite (latch) handle, rotating about
 *                        pin B relative to the blade. Angle 0 = open (alongside the safe handle when the blade is open),
 *                        180 = closed over the blade's edge; it rotates by -angle about local x.
 * Both closed (180, 180) is the idle; knives/bunnyfly.ts poseBunnyfly() drives them (and can keep the bite handle in
 * the fist instead of the safe one, for flips).
 */
export const EXTRA_BONES: { name: string; parent: string; pos: V3 }[] = [
  { name: "v_weapon.Bfly_Blade", parent: "v_weapon.Knife_Handle", pos: [0, BFLY.pinY, BFLY.pinZ] },
  { name: "v_weapon.Bfly_Bite", parent: "v_weapon.Bfly_Blade", pos: [0, -2 * BFLY.pinY, 0] },
];

export interface VmRig {
  names: string[];
  parent: Int16Array;
  /** Bind pose, bone-to-model (3x4 per bone). */
  bind: Float32Array;
  /** Inverse bind (model-to-bone). */
  inv: Float32Array;
  /** Index of the first extra bone (EXTRA_BONES): bones below it are v_knife_t's. */
  extra: number;
  /** Bone index by full name (case-insensitive), -1 if missing. */
  index(name: string): number;
  /** Bone index by short name ("Right_Hand" -> "v_weapon.Right_Hand"); throws if missing. */
  bone(name: string): number;
  /** Bind-pose position of a bone (short name). */
  at(name: string): V3;
  /** Bind-pose local axis k (0 x, 1 y, 2 z) of a bone, model space. */
  axis(name: string, k: number): V3;
  /** Bones in the subtree of `root` (inclusive). */
  subtree(root: number): number[];
}

let cached: VmRig | null = null;

export function vmRig(): VmRig {
  if (cached) return cached;
  const base = (skeleton as { bones: { name: string; parent: number; pos: number[]; quat: number[] }[] }).bones;
  const byName = (nm: string) => base.findIndex((b) => b.name === nm);
  const bones = [...base];
  for (const e of EXTRA_BONES) {
    const parent = Math.max(byName(e.parent), bones.findIndex((b) => b.name === e.parent));
    bones.push({ name: e.name, parent, pos: e.pos, quat: [0, 0, 0, 1] });
  }
  const n = bones.length;
  const names = bones.map((b) => b.name);
  const parent = new Int16Array(n);
  const bind = new Float32Array(n * 12);
  const inv = new Float32Array(n * 12);
  const local = new Float32Array(12);
  bones.forEach((b, i) => {
    parent[i] = b.parent;
    quatMat(b.quat, b.pos, local);
    if (b.parent < 0) bind.set(local, i * 12);
    else concat(bind, b.parent * 12, local, 0, bind, i * 12);
    invert34(bind, i * 12, inv, i * 12);
  });
  const idx = new Map(names.map((nm, i) => [nm.toLowerCase(), i]));
  const index = (name: string) => idx.get(name.toLowerCase()) ?? -1;
  const bone = (name: string) => {
    const i = index(name.startsWith("v_weapon") ? name : `v_weapon.${name}`);
    if (i < 0) throw new Error(`viewmodel rig: no bone ${name}`);
    return i;
  };
  cached = {
    names,
    parent,
    bind,
    inv,
    extra: base.length,
    index,
    bone,
    at: (name) => {
      const o = bone(name) * 12;
      return [bind[o + 3], bind[o + 7], bind[o + 11]];
    },
    axis: (name, k) => {
      const o = bone(name) * 12;
      return [bind[o + k], bind[o + 4 + k], bind[o + 8 + k]];
    },
    subtree: (root) => {
      const out = [root];
      for (let i = 0; i < n; i++) {
        let p = parent[i];
        while (p >= 0 && p !== root) p = parent[p];
        if (p === root && i !== root) out.push(i);
      }
      return out;
    },
  };
  return cached;
}
