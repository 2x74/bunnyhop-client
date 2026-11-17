// The charm on the knife viewmodel (v0.0.43): the glue between viewmodel.ts and the charm rig. It knows the knife's
// anchors (anchors.ts), turns the posed bones (model space) and the view's feel matrix into the eye's frame, and hands
// the rig its pose. Nothing runs unless a charm is worn.

import * as THREE from "three";
import { gloveStyle, type CosmeticLoadout, type GloveStyleId } from "../../loadout";
import { concat, invert34 } from "../../player/bunny/rig";
import type { KnifeDef } from "../knives/types";
import type { VmRig } from "../rig";
import { liveCharmAnchors, liveDesign, liveMeshes } from "../hilts/live/index";
import { charmFit, charmHang, charmPlaces, sampleTri, setHiltCharmAnchors, type CharmFit, type CharmHang } from "./anchors";
import { charmClamp } from "./places";
import { PointCloud, type CloudInput, type Collider, type V3 } from "./physics";
import { CharmRig, charmOptions, type CharmInput } from "./rig";

// The living hilts (v0.0.43, hilts/live) bring their own guard pieces and lanyard ring: they say where a charm goes
// (liveCharmAnchors), and their pieces' points go with it so the cord is tied round them, not through them.
export function registerHiltAnchors(): void {
  setHiltCharmAnchors((hilt, knife, side) => {
    const a = liveCharmAnchors(hilt, knife, side);
    if (!a) return null;
    const lit = liveMeshes(liveDesign(hilt)!, knife, true).lit;
    return { ...a, cloud: lit ? dense(lit.getAttribute("position").array as Float32Array) : null };
  });
}
registerHiltAnchors();

/** Points over a triangle list (anchors.ts measures clearances from points). */
function dense(p: Float32Array): Float32Array {
  const out: number[] = [];
  for (let t = 0; t + 8 < p.length; t += 9) sampleTri(p, t, out);
  return new Float32Array(out);
}

/** The swing limit a tied charm needs at least (rig.ts minCone): past the steepest lean a charm rests at on any knife. */
const REST_CONE = (82 * Math.PI) / 180;

export class KnifeCharm {
  readonly rig: CharmRig;
  private fit: CharmFit | null = null;
  private hang: CharmHang | null = null;
  private hangKey = "";
  private knife: KnifeDef | null | undefined = undefined;
  private hilt: string | null = null;
  private glove: GloveStyleId = "knit";
  /** Model -> eye (3x4), a bone in the eye's frame, the colliders. */
  private M = new Float32Array(12);
  private E = new Float32Array(12);
  private C = new Float32Array(12);
  private colliders: Collider[] = [];
  /** What the charm rests against (anchors.ts CharmFit.solid / hands), in the knife's frame; this frame's list. */
  private solid: PointCloud | null = null;
  private hands: PointCloud | null = null;
  private clouds: CloudInput[] = [];
  private Ei = new Float32Array(12);
  private Wk = new Float32Array(12);
  private eyeToWorld = new THREE.Matrix4();

  constructor(scene: THREE.Object3D) {
    this.rig = new CharmRig(scene);
    this.rig.minCone = REST_CONE;
  }

  get worn(): boolean {
    return !!this.rig.worn;
  }

  /** The loadout (its charm and options) and the knife in hand (null = the carrot). */
  set(l: CosmeticLoadout, knife: KnifeDef | null): void {
    // The Cord and Size sliders inside this knife's clamps (places.ts: no reachable setting crosses the hand or knife).
    const kid = knife?.id ?? null, o = charmOptions(l), pl = charmPlaces(kid);
    const c = charmClamp(kid, pl.guard ? o.pommel && pl.pommel : true, o.length, o.size);
    this.rig.set(c.cord !== o.length || c.size !== o.size ? { ...l, charmLength: c.cord, charmSize: c.size } : l);
    const hilt = l.hilt ?? null, glove = gloveStyle(l.glove).style;
    if (knife !== this.knife || hilt !== this.hilt || glove !== this.glove) {
      this.knife = knife;
      this.hilt = hilt;
      this.glove = glove;
      this.fit = null;
      this.rig.reset();
    }
    this.place();
  }

