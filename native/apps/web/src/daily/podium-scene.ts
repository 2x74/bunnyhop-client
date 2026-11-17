// The Daily Challenge podium as a three.js scene (ui/daily-podium.ts puts it on the page and into the Discord image):
// a three-step podium with the day's top three standing on it as their own bunnies, the day's map blurred behind them.
//
// The bunnies are the game's PlayerModel (player/model.ts), the same model other players are drawn with in a room: a
// colourway, the loadout (knife + finish + hilt in hand, gloves, head item, back item and its settings) and the
// Supporter glow, all passed explicitly, so nothing here follows the viewer's own loadout. Geometry is built in the
// prebuild worker and programs are compiled before a bunny is shown (prebuild.ts), so a bunny arriving never blocks a
// frame.
//
// Updates never rebuild the scene: set() plans per place (podium-data.ts planPodium) and only builds a bunny that isn't
// built already; a place that waits for its new bunny keeps the one it had until the new one is ready, then they are
// exchanged between two frames. `builds` counts the bunnies made, for the tests and the page's measurements.
//
// Motion is small: the bunnies' own idle (weight shift, ears), and the winner's knife arm held up a little and breathing.
// The camera never moves. One camera for the page and the image (CAMERA).
//
// Units are Source's (a bunny is 72 tall); three.js axes are (x, z, -y) of Source's, as everywhere else.

import * as THREE from "three";
import { PlayerModel, type PlayerPose } from "../player/model";
import { prebuildBunny } from "../player/bunny/prebuild";
import { hasAnimRig, loadAnimRig } from "../player/studio/loader";
import type { BunnyActing } from "../player/bunny/model";
import { lookKey, planPodium, type Place, type PodiumWant, type Standing } from "./podium-data";
export type { PodiumWant } from "./podium-data";

/** The steps: how wide and deep each is, and how tall (1st in the middle and highest, 2nd on the viewer's left, 3rd on the right). */
export const STEP = { w: 70, d: 46 } as const;
export const STEP_H: Record<Place, number> = { 1: 30, 2: 23, 3: 16 };
export const STEP_X: Record<Place, number> = { 1: 0, 2: -STEP.w, 3: STEP.w };
/** Where each bunny looks (Source yaw; 270 faces the camera): the outer two turned a little toward the middle. */
const YAW: Record<Place, number> = { 1: 262, 2: 274, 3: 250 };
/** One camera for every size: 16:9 shows the podium with room either side; a wider frame shows more to the sides. */
export const CAMERA = { fov: 24, pitch: 7, target: 60, half: 72 } as const;
/** The metals of the daily marks (creators.ts MEDALS: the weekly marks' gold, silver and bronze). */
export const METAL: Record<Place, { light: string; mid: string; dark: string }> = {
  1: { light: "#ffe9a3", mid: "#f2b628", dark: "#c98a1c" },
  2: { light: "#f4f6fa", mid: "#c5ccd8", dark: "#8d96a6" },
  3: { light: "#f6c896", mid: "#c9824a", dark: "#8f5328" },
};
const INK = "#0e1428";
const PLACE_OF: readonly Place[] = [1, 2, 3];
const D2R = Math.PI / 180;

interface Stand extends Standing {
  model: PlayerModel;
  /** The body's middle off the model's origin (model space, before the feet's yaw), so it stands in the middle of its step. */
  mid: [number, number];
  /** Seconds since it took the top step (the knife arm eases up over the first of them). */
  raised: number;
  was: Place | null;
}

const key = (s: Standing) => `${s.id}\n${s.key}`;
const _box = new THREE.Box3();

// ---------------------------------------------------------------------------------------------
// The podium object: three plain blocks, each with a cap and a thin metal band under it, and the place's disc on its
// front. Faceted and self-lit like the bunny (a key from the upper left, a sky / ground fill): vertex colours on one
// unlit material, one draw call. The discs are one more (a small canvas texture).

