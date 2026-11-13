// Brush models that aren't simply drawn with the map's materials, as in CS:S:
//
// func_areaportalwindow (SDK 2013 game/server/func_areaportalwindow.cpp, client c_func_areaportalwindow.cpp): the window
//   entity takes its target's brush model and draws it itself, blended by the eye's distance to the brush's box:
//   TranslucencyLimit up to FadeStartDist (0: the brush isn't there, you see the room behind it), opaque from FadeDist on
//   (where the engine also stops drawing what is behind). Without this the brush is a wall at every distance.
//
// Materials whose proxies drive `$alpha` (material-alpha.ts), run for each brush entity wearing one. The world's own
//   faces only run chains that need no entity (a Sine pulse).
//
// The entity's render keys (brush-render.ts): not drawn at all (rendermode 10, a blend of 0), blended by renderamt or
//   a renderfx, tinted by rendercolor. A window brush is drawn by the window entity, so its own keys don't count.
//
// A faded surface is drawn with its own copy of the material (blended, no depth writes). At full strength it goes
// back to the map's shared material (or its tinted copy), so it is drawn exactly as a plain brush is. Render only.

import * as THREE from "three";
import { fxBlend, fxIsTimed, RENDER_NONE, type RenderKeys } from "./brush-render";
import { hash01, windowBlend, type AlphaInputs, type AlphaProgram } from "./material-alpha";

export interface FadeWindow {
  start: number;
  end: number;
  limit: number;
}

/** `func_areaportalwindow` windows by the brush model they draw (the first entity named by `target`). */
export function areaportalWindows(entities: readonly Record<string, string>[]): Map<number, FadeWindow> {
  const key = (e: Record<string, string>, k: string) => Object.entries(e).find(([n]) => n.toLowerCase() === k)?.[1];
  const num = (v: string | undefined) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = new Map<number, FadeWindow>();
  for (const w of entities) {
    if (key(w, "classname")?.toLowerCase() !== "func_areaportalwindow") continue;
    const name = key(w, "target")?.toLowerCase();
    const target = name ? entities.find((e) => key(e, "targetname")?.toLowerCase() === name) : undefined;
    const model = /^\*([1-9]\d*)$/.exec((target && key(target, "model")) ?? "");
    if (!model || out.has(Number(model[1]))) continue;
    const limit = Math.min(1, Math.max(0, num(key(w, "translucencylimit"))));
    out.set(Number(model[1]), { start: num(key(w, "fadestartdist")), end: num(key(w, "fadedist")), limit });
  }
  return out;
}

/** Sets a material's opacity; false for a kind that has none to set (water, glass). */
export function setMaterialAlpha(m: THREE.Material, alpha: number): boolean {
  const uniform = (m as THREE.ShaderMaterial).uniforms?.uImpColor?.value as THREE.Vector4 | undefined;
  if (uniform) uniform.w = alpha;
  else if (m instanceof THREE.MeshBasicMaterial) m.opacity = alpha;
  else return false;
  return true;
}

/** A material's opacity as `setMaterialAlpha` sets it, or null. */
export function materialAlpha(m: THREE.Material): number | null {
  const uniform = (m as THREE.ShaderMaterial).uniforms?.uImpColor?.value as THREE.Vector4 | undefined;
  return uniform ? uniform.w : m instanceof THREE.MeshBasicMaterial ? m.opacity : null;
}

/** A material's colour, replaced (rendercolor takes the place of `$color`); false for a kind that has none to set. */
export function setMaterialTint(m: THREE.Material, tint: readonly [number, number, number]): boolean {
  const uniform = (m as THREE.ShaderMaterial).uniforms?.uImpColor?.value as THREE.Vector4 | undefined;
  if (uniform) uniform.set(tint[0], tint[1], tint[2], uniform.w);
  else if (m instanceof THREE.MeshBasicMaterial) m.color.setRGB(tint[0], tint[1], tint[2]);
  else return false;
  return true;
}