  /** Where the charm hangs on the knife in hand (anchors.ts): measured when the knife, hilt, glove or place changes, not per frame. */
  private place(): CharmHang | null {
    if (!this.rig.worn) return (this.hang = null);
    const key = String(this.rig.pommel);
    if (this.fit && this.hang && key === this.hangKey) return this.hang;
    if (!this.fit) {
      this.fit = charmFit(this.knife ?? null, this.hilt, this.glove);
      this.solid = new PointCloud(this.fit.solid);
      this.hands = new PointCloud(this.fit.hands);
    }
    const fit = this.fit;
    this.hang = charmHang(fit, this.rig.pommel);
    this.hangKey = key;
    this.rig.setMount(this.hang.mount);
    this.rig.reset();
    return this.hang;
  }

  /** The fitted place (tests, the lab). */
  get placed(): CharmHang | null {
    return this.hang;
  }

  reset(): void {
    this.rig.reset();
  }

  /**
   * One frame: `W` the posed bones (model space, 3x4 each), `V` the feel matrix (view space) with the offsets
   * (forward, sideways, up) added as viewmodel.ts render() does, `left` the mirrored hand.
   */
  update(dt: number, s: CharmInput, W: Float32Array, r: VmRig, V: ArrayLike<number>, off: V3, left: boolean, clock: number): void {
    if (!this.rig.worn) return;
    const hang = this.place();
    if (!hang) return;
    // Model -> eye: (V + offsets) * mirror.
    const M = this.M;
    for (let i = 0; i < 12; i++) M[i] = V[i];
    M[3] += off[0], M[7] += off[1], M[11] += off[2];
    if (left) M[1] = -M[1], M[5] = -M[5], M[9] = -M[9];
    concat(M, 0, W, r.bone(hang.bone) * 12, this.E, 0);
    // Whether the hand holds the knife as at rest (its finger joints where the rest hold has them, in the knife's
    // frame): then the charm rests against the hand's real surface; in an inspect, against stand-ins on its bones.
    const kbone = r.bone("Knife_Handle");
    concat(M, 0, W, kbone * 12, this.C, 0);
    invert34(this.C, 0, this.Ei, 0);
    let held = true;
    const Wk = this.Wk;
    invert34(W, kbone * 12, Wk, 0);
    for (const j of this.fit!.joints) {
      const o = r.bone(j.bone) * 12;
      const x = W[o + 3], y = W[o + 7], z = W[o + 11];
      const lx = Wk[0] * x + Wk[1] * y + Wk[2] * z + Wk[3] - j.p[0], ly = Wk[4] * x + Wk[5] * y + Wk[6] * z + Wk[7] - j.p[1], lz = Wk[8] * x + Wk[9] * y + Wk[10] * z + Wk[11] - j.p[2];
      if (lx * lx + ly * ly + lz * lz > 0.3 * 0.3) {
        held = false;
        break;
      }
    }
    const clouds = this.clouds;
    clouds.length = 0;
    if (this.solid) clouds.push({ cloud: this.solid, toLocal: this.Ei });
    if (held && this.hands) clouds.push({ cloud: this.hands, toLocal: this.Ei });
    // Colliders: each on its bone, into the eye's frame (the hand's stand-ins only while it is away from its hold).
    const out = this.colliders;
    out.length = 0;
    for (const c of hang.colliders) {
      if (c.hand && held) continue;
      concat(M, 0, W, r.bone(c.bone) * 12, this.C, 0);
      const pa = xf(this.C, c.a);
      if (c.b && c.boneB) concat(M, 0, W, r.bone(c.boneB) * 12, this.C, 0);
      out.push({ a: pa, b: c.b ? xf(this.C, c.b) : null, r: c.r });
    }
    this.rig.update(dt, s, { bone: this.E, at: hang.at, colliders: out, clouds }, clock);
  }

  /** Before the viewmodel's scene renders: the eye's frame -> world (camera * conv), the knife's material. */
  draw(camera: THREE.Camera, conv: THREE.Matrix4, material: THREE.Material, visible: boolean): void {
    if (!this.rig.worn) return this.rig.draw(this.eyeToWorld, false);
    this.eyeToWorld.multiplyMatrices(camera.matrixWorld, conv);
    this.rig.setMaterial(material);
    this.rig.draw(this.eyeToWorld, visible);
  }

  dispose(): void {
    this.rig.dispose();
  }
}

const xf = (m: Float32Array, p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
