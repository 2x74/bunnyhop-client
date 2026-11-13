// Brush models whose opacity changes while you play, as in CS:S:
//
// func_areaportalwindow (SDK 2013 game/server/func_areaportalwindow.cpp, client c_func_areaportalwindow.cpp): the window
//   entity takes its target's brush model and draws it itself, blended by the eye's distance to the brush's box:
//   TranslucencyLimit up to FadeStartDist (0: the brush isn't there, you see the room behind it), opaque from FadeDist on
//   (where the engine also stops drawing what is behind). Without this the brush is a wall at every distance.
//
// Materials whose proxies drive `$alpha` (material-alpha.ts), run for each brush entity wearing one. The world's own
//   faces only run chains that need no entity (a Sine pulse).
//
// A faded surface is drawn with its own copy of the material (blended, no depth writes). A window at full strength
// goes back to the map's shared material, so from afar it is drawn exactly as a plain brush is. Render only.

import * as THREE from "three";
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

interface Slot {
  index: number;
  shared: THREE.Material;
  own: THREE.Material;
  /** The shared material's opacity (the VMT's `$alpha`). */
  base: number;
  depthWrite: boolean;
  program: AlphaProgram | null;
  vars: Float64Array | null;
}

interface Entry {
  mesh: THREE.Mesh;
  /** The mesh's material array outside Potato mode. */
  materials: THREE.Material[];
  slots: Slot[];
  window: FadeWindow | null;
  /** The model's bounds in its own space. */
  box: THREE.Box3;
  /** A brush entity (not the world's own faces). */
  entity: boolean;
  /** Every material the mesh draws fades: at zero the mesh isn't drawn at all. */
  whole: boolean;
  seed: number;
}

/** Height of the eye above the middle of a standing player (64 - 62 / 2): PlayerProximity measures from the middle. */
const EYE_ABOVE_CENTRE = 33;
/** Noise changes this often (GaussianNoise draws a new number on every bind). */
const NOISE_HZ = 100;

export class BrushFades {
  private readonly entries: Entry[] = [];
  private readonly eye = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();

  get size(): number {
    return this.entries.length;
  }

  /** Every per-surface material made for the fades (for a holder mesh: disposal, Fullbright). */
  get materials(): THREE.Material[] {
    return this.entries.flatMap((e) => e.slots.map((s) => s.own));
  }

  /**
   * `mesh` (a brush model under the Source-space root, with its own material array) fades: all of it as `window`, and
   * the materials in `programs` by their chains. `used`: the material indices it draws; `own(i)`: a new instance of
   * material `i`. Materials without an opacity to set are left alone.
   */
  add(mesh: THREE.Mesh, model: number, used: readonly number[], box: THREE.Box3, window: FadeWindow | null, programs: ReadonlyMap<number, AlphaProgram>, own: (index: number) => THREE.Material): void {
    const materials = mesh.material as THREE.Material[];
    const slots: Slot[] = [];
    for (const index of used) {
      const program = programs.get(index) ?? null;
      const shared = materials[index];
      const base = shared && materialAlpha(shared);
      if ((!window && !program) || base === null || base === undefined) continue;
      const mine = own(index);
      mine.transparent = true;
      mine.depthWrite = false;
      slots.push({ index, shared, own: mine, base, depthWrite: shared.depthWrite, program, vars: program?.vars() ?? null });
    }
    if (slots.length) this.entries.push({ mesh, materials, slots, window, box, entity: model !== 0, whole: model !== 0 && slots.length === used.length, seed: model });
  }

  /**
   * Sets every fade for a view from `eye` (Source space) at map time `time`. In Potato mode the meshes wear Potato's
   * shared flat materials, so a fading brush is simply there or not.
   */
  update(eye: THREE.Vector3, time: number, potato: boolean): void {
    const tick = Math.floor(time * NOISE_HZ);
    for (const e of this.entries) {
      const m = e.mesh.matrix;
      let blend = 1;
      if (e.window) {
        this.local.copy(eye).applyMatrix4(this.inverse.copy(m).invert());
        blend = windowBlend(e.box.distanceToPoint(this.local), e.window.start, e.window.end, e.window.limit);
      }
      let n = 0;
      const inputs: AlphaInputs = {
        distance: e.entity ? e.box.getCenter(this.centre).applyMatrix4(m).distanceTo(this.eye.copy(eye).setZ(eye.z - EYE_ABOVE_CENTRE)) : 0,
        time,
        random: hash01(e.seed, 7),
        // Box-Muller on two hashed uniforms: the same flicker whenever the same moment is drawn again (replays, exports).
        gaussian: () => Math.sqrt(-2 * Math.log(Math.max(hash01(e.seed, tick * 64 + n++), 1e-12))) * Math.cos(2 * Math.PI * hash01(e.seed, tick * 64 + n++)),
      };
      let most = 0;
      for (const s of e.slots) {
        const alpha = (s.program ? s.program.run(s.vars!, inputs) : s.base) * blend;
        most = Math.max(most, alpha);
        // As the map draws it anyway: the shared material (opaque ones stay in the opaque pass).
        const plain = blend >= 1 && (!s.program || (alpha >= 1 && s.base >= 1));
        e.materials[s.index] = plain ? s.shared : s.own;
        if (plain) continue;
        setMaterialAlpha(s.own, alpha);
        s.own.depthWrite = s.depthWrite && alpha >= 1;
      }
      if (!e.whole) continue;
      const hidden = potato ? most < 0.5 : most <= 0;
      e.mesh.userData.fadeHidden = hidden;
      e.mesh.visible = !hidden && e.mesh.userData.stateShown !== false;
    }
  }
}
