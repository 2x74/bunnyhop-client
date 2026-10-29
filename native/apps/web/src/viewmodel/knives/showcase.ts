// A knife on its own, for the Loadout screen (ui/loadout-stage.ts): the close-up turntable and the item thumbnails.
// The registry knife built in its knife-local frame (no hands), skinned like the knife lab's turntable (knives/lab.ts:
// Knife_Handle at identity, extra bones posed by the knife's hold layer), in the player solid material with the
// production finish shader, so the blade looks exactly as it does in your hand. Geometry is built once per knife and
// cached; one material per finish kind is kept alive so switching finishes never recompiles.
//
//   const s = new KnifeShowcase();  scene.add(s.root);
//   s.setKnife(knifeById("karrotbit")); s.setFinish(specOf(loadout));
//   s.root.quaternion = ...   // knife-local (x through the blade, y across, z toward the tip) -> world; centred at 0

import * as THREE from "three";
import { Builder } from "../../player/bunny/builder";
import { colourway, paletteOf } from "../../player/bunny/palettes";
import { playerUniforms, solidMaterial, type PlayerUniforms } from "../../player/materials";
import { concat, invert34 } from "../../player/bunny/rig";
import { lookOf, setFinishUniforms, type FinishSpec } from "../finishes/shader";
import { vmRig } from "../rig";
import { KnifeCtx } from "./ctx";
import { KnifeHold } from "./hold";
import type { KnifeDef } from "./types";

interface Built {
  geo: THREE.BufferGeometry;
  /** Bounding box centre (knife-local) and bounding sphere radius about it. */
  center: THREE.Vector3;
  radius: number;
  /** Half extents of the box (knife-local x, y, z). */
  half: THREE.Vector3;
  /** Every few vertices, centred (knife-local): tight framing at any angle (extentAt). */
  pts: Float32Array;
}

const built = new Map<string, Built>();

function build(k: KnifeDef): Built {
  let b = built.get(k.id);
  if (b) return b;
  const r = vmRig();
  const kb = r.bone("Knife_Handle");
  const bld = new Builder();
  const ctx = new KnifeCtx(bld, "fp", (p) => [p[0], p[1], p[2]], (bone) => [[bone ? r.bone(bone) : kb, 1]]);
  k.build(ctx);
  const geo = bld.geometry();
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const P = geo.getAttribute("position");
  const step = Math.max(1, Math.floor(P.count / 1500));
  const pts = new Float32Array(Math.ceil(P.count / step) * 3);
  for (let i = 0, j = 0; i < P.count; i += step, j += 3) {
    pts[j] = P.getX(i) - center.x;
    pts[j + 1] = P.getY(i) - center.y;
    pts[j + 2] = P.getZ(i) - center.z;
  }
  b = { geo, center, radius: half.length(), half, pts };
  built.set(k.id, b);
  return b;
}

/** Builds (and caches) a knife's showcase geometry ahead of time (idle prewarm). */
export function prewarmShowcase(k: KnifeDef): void {
  build(k);
}

export class KnifeShowcase {
  /** Orient / place this (knife-local -> world); the knife's bounding-box centre sits at its origin. */
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms = playerUniforms();
  private mesh: THREE.SkinnedMesh;
  private skeleton: THREE.Skeleton;
  private hold: KnifeHold | null = null;
  private knife: KnifeDef | null = null;
  private mats = new Map<number, THREE.ShaderMaterial>();
  private BLinv: Float32Array;
  private W: Float32Array;
  private S = new Float32Array(12);
  private cur: Built | null = null;

