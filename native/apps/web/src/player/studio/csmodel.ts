// CsPlayerModel: a real CS:S player model (loader.ts) animated by the CS:S anim state (animstate.ts) and bone setup
// (pose.ts), holding the knife (bone-merged w_knife world model). Implements the PlayerModel contract (model.ts):
// setState(pose) / update(dt) per frame, Source-space poses in, three.js out.
//
// GPU skinning: one SkinnedMesh per model whose skeleton's bone matrices are written directly from the bone setup
// (model space, DetachedBindMode with an identity bind matrix), so no THREE.Bone hierarchy is updated per frame.
// The mesh sits in Source model space under a yaw group (feet yaw) and a Z-up -> Y-up group.

import * as THREE from "three";
import { textureFromPayload, type TextureSupport } from "../../render";
import { TextureFormat } from "../../core";
import { playerUniforms, type PlayerUniforms } from "../materials";
import type { PlayerModelImpl, PlayerModelOptions, PlayerPose, PlayerStyle } from "../model";
import { CsAnimState } from "./animstate";
import { VERTEX_FLOATS, type StudioData } from "./data";
import type { CsAsset } from "./loader";
import { setMaps, studioDepthMaterial, studioGhostMaterial, studioSolidMaterial, type StudioMaps } from "./materials";
import { BoneSetup, concat34, concat34To44 } from "./pose";
import { TpInspect, type TpBones } from "../../viewmodel/inspects/third";

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** A skeleton whose bone matrices are written by the owner (no THREE.Bone world matrices involved). */
class DirectSkeleton extends THREE.Skeleton {
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

/** Geometry per StudioData (shared by every instance of a model). */
const geometries = new WeakMap<StudioData, THREE.BufferGeometry>();
function geometryFor(d: StudioData): THREE.BufferGeometry {
  let g = geometries.get(d);
  if (g) return g;
  const v = d.vertices;
  const n = v.length / VERTEX_FLOATS;
  const buf = new THREE.InterleavedBuffer(v, VERTEX_FLOATS);
  g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
  g.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
  g.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 6));
  g.setAttribute("aTangent", new THREE.InterleavedBufferAttribute(buf, 4, 8));
  const idx = new Uint16Array(n * 4);
  const wts = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_FLOATS;
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      wts[i * 4 + k] = v[o + 12 + k];
      idx[i * 4 + k] = v[o + 15 + k];
      sum += v[o + 12 + k];
    }
    if (sum <= 0) wts[i * 4] = 1;
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wts, 4));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  d.info.groups.forEach(([mat, first, count], gi) => g!.addGroup(first, count, gi));
  geometries.set(d, g);
  return g;
}

/** Uploaded textures per asset (shared by every instance). */
const uploaded = new WeakMap<StudioData, StudioMaps[]>();
function texturesFor(asset: CsAsset, d: StudioData, renderer: THREE.WebGLRenderer): StudioMaps[] {
  let maps = uploaded.get(d);
  if (maps) return maps;
  const support: TextureSupport = {
    s3tc: renderer.extensions.has("WEBGL_compressed_texture_s3tc") && renderer.extensions.has("WEBGL_compressed_texture_s3tc_srgb"),
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  };
  const cache = new Map<string, THREE.Texture | null>();
  const tex = (path: string | null, normal: boolean): THREE.Texture | null => {
    if (!path) return null;
    const k = `${path}|${normal}`;
    if (!cache.has(k)) {
      const p = asset.textures.get(path, support.s3tc, false);
      let t: THREE.Texture | null = null;
      if (p) {
        // Normal maps keep their alpha (phong mask): DXT1 has none, others are fine; RGBA8 always has it.
        t = textureFromPayload(p, support, normal ? THREE.NoColorSpace : THREE.SRGBColorSpace);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (normal && p.format === TextureFormat.DXT1) t.userData.noAlpha = true;
      }
      cache.set(k, t);
    }
    return cache.get(k) ?? null;
  };
  maps = d.info.groups.map(([m]) => {
    const mi = d.info.materials[m];
    return { map: tex(mi?.base ?? null, false), normal: tex(mi?.bump ?? null, true) };
  });
  uploaded.set(d, maps);
  return maps;
}

export interface CsModelStats {
  /** Sequences accumulated in the last update. */
  layers: number;
  activity: string;
  cycle: number;
  feetYaw: number;
  bodyYaw: number;
  jumps: number;
}

