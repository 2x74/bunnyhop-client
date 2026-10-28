// First-person gun viewmodel: the bunny's gloved hands holding a map-given gun in a two-hand CS-style hold, drawn like
// the knife viewmodel (viewmodel/viewmodel.ts): its own scene and camera after the world with the depth cleared, the
// player's viewmodel FOV / offsets / hand, the same bob and sway (the knife viewmodel's feel matrix, which keeps running
// while a gun is out), the colourway and the equipped gloves. One SkinnedMesh (hands + gun, guns/rig.ts), one draw call,
// plus the pooled muzzle flash and shells (guns/fx.ts). The pose itself is guns/pose.ts (no DOM: the audits use it).
//
// Presentation only: guns/presenter.ts drives it from the core's weapon reports.

import * as THREE from "three";
import { playerUniforms, solidMaterial, type PlayerUniforms } from "../../player/materials";
import { colourway, paletteOf } from "../../player/bunny/palettes";
import { getLoadout, getOutfit, onLoadout, onOutfit } from "../../player/cosmetics";
import { gloveStyle, type CosmeticLoadout, type GloveStyleId } from "../../loadout";
import { applyLoadoutUniforms, NO_LOOK, sameLook, type MaterialLook } from "../finishes/shader";
import { concat } from "../../player/bunny/rig";
import { prefs, verticalFov } from "../../ui/settings";
import type { Cue, GunAnimator } from "./anim";
import { prewarmGunHolds } from "./hold";
import { clampFeel, GunPoser } from "./pose";
import { gunGeometry, gunRig } from "./rig";
import { GunFx } from "./fx";
import type { GunDef, GunPart } from "./types";

class DirectSkeleton extends THREE.Skeleton {
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

export interface GunViewmodelOptions {
  /** Look (gloves, colourway) of this loadout instead of the equipped one (dev lab). */
  loadout?: CosmeticLoadout;
}

export class GunViewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(41, 1, 0.75, 400);
  readonly uniforms: PlayerUniforms = playerUniforms();
  readonly mesh: THREE.SkinnedMesh;
  readonly poser = new GunPoser();
  /** Muzzle flash + shells (created at the first render or shot). */
  private fxImpl: GunFx | null = null;
  /** Sounds of this viewmodel's actions (presenter: guns/sounds.ts gunSound); null = silent (previews). */
  onSound: ((kind: "fire" | "silenced" | "dry" | Cue, gain: number) => void) | null = null;
  /** Perf: ms spent in the last update. */
  lastUpdateMs = 0;
  /** Animation time scale (dev / screenshots: 0 freezes). */
  timeScale = 1;
  /** Dev: hide one arm (its bones collapse) to look at the other's grip. */
  debugHide: "R" | "L" | null = null;

  private root = new THREE.Group();
  private skeleton: DirectSkeleton;
  private rig = gunRig();
  private S: Float32Array;
  private loadout: CosmeticLoadout;
  private glove: GloveStyleId = "knit";
  private look: MaterialLook = NO_LOOK;
  private visible = true;
  private unsub: (() => void)[] = [];
  private conv = new THREE.Matrix4();
  private m4 = new THREE.Matrix4();
  /** Camera space <- viewmodel root (offset, feel, hand mirror): where fx spawn. */
  readonly camRel = new THREE.Matrix4();
  private V = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  private hidden: Set<number> | null = null;
  /** The M3 ejects its shell when the pump comes back. */
  private lastPump = 0;