const BODY = new THREE.Color("#2a2c35");
const CAP = new THREE.Color("#3a3d49");
/** The cap and the metal band under it take this much off the top of a block's face. */
const TRIM = 3.4;
const KEY = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();

/** The shade a face takes from its normal (three.js space). */
function shade(nx: number, ny: number, nz: number): number {
  const k = Math.max(0, nx * KEY.x + ny * KEY.y + nz * KEY.z);
  const sky = 0.5 + 0.5 * ny;
  return 0.42 + 0.22 * sky + 0.62 * k;
}

function pushBox(pos: number[], col: number[], cx: number, y0: number, y1: number, w: number, d: number, c: THREE.Color): void {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = -d / 2, z1 = d / 2;
  // (four corners counter-clockwise seen from outside, then the normal)
  const faces: [number[][], [number, number, number]][] = [
    [[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]],
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    [[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]],
    [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]],
  ];
  for (const [q, n] of faces) {
    const s = shade(n[0], n[1], n[2]);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(q[i][0], q[i][1], q[i][2]);
      col.push(c.r * s, c.g * s, c.b * s);
    }
  }
}

/** The blocks' geometry (positions + colours). Exported for the tests: the heights and the order are the design. */
export function podiumGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  for (const place of PLACE_OF) {
    const h = STEP_H[place], x = STEP_X[place];
    // (The blocks touch: the outer two are a hair narrower so no two faces share a plane.)
    const w = place === 1 ? STEP.w : STEP.w - 0.4;
    const cx = place === 1 ? x : x + (place === 2 ? 0.2 : -0.2);
    pushBox(pos, col, cx, 0, h - TRIM, w, STEP.d, BODY);
    pushBox(pos, col, cx, h - TRIM, h - 2, w + 1.2, STEP.d + 1.2, new THREE.Color(METAL[place].mid));
    pushBox(pos, col, cx, h - 2, h, w + 2.4, STEP.d + 2.4, CAP);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** The three place discs (the daily mark's plain disc: the metal's gradient, the place engraved in dark ink), side by side in one canvas. */
function discCanvas(font: string): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S * 3;
  c.height = S;
  const g = c.getContext("2d")!;
  PLACE_OF.forEach((place, i) => {
    const m = METAL[place], cx = S * i + S / 2, cy = S / 2, r = S * 0.4;
    const fill = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    fill.addColorStop(0, m.light);
    fill.addColorStop(0.55, m.mid);
    fill.addColorStop(1, m.dark);
    g.fillStyle = fill;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.font = `850 ${Math.round(S * 0.5)}px ${font}`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    // Engraved: a light edge under the dark numeral, as the marks have.
    g.fillStyle = "rgba(255, 255, 255, 0.35)";
    g.fillText(String(place), cx, cy + S * 0.18 + 2);
    g.fillStyle = INK;
    g.fillText(String(place), cx, cy + S * 0.18);
  });
  return c;
}

function discGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  PLACE_OF.forEach((place, i) => {
    const h = STEP_H[place], x = STEP_X[place];
    // A disc that fits the block's face under the band: smaller on the low step.
    const r = Math.min(8.5, (h - TRIM) * 0.46), cy = (h - TRIM) / 2, z = STEP.d / 2 + 0.15;
    const q = [[x - r, cy - r], [x + r, cy - r], [x + r, cy + r], [x - r, cy + r]];
    const t = [[i / 3, 0], [(i + 1) / 3, 0], [(i + 1) / 3, 1], [i / 3, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(q[k][0], q[k][1], z);
      uv.push(t[k][0], t[k][1]);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// ---------------------------------------------------------------------------------------------

export class PodiumScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 20, 2400);
  /** Bunnies built since the scene was made. */
  builds = 0;
  /** Called when what is drawn changed (a bunny arrived, left or moved; the backdrop loaded): a still view redraws. */
  onChange: (() => void) | null = null;
  /** Compiles a new bunny's programs for wherever the scene is drawn, before it is shown (set by the view). */
  warm: ((root: THREE.Object3D) => Promise<void>) | null = null;

  private want: (PodiumWant | null)[] = [null, null, null];
  private shown: (Stand | null)[] = [null, null, null];
  private spare = new Map<string, Stand>();
  private pending = new Set<string>();
  private disposed = false;
  private clock = 0;
  private own: { geometry: THREE.BufferGeometry[]; material: THREE.Material[]; texture: THREE.Texture[] } = { geometry: [], material: [], texture: [] };
  private shadows: THREE.Mesh[] = [];
  private backdrop: THREE.Mesh;
  private backdropUrl: string | null = null;

  constructor(o: { font?: string } = {}) {
    const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => {
      (x instanceof THREE.BufferGeometry ? this.own.geometry : x instanceof THREE.Texture ? this.own.texture : this.own.material).push(x as never);
      return x;
    };
    this.setAspect(16 / 9);

    // The backdrop: the day's map, small and soft (setBackdrop), far behind; a plain dark wall until it loads.
    const wall = keep(new THREE.CanvasTexture(backdropCanvas(null)));
    wall.colorSpace = THREE.SRGBColorSpace;
    this.backdrop = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: wall, depthWrite: false, depthTest: false, toneMapped: false })));
    this.backdrop.renderOrder = -10;
    this.backdrop.frustumCulled = false;
    this.scene.add(this.backdrop);

    // The floor the podium stands on: a soft dark pool that fades out, darkest under the blocks.
    const floor = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(520, 300).rotateX(-Math.PI / 2)),
      keep(new THREE.MeshBasicMaterial({ map: keep(floorTexture()), transparent: true, depthWrite: false, toneMapped: false })),
    );
    floor.position.set(0, 0, 30);
    floor.renderOrder = -5;
    this.scene.add(floor);

    const blocks = new THREE.Mesh(keep(podiumGeometry()), keep(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })));
    this.scene.add(blocks);
    if (typeof document !== "undefined") {
      const discs = keep(new THREE.CanvasTexture(discCanvas(o.font ?? "sans-serif")));
      discs.colorSpace = THREE.SRGBColorSpace;
      discs.anisotropy = 4;
      this.scene.add(new THREE.Mesh(keep(discGeometry()), keep(new THREE.MeshBasicMaterial({ map: discs, transparent: true, toneMapped: false }))));
    }

    // A soft contact shadow under each bunny, on its step.
    const blob = keep(new THREE.CircleGeometry(15, 28).rotateX(-Math.PI / 2));
    const dark = keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
    for (const place of PLACE_OF) {
      const m = new THREE.Mesh(blob, dark);
      m.position.set(STEP_X[place], STEP_H[place] + 0.12, 0);
      m.scale.set(1, 1, 0.72);
      m.visible = false;
      this.shadows.push(m);
      this.scene.add(m);
    }
  }

  /**
   * The frame's aspect (width / height). The camera never moves (CAMERA); 16:9 on the page, a wider frame sees more to
   * the sides. `lo` / `hi`: the heights (units, at the podium) the frame's bottom and top edges show, for a picture that
   * wants room under the podium (the Discord image): the same camera with a taller, shifted film, not another view.
   */
  setAspect(aspect: number, lo: number = CAMERA.target - CAMERA.half, hi: number = CAMERA.target + CAMERA.half): void {
    const cam = this.camera, a = CAMERA.pitch * D2R;
    const d = CAMERA.half / Math.tan((CAMERA.fov * D2R) / 2);
    cam.position.set(0, CAMERA.target + Math.sin(a) * d, Math.cos(a) * d);
    cam.lookAt(0, CAMERA.target, 0);
    // The film that holds [lo, hi] about the camera's axis, and the part of it that is the frame.
    const half = Math.max(CAMERA.target - lo, hi - CAMERA.target), part = (hi - lo) / (2 * half);
    cam.fov = (2 * Math.atan(half / d)) / D2R;
    aspect = Math.max(0.5, aspect);
    cam.aspect = aspect * part;
    if (part < 0.999) cam.setViewOffset(aspect * 1000, 1000 / part, 0, ((hi - CAMERA.target - half) / (-2 * half)) * (1000 / part), aspect * 1000, 1000);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (this.backdrop) this.placeBackdrop();
  }

  /** The backdrop fills the view from far behind the podium, facing the camera. */
  private placeBackdrop(): void {
    const cam = this.camera, far = 900;
    const h = 2 * far * Math.tan((cam.fov * D2R) / 2), w = h * cam.aspect;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    this.backdrop.position.copy(cam.position).addScaledVector(dir, far);
    this.backdrop.quaternion.copy(cam.quaternion);
    this.backdrop.scale.set(w * 1.02, h * 1.02, 1);
  }

  /** The day's map picture (a URL the page may read pixels from; anything else leaves the plain wall). */
  setBackdrop(url: string | null): void {
    if (url === this.backdropUrl || typeof Image === "undefined") return;
    this.backdropUrl = url;
    const paint = (img: HTMLImageElement | null) => {
      if (this.disposed || this.backdropUrl !== url) return;
      const mat = this.backdrop.material as THREE.MeshBasicMaterial;
      let canvas: HTMLCanvasElement;
      try {
        canvas = backdropCanvas(img);
        // (A picture from another origin without CORS headers taints the canvas: reading it back throws.)
        if (img) canvas.getContext("2d")!.getImageData(0, 0, 1, 1);
      } catch {
        canvas = backdropCanvas(null);
      }
      const old = mat.map;
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      this.own.texture = this.own.texture.filter((x) => x !== old).concat(t);
      old?.dispose();
      this.onChange?.();
    };
    if (!url) return paint(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => paint(img);
    img.onerror = () => paint(null);
    img.src = url;
  }

  /** What should stand on the three places (index 0 = 1st; null = an empty step). Only what differs is built or moved. */
  set(next: readonly (PodiumWant | null)[]): void {
    this.want = [0, 1, 2].map((i) => next[i] ?? null);
    this.reconcile();
  }

  /** The standings as drawn right now (a place still waiting for its bunny shows the one it had, or nothing). */
  drawn(): (Standing | null)[] {
    return this.shown.map((s) => (s ? { id: s.id, key: s.key } : null));
  }

  /** Every place shows what it should (nothing is being built). */
  get settled(): boolean {
    return !this.pending.size && this.want.every((w, i) => (w ? this.shown[i]?.id === w.id && this.shown[i]?.key === lookKey(w.look) : !this.shown[i]));
  }

  private reconcile(): void {
    if (this.disposed) return;
    const wanted = this.want.map((w) => (w ? { id: w.id, key: lookKey(w.look) } : null));
    const steps = planPodium(this.drawn(), wanted);
    const next: (Stand | null)[] = [null, null, null];
    const used = new Set<Stand>();
    steps.forEach((st, i) => {
      const s = st.kind === "keep" ? this.shown[i] : st.kind === "move" ? this.shown[st.from] : null;
      if (s) (next[i] = s), used.add(s);
    });
    steps.forEach((st, i) => {
      if (st.kind !== "build") return;
      const k = key(wanted[i]!);
      const ready = this.spare.get(k);
      if (ready) {
        this.spare.delete(k);
        this.scene.add(ready.model.root);
        next[i] = ready;
        used.add(ready);
        return;
      }
      this.build(this.want[i]!, wanted[i]!);
      // Until it is ready the bunny that stood here stays (unless it just moved to another place).
      const old = this.shown[i];
      if (old && !used.has(old)) (next[i] = old), used.add(old);
    });
    let changed = false;
    for (const s of this.shown) if (s && !used.has(s)) (this.drop(s), (changed = true));
    for (let i = 0; i < 3; i++) if (next[i] !== this.shown[i]) changed = true;
    this.shown = next;
    // Bunnies built for a standing nobody wants any more.
    const keys = new Set(wanted.filter((w): w is Standing => !!w).map(key));
    for (const [k, s] of this.spare) if (!keys.has(k)) (this.spare.delete(k), s.model.dispose());
    if (changed) {
      this.place(0);
      this.onChange?.();
    }
  }

  private drop(s: Stand): void {
    this.scene.remove(s.model.root);
    s.model.dispose();
  }

  private build(w: PodiumWant, standing: Standing): void {
    const k = key(standing);
    if (this.pending.has(k)) return;
    this.pending.add(k);
    void (async () => {
      let stand: Stand | null = null;
      try {
        // The stance's animations first (a moment at most: the game has them once any bunny was drawn), so a bunny is
        // made in the pose it keeps and measured in it, and a still picture never catches the stand-in animation.
        // (Outside a page there is no worker: the model then builds its own geometry, as the game's tests do.)
        await Promise.all([typeof window === "undefined" ? null : prebuildBunny(w.look.outfit, w.look.loadout, !!w.look.glow), animations()]);
        if (this.disposed) return;
        stand = this.make(w, standing);
        await this.warm?.(stand.model.root);
      } catch (e) {
        console.warn("daily podium: a bunny could not be built", e);
        stand?.model.dispose();
        stand = null;
      } finally {
        this.pending.delete(k);
      }
      if (!stand) return void this.onChange?.();
      const stillWanted = this.want.some((x) => x && x.id === standing.id && lookKey(x.look) === standing.key);
      if (this.disposed || !stillWanted) return stand.model.dispose();
      this.spare.set(k, stand);
      this.reconcile();
    })();
  }

  /** A bunny in a look, settled into its stance, with where its body stands off its origin for each place's facing. */
  private make(w: PodiumWant, standing: Standing): Stand {
    const l = w.look;
    // (previewGlow: the glow is part of the picture here, whatever the viewer's in-game Player glow setting says.)
    const model = new PlayerModel({ model: "bunny", style: "solid", outfit: l.outfit, loadout: l.loadout, playerGlow: l.glow, previewGlow: !!l.glow, legs: false, seed: seedOf(w.id) });
    model.setNearFade(0, 0);
    this.builds++;
    // Settled into the stance (the idle eases in from rest), then measured: the stance stands the body off the origin.
    model.setState(stand(1));
    model.snap();
    for (let i = 0; i < 40; i++) model.update(1 / 60);
    const box = model.bunnyModel?.bodyBox(_box);
    const mid: [number, number] = box && !box.isEmpty() ? [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2] : [0, 0];
    return { ...standing, model, mid, raised: 0, was: null };
  }

  /** Steps the bunnies by dt seconds (0: just puts them where they belong). */
  advance(dt: number): void {
    if (this.disposed) return;
    this.clock += dt;
    this.place(dt);
  }

  private place(dt: number): void {
    this.shown.forEach((s, i) => {
      const place = PLACE_OF[i];
      this.shadows[i].visible = !!s;
      if (!s) return;
      if (s.model.root.parent !== this.scene) this.scene.add(s.model.root);
      const moved = s.was !== place;
      if (moved) {
        s.was = place;
        s.raised = 0;
      }
      s.model.setState(stand(place));
      if (moved) s.model.snap();
      // The winner holds the knife up a little; the arm eases up when the bunny takes the top step and breathes after.
      s.raised += dt;
      s.model.bunnyModel?.setActing(place === 1 ? raise(Math.min(1, s.raised / 0.7), this.clock) : null);
      s.model.update(Math.max(dt, 1e-4));
      // The body's middle over the step's middle: its offset turned with the feet (Source, about z).
      const a = (s.model.bunnyModel?.feetYaw ?? YAW[place]) * D2R, [cx, cy] = s.mid;
      const p = s.model.root.position;
      p.x = STEP_X[place] - (cx * Math.cos(a) - cy * Math.sin(a));
      p.z = cx * Math.sin(a) + cy * Math.cos(a);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of new Set([...this.shown, ...this.spare.values()])) if (s) this.drop(s);
    this.shown = [null, null, null];
    this.spare.clear();
    for (const g of this.own.geometry) g.dispose();
    for (const m of this.own.material) m.dispose();
    for (const t of this.own.texture) t.dispose();
    this.scene.clear();
    this.onChange = null;
    this.warm = null;
  }
}

/** The CS:S stance animations when the page can have them, waited for at most `ms`. Never rejects. */
function animations(ms = 2500): Promise<void> {
  if (!hasAnimRig()) return Promise.resolve();
  return Promise.race([loadAnimRig().then(() => {}, () => {}), new Promise<void>((r) => setTimeout(r, ms))]);
}

/** Standing on a step, the feet on its top. */
function stand(place: Place): PlayerPose {
  return { position: [STEP_X[place], 0, STEP_H[place]], velocity: [0, 0, 0], yaw: YAW[place], pitch: 3, crouched: false, grounded: true };
}

const ease = (t: number) => t * t * (3 - 2 * t);
/** The winner's knife arm: up a little (k: 0 = down, 1 = up), breathing slowly. */
function raise(k: number, t: number): BunnyActing {
  const e = ease(k), breath = Math.sin(t * 1.5) * 2.2 * e;
  return {
    chestPitch: 0, chestYaw: 0, chestRoll: 0, headPitch: -3 * e, headYaw: 0, headRoll: 0, earL: 0.35 * e, earR: 0.35 * e,
    arm: { shoulder: [-25 * e, 0, -13 * e], elbow: [-80 * e + breath, 0, 0] },
  };
}

/** 0..1 from a player's id: bunnies don't idle in step, and a player's bunny idles the same way every time. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * The backdrop's picture: the map shot drawn small and scaled back up (a light softening with no filter: the map stays
 * recognisable), a little dimmed, with the lower part and the corners darker so the podium and the bunnies stand clear
 * of it. No picture: the plain wall.
 */
function backdropCanvas(img: HTMLImageElement | null): HTMLCanvasElement {
  const W = 512, H = 288;
  const c = typeof document !== "undefined" ? document.createElement("canvas") : ({ width: W, height: H, getContext: () => null } as unknown as HTMLCanvasElement);
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return c;
  g.fillStyle = "#16171d";
  g.fillRect(0, 0, W, H);
  if (img && img.naturalWidth) {
    const small = document.createElement("canvas");
    small.width = 192;
    small.height = 108;
    const s = small.getContext("2d")!;
    // Cover: the picture's middle, cropped to 16:9.
    const ar = img.naturalWidth / img.naturalHeight, want = 16 / 9;
    const sw = ar > want ? img.naturalHeight * want : img.naturalWidth, sh = ar > want ? img.naturalHeight : img.naturalWidth / want;
    s.imageSmoothingQuality = "high";
    s.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, small.width, small.height);
    g.imageSmoothingQuality = "high";
    g.globalAlpha = 0.82;
    g.drawImage(small, 0, 0, W, H);
    g.globalAlpha = 1;
  }
  const down = g.createLinearGradient(0, 0, 0, H);
  down.addColorStop(0, "rgba(10, 10, 14, 0.1)");
  down.addColorStop(0.5, "rgba(10, 10, 14, 0.22)");
  down.addColorStop(1, "rgba(10, 10, 14, 0.8)");
  g.fillStyle = down;
  g.fillRect(0, 0, W, H);
  const edge = g.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.45, W * 0.72);
  edge.addColorStop(0, "rgba(0, 0, 0, 0)");
  edge.addColorStop(1, "rgba(0, 0, 0, 0.38)");
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);
  return c;
}

function floorTexture(): THREE.Texture {
  const W = 256, H = 128;
  if (typeof document === "undefined") return new THREE.Texture();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.translate(W / 2, H / 2);
  g.scale(1, H / W);
  const pool = g.createRadialGradient(0, 0, 0, 0, 0, W / 2);
  pool.addColorStop(0, "rgba(6, 6, 9, 0.85)");
  pool.addColorStop(0.45, "rgba(6, 6, 9, 0.55)");
  pool.addColorStop(1, "rgba(6, 6, 9, 0)");
  g.fillStyle = pool;
  g.beginPath();
  g.arc(0, 0, W / 2, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