export class CsPlayerModel implements PlayerModelImpl {
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms;
  readonly kind: string;
  private src = new THREE.Group();
  private yawG = new THREE.Group();
  private mesh: THREE.SkinnedMesh;
  private depthMesh: THREE.SkinnedMesh;
  private skeleton: DirectSkeleton;
  private weapon: { mesh: THREE.SkinnedMesh; depth: THREE.SkinnedMesh; skeleton: DirectSkeleton; map: Int16Array; world: Float32Array } | null = null;
  readonly bs: BoneSetup;
  readonly anim: CsAnimState;
  private style: PlayerStyle = "solid";
  private dither = false;
  private baseRenderOrder = 20;
  private maps: StudioMaps[] | null = null;
  private weaponMaps: StudioMaps[] | null = null;

  // Input / derived state
  private pose: PlayerPose | null = null;
  private lastPos = new THREE.Vector3();
  private hasLast = false;
  private vel = [0, 0, 0];
  private snapNext = true;
  private vzHist: { t: number; vz: number }[] = [];
  private time = 0;
  private lastJump = -1;
  private airTime = 0;
  private wasGrounded = true;
  /** Seconds since the pose was last on the ground (for jump detection without an explicit event). */
  private sinceGround = 0;
  /** Perf: ms spent in the last update (anim state + bone setup + matrices). */
  lastUpdateMs = 0;
  private tmp12 = new Float32Array(12);
  /** Inspect gesture layer (created on the first inspect signal; the w_knife follows weapon_bone). */
  private tp: TpInspect | null = null;
  private tpW: Float32Array | null = null;
  private tpBones: TpBones | null = null;