/** How one brush model departs from a plain brush. */
export interface BrushFade {
  window: FadeWindow | null;
  /** `$alpha` chains by material index. */
  programs: ReadonlyMap<number, AlphaProgram>;
  /** The entity's render keys, or null when they change nothing (or aren't its to use). */
  render: RenderKeys | null;
  /**
   * Material indices the render keys apply to: those with an opacity to set, no `$alpha` chain, and a VMT `$color` and
   * `$alpha` of 1 (the engine puts the entity's colour and blend in their place, and whether it replaces or multiplies
   * a material's own isn't in the SDK). The others are drawn as before.
   */
  renderable: ReadonlySet<number>;
  /** De-syncs the timed effects between entities (the entity's place in the map's entity list). */
  index: number;
}

interface Slot {
  index: number;
  shared: THREE.Material;
  /** Drawn at full strength: the shared material, or its tinted copy. */
  plain: THREE.Material;
  /** Drawn below full strength; null for a surface that is only tinted. */
  own: THREE.Material | null;
  /** The shared material's opacity (the VMT's `$alpha`). */
  base: number;
  depthWrite: boolean;
  program: AlphaProgram | null;
  vars: Float64Array | null;
  /** The entity's render blend applies. */
  render: boolean;
}

interface Entry {
  mesh: THREE.Mesh;
  /** The mesh's material array outside Potato mode. */
  materials: THREE.Material[];
  slots: Slot[];
  window: FadeWindow | null;
  render: RenderKeys | null;
  /** The render blend (0..1) when no renderfx moves it. */
  blend: number;
  /** The model's bounds in its own space. */
  box: THREE.Box3;
  /** A brush entity (not the world's own faces). */
  entity: boolean;
  /** Every material the mesh draws fades: at zero the mesh isn't drawn at all. */
  whole: boolean;
  seed: number;
  index: number;
  /** Nothing about it changes while the map runs. */
  fixed: boolean;
}

/** Height of the eye above the middle of a standing player (64 - 62 / 2): PlayerProximity measures from the middle. */
const EYE_ABOVE_CENTRE = 33;
/** Noise changes this often (GaussianNoise and the renderfx flicker draw a new number on every frame). */
const NOISE_HZ = 100;
const STILL = { time: 0, index: 0, depth: 0, jitter: () => 0 };

export class BrushFades {
  private readonly entries: Entry[] = [];
  private readonly made = new Set<THREE.Material>();
  /** Blended copies of brushes that never change, shared by material, tint and blend. */
  private readonly still = new Map<string, THREE.Material>();
  private readonly eye = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  private potato: boolean | null = null;
  /** Brushes the render keys leave undrawn for good. */
  undrawn = 0;

  get size(): number {
    return this.entries.length;
  }

  /** Brushes that change while the map runs (the rest are set once). */
  get moving(): number {
    return this.entries.filter((e) => !e.fixed).length;
  }

  /** Every material made for these brushes (for a holder mesh: program warm-up, Fullbright, disposal). */
  get materials(): THREE.Material[] {
    return [...this.made];
  }

  /**
   * `mesh` (a brush model under the Source-space root, with its own material array) as `fade` says. `used`: the
   * material indices it draws; `make(i, tint, blended)`: an instance of material `i`, tinted, to be drawn blended or as
   * the map draws it (the caller may share the unblended ones). Materials without an opacity to set are left alone.
   */
  add(mesh: THREE.Mesh, model: number, used: readonly number[], box: THREE.Box3, fade: BrushFade, make: (index: number, tint: readonly [number, number, number] | null, blended: boolean) => THREE.Material): void {
    const materials = mesh.material as THREE.Material[];
    const render = fade.render;
    const timed = !!render && fxIsTimed(render);
    const blend = render && !timed ? fxBlend(render, STILL) / 255 : 1;
    const entry: Entry = { mesh, materials, slots: [], window: fade.window, render: timed ? render : null, blend, box, entity: model !== 0, whole: false, seed: model, index: fade.index, fixed: !fade.window && !timed && !fade.programs.size };
    if (render && (render.mode === RENDER_NONE || (!timed && blend <= 0))) {
      // Never drawn, whatever it is made of.
      this.undrawn++;
      entry.blend = 0;
      entry.fixed = true;
      this.entries.push(entry);
      return;
    }
    for (const index of used) {
      const program = fade.programs.get(index) ?? null;
      const shared = materials[index];
      const base = shared && materialAlpha(shared);
      if (base === null || base === undefined) continue;
      const keyed = !!render && fade.renderable.has(index);
      const tint = keyed ? render!.color : null;
      const fades = !!fade.window || !!program || (keyed && (timed || blend < 1));
      if (!fades && !tint) continue;
      const plain = tint ? make(index, tint, false) : shared;
      let own: THREE.Material | null = null;
      if (fades) {
        const key = entry.fixed ? `${index}|${tint?.join(",") ?? ""}|${blend}` : "";
        own = this.still.get(key) ?? make(index, tint, true);
        if (key) this.still.set(key, own);
        own.transparent = true;
        own.depthWrite = false;
        this.made.add(own);
      }
      if (tint) this.made.add(plain);
      entry.slots.push({ index, shared, plain, own, base, depthWrite: shared.depthWrite, program, vars: program?.vars() ?? null, render: keyed });
    }
    if (!entry.slots.length) return;
    entry.whole = model !== 0 && entry.slots.length === used.length;
    this.entries.push(entry);
  }

