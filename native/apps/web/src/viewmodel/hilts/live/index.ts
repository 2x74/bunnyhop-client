// LIVING HILTS (v0.0.43, Supporter): hilt skins with pieces that move and glow (the owner's ask: "cool animated hilts
// for knives for the supporters"). Each is an ordinary hilt skin for the knife's own grip, guard and pommel
// (LIVE_HILT_SKINS, spread into loadout.ts HILT_SKIN, existing material kinds only) plus a design (designs/*.ts):
// sculpted pieces fitted to the held knife from its measured anchors (anchors.ts), lit like the hands (material.ts),
// a little additive light, and motion on the viewmodel's clock that answers play (state.ts).
//
// First person only: a LiveHilt on the viewmodel (viewmodel.ts) adds two meshes to its root on its own skeleton while a
// living hilt is held, and nothing otherwise (the default and every other hilt draw exactly as before). Third person
// shows the skin alone. The Loadout's stage and the Support page use the same Viewmodel, so they animate there too.

import * as THREE from "three";
import type { V3 } from "../../../player/bunny/rig";
import type { PlayerUniforms } from "../../../player/materials";
import { cosmeticsStill } from "../../finishes/shader";
import { motionScale } from "../../feel";
import { vmRig } from "../../rig";
import type { KnifeDef } from "../../knives/types";
import { hiltAnchors } from "./anchors";
import { PieceCtx, type CameraInKnife, type LiveDesign } from "./design";
import { LiveKit } from "./kit";
import { glowMaterial, litMaterial, liveUniforms, type LiveUniforms } from "./material";
import { PlaySignals, type PlayInput } from "./state";
import { watcher } from "./designs/watcher";
import { frostrune } from "./designs/frostrune";
import { clockwork } from "./designs/clockwork";
import { forge } from "./designs/forge";
import { deep } from "./designs/deep";
import { storm } from "./designs/storm";
import { bloom } from "./designs/bloom";

/** Every living hilt, in catalogue order. */
export const LIVE_DESIGNS: readonly LiveDesign[] = [watcher, frostrune, clockwork, forge, deep, storm, bloom];
const byId = new Map(LIVE_DESIGNS.map((d) => [d.id, d]));

/** The design of a hilt id, if it is a living one. */
export const liveDesign = (id: string | null | undefined): LiveDesign | undefined => (id ? byId.get(id) : undefined);

export { LIVE_HILT_SKINS } from "./skins";
import { LIVE_HILT_SKINS } from "./skins";

/** The living hilt a hilt skin belongs to (loadout.ts HILT_SKIN holds the same objects), for code that is handed a skin. */
export const liveIdOfSkin = (skin: unknown): string | undefined => (skin ? Object.keys(LIVE_HILT_SKINS).find((id) => LIVE_HILT_SKINS[id] === skin) : undefined);

export interface LiveMeshes {
  /** The design's named points (knife-local), e.g. `pommel`: its lanyard ring. */
  anchors: Record<string, V3>;
  lit: THREE.BufferGeometry | null;
  glow: THREE.BufferGeometry | null;
  tris: number;
  glows: number;
}
const built = new Map<string, LiveMeshes>();
/** A design's pieces on a knife (built once per pair, a few ms); `local`: in the knife's own frame (the showcase). */
export function liveMeshes(d: LiveDesign, k: KnifeDef, local = false): LiveMeshes {
  const key = `${d.id}|${k.id}|${local ? "l" : "b"}`;
  let m = built.get(key);
  if (!m) {
    const kit = new LiveKit(!local);
    d.build(kit, hiltAnchors(k), k);
    built.set(key, (m = { anchors: kit.anchors, lit: kit.litGeometry(), glow: kit.glowGeometry(), tris: kit.tris, glows: kit.glows }));
  }
  return m;
}

/**
 * Where a charm hangs on a living hilt (for the charms lane, $V43/reports/charms.md): knife-local points. `pommel` is the
 * design's lanyard ring; `guard` the outermost point of the design's pieces along `side` (a knife-local direction, the
 * charms lane's per-knife side) within the guard's height, so a charm hung there clears the living guard. Null for a
 * hilt that isn't a living one (the knife's own anchors stand).
 */
export function liveCharmAnchors(hilt: string | null | undefined, knife: KnifeDef, side: V3): { guard: V3; pommel: V3 } | null {
  const d = liveDesign(hilt);
  if (!d) return null;
  const m = liveMeshes(d, knife, true), a = hiltAnchors(knife);
  let best = -Infinity, guard: V3 = [side[0] * a.top.hy, side[1] * a.top.hy, a.top.z];
  const P = m.lit?.getAttribute("position");
  for (let i = 0; P && i < P.count; i++) {
    const z = P.getZ(i);
    if (z < a.top.z - 0.6 || z > a.top.z + 0.9) continue;
    const s = P.getX(i) * side[0] + P.getY(i) * side[1] + z * side[2];
    if (s > best) (best = s), (guard = [P.getX(i), P.getY(i), z]);
  }
  return { guard, pommel: m.anchors.pommel ?? a.charm };
}