  constructor(
    readonly asset: CsAsset,
    o: PlayerModelOptions = {},
    uniforms: PlayerUniforms = playerUniforms(),
  ) {
    this.uniforms = uniforms;
    this.kind = asset.skin;
    const d = asset.data;
    this.bs = new BoneSetup(d);
    this.anim = new CsAnimState(d, this.bs);
    d.warm(this.anim.sequences());
    const geo = geometryFor(d);
    this.skeleton = new DirectSkeleton(d.bones);
    this.mesh = new THREE.SkinnedMesh(geo, []);
    this.depthMesh = new THREE.SkinnedMesh(geo, []);
    const identity = new THREE.Matrix4();
    for (const m of [this.mesh, this.depthMesh]) {
      m.bindMode = THREE.DetachedBindMode;
      m.bind(this.skeleton, identity);
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 36), 56);
      m.frustumCulled = true;
      this.yawG.add(m);
    }
    // Textures upload on first draw (only then is the renderer, and its S3TC support, known).
    this.mesh.onBeforeRender = (renderer) => this.ensureTextures(renderer);
    if (asset.weapon) this.buildWeapon(asset.weapon);
    this.src.rotation.x = -Math.PI / 2;
    this.src.add(this.yawG);
    this.root.add(this.src);
    this.root.name = `player-model:${asset.skin}`;
    this.setStyle(o.style ?? "solid", o.color, o.dither);
  }

  private buildWeapon(w: StudioData): void {
    const pd = this.asset.data;
    const map = new Int16Array(w.bones);
    for (let i = 0; i < w.bones; i++) map[i] = pd.bone(w.info.bones[i].name);
    const geo = geometryFor(w);
    const skeleton = new DirectSkeleton(w.bones);
    const identity = new THREE.Matrix4();
    const mk = () => {
      const m = new THREE.SkinnedMesh(geo, []);
      m.bindMode = THREE.DetachedBindMode;
      m.bind(skeleton, identity);
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 36), 60);
      this.yawG.add(m);
      return m;
    };
    this.weapon = { mesh: mk(), depth: mk(), skeleton, map, world: new Float32Array(w.bones * 12) };
  }

  private ensureTextures(renderer: THREE.WebGLRenderer): void {
    if (this.maps) return;
    this.maps = texturesFor(this.asset, this.asset.data, renderer);
    if (this.asset.weapon) this.weaponMaps = texturesFor(this.asset, this.asset.weapon, renderer);
    this.applyMaps();
  }

  private applyMaps(): void {
    const set = (mesh: THREE.SkinnedMesh, maps: StudioMaps[] | null) => {
      if (!maps) return;
      (mesh.material as THREE.ShaderMaterial[]).forEach((m, i) => maps[i] && setMaps(m, maps[i]));
    };
    set(this.mesh, this.maps);
    set(this.depthMesh, this.maps);
    if (this.weapon) {
      set(this.weapon.mesh, this.weaponMaps);
      set(this.weapon.depth, this.weaponMaps);
    }
  }

  private materials(d: StudioData, kind: "solid" | "ghost" | "depth"): THREE.ShaderMaterial[] {
    return d.info.groups.map(([m]) => {
      const info = d.info.materials[m] ?? { name: "", shader: "", base: null, bump: null, translucent: false, alphatest: false, alphaRef: 0.5, nocull: false, additive: false, selfillum: false, phong: false, phongExponent: 5, phongBoost: 1 };
      const maps = { map: null, normal: null };
      const mat = kind === "solid" ? studioSolidMaterial(this.uniforms, info, maps) : kind === "ghost" ? studioGhostMaterial(this.uniforms, info, maps, this.dither) : studioDepthMaterial(this.uniforms, info, maps);
      mat.forceSinglePass = true;
      return mat;
    });
  }

  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither = this.dither): void {
    const changed = style !== this.style || dither !== this.dither || !(this.mesh.material as THREE.Material[]).length;
    this.style = style;
    this.dither = dither;
    if (style === "solid" && color !== undefined) this.uniforms.uAccent.value.set(color);
    else if (style === "ghost" && color !== undefined) this.uniforms.uGhost.value.set(color);
    if (changed) {
      const swap = (mesh: THREE.SkinnedMesh, mats: THREE.ShaderMaterial[]) => {
        for (const m of mesh.material as THREE.Material[]) m.dispose();
        mesh.material = mats;
      };
      const d = this.asset.data;
      swap(this.mesh, this.materials(d, style === "solid" ? "solid" : "ghost"));
      swap(this.depthMesh, this.materials(d, "depth"));
      if (this.weapon && this.asset.weapon) {
        swap(this.weapon.mesh, this.materials(this.asset.weapon, style === "solid" ? "solid" : "ghost"));
        swap(this.weapon.depth, this.materials(this.asset.weapon, "depth"));
      }
      this.applyMaps();
    }
    const ghostDepth = style === "ghost" && !dither;
    this.depthMesh.visible = ghostDepth;
    if (this.weapon) this.weapon.depth.visible = ghostDepth;
    this.setRenderOrder(this.baseRenderOrder);
  }

  get currentStyle(): PlayerStyle {
    return this.style;
  }

  setOpacity(a: number): void {
    this.uniforms.uOpacity.value = a;
  }

  setNearFade(near: number, far: number): void {
    this.uniforms.uNearFade.value.set(near, far);
  }

  setRenderOrder(order: number): void {
    this.baseRenderOrder = order;
    this.depthMesh.renderOrder = order;
    this.mesh.renderOrder = order + 1;
    if (this.weapon) {
      this.weapon.depth.renderOrder = order;
      this.weapon.mesh.renderOrder = order + 1;
    }
  }

  setState(pose: PlayerPose): void {
    this.pose = pose;
  }

  snap(): void {
    this.snapNext = true;
  }

  get stats(): CsModelStats {
    const a = this.anim;
    return { layers: this.bs.layersThisFrame, activity: a.activity, cycle: a.cycle, feetYaw: a.feetYaw, bodyYaw: a.bodyYaw, jumps: a.jumps };
  }

  update(dt: number): void {
    const s = this.pose;
    if (!s) return;
    const t0 = performance.now();
    dt = clamp(dt, 0, 0.1);
    this.time = s.visualTime ?? (this.time + dt);
    const pos = s.position;
    const px = pos[0], py = pos[2], pz = -pos[1];
    const lp = this.lastPos;
    if (this.hasLast && (lp.x - px) ** 2 + (lp.y - py) ** 2 + (lp.z - pz) ** 2 > 160 * 160) this.snapNext = true;
    const snap = this.snapNext;
    this.snapNext = false;

    // Velocity (Source axes): given, else derived from position changes.
    if (s.velocity) {
      this.vel[0] = s.velocity[0];
      this.vel[1] = s.velocity[1];
      this.vel[2] = s.velocity[2];
    } else if (this.hasLast && dt > 0 && !snap) {
      const k = 1 - Math.exp(-20 * dt);
      this.vel[0] += ((px - lp.x) / dt - this.vel[0]) * k;
      this.vel[1] += (-(pz - lp.z) / dt - this.vel[1]) * k;
      this.vel[2] += ((py - lp.y) / dt - this.vel[2]) * k;
    } else this.vel[0] = this.vel[1] = this.vel[2] = 0;
    lp.set(px, py, pz);
    this.hasLast = true;
    this.root.position.set(px, py, pz);

    if (snap) {
      this.anim.reset(s.visualTime);
      this.vzHist.length = 0;
      this.lastJump = -1;
      // Airborne after a seek / teleport: resume the hop where a CS:S jump arc would be (impulse 301.99, gravity 800).
      if (!s.grounded) {
        const elapsed = (301.993 - this.vel[2]) / 800;
        if (elapsed >= 0 && elapsed < 2) this.anim.startAirborne(elapsed);
      }
    }
    const jumped = s.jumped ?? this.detectJump(s, snap, dt);
    if (s.attack) this.anim.fire();
    this.anim.update(snap ? 0 : dt, { vel: this.vel, eyeYaw: s.yaw, eyePitch: s.pitch, ducking: s.crouched, onGround: s.grounded, jumped }, snap ? s.visualTime : undefined);
    this.anim.apply();
    const W = this.bs.buildMatrices();
    const d = this.asset.data;
    this.inspectLayer(s, snap, dt, W);
    const bm = this.skeleton.boneMatrices!;
    for (let i = 0; i < d.bones; i++) concat34To44(W, i * 12, d.poseToBone, i * 12, bm, i * 16);
    if (this.weapon && this.asset.weapon) this.poseWeapon(this.asset.weapon, W);
    this.yawG.rotation.z = this.anim.feetYaw * D2R;
    // Head-relative axis for the near fade (world space, three.js coords).
    this.uniforms.uAxisA.value.copy(this.root.position).y += 8;
    this.uniforms.uAxisB.value.copy(this.root.position).y += 60;
    this.lastUpdateMs = performance.now() - t0;
  }

  /** Inspect gesture (viewmodel/inspects/third.ts) on the bone-to-model matrices: arm + weapon_bone. */
  private inspectLayer(s: PlayerPose, snap: boolean, dt: number, W: Float32Array): void {
    if (!this.tp) {
      if (!s.inspect) return;
      this.tp = new TpInspect();
      const d = this.asset.data, tmp = this.tmp12;
      this.tpBones = {
        index: (n) => d.bone(n),
        parent: d.parent,
        count: d.bones,
        posed: (i, out) => out.set(this.tpW!.subarray(i * 12, i * 12 + 12)),
        pre: (i, M) => {
          concat34(M, 0, this.tpW!, i * 12, tmp, 0);
          this.tpW!.set(tmp, i * 12);
        },
      };
    }
    this.tpW = W;
    const tp = this.tp;
    if (snap) tp.reset();
    if (s.attack) tp.cancel("attack");
    if (s.inspect) tp.signal(s.inspect);
    tp.setHeld(!!s.inspectHeld);
    tp.update(snap ? 0 : dt);
    tp.apply(this.tpBones!, this.asset.data, "ValveBiped.weapon_bone", null);
  }

  /** EF_BONEMERGE: weapon bones named like player bones take the player's transform; others follow their parent. */
  private poseWeapon(w: StudioData, W: Float32Array): void {
    const wp = this.weapon!;
    const ww = wp.world;
    const local = this.tmp12;
    for (let i = 0; i < w.bones; i++) {
      const pb = wp.map[i];
      if (pb >= 0) ww.set(W.subarray(pb * 12, pb * 12 + 12), i * 12);
      else {
        const q = w.restQ.subarray(i * 4, i * 4 + 4);
        const p = w.restP.subarray(i * 3, i * 3 + 3);
        const [x, y, z, s] = q;
        local.set([1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * s * z, 2 * x * z + 2 * s * y, p[0], 2 * x * y + 2 * s * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * s * x, p[1], 2 * x * z - 2 * s * y, 2 * y * z + 2 * s * x, 1 - 2 * x * x - 2 * y * y, p[2]]);
        const par = w.parent[i];
        if (par < 0) ww.set(local, i * 12);
        else concat34(ww, par * 12, local, 0, ww, i * 12);
      }
    }
    const bm = wp.skeleton.boneMatrices!;
    for (let i = 0; i < w.bones; i++) concat34To44(ww, i * 12, w.poseToBone, i * 12, bm, i * 16);
  }

  /**
   * PLAYERANIMEVENT_JUMP from state alone: the vertical velocity rises sharply (a landing at -300 u/s followed by a
   * +290 u/s jump within a tick or two), or the player leaves the ground moving up.
   */
  private detectJump(s: PlayerPose, snap: boolean, dt: number): boolean {
    const vz = this.vel[2];
    const now = this.time;
    const h = this.vzHist;
    if (snap) {
      h.length = 0; this.lastJump = -1; this.wasGrounded = s.grounded;
      this.sinceGround = 0; this.airTime = 0;
    }
    h.push({ t: now, vz });
    while (h.length > 2 && now - h[0].t > 0.08) h.shift();
    this.sinceGround = s.grounded ? 0 : this.sinceGround + dt;
    const wasGrounded = this.wasGrounded;
    this.wasGrounded = s.grounded;
    this.airTime = s.grounded ? 0 : this.airTime + dt;
    if (snap || vz < 120 || (this.lastJump >= 0 && now - this.lastJump < 0.2)) return false;
    let min = vz;
    for (const e of h) if (e.vz < min) min = e.vz;
    const rose = vz - min > 220;
    const left = wasGrounded && !s.grounded && vz > 150;
    if (rose || left) {
      this.lastJump = now;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of [this.mesh, this.depthMesh, this.weapon?.mesh, this.weapon?.depth]) {
      if (!m) continue;
      for (const mat of m.material as THREE.Material[]) mat.dispose();
    }
    this.skeleton.dispose();
    this.weapon?.skeleton.dispose();
  }
}
