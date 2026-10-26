// Third-person inspects (the gesture layer): other players, replays, ghosts and your own third-person bunny show the
// same trick chain as the first-person viewmodel, driven by a puppet combo (combo.ts InspectCombo.remote) from the
// sender's signals (room samples SF_INSPECT_*, the replay's inspect trailer), cancelled by their attacks and snaps.
//
// What it poses, on top of the CS:S animation / procedural pose:
//   - the arm: the forearm swings up and in about the elbow toward the chest and rolls the palm up, by the trick's
//     "presented" amount (the same enter / exit / len as the first-person clip, so spectators see the same rhythm);
//   - the knife: the first-person clip's motion of the knife relative to the hand, sampled once per clip at 60 Hz on
//     the procedural rest pose and expressed in the knife's own axes (a spin about the blade's face normal stays one),
//     replayed on the third-person knife (the bunny's knife bone, player/bunny/rig.ts KNIFE_BONE; a CS:S model's
//     weapon_bone, the bone-merged w_knife follows it). Translations scale with the third-person knife (TpSpec.s).
// Fingers stay as animated (too small to read at third-person distances).
//
// Cost: nothing until a signal arrives (models create it lazily); then ~20 3x4 products per frame.

import type { V3 } from "../../player/bunny/rig";
import { concat, invert34 } from "../../player/bunny/rig";
import { KnifeHold } from "../knives/hold";
import type { KnifeDef, TpSpec } from "../knives/types";
import { VmProcedural } from "../procedural";
import { vmRig } from "../rig";
import { presented } from "./common";
import { InspectCombo, type ComboEvent, type ComboPose } from "./combo";
import { inspectSetFor } from "./index";
import { Arm, cross, D2R, dot, norm, sub } from "./kit";
import { rotAbout } from "../math";
import type { InspectClip, InspectSet } from "./types";

const RATE = 60;

/** Knife motion of a clip in knife-local coordinates (quaternion xyzw + translation per sample). */
interface Track {
  q: Float32Array;
  p: Float32Array;
  n: number;
}

const tracks = new WeakMap<InspectClip, Map<string, Track>>();

function quatOf(m: ArrayLike<number>, q: Float32Array, o: number): void {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6], m20 = m[8], m21 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    (w = 0.25 * s), (x = (m21 - m12) / s), (y = (m02 - m20) / s), (z = (m10 - m01) / s);
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    (w = (m21 - m12) / s), (x = 0.25 * s), (y = (m01 + m10) / s), (z = (m02 + m20) / s);
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    (w = (m02 - m20) / s), (x = (m01 + m10) / s), (y = 0.25 * s), (z = (m12 + m21) / s);
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    (w = (m10 - m01) / s), (x = (m02 + m20) / s), (y = (m12 + m21) / s), (z = 0.25 * s);
  }
  // Keep consecutive samples in the same hemisphere so interpolation never takes the long way.
  if (o >= 4 && x * q[o - 4] + y * q[o - 3] + z * q[o - 2] + w * q[o - 1] < 0) (x = -x), (y = -y), (z = -z), (w = -w);
  q[o] = x, q[o + 1] = y, q[o + 2] = z, q[o + 3] = w;
}