const M1 = new THREE.Matrix4(), M2 = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Vector3();

/** One viewmodel's living hilt: its meshes while one is held, its play signals and animation. */
export class LiveHilt {
  readonly signals = new PlaySignals();
  readonly u: LiveUniforms = liveUniforms();
  private design: LiveDesign | null = null;
  private knife: KnifeDef | null = null;
  private lit: THREE.SkinnedMesh | null = null;
  private glow: THREE.SkinnedMesh | null = null;
  private ctx: PieceCtx | null = null;
  private litMat: THREE.ShaderMaterial | null = null;
  private glowMat: THREE.ShaderMaterial | null = null;
  private cam: CameraInKnife = { pos: [0, 0, 0], right: [0, 1, 0], up: [0, 0, 1] };

  constructor(
    private root: THREE.Object3D,
    private skeleton: THREE.Skeleton,
    private vmU: PlayerUniforms,
    /** The knife's own frame instead of the viewmodel's bind space (the Loadout's knife showcase, knives/showcase.ts). */
    private local = false,
  ) {}

  /** Whether a living hilt is held (its meshes are in the scene). */
  get active(): boolean {
    return !!this.design;
  }

  /** The hilt id held and the knife (null = the carrot, passed by the viewmodel as its def). */
  set(hilt: string | null | undefined, knife: KnifeDef): void {
    const d = liveDesign(hilt) ?? null;
    if (d === this.design && knife === this.knife) return;
    this.clear();
    this.design = d;
    this.knife = knife;
    if (!d) return;
    const g = liveMeshes(d, knife, this.local);
    this.litMat ??= litMaterial(this.vmU, this.u);
    this.glowMat ??= glowMaterial(this.u);
    this.ctx = new PieceCtx(this.u, hiltAnchors(knife), knife, this.local);
    for (const m of this.u.uPiece.value) m.identity();
    this.u.uMorph.value.fill(0);
    for (const c of this.u.uChan.value) c.set(1, 1, 1, 0);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, name: string) => {
      const m = new THREE.SkinnedMesh(geo, mat);
      m.bindMode = THREE.DetachedBindMode;
      m.bind(this.skeleton, new THREE.Matrix4());
      m.frustumCulled = false;
      m.name = name;
      this.root.add(m);
      return m;
    };
    if (g.lit) {
      this.lit = mk(g.lit, this.litMat, "live-hilt");
      this.lit.onBeforeRender = (_r, _s, camera) => this.look(camera);
    }
    if (g.glow) this.glow = mk(g.glow, this.glowMat, "live-hilt-glow");
    // First pose before the first update (the Loadout's stills).
    d.animate(this.signals, this.ctx, 0);
  }

  /** Back to the start (the viewmodel's idle(): a replay seek, an export's first frame). */
  reset(): void {
    this.signals.reset();
    if (this.ctx) for (const k of Object.keys(this.ctx.mem)) delete this.ctx.mem[k];
  }

  /** Per frame, after the viewmodel's own update: `now` is its clock, `inspecting` its inspect runtime's state. */
  update(dt: number, now: number, input: PlayInput, inspecting: boolean, mirrored: boolean): void {
    if (!this.design || !this.ctx) return;
    this.signals.still = cosmeticsStill() || motionScale() < 1;
    this.signals.update(dt, now, input, inspecting);
    this.u.uMirror.value = mirrored ? 1 : 0;
    this.design.animate(this.signals, this.ctx, dt);
  }

  /** The camera from the knife (knife-local), for designs that look at it; called as the lit mesh is drawn. */
  private look(camera: THREE.Camera): void {
    const d = this.design, mesh = this.lit;
    if (!d?.look || !mesh || !this.ctx) return;
    const r = vmRig();
    const bone = d.lookBone?.(this.knife!) ?? "Knife_Handle";
    const bi = r.bone(bone);
    const bm = this.skeleton.boneMatrices;
    if (!bm) return;
    // knife-local = K^-1 * boneSkin^-1 * meshWorld^-1 * world
    M1.fromArray(bm, bi * 16);
    M2.copy(mesh.matrixWorld).multiply(M1).multiply(this.ctx.K).invert();
    const out = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
    V.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(M2);
    this.cam.pos = out(V);
    const o = Q.set(0, 0, 0).applyMatrix4(camera.matrixWorld).applyMatrix4(M2).clone();
    V.set(1, 0, 0).applyMatrix4(camera.matrixWorld).applyMatrix4(M2).sub(o).normalize();
    this.cam.right = out(V);
    V.set(0, 1, 0).applyMatrix4(camera.matrixWorld).applyMatrix4(M2).sub(o).normalize();
    this.cam.up = out(V);
    d.look(this.cam, this.ctx);
  }

  private clear(): void {
    for (const m of [this.lit, this.glow]) m?.removeFromParent();
    this.lit = this.glow = null;
    this.design = null;
    this.ctx = null;
  }

  dispose(): void {
    this.clear();
    this.litMat?.dispose();
    this.glowMat?.dispose();
    this.litMat = this.glowMat = null;
  }
}
