// A knife's moving parts in third person (v0.0.38, Astra 11-06: the Bunnyfly stayed open and the Whirligig's spinner
// still while the first person flipped and spun them). The same joint angles as the viewmodel (KnifeState.angles, in
// KnifeDef.joints order) pose the same chain of pivots: each part turns by -angle about the knife-local x axis through
// its pivot, after its parent part (viewmodel/rig.ts EXTRA_BONES: Bfly_Blade on the knife, Bfly_Bite on the blade,
// Bfly_Latch on the bite handle, Whirl_Spin on the knife).
//
//   knifePartDeforms(def, angles, out)   knife-local 3x4 per joint: part point p -> its posed knife-local point
//   PartPoser (player/bunny/model.ts)    those in the bunny's model space for the third-person part bones
//
// The angles come from the knife's own pose() (idle on the model's clock: the Whirligig's thumb flicks) and, while an
// inspect plays, the trick's sampled angles on top (inspects/third.ts TpInspect.angles): pure functions of time.

import { concat, invert34, type V3 } from "../../player/bunny/rig";
import { rotAbout } from "../math";
import { EXTRA_BONES } from "../rig";
import type { KnifeDef, KnifeState, TpSpec } from "./types";

const D2R = Math.PI / 180;

interface Chain {
  /** Joint index of the parent part (-1: the knife itself). */
  parent: number;
  /** Pivot, knife-local. */
  pivot: V3;
}

const chains = new Map<string, Chain[]>();

/** Each joint's parent joint and knife-local pivot (from the viewmodel's extra bones). */
export function partChain(def: KnifeDef): Chain[] {
  let c = chains.get(def.id);
  if (c) return c;
  const joints = def.joints ?? [];
  const full = (s: string) => `v_weapon.${s}`;
  const byName = new Map(EXTRA_BONES.map((e) => [e.name, e]));
  c = joints.map((j) => {
    const e = byName.get(full(j));
    if (!e) throw new Error(`tp-parts: no extra bone ${j}`);
    // Knife-local pivot: the bind positions are translations only, summed up to Knife_Handle.
    const pivot: V3 = [0, 0, 0];
    let cur: typeof e | undefined = e;
    while (cur) {
      pivot[0] += cur.pos[0], pivot[1] += cur.pos[1], pivot[2] += cur.pos[2];
      cur = byName.get(cur.parent);
    }
    const parentShort = e.parent.replace("v_weapon.", "");
    return { parent: joints.indexOf(parentShort), pivot };
  });
  chains.set(def.id, c);
  return c;
}

/** Knife-local deformation per joint (out[j]: 12 floats) for these angles. */
export function knifePartDeforms(def: KnifeDef, angles: ArrayLike<number>, out: Float32Array[]): void {
  const c = partChain(def);
  const R = new Float32Array(12);
  c.forEach((j, k) => {
    rotAbout([1, 0, 0], -(angles[k] ?? 0) * D2R, j.pivot, R);
    if (j.parent >= 0) concat(out[j.parent], 0, R, 0, out[k], 0);
    else out[k].set(R);
  });
}

/** Knife-local -> bunny R_Hand bind-frame transform for a TpSpec (what tpCtx builds the third-person knife with). */
export function tpFrame(tp: TpSpec, out = new Float32Array(12)): Float32Array {
  const n = (v: readonly number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const z = n(tp.z);
  const d = tp.y[0] * z[0] + tp.y[1] * z[1] + tp.y[2] * z[2];
  const y = n([tp.y[0] - z[0] * d, tp.y[1] - z[1] * d, tp.y[2] - z[2] * d]);
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  const s = tp.s;
  out.set([x[0] * s, y[0] * s, z[0] * s, tp.o[0], x[1] * s, y[1] * s, z[1] * s, tp.o[1], x[2] * s, y[2] * s, z[2] * s, tp.o[2]]);
  return out;
}

/**
 * Poses the third-person part bones of one knife: the skinning matrix of each part bone (bind = the knife bone's =
 * R_Hand's) is S_knife * C * Def_j * C^-1, C = R_Hand's bind * tpFrame(tp) (the knife-local -> bind map tpCtx used).
 */
export class PartPoser {
  private C = new Float32Array(12);
  private Ci = new Float32Array(12);
  private defs: Float32Array[] = [];
  private T = new Float32Array(12);
  private U = new Float32Array(12);
  /** Scratch hold state for the knife's own idle pose (angles on the model's clock). */
  private st: KnifeState | null = null;
  readonly angles: number[] = [];

  constructor(
    readonly def: KnifeDef,
    handBind: Float32Array,
    handBindOffset: number,
    tp: TpSpec,
  ) {
    const G = tpFrame(tp);
    concat(handBind, handBindOffset, G, 0, this.C, 0);
    // C^-1 = G^-1 B^-1: invert34 assumes a rigid matrix, and G carries the TpSpec's scale (G^-1 = [R^T / s | -R^T o / s]).
    const Bi = new Float32Array(12), Gi = new Float32Array(12), s2 = tp.s * tp.s;
    invert34(handBind, handBindOffset, Bi, 0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Gi[i * 4 + j] = G[j * 4 + i] / s2;
    for (let i = 0; i < 3; i++) Gi[i * 4 + 3] = -(Gi[i * 4] * G[3] + Gi[i * 4 + 1] * G[7] + Gi[i * 4 + 2] * G[11]);
    concat(Gi, 0, Bi, 0, this.Ci, 0);
    const n = def.joints?.length ?? 0;
    for (let i = 0; i < n; i++) this.defs.push(new Float32Array(12)), this.angles.push(0);
  }

  get count(): number {
    return this.defs.length;
  }

  /** The knife's own joint angles at model time `time` (its idle: the Whirligig's flicks; the Bunnyfly open). */
  baseAngles(time: number): number[] {
    const n = this.defs.length;
    if (!this.st) this.st = { arm: { o: [0, 0, 0], a: [0, 0, 0] }, wrist: [0, 0, 0], offset: [0, 0, 0], local: null, angles: new Array(n).fill(0), show: 0, loosen: 0, lock: 0, thumb: [0, 0, 0], time: 0 };
    const st = this.st;
    for (let i = 0; i < n; i++) st.angles[i] = 0;
    st.time = time;
    this.def.pose?.("idle", 0, st, "procedural");
    for (let i = 0; i < n; i++) this.angles[i] = st.angles[i];
    return this.angles;
  }

  /** Writes the part bones' skinning matrices into S (bones[j] per joint), from the knife bone's at kOff. */
  pose(S: Float32Array, kOff: number, bones: readonly number[], angles: ArrayLike<number>): void {
    knifePartDeforms(this.def, angles, this.defs);
    for (let j = 0; j < this.defs.length; j++) {
      const b = bones[j];
      if (b < 0) continue;
      concat(this.C, 0, this.defs[j], 0, this.T, 0);
      concat(this.T, 0, this.Ci, 0, this.U, 0);
      concat(S, kOff, this.U, 0, S, b * 12);
    }
  }
}