  constructor(o: GunViewmodelOptions = {}) {
    const r = this.rig;
    this.S = new Float32Array(r.count * 12);
    this.skeleton = new DirectSkeleton(r.count);
    this.loadout = o.loadout ?? getLoadout();
    this.glove = gloveStyle(this.loadout.glove).style;
    this.mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), solidMaterial(this.uniforms));
    this.mesh.bindMode = THREE.DetachedBindMode;
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.frustumCulled = false;
    this.mesh.name = "gun-viewmodel";
    this.mesh.visible = false;
    this.root.add(this.mesh);
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    // Source viewmodel space (x forward, y left, z up) -> three camera space (-z forward, x right, y up).
    this.conv.set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
    this.poser.anim.onCue = (c, g) => this.onSound?.(c, g);
    this.applyColours(getOutfit());
    this.refreshLook();
    if (!o.loadout) {
      this.unsub.push(onLoadout((l) => this.setLoadout(l)));
      this.unsub.push(onOutfit((id) => this.applyColours(id)));
    }
  }

  get anim(): GunAnimator {
    return this.poser.anim;
  }

  get def(): GunDef | null {
    return this.poser.def;
  }

  private applyColours(id: string | null | undefined): void {
    const c = colourway(id);
    const pal = paletteOf(c);
    this.uniforms.uPalette.value.forEach((col, i) => col.set(pal[i]));
    this.uniforms.uAccent.value.set(c.accent);
  }

  /** Gloves (and colourway accents) of a loadout; guns take no finish yet (the knife's finish stays on the knife). */
  setLoadout(l: CosmeticLoadout): void {
    this.loadout = l;
    const g = gloveStyle(l.glove).style;
    if (g !== this.glove) {
      this.glove = g;
      if (this.def) this.setGun(this.def, true);
    }
    this.refreshLook();
  }

  private refreshLook(): void {
    const look = applyLoadoutUniforms(this.uniforms, { ...this.loadout, finish: "fin-garden" });
    if (sameLook(look, this.look)) return;
    this.look = look;
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.material = solidMaterial(this.uniforms, look);
  }

  /** The gun in hand (null hides the viewmodel). Builds / solves on first use per gun + glove (cached). */
  setGun(def: GunDef | null, force = false): void {
    if (def === this.def && !force) return;
    this.mesh.visible = !!def;
    this.poser.setGun(def, this.glove, force);
    if (!def) return;
    this.mesh.geometry = gunGeometry(def, this.glove);
    this.fxImpl?.setGun(def);
  }

  /** Solves these guns' holds in the current gloves when the browser is idle (switching never solves on the spot). */
  prewarm(defs: readonly GunDef[]): void {
    prewarmGunHolds(defs, this.glove);
  }

  // -------------------------------------------------------------------------------------------
  // Actions (presenter / harness)

  draw(): void {
    if (this.def) this.poser.draw();
  }

  /** A shot; `silenced`: through the silencer (the core's attack mode 2): a small puff at its tip, the quiet shot. */
  fire(silenced = false): void {
    const def = this.def;
    if (!def) return;
    const quiet = silenced && !!def.silencer;
    this.anim.fire();
    if (typeof document !== "undefined") this.fx.shot(def.timing.pump ? 0 : 1, quiet);
    this.onSound?.(quiet ? "silenced" : "fire", 1);
  }

  /**
   * The silencer goes on / off over `dur` seconds (the core's lock-out), `at` seconds in (a restart / seek into it);
   * guns without one only keep the state.
   */
  silencer(on: boolean, dur: number, at = 0): void {
    this.anim.silencer(on, dur, at);
  }

  /** The silencer's state with no animation (a draw, a restart): shown on the gun or not. */
  setSilenced(on: boolean): void {
    this.anim.silenced = on;
  }

  dryFire(): void {
    this.anim.dryFire();
    this.onSound?.("dry", 1);
  }

  reload(dur: number, empty = false): void {
    this.anim.reload(dur, empty);
  }

  inspect(): void {
    this.anim.inspect();
  }

  /** Muzzle flash + shells (created on first use). */
  get fx(): GunFx {
    if (!this.fxImpl) {
      this.fxImpl = new GunFx(this.scene, this.root);
      if (this.def) this.fxImpl.setGun(this.def);
    }
    return this.fxImpl;
  }

  // -------------------------------------------------------------------------------------------
  // Per frame

  /** Advances the animation and poses the bones. `feel`: the knife viewmodel's bob / sway matrix (3x4), or null. */
  update(dt: number, feel: ArrayLike<number> | null = null): void {
    const t0 = performance.now();
    dt = Math.min(0.1, Math.max(0, dt)) * this.timeScale;
    if (feel) clampFeel(feel, this.V);
    const def = this.def;
    if (!def) return;
    this.poser.update(dt);
    this.skin();
    this.fxImpl?.update(dt);
    const pump = this.anim.pose.pump;
    if (def.timing.pump && this.lastPump < 1.8 && pump >= 1.8 && this.anim.clip === "pump" && this.fxImpl) this.fxImpl.eject();
    this.lastPump = pump;
    this.lastUpdateMs = performance.now() - t0;
  }

  /** Bone index of a gun part (bonesW offsets are index * 12). */
  partIndex(part: GunPart): number {
    return this.poser.partIndex(part);
  }

  /** Posed bone matrices (Source viewmodel space, 3x4 per bone). */
  get bonesW(): Float32Array {
    return this.poser.bonesW;
  }

  pointOn(part: GunPart, p: ArrayLike<number>, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = this.poser.pointOn(part, p);
    return out.set(x, y, z);
  }

  dirOn(part: GunPart, d: ArrayLike<number>, out: THREE.Vector3): THREE.Vector3 {
    const [x, y, z] = this.poser.dirOn(part, d);
    return out.set(x, y, z);
  }

  private skin(): void {
    const W = this.poser.bonesW, S = this.S, r = this.rig;
    if (this.debugHide && !this.hidden) {
      const h = r.hands;
      this.hidden = new Set(h.subtree(h.bone(this.debugHide === "R" ? "Root36" : "Root34")));
    } else if (!this.debugHide) this.hidden = null;
    const n = r.hands.names.length;
    const inv = r.hands.inv;
    const bm = this.skeleton.boneMatrices!;
    for (let i = 0; i < r.count; i++) {
      const o = i * 12, q = i * 16;
      if (i < n) concat(W, o, inv, o, S, o);
      else S.set(W.subarray(o, o + 12), o);
      if (this.hidden?.has(i)) S.fill(0, o, o + 12);
      bm[q] = S[o], bm[q + 1] = S[o + 4], bm[q + 2] = S[o + 8], bm[q + 3] = 0;
      bm[q + 4] = S[o + 1], bm[q + 5] = S[o + 5], bm[q + 6] = S[o + 9], bm[q + 7] = 0;
      bm[q + 8] = S[o + 2], bm[q + 9] = S[o + 6], bm[q + 10] = S[o + 10], bm[q + 11] = 0;
      bm[q + 12] = S[o + 3], bm[q + 13] = S[o + 7], bm[q + 14] = S[o + 11], bm[q + 15] = 1;
    }
    this.skeleton.update();
  }

  // -------------------------------------------------------------------------------------------
  // Rendering

  setVisible(v: boolean): void {
    this.visible = v;
  }

  get shown(): boolean {
    return this.visible && !!this.def;
  }

  /** Draws the gun viewmodel over the frame just rendered with `world` (depth cleared first). */
  render(renderer: THREE.WebGLRenderer, world: THREE.PerspectiveCamera): void {
    if (!this.visible || !this.def) return;
    const vp = prefs.get().viewmodel;
    const cam = this.camera;
    world.updateMatrixWorld();
    cam.position.copy(world.position);
    cam.quaternion.copy(world.quaternion);
    cam.aspect = world.aspect;
    cam.fov = verticalFov(vp.fov);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // root = camera * conv * (offset + V) (* mirror for the left hand), exactly like the knife viewmodel.
    const V = this.V;
    const left = vp.hand === "left";
    this.m4.set(V[0], V[1], V[2], V[3] + vp.y, V[4], V[5], V[6], V[7] + (left ? vp.x : -vp.x), V[8], V[9], V[10], V[11] + vp.z, 0, 0, 0, 1);
    this.camRel.multiplyMatrices(this.conv, this.m4);
    if (left) this.camRel.multiply(this.m4.makeScale(1, -1, 1));
    const m = this.root.matrix;
    m.multiplyMatrices(cam.matrixWorld, this.camRel);
    this.root.matrixWorldNeedsUpdate = true;
    this.fx.beforeRender(this, cam);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, cam);
    renderer.autoClear = auto;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    (this.mesh.material as THREE.Material).dispose();
    this.skeleton.dispose();
    this.fxImpl?.dispose();
  }
}

