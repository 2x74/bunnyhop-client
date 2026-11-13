// The map's fog and light on the game's own models (bunnies, ghosts, replay bots, the first-person hands and weapon).
//
// Player materials (player/materials.ts) carry both with their own uniforms, neutral by default, so previews, the
// Loadout and the avatar editor are never touched. A world (render.ts) owns one of these and calls `frame` from every
// render of its scene. Nothing registers: a model is anything named "player-model" in the scene being drawn
// (PlayerModel's root), so the many places that build a PlayerModel need no change. The viewmodels are drawn over the
// world from their own scenes: whoever draws them names them each frame (`eye`).
//
// Fog: the models are pointed at the world's fog uniforms (depth-fog.ts).
//
// Light ("Model lighting"): the studio light every model carries is scaled and tinted by the map's light where the
// model stands (the core's `light_cube`: the leaf's ambient cube plus the lights that reach the point; at the camera
// for the viewmodels). One sample per model every few frames, eased over time so crossing into another leaf or out of
// a lamp's reach never flickers. Readability comes first: the light only ever dims a model, never past the mode's
// floor, and only half of the light's colour is taken in Subtle.

import * as THREE from "three";
import { DEPTH_FOG_OFF, type DepthFogUniforms } from "./depth-fog";
import type { ModelLighting } from "./graphics/presets";

/** Per mode: the darkest a model gets (1 = the studio light as it is) and how much of the light's colour it takes. */
export const MODEL_LIGHTING: Record<Exclude<ModelLighting, "off">, { floor: number; tint: number }> = {
  subtle: { floor: 0.6, tint: 0.5 },
  full: { floor: 0.32, tint: 1 },
};

/** Light (linear, 1 = a surface at its texture's brightness) at and above which a model keeps its full studio light. */
const FULL_LIGHT = 0.4;
/** A tint never pushes a channel past these (a pure red lamp still leaves a readable model). */
const TINT_MIN = 0.55;
const TINT_MAX = 1.3;

const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * A model's light from the map's light cube at its place (six linear RGB colours, core.ts lightCube), as the offset
 * from the studio light (0 = unchanged): what the player materials' uMapLight takes. `exposure`: the HDR look's
 * current exposure for models drawn after it (the viewmodels); the ones in the scene get it with the scene.
 */
export function modelLightOf(cube: ArrayLike<number>, mode: Exclude<ModelLighting, "off">, exposure: number, out: THREE.Vector3): THREE.Vector3 {
  const { floor, tint } = MODEL_LIGHTING[mode];
  const avg = [0, 0, 0];
  for (let i = 0; i < 18; i++) avg[i % 3] += (cube[i] * exposure) / 6;
  const luma = avg[0] * LUMA[0] + avg[1] * LUMA[1] + avg[2] * LUMA[2];
  // Brightness follows the eye more than the light: the square root, capped at the studio light.
  const level = Math.min(1, Math.max(floor, Math.sqrt(Math.max(0, luma) / FULL_LIGHT)));
  const c = [1, 1, 1];
  if (luma > 1e-5) {
    for (let k = 0; k < 3; k++) c[k] = Math.min(TINT_MAX, Math.max(TINT_MIN, 1 + (avg[k] / luma - 1) * tint));
    // The tint moves the colour, not the brightness.
    const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
    for (let k = 0; k < 3; k++) c[k] /= l;
  }
  return out.set(c[0] * level - 1, c[1] * level - 1, c[2] * level - 1);
}

type Block = Record<string, THREE.IUniform | undefined>;

interface Lit {
  blocks: Set<Block>;
  /** Drawn from the camera (a viewmodel): lit at the eye, with the scene's exposure. */
  eye: boolean;
  light: THREE.Vector3;
  target: THREE.Vector3;
  /** When it was last sampled (visual seconds); -Infinity: not yet, the first sample is taken as it is. */
  sampled: number;
  /** When the last search saw it (ms). */
  seen: number;
  /** An eye model: the world's clock when it was last named and stepped, and when its materials were last gathered. */
  named: number;
  linked: number;
}

