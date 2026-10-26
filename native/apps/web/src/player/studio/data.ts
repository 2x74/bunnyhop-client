// A loaded studio model (crates/core/src/studio.rs) on the client: skeleton, skinned mesh, sequences, pose parameters
// and lazily decoded animations. Shared by every instance of the same model (one decode per animation per session).
//
// All maths stays in Source conventions (model space: x forward, y left, z up; quaternions xyzw).

import type { Core } from "../../core";

export interface StudioBoneInfo {
  name: string;
  parent: number;
  pos: number[];
  quat: number[];
  poseToBone: number[];
  flags: number;
  quatInterp?: { control: number; triggers: { invTolerance: number; trigger: number[]; pos: number[]; quat: number[] }[] };
}

export interface StudioSeqInfo {
  name: string;
  activity: string;
  actWeight: number;
  flags: number;
  fadeIn: number;
  fadeOut: number;
  groupSize: [number, number];
  params: [number, number];
  paramStart: [number, number];
  paramEnd: [number, number];
  anims: number[];
  weights: number[];
  poseKeys: number[];
  layers: { seq: number; pose: number; flags: number; start: number; peak: number; tail: number; end: number }[];
}

export interface StudioMaterialInfo {
  name: string;
  shader: string;
  base: string | null;
  bump: string | null;
  translucent: boolean;
  alphatest: boolean;
  alphaRef: number;
  nocull: boolean;
  additive: boolean;
  selfillum: boolean;
  phong: boolean;
  phongExponent: number;
  phongBoost: number;
}

export interface StudioInfo {
  path: string;
  name: string;
  version: number;
  eye: number[];
  hull: [number[], number[]];
  includes: string[];
  bones: StudioBoneInfo[];
  attachments: { name: string; bone: number; local: number[] }[];
  poseParams: { name: string; flags: number; start: number; end: number; loop: number }[];
  anims: { name: string; fps: number; flags: number; frames: number }[];
  seqs: StudioSeqInfo[];
  materials: StudioMaterialInfo[];
  /** [material, firstIndex, indexCount] */
  groups: [number, number, number][];
  vertexCount: number;
  indexCount: number;
}

/** studio.h flags. */
export const STUDIO_LOOPING = 0x0001;
export const STUDIO_SNAP = 0x0002;
export const STUDIO_DELTA = 0x0004;
export const STUDIO_POST = 0x0010;
export const STUDIO_AL_SPLINE = 0x0040;
export const STUDIO_AL_XFADE = 0x0080;
export const STUDIO_AL_NOBLEND = 0x0200;
export const STUDIO_AL_LOCAL = 0x1000;
export const STUDIO_AL_POSE = 0x4000;

/** Floats per vertex from core.studioVertices: pos3 normal3 uv2 tangent4 weights3 bones3. */
export const VERTEX_FLOATS = 18;

/** Runtime form of a sequence, with what the bone setup needs precomputed. */
export interface Seq extends StudioSeqInfo {
  index: number;
  looping: boolean;
  delta: boolean;
  post: boolean;
  /** Per-bone weight (Float32Array copy of `weights`). */
  w: Float32Array;
  /** Bones with weight > 0 (the only ones this sequence touches). */
  active: Uint8Array;
}

export class StudioData {
  readonly info: StudioInfo;
  readonly bones: number;
  readonly parent: Int16Array;
  /** Bind (reference) pose, bone-local: quat xyzw / position. */
  readonly restQ: Float32Array;
  readonly restP: Float32Array;
  /** Inverse bind matrices, 3x4 row-major per bone. */
  readonly poseToBone: Float32Array;
  readonly seqs: Seq[];
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  private seqByName = new Map<string, number>();
  private animCache: (Float32Array | null)[];

  constructor(
    private core: Core,
    readonly handle: number,
  ) {
    this.info = JSON.parse(core.studioInfo(handle)) as StudioInfo;
    const n = (this.bones = this.info.bones.length);
    this.parent = new Int16Array(n);
    this.restQ = new Float32Array(n * 4);
    this.restP = new Float32Array(n * 3);
    this.poseToBone = new Float32Array(n * 12);
    this.info.bones.forEach((b, i) => {
      this.parent[i] = b.parent;
      this.restQ.set(b.quat, i * 4);
      this.restP.set(b.pos, i * 3);
      this.poseToBone.set(b.poseToBone, i * 12);
    });
    this.seqs = this.info.seqs.map((s, index) => {
      const w = Float32Array.from(s.weights.length === n ? s.weights : new Array(n).fill(1));
      const active: number[] = [];
      for (let b = 0; b < n; b++) if (w[b] > 0) active.push(b);
      return { ...s, index, looping: (s.flags & STUDIO_LOOPING) !== 0, delta: (s.flags & STUDIO_DELTA) !== 0, post: (s.flags & STUDIO_POST) !== 0, w, active: Uint8Array.from(active) };
    });
    this.seqs.forEach((s, i) => {
      const k = s.name.toLowerCase();
      if (!this.seqByName.has(k)) this.seqByName.set(k, i);
    });
    this.vertices = core.studioVertices(handle);
    this.indices = core.studioIndices(handle);
    this.animCache = new Array(this.info.anims.length).fill(null);
  }

  /** `LookupSequence` (case-insensitive), -1 if missing. */
  seq(name: string): number {
    return this.seqByName.get(name.toLowerCase()) ?? -1;
  }

  /** `SelectWeightedSequence` without the random pick: the first sequence with this activity. */
  seqForActivity(activity: string): number {
    const i = this.seqs.findIndex((s) => s.activity === activity);
    return i;
  }

  pose(name: string): number {
    return this.info.poseParams.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  bone(name: string): number {
    const k = name.toLowerCase();
    return this.info.bones.findIndex((b) => b.name.toLowerCase() === k);
  }

  /** Decoded frames of animation `a` (frames x bones x 7), decoded on first use. */
  anim(a: number): Float32Array {
    let d = this.animCache[a];
    if (!d) {
      d = this.core.studioAnim(this.handle, a);
      if (d.length !== this.info.anims[a].frames * this.bones * 7) {
        // Undecodable: hold the reference pose (or identity for deltas).
        const frames = this.info.anims[a].frames;
        const delta = (this.info.anims[a].flags & STUDIO_DELTA) !== 0;
        d = new Float32Array(frames * this.bones * 7);
        for (let f = 0; f < frames; f++)
          for (let b = 0; b < this.bones; b++) {
            const o = (f * this.bones + b) * 7;
            if (delta) d[o + 3] = 1;
            else {
              d.set(this.restQ.subarray(b * 4, b * 4 + 4), o);
              d.set(this.restP.subarray(b * 3, b * 3 + 3), o + 4);
            }
          }
      }
      this.animCache[a] = d;
    }
    return d;
  }

  /** Decodes every animation the given sequences (and their autolayers) use, so the first frames don't hitch. */
  warm(seqs: number[]): void {
    const seen = new Set<number>();
    const visit = (i: number) => {
      if (i < 0 || seen.has(i)) return;
      seen.add(i);
      const s = this.seqs[i];
      for (const a of s.anims) this.anim(a);
      for (const l of s.layers) visit(l.seq);
    };
    seqs.forEach(visit);
  }

  /** Bytes held by decoded animations. */
  get decodedBytes(): number {
    return this.animCache.reduce((s, a) => s + (a ? a.byteLength : 0), 0);
  }
}