  constructor() {
    const r = vmRig();
    const n = r.names.length;
    const bones = Array.from({ length: n }, () => new THREE.Bone());
    this.skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
    // Bone matrices are written directly (like the viewmodel's DirectSkeleton): three must not recompute them.
    const sk = this.skeleton;
    sk.update = () => {
      if (sk.boneTexture) sk.boneTexture.needsUpdate = true;
    };
    this.mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), this.material(0));
    this.mesh.bindMode = THREE.DetachedBindMode;
    this.mesh.bind(sk, new THREE.Matrix4());
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    // Knife-local skinning: bone j's knife-local bind BL_j = inv(bind_Knife_Handle) * bind_j.
    const kb = r.bone("Knife_Handle");
    const invKb = new Float32Array(12);
    invert34(r.bind, kb * 12, invKb, 0);
    this.BLinv = new Float32Array(n * 12);
    this.W = new Float32Array(n * 12);
    const tmp = new Float32Array(12);
    for (let i = 0; i < n; i++) {
      concat(invKb, 0, r.bind, i * 12, tmp, 0);
      invert34(tmp, 0, this.BLinv, i * 12);
    }
  }

  private material(code: number): THREE.ShaderMaterial {
    let m = this.mats.get(code);
    if (!m) this.mats.set(code, (m = solidMaterial(this.uniforms, { finish: code, glove: false, detail: true })));
    return m;
  }

  /** The bounding sphere radius of the knife shown (about its centre). */
  get radius(): number {
    return this.cur?.radius ?? 8;
  }

  /** Half extents of the knife's box, knife-local. */
  get half(): THREE.Vector3 {
    return this.cur?.half ?? new THREE.Vector3(1, 1, 6);
  }

  /** Half extents (x, y, z in world axes) of the knife turned by `q`: a tight fit for a fixed view. */
  extentAt(q: THREE.Quaternion): THREE.Vector3 {
    const out = new THREE.Vector3();
    const pts = this.cur?.pts;
    if (!pts) return out.set(1, 1, 1);
    const v = new THREE.Vector3();
    for (let j = 0; j < pts.length; j += 3) {
      v.set(pts[j], pts[j + 1], pts[j + 2]).applyQuaternion(q);
      out.set(Math.max(out.x, Math.abs(v.x)), Math.max(out.y, Math.abs(v.y)), Math.max(out.z, Math.abs(v.z)));
    }
    return out;
  }

  get current(): KnifeDef | null {
    return this.knife;
  }

  setKnife(k: KnifeDef): void {
    if (k === this.knife) return;
    this.knife = k;
    this.cur = build(k);
    this.mesh.geometry = this.cur.geo;
    this.mesh.position.copy(this.cur.center).multiplyScalar(-1);
    this.hold = new KnifeHold(k, vmRig());
    this.pose();
  }

  /** Colourway accent / palette (guards and grips that follow your colours), like the viewmodel. */
  setColours(outfit: string | null | undefined): void {
    const c = colourway(outfit);
    const pal = paletteOf(c);
    this.uniforms.uPalette.value.forEach((col, i) => col.set(pal[i]));
    this.uniforms.uAccent.value.set(c.accent);
  }

  setFinish(spec: FinishSpec | null): void {
    const s = spec && spec.kind !== "none" ? spec : null;
    setFinishUniforms(this.uniforms, s);
    this.mesh.material = this.material(lookOf(s, null).finish);
  }

  /** Every finish kind's program, compiled ahead (KHR_parallel_shader_compile where available). */
  precompile(renderer: THREE.WebGLRenderer, camera: THREE.Camera, codes: number[]): Promise<unknown> {
    const scene = new THREE.Scene();
    const meshes = codes.map((c) => {
      const m = new THREE.SkinnedMesh(this.mesh.geometry, this.material(c));
      m.bindMode = THREE.DetachedBindMode;
      m.bind(this.skeleton, new THREE.Matrix4());
      m.frustumCulled = false;
      scene.add(m);
      return m;
    });
    return renderer.compileAsync(scene, camera).finally(() => meshes.forEach((m) => scene.remove(m)));
  }

  /** Poses the knife's extra bones (balisong halves) at their rest (open) angles. */
  private pose(): void {
    const r = vmRig();
    const n = r.names.length;
    const W = this.W;
    for (let j = 0; j < n; j++) W.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], j * 12);
    if (this.hold) {
      this.hold.state.angles.fill(0);
      this.hold.solve(W);
    }
    const bm = this.skeleton.boneMatrices!;
    const S = this.S;
    for (let j = 0; j < n; j++) {
      concat(W, j * 12, this.BLinv, j * 12, S, 0);
      const q = j * 16;
      bm[q] = S[0], bm[q + 1] = S[4], bm[q + 2] = S[8], bm[q + 3] = 0;
      bm[q + 4] = S[1], bm[q + 5] = S[5], bm[q + 6] = S[9], bm[q + 7] = 0;
      bm[q + 8] = S[2], bm[q + 9] = S[6], bm[q + 10] = S[10], bm[q + 11] = 0;
      bm[q + 12] = S[3], bm[q + 13] = S[7], bm[q + 14] = S[11], bm[q + 15] = 1;
    }
    this.skeleton.update();
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.skeleton.dispose();
  }
}