/** How often the scene is searched for models that came or went, and a model for new parts: seconds of the world's clock, and ms of the wall clock while that stands. */
const RESCAN_S = 0.25;
const RESCAN_MS = 250;
/** Groups up to this size are looked into for a model on every step (a ghost's: model, trail, tag). */
const SMALL_GROUP = 8;
/** An eye model not named for this long on the world's clock (a cut to another camera) starts from its new light. */
const EYE_GAP = 0.15;
/** An eye model not named for this long is forgotten (ms). */
const EYE_KEEP_MS = 2000;
/** Seconds between a model's samples, and the time constant its light eases with. */
const SAMPLE_EVERY = 0.05;
const EASE = 0.18;
/** A jump in the world's clock past this (a seek, a new attempt after a pause) takes the new light at once. */
const CUT = 0.5;
/** Height above a model's feet its light is sampled at (units). */
const CHEST = 40;

/** The uniform blocks of the player materials under `root` (a model's body, hat, held gun). */
function blocksUnder(root: THREE.Object3D, out: Set<Block>): void {
  out.clear();
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const u = (m as THREE.ShaderMaterial).uniforms as Block | undefined;
      if (u?.uDepthFogRange && u.uMapLight) out.add(u);
    }
  });
}

export class ModelLight {
  private scanned = -Infinity;
  private scannedAt = -Infinity;
  private models = new Map<THREE.Object3D, Lit>();
  private mode: ModelLighting = "off";
  /** The world's clock (WorldView.update's visual time) now and at the last step. */
  private time = 0;
  private stepped = 0;
  private exposure = 1;
  private eyeAt = new THREE.Vector3();
  private cube = new Float32Array(18);
  private at = new THREE.Vector3();
  private inverse = new THREE.Matrix4();

  /**
   * `fog`: the world's fog uniforms (depth-fog.ts), null on a map without fog. `world`: the world's own subtree (not
   * searched), whose `sourceRoot` child maps Source space to the scene. `sample`: the map's light cube at a Source-space
   * point into `out`, false where there is none (core.ts lightCube).
   */
  constructor(
    private fog: DepthFogUniforms | null,
    private world: THREE.Object3D,
    private sourceRoot: THREE.Object3D,
    private sample: (x: number, y: number, z: number, out: Float32Array) => boolean,
  ) {}