/** Samples a first-person clip's knife-in-hand motion (relative to the held knife), for knife `def`. */
export function inspectKnifeTrack(clip: InspectClip, def: KnifeDef | null): Track {
  let m = tracks.get(clip);
  if (!m) tracks.set(clip, (m = new Map()));
  const key = def?.id ?? "carrot";
  let tr = m.get(key);
  if (tr) return tr;
  const r = vmRig();
  const proc = new VmProcedural(r);
  const arm = new Arm(r);
  const hold = def ? new KnifeHold(def, r) : null;
  const W = new Float32Array(r.names.length * 12);
  const ctx = { arm, knife: def, state: hold?.state ?? null };
  const rel = (out: Float32Array) => {
    const Hi = new Float32Array(12);
    invert34(W, arm.handBone * 12, Hi, 0);
    concat(Hi, 0, W, arm.kb * 12, out, 0);
  };
  const base = () => {
    proc.pose("idle", 0, W);
    hold?.apply(W, "idle", 0);
  };
  base();
  const rel0 = new Float32Array(12), rel0i = new Float32Array(12), relT = new Float32Array(12), D = new Float32Array(12);
  rel(rel0);
  invert34(rel0, 0, rel0i, 0);
  const n = Math.ceil(clip.len * RATE) + 1;
  tr = { q: new Float32Array(n * 4), p: new Float32Array(n * 3), n };
  for (let i = 0; i < n; i++) {
    base();
    clip.apply(W, Math.min(clip.len, i / RATE), ctx);
    rel(relT);
    concat(rel0i, 0, relT, 0, D, 0);
    quatOf(D, tr.q, i * 4);
    tr.p[i * 3] = D[3], tr.p[i * 3 + 1] = D[7], tr.p[i * 3 + 2] = D[11];
  }
  m.set(key, tr);
  return tr;
}

/** D (3x4, knife-local) of a track at t. */
function sampleTrack(tr: Track, t: number, D: Float32Array): void {
  const f = Math.max(0, Math.min(tr.n - 1, t * RATE));
  const i = Math.min(tr.n - 2, Math.floor(f)), u = Math.max(0, f - i);
  const q = tr.q, p = tr.p;
  let x = q[i * 4] + (q[i * 4 + 4] - q[i * 4]) * u, y = q[i * 4 + 1] + (q[i * 4 + 5] - q[i * 4 + 1]) * u;
  let z = q[i * 4 + 2] + (q[i * 4 + 6] - q[i * 4 + 2]) * u, w = q[i * 4 + 3] + (q[i * 4 + 7] - q[i * 4 + 3]) * u;
  const l = Math.hypot(x, y, z, w) || 1;
  (x /= l), (y /= l), (z /= l), (w /= l);
  D[0] = 1 - 2 * (y * y + z * z), D[1] = 2 * (x * y - z * w), D[2] = 2 * (x * z + y * w);
  D[4] = 2 * (x * y + z * w), D[5] = 1 - 2 * (x * x + z * z), D[6] = 2 * (y * z - x * w);
  D[8] = 2 * (x * z - y * w), D[9] = 2 * (y * z + x * w), D[10] = 1 - 2 * (x * x + y * y);
  D[3] = p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * u;
  D[7] = p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * u;
  D[11] = p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * u;
}

/** How a model exposes its bones to the gesture layer. */
export interface TpBones {
  /** Bone index by full name (-1 if missing). */
  index(name: string): number;
  parent: ArrayLike<number>;
  count: number;
  /** Posed bone-to-model of bone i (model space: x forward, y left, z up). */
  posed(i: number, out: Float32Array): void;
  /** Bone i := M (model space) * bone i. */
  pre(i: number, M: Float32Array): void;
}

interface Resolved {
  fore: number;
  hand: number;
  index: number;
  middle: number;
  thumb: number;
  /** Forearm subtree minus the knife bone. */
  arm: number[];
  knife: number;
}

const resolvedCache = new WeakMap<object, Resolved | null>();

function resolve(b: TpBones, key: object, knifeBone: string): Resolved | null {
  if (resolvedCache.has(key)) return resolvedCache.get(key)!;
  const I = (n: string) => b.index(`ValveBiped.Bip01_${n}`);
  const fore = I("R_Forearm"), hand = I("R_Hand"), index = I("R_Finger1"), middle = I("R_Finger2"), thumb = I("R_Finger0");
  const knife = b.index(knifeBone);
  let out: Resolved | null = null;
  if (fore >= 0 && hand >= 0 && index >= 0 && middle >= 0 && knife >= 0) {
    const arm: number[] = [];
    for (let i = 0; i < b.count; i++) {
      let p = i;
      while (p >= 0 && p !== fore) p = b.parent[p];
      if (p === fore && i !== knife) arm.push(i);
    }
    out = { fore, hand, index, middle, thumb, arm, knife };
  }
  resolvedCache.set(key, out);
  return out;
}

const PRESENT_DIR = norm([1, 0.55, 0.62]);