  /**
   * Sets every fade for a view from `eye` looking along `forward` (Source space) at map time `time`. In Potato mode the
   * meshes wear Potato's shared flat materials, so a fading brush is simply there or not.
   */
  update(eye: THREE.Vector3, forward: THREE.Vector3, time: number, potato: boolean): void {
    const tick = Math.floor(time * NOISE_HZ);
    const first = this.potato !== potato;
    this.potato = potato;
    for (const e of this.entries) {
      if (e.fixed && !first) continue;
      const m = e.mesh.matrix;
      let n = 0;
      const uniform = () => hash01(e.seed, tick * 64 + n++);
      let blend = e.blend;
      if (e.render) {
        // Hologram: how far ahead of the eye the entity's origin is.
        const depth = this.local.setFromMatrixPosition(m).sub(eye).dot(forward);
        blend = fxBlend(e.render, { time, index: e.index, depth, jitter: () => Math.floor(uniform() * 64) - 32 }) / 255;
      }
      let window = 1;
      if (e.window) {
        this.local.copy(eye).applyMatrix4(this.inverse.copy(m).invert());
        window = windowBlend(e.box.distanceToPoint(this.local), e.window.start, e.window.end, e.window.limit);
      }
      const inputs: AlphaInputs = {
        distance: e.entity ? e.box.getCenter(this.centre).applyMatrix4(m).distanceTo(this.eye.copy(eye).setZ(eye.z - EYE_ABOVE_CENTRE)) : 0,
        time,
        random: hash01(e.seed, 7),
        // Box-Muller on two hashed uniforms: the same flicker whenever the same moment is drawn again (replays, exports).
        gaussian: () => Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12))) * Math.cos(2 * Math.PI * uniform()),
      };
      let most = 0;
      let mostFaded = 0;
      for (const s of e.slots) {
        const faded = (s.program ? s.program.run(s.vars!, inputs) : s.base) * window;
        const alpha = faded * (s.render ? blend : 1);
        most = Math.max(most, alpha);
        mostFaded = Math.max(mostFaded, faded);
        // As the map draws it anyway: the shared material or its tinted copy (opaque ones stay in the opaque pass).
        const plain = !s.own || (window >= 1 && (!s.render || blend >= 1) && (!s.program || (alpha >= 1 && s.base >= 1)));
        e.materials[s.index] = plain ? s.plain : s.own!;
        if (plain) continue;
        setMaterialAlpha(s.own!, alpha);
        s.own!.depthWrite = s.depthWrite && alpha >= 1;
      }
      // The window entity, and an entity with a blend of its own, draw the whole brush or none of it. In Potato a
      // distance fade switches at half strength; a brush the map made see-through stays, drawn flat.
      const hidden = blend <= 0 || (potato ? window < 0.5 || (e.whole && mostFaded < 0.5) : window <= 0 || (e.whole && most <= 0));
      e.mesh.userData.fadeHidden = hidden;
      e.mesh.visible = !hidden && e.mesh.userData.stateShown !== false;
    }
  }
}