  /** Off, or how far the map's light reaches into the models' own (Potato and Fullbright pass "off"). */
  setMode(mode: ModelLighting): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // The new mode's light at once, not eased from the old one.
    for (const m of this.models.values()) m.sampled = -Infinity;
  }

  /** The world's clock (visual seconds): what the easing runs on, so a paused view holds and an export repeats. */
  setTime(seconds: number): void {
    if (Number.isFinite(seconds)) this.time = seconds;
  }

  /**
   * Names the scenes drawn over this world from `camera` this frame (the hands and weapon): fogged like the world and
   * lit at the eye, at the scene's `exposure` (they are drawn after the HDR look's).
   */
  eye(roots: readonly THREE.Object3D[], camera: THREE.Camera, exposure = 1, now = performance.now()): void {
    // Lit here, not with the scene's models: the caller draws them right after, before or after the scene's render
    // (an export draws them over its finished frame), and each frame must carry that frame's light.
    this.inverse.copy(this.sourceRoot.matrixWorld).invert();
    camera.getWorldPosition(this.eyeAt).applyMatrix4(this.inverse);
    this.exposure = exposure;
    for (const root of roots) {
      const m = this.entry(root, true);
      m.seen = now;
      if (Math.abs(this.time - m.linked) >= RESCAN_S) {
        this.link(root, m);
        m.linked = this.time;
      }
      const dt = this.time - m.named;
      const fresh = !(Math.abs(dt) <= EYE_GAP);
      if (fresh) m.sampled = -Infinity;
      this.step(m, this.eyeAt, 0, fresh, fresh ? 0 : Math.max(0, dt));
      m.named = this.time;
    }
  }

  private entry(root: THREE.Object3D, eye: boolean): Lit {
    let m = this.models.get(root);
    if (!m) this.models.set(root, (m = { blocks: new Set(), eye, light: new THREE.Vector3(), target: new THREE.Vector3(), sampled: -Infinity, seen: 0, named: -Infinity, linked: -Infinity }));
    return m;
  }

  /** One model's light for this step: a new sample when due (at the Source-space point `p`, `lift` above it), eased over `dt`. */
  private step(m: Lit, p: THREE.Vector3, lift: number, cut: boolean, dt: number): void {
    if (this.mode === "off") {
      m.target.set(0, 0, 0);
      m.light.set(0, 0, 0);
    } else {
      if (cut || this.time - m.sampled >= SAMPLE_EVERY) {
        if (this.sample(p.x, p.y, p.z + lift, this.cube)) modelLightOf(this.cube, this.mode, m.eye ? this.exposure : 1, m.target);
        if (m.sampled === -Infinity || cut) m.light.copy(m.target);
        m.sampled = this.time;
      }
      m.light.lerp(m.target, cut ? 1 : 1 - Math.exp(-dt / EASE));
    }
    for (const b of m.blocks) (b.uMapLight!.value as THREE.Vector3).copy(m.light);
  }

  /** Before a render of `scene` (the one the world is in). */
  frame(scene: THREE.Object3D, now = performance.now()): void {
    const dt = this.time - this.stepped;
    const cut = Math.abs(dt) > CUT;
    // A small step back holds: two views of one world a little apart in time (head to head) share one clock.
    const moved = cut || dt > 0;
    // Searches run on the world's clock while it moves, so an export finds and lights every model on the same frames
    // each time; on the wall clock only while it stands (a paused view, a menu).
    if (cut || Math.abs(this.time - this.scannedAt) >= RESCAN_S || (!moved && now - this.scanned >= RESCAN_MS)) this.scan(scene, now);
    else if (moved) this.arrivals(scene, now);
    if (!moved && this.settled) return;
    if (moved) this.stepped = this.time;
    this.settled = true;
    this.inverse.copy(this.sourceRoot.matrixWorld).invert();
    // (Eye models are stepped where they are named: `eye`.) Source space: the world root's local frame.
    for (const [root, m] of this.models) if (!m.eye) this.step(m, root.getWorldPosition(this.at).applyMatrix4(this.inverse), CHEST, cut, Math.max(0, dt));
  }

  /** Nothing new since the last step (a paused view): skip until the clock moves or the scene changes. */
  private settled = false;

  /** A model's materials again (a gun drawn, a hat put on), pointed at this world's fog. */
  private link(root: THREE.Object3D, m: Lit): void {
    blocksUnder(root, m.blocks);
    const fog = this.fog ?? DEPTH_FOG_OFF;
    for (const b of m.blocks) {
      b.uDepthFogColor = fog.uDepthFogColor;
      b.uDepthFogRange = fog.uDepthFogRange;
    }
  }

  /**
   * Every step between searches: models that just came into the scene, where every caller puts them (straight into it,
   * or one small group down like a ghost with its trail and tag), so a player who joins is lit on their first frame.
   */
  private arrivals(scene: THREE.Object3D, now: number): void {
    const meet = (o: THREE.Object3D) => {
      if (o.name !== "player-model" || this.models.has(o)) return;
      const m = this.entry(o, false);
      m.seen = now;
      this.link(o, m);
      this.settled = false;
    };
    for (const o of scene.children) {
      if (o === this.world) continue;
      meet(o);
      if (o.children.length <= SMALL_GROUP) for (const c of o.children) meet(c);
    }
  }

  private scan(scene: THREE.Object3D, now: number): void {
    this.scanned = now;
    this.scannedAt = this.time;
    this.settled = false;
    const visit = (o: THREE.Object3D) => {
      if (o === this.world) return;
      if (o.name === "player-model") this.entry(o, false).seen = now;
      else for (const c of o.children) visit(c);
    };
    visit(scene);
    for (const [root, m] of this.models) {
      if (now - m.seen > (m.eye ? EYE_KEEP_MS : 0)) {
        // Gone from this world: back to the plain model, wherever it is shown next.
        for (const b of m.blocks) {
          (b.uMapLight!.value as THREE.Vector3).set(0, 0, 0);
          b.uDepthFogColor = DEPTH_FOG_OFF.uDepthFogColor;
          b.uDepthFogRange = DEPTH_FOG_OFF.uDepthFogRange;
        }
        this.models.delete(root);
        continue;
      }
      this.link(root, m);
    }
  }
}