export class TpInspect {
  readonly combo: InspectCombo;
  private set: InspectSet;
  private knife: KnifeDef | null = null;
  private held = false;
  private pz: ComboPose = { cur: null, prev: null, mix: 1, weight: 0 };
  private A = new Float32Array(12);
  private B = new Float32Array(12);
  private M = new Float32Array(12);
  private M2 = new Float32Array(12);
  private P = new Float32Array(12);
  private D = new Float32Array(12);
  private D2 = new Float32Array(12);
  private F = new Float32Array(12);
  private Fi = new Float32Array(12);

  constructor(knife: KnifeDef | null = null) {
    this.knife = knife;
    this.set = inspectSetFor(knife);
    this.combo = new InspectCombo(this.set.spec);
  }

  setKnife(k: KnifeDef | null): void {
    if (k?.id === "carrot") k = null;
    if (k === this.knife) return;
    this.knife = k;
    this.set = inspectSetFor(k);
    this.combo.setSpec(this.set.spec);
  }

  get active(): boolean {
    return this.pz.weight > 0 || this.combo.active;
  }

  /** Sender's signal (SIG_START / SIG_NEXT). */
  signal(sig: number): ComboEvent[] {
    return this.combo.remote(sig);
  }

  setHeld(h: boolean): void {
    this.held = h;
  }

  cancel(reason: "attack" | "draw"): void {
    this.combo.cancel(reason);
  }

  reset(): void {
    this.combo.reset();
    this.pz.weight = 0;
  }

  update(dt: number): ComboEvent[] {
    const ev = this.combo.update(dt, this.held);
    this.combo.pose(this.pz);
    return ev;
  }

  /** Clip id playing (debug), or null. */
  get playing(): string | null {
    return this.pz.cur ? this.set.clips[this.pz.cur.trick].id : null;
  }

  /**
   * Poses the gesture on a model. `tp`: the knife's third-person placement in R_Hand's bone frame (bunny), or null to
   * place the knife frame on the hand's axes (CS:S models' weapon_bone).
   */
  apply(b: TpBones, key: object, knifeBone: string, tp: TpSpec | null): void {
    const pz = this.pz;
    if (!pz.cur || pz.weight <= 0) return;
    const R = resolve(b, key, knifeBone);
    if (!R) return;
    const clips = this.set.clips;
    const w = pz.weight;
    // Presented amount and knife motion (crossfaded like the first person).
    const cc = clips[pz.cur.trick];
    let p = presented(pz.cur.t, cc.enter, cc.exit, cc.len);
    sampleTrack(inspectKnifeTrack(cc, this.knife), pz.cur.t, this.D);
    if (pz.prev && pz.mix < 1) {
      const pc = clips[pz.prev.trick];
      p = presented(pz.prev.t, pc.enter, pc.exit, pc.len) * (1 - pz.mix) + p * pz.mix;
      sampleTrack(inspectKnifeTrack(pc, this.knife), pz.prev.t, this.D2);
      blend34(this.D2, this.D, pz.mix, this.D);
    }
    p *= w;
    if (w < 1) blend34(IDENTITY, this.D, w, this.D);

    // --- Arm: swing the forearm about the elbow toward the chest-front direction, roll the palm up.
    b.posed(R.fore, this.A);
    b.posed(R.hand, this.B);
    const elbow: V3 = [this.A[3], this.A[7], this.A[11]];
    const dir = norm(sub([this.B[3], this.B[7], this.B[11]], elbow));
    if (p > 1e-3) {
      const ax = cross(dir, PRESENT_DIR);
      const s = Math.hypot(ax[0], ax[1], ax[2]);
      const ang = Math.atan2(s, dot(dir, PRESENT_DIR)) * 0.75 * p;
      if (s > 1e-6) rotAbout([ax[0] / s, ax[1] / s, ax[2] / s], ang, elbow, this.M);
      else this.M.set(IDENTITY);
      const nd = norm([this.M[0] * dir[0] + this.M[1] * dir[1] + this.M[2] * dir[2], this.M[4] * dir[0] + this.M[5] * dir[1] + this.M[6] * dir[2], this.M[8] * dir[0] + this.M[9] * dir[1] + this.M[10] * dir[2]]);
      rotAbout(nd, -70 * p * D2R, elbow, this.M2);
      concat(this.M2, 0, this.M, 0, this.P, 0);
      for (const i of R.arm) b.pre(i, this.P);
      b.pre(R.knife, this.P);
    }

    // --- Knife: the clip's knife-local motion on the third-person knife frame F (posed): K' = F D F^-1 K.
    b.posed(R.hand, this.B);
    if (tp) {
      // Knife frame = hand bone * G (TpSpec: origin o, axes from z / y, uniform scale s; D's translation scales by s).
      const z = norm(tp.z), y0 = tp.y;
      const yd = dot(y0 as V3, z);
      const y = norm([y0[0] - z[0] * yd, y0[1] - z[1] * yd, y0[2] - z[2] * yd]);
      const x = cross(y, z);
      this.A.set([x[0], y[0], z[0], tp.o[0], x[1], y[1], z[1], tp.o[1], x[2], y[2], z[2], tp.o[2]]);
      concat(this.B, 0, this.A, 0, this.F, 0);
      this.D[3] *= tp.s, this.D[7] *= tp.s, this.D[11] *= tp.s;
    } else {
      // CS:S model: a frame on the hand's axes at the knife bone (x toward the fingers, y palm normal, z toward the index).
      b.posed(R.index, this.A);
      b.posed(R.middle, this.M);
      b.posed(R.knife, this.M2);
      const o: V3 = [this.M2[3], this.M2[7], this.M2[11]];
      const hx = norm(sub([(this.A[3] + this.M[3]) / 2, (this.A[7] + this.M[7]) / 2, (this.A[11] + this.M[11]) / 2], [this.B[3], this.B[7], this.B[11]]));
      let hz = sub([this.A[3], this.A[7], this.A[11]], [this.M[3], this.M[7], this.M[11]]);
      const k = dot(hz, hx);
      hz = norm([hz[0] - hx[0] * k, hz[1] - hx[1] * k, hz[2] - hx[2] * k]);
      const hy = cross(hz, hx);
      this.F.set([hx[0], hy[0], hz[0], o[0], hx[1], hy[1], hz[1], o[1], hx[2], hy[2], hz[2], o[2]]);
      this.D[3] *= 1.3, this.D[7] *= 1.3, this.D[11] *= 1.3;
    }
    invert34(this.F, 0, this.Fi, 0);
    concat(this.F, 0, this.D, 0, this.A, 0);
    concat(this.A, 0, this.Fi, 0, this.M, 0);
    b.pre(R.knife, this.M);
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
const qa = new Float32Array(4), qb = new Float32Array(4);

/** out = blend(a, b, w) for rigid 3x4s (nlerp). out may alias b. */
function blend34(a: Float32Array, b: Float32Array, w: number, out: Float32Array): void {
  quatOf(a, qa, 0);
  quatOf(b, qb, 0);
  const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
  const tx = a[3] + (b[3] - a[3]) * w, ty = a[7] + (b[7] - a[7]) * w, tz = a[11] + (b[11] - a[11]) * w;
  let x = qa[0] + (qb[0] * s - qa[0]) * w, y = qa[1] + (qb[1] * s - qa[1]) * w, z = qa[2] + (qb[2] * s - qa[2]) * w, q = qa[3] + (qb[3] * s - qa[3]) * w;
  const l = Math.hypot(x, y, z, q) || 1;
  (x /= l), (y /= l), (z /= l), (q /= l);
  out[0] = 1 - 2 * (y * y + z * z), out[1] = 2 * (x * y - z * q), out[2] = 2 * (x * z + y * q), out[3] = tx;
  out[4] = 2 * (x * y + z * q), out[5] = 1 - 2 * (x * x + z * z), out[6] = 2 * (y * z - x * q), out[7] = ty;
  out[8] = 2 * (x * z - y * q), out[9] = 2 * (y * z + x * q), out[10] = 1 - 2 * (x * x + y * y), out[11] = tz;
}
