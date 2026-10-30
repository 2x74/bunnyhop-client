// The Loadout screen's hero (ui/loadout-view.ts): one WebGL canvas that shows what you wear (or the item you're
// hovering) live, and renders the item thumbnails for the grid. The Loadout's only WebGL context.
//
//   First person  The real Viewmodel (your hands, the knife, its finish, your gloves, your viewmodel FOV / offsets /
//                 hand), framed on the fist and the WHOLE blade: the idle pose's hand + knife are projected once per
//                 knife (on a second, always-idle Viewmodel, so a draw or an inspect never skews it) and the camera's
//                 view offset crops the virtual 16:9 screen to them, eased when the knife changes, eased out a little
//                 while an inspect plays. A slow look-around keeps it alive (the hands lag behind it like in game);
//                 dragging looks around too. Inspect plays the knife's real trick chain (tap, re-press, hold).
//   Close-up      The knife alone (viewmodel/knives/showcase.ts) on a turntable: turns slowly, drag to spin it (with
//                 a little inertia), so the finish catches the light.
//   Bunny         Your bunny (ui/bunny-preview.ts) in its colourway and hat, holding your knife: turns slowly, drag
//                 to turn it.
//   Ghost         Your PB ghost hopping a small circle with its trail.
//
// Thumbnails: requestThumb() queues a render (a knife in a finish, your fist in a pair of gloves, or for colourways,
// ghosts, trails and hats the same little model the unlock card shows: notify/item3d-scenes.ts); a few are drawn
// per frame into a corner of this same canvas and copied out to a small 2D canvas before the frame is drawn, so they
// share the hero's context and its compiled shaders (one context, no second GPU warm-up). They're cached per page by
// what they show. No WebGL at all: the constructor throws and the view keeps its CSS swatches.
//
// Renders only while on screen and the tab is visible. Once its canvas leaves the DOM it's parked, not disposed: the next
// Loadout (or Support's preview) opened within PARK_MS takes it over (LoadoutStage.acquire) with its GL context, compiled
// shaders and built models, so opening the Loadout again costs a frame, not a context and every shader. Parked longer, it
// disposes itself (and the GL context). Bunny geometry (the bunny views, item thumbnails) is built in the prebuild worker
// (player/bunny/prebuild.ts) and item models' shaders compile in parallel before their thumbnail is drawn, so neither
// blocks a frame. Reduced motion: no sway, no turntable spin (dragging still turns it).

import * as THREE from "three";
import { Viewmodel, type ViewmodelInput } from "../viewmodel/viewmodel";
import { KnifeShowcase, prewarmShowcase } from "../viewmodel/knives/showcase";
import { KNIVES, knifeById, type KnifeDef } from "../viewmodel/knives/index";
import { carrot } from "../viewmodel/knives/carrot";
import { FINISH_CODE, specOf } from "../viewmodel/finishes/shader";
import { ensureViewmodelLayout } from "../viewmodel/finishes/layout";
import { viewmodelGeometry } from "../viewmodel/mesh";
import { vmRig } from "../viewmodel/rig";
import { getLoadout, getOutfit, onOutfit } from "../player/cosmetics";
import { GLOVE_STYLE_IDS, gloveStyle, type CosmeticLoadout, type GloveStyleId } from "../loadout";
import { prefs } from "./settings";
import { BunnyScene, type BunnyLook } from "./bunny-preview";
import { HERO, type PreviewSpec } from "../notify/item-preview";
import type { ItemScene } from "../notify/item3d-scenes";
import { compileModel, prebuildBunny, prebuildViewmodels } from "../player/bunny/prebuild";
import { bunnyParts } from "../player/bunny/prebuild-parts";
import { hasBunnyGeometry } from "../player/bunny/mesh";
import { hasHatGeometry } from "../player/bunny/hats";
import { loadoutFor } from "../loadout";
import { menuIdleAllowed, onMenuMapStart } from "./menu-work";
import { loadThumb, saveThumb } from "./thumb-store";
import { playerLookTier } from "../player/look-tier";

/** First person and close-up (hands), your bunny, your ghost. */
export type StageView = "fp" | "close" | "bunny" | "ghost";
/** What the bunny views dress the bunny in (the knife, gloves and hat come from the loadout). */
export type StageLook = Pick<BunnyLook, "outfit" | "ghost" | "trail" | "veil" | "playerGlow" | "previewGlow">;

/** Thumbnail size in device pixels (16:10). */
export const THUMB_W = 384;
export const THUMB_H = 240;

export type ThumbJob =
  | { key: string; kind: "knife"; knife: string; loadout: CosmeticLoadout }
  | { key: string; kind: "glove"; loadout: CosmeticLoadout }
  /** A colourway, ghost colour, trail or hat: the unlock card's model (built on demand, then dropped). */
  | { key: string; kind: "item"; spec: PreviewSpec; scene?: ItemScene | null };

const NO_ATTACK = { primary: false, secondary: false };
const still = (yaw: number, pitch: number): ViewmodelInput => ({ velocity: [0, 0, 0], grounded: true, viewOffsetZ: 64, sidemove: 0, yaw, pitch, landed: 0 });
const knifeOf = (id: string | null | undefined): KnifeDef => knifeById(id) ?? carrot;
const vmKnife = (k: KnifeDef): KnifeDef | null => (k.id === "carrot" ? null : k);
const FINISH_CODES = [...new Set(Object.values(FINISH_CODE))];
/** Seconds of the idle sequence the hero loops (see drawFirstPerson). */
const IDLE_LOOP = 4.6;

/** Thumbnails, per page: they only depend on what they show. */
const thumbCache = new Map<string, HTMLCanvasElement>();
const MAX_THUMBS = 240;
/**
 * Thumbnails are also kept across page loads (thumb-store.ts), as long as this chunk is the same build: its hashed URL
 * changes whenever this file or any model code it imports changes. Not in dev (one URL for every edit).
 */
const THUMB_STORE = import.meta.env.DEV ? null : new URL(import.meta.url).pathname;
/** A stored thumbnail's key: the job's, plus what else the drawing depends on (the player-material look; for gloves,
 * the viewmodel settings that place the hand). */
function storedKey(job: ThumbJob): string {
  const vm = job.kind === "glove" ? `|${JSON.stringify(prefs.get().viewmodel)}` : "";
  return `${job.key}|t${playerLookTier()}${vm}`;
}

/** How long a stage whose view closed waits to be taken over before it frees its GL context. */
const PARK_MS = 60_000;
/** Stages alive (attached or parked): acquire() takes one whose canvas left the page. */
const stages = new Set<LoadoutStage>();
function disposeStages(): void {
  for (const s of stages) s.dispose();
  // The loading animation can still have the old view attached when disposal runs.
  for (const c of thumbCache.values()) c.remove();
}
onMenuMapStart(disposeStages);

// Back in game (pointer locked): release previews even if a hidden menu still has its canvas attached.
if (typeof document !== "undefined")
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) disposeStages();
  });

/** The bunny geometry (and headwear) for this look is built: the model can be made without blocking a frame. */
function bunnyReady(outfit: string | null | undefined, l: CosmeticLoadout): boolean {
  try {
    const p = bunnyParts(outfit, l);
    return hasBunnyGeometry(p.key) && (!p.hat || hasHatGeometry(p.hat));
  } catch {
    return true;
  }
}

type Rect = [number, number, number, number];

/**
 * Sample vertices per geometry: the blade (finishUV PART.blade), the rest of the knife (guard, grip, pommel: parts 2-3)
 * and the right glove (vertices that follow the right hand or its fingers).
 */
interface Samples {
  blade: number[];
  knife: number[];
  hand: number[];
}
const samples = new WeakMap<THREE.BufferGeometry, Samples>();
function sampleOf(g: THREE.BufferGeometry): Samples {
  let s = samples.get(g);
  if (s) return s;
  ensureViewmodelLayout(g);
  const r = vmRig();
  const right = new Set(r.names.map((n, i) => (/Right_(Hand|Index|Middle|Ring|Pinky|Thumb)|R_wrist/.test(n) ? i : -1)).filter((i) => i >= 0));
  const F = g.getAttribute("finishUV");
  const SI = g.getAttribute("skinIndex");
  s = { blade: [], knife: [], hand: [] };
  for (let i = 0; i < F.count; i += 2) {
    const part = F.getZ(i);
    if (part > 0.5 && part < 1.5) s.blade.push(i);
    else if (part > 1.5 && part < 3.5) s.knife.push(i);
    else if (right.has(SI.getX(i))) s.hand.push(i);
  }
  samples.set(g, s);
  return s;
}

const union = (a: Rect | null, b: Rect | null): Rect | null => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
/** What's on the real screen of a rect (the arm and the grip run off its bottom / right edge in game). */
const onScreen = (r: Rect | null): Rect | null => (r ? [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(1, r[2]), Math.min(1, r[3])] : null);
/** How far below the real screen's bottom edge the preview may look to show the whole fist (fraction of its height). */
const FIST_MARGIN = 0.18;
/** `clipped` (on screen) with its bottom let back down to where `full` ends, up to FIST_MARGIN past the edge. */
const belowEdge = (clipped: Rect | null, full: Rect | null): Rect | null =>
  clipped && full ? [clipped[0], clipped[1], clipped[2], Math.max(clipped[3], Math.min(1 + FIST_MARGIN, full[3]))] : clipped;

export class LoadoutStage {
  readonly canvas: HTMLCanvasElement;
  /** Called when the view changes (the toggle follows it). */
  onView: ((v: StageView) => void) | null = null;
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.PerspectiveCamera(74, 16 / 9, 1, 1000);
  private vm: Viewmodel;
  /** Always idle: framing bounds and glove thumbnails. */
  private probe: Viewmodel;
  private show = new KnifeShowcase();
  private thumbShow = new KnifeShowcase();
  private closeScene = new THREE.Scene();
  private thumbScene = new THREE.Scene();
  private closeCam = new THREE.PerspectiveCamera(24, 1, 0.5, 400);
  private thumbCam = new THREE.PerspectiveCamera(18, THUMB_W / THUMB_H, 0.5, 600);
  private itemCam = new THREE.PerspectiveCamera(24, THUMB_W / THUMB_H, 0.05, 4000);
  private shown: CosmeticLoadout;
  private look: StageLook = { outfit: null, ghost: null, trail: null, veil: false };
  private bunny: BunnyScene | null = null;
  /** Item thumbnails being built (a couple at a time). */
  private building = 0;
  private viewMode: StageView = "fp";
  private raf = 0;
  private last = 0;
  private t = 0;
  private visible = true;
  private disposed = false;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private host: HTMLElement | null = null;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private offOutfit: () => void;
  private parkTimer = 0;
  private warmed = false;
  /** The latest display() whose bunny was waiting for the worker (an older one finishing late is dropped). */
  private bunnyWant = 0;
  private offHost: (() => void) | null = null;
  private w = 1;
  private h = 1;
  // First-person framing (fractions of the virtual 16:9 screen).
  private rect: Rect | null = null;
  private boundsCache = new Map<string, Rect>();
  // Look-around (first person) and turntable (close-up) state.
  private lookYaw = 0;
  private lookPitch = 0;
  private spin = 0.35;
  private spinV = 0;
  private tilt = 0.08;
  private tiltV = 0;
  private dragging: { x: number; y: number; id: number } | null = null;
  private idleSpin = 0;
  private inspectHeld = false;
  // Thumbnails.
  private jobs: ThumbJob[] = [];
  /** The last item model drawn per kind (see runJob). */
  private lastItem = new Map<string, ItemScene>();
  private waiting = new Map<string, ((c: HTMLCanvasElement) => void)[]>();
  /** Thumbnails being looked up in the store (thumb-store.ts). */
  private looking = new Set<string>();

  /**
   * The Loadout's stage in `host`: a parked one (its canvas left the page: a closed Loadout, the screen being replaced)
   * taken over, else a new one. Throws without WebGL.
   */
  static acquire(host: HTMLElement, initial: CosmeticLoadout): LoadoutStage {
    for (const s of stages) {
      if (s.disposed) continue;
      if (s.renderer.getContext().isContextLost()) {
        if (!s.canvas.isConnected) s.dispose();
        continue;
      }
      if (s.canvas.isConnected) continue;
      s.attach(host, initial);
      return s;
    }
    return new LoadoutStage(host, initial);
  }

  constructor(host: HTMLElement, initial: CosmeticLoadout) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "lo-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.shown = initial;
    this.vm = new Viewmodel();
    this.vm.setVisible(true);
    this.probe = new Viewmodel();
    this.probe.glowOverride = null; // tile thumbnails: the item, never a glow
    this.probe.seek("idle", 0);
    this.closeScene.add(this.show.root);
    this.thumbScene.add(this.thumbShow.root);
    const outfit = getOutfit();
    this.show.setColours(outfit);
    this.thumbShow.setColours(outfit);
    this.offOutfit = onOutfit((id) => {
      this.show.setColours(id);
      this.thumbShow.setColours(id);
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.io = new IntersectionObserver((e) => {
      if (!this.canvas.isConnected) return this.park();
      this.visible = e.some((x) => x.isIntersecting);
      this.kick();
    });
    stages.add(this);
    this.attach(host, initial);
  }

  /** Into a (new) view's host: the canvas, its observers and drag; what it shows comes from the view (display / setView). */
  private attach(host: HTMLElement, initial: CosmeticLoadout): void {
    clearTimeout(this.parkTimer);
    this.detach();
    this.host = host;
    host.prepend(this.canvas);
    host.dataset.view = this.viewMode;
    this.visible = true;
    this.lookYaw = this.lookPitch = 0;
    this.dragging = null;
    if (this.bunny) this.bunny.dragging = false;
    this.inspectHeld = false;
    this.display(initial);
    this.ro.observe(host);
    this.io.observe(this.canvas);
    document.addEventListener("visibilitychange", this.onVis);
    this.offHost = this.bindDrag(host);
    this.resize();
    if (!this.warmed) (this.warmed = true), this.warm();
    this.kick();
  }

  /**
   * The view closed (its canvas left the page): stop drawing, drop its thumbnail requests and listeners, and wait
   * PARK_MS for another view to take the stage over before disposing it.
   */
  private park(): void {
    if (this.disposed || this.canvas.isConnected) return;
    this.detach();
    // One parked stage is plenty (a second one goes now), and none while the game has the mouse.
    if (!menuIdleAllowed() || this.renderer.getContext().isContextLost()) return this.dispose();
    for (const s of stages) if (s !== this && !s.disposed && !s.canvas.isConnected) return this.dispose();
    clearTimeout(this.parkTimer);
    this.parkTimer = window.setTimeout(() => !this.canvas.isConnected && this.dispose(), PARK_MS);
  }

  /** Off the current view: no drawing, observers, listeners or pending thumbnails. */
  private detach(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener("visibilitychange", this.onVis);
    this.offHost?.();
    this.offHost = null;
    this.host = null;
    this.onView = null;
    this.dropThumbs();
    this.bunnyWant++;
    // Cached thumbnails sit in the closed view's tiles (loadout-view.ts paintThumb moves them in): take them out, or
    // each would keep that whole view alive through its parent.
    for (const c of thumbCache.values()) if (!c.isConnected) c.remove();
  }

  get alive(): boolean {
    return !this.disposed;
  }

  get view(): StageView {
    return this.viewMode;
  }

  /**
   * What the hero shows (your equipped loadout, or with the hovered item swapped in; `look`: the colourway and ghost /
   * trail colours for the bunny views). Cheap to call often.
   */
  display(l: CosmeticLoadout, look?: StageLook): void {
    if (this.disposed) return;
    this.shown = l;
    if (look) this.look = { ...look };
    // The first-person views show the glow being edited too (ui/player-glow-controls.ts), as the bunny does.
    this.vm.glowOverride = this.look?.playerGlow;
    const k = knifeOf(l.knife);
    this.vm.setKnife(vmKnife(k));
    this.vm.setLoadout(l);
    this.show.setKnife(k);
    this.show.setFinish(specOf(l));
    this.showBunny();
    this.kick();
  }

  /**
   * The bunny takes the look shown. A look whose geometry isn't built yet (a colourway or hat hovered for the first
   * time) is built in the worker first; the bunny keeps the last look meanwhile (a frame or two), instead of the frame
   * freezing while it's built here.
   */
  private showBunny(): void {
    const b = this.bunny;
    if (!b) return;
    const want = ++this.bunnyWant;
    const look = this.bunnyLook();
    const outfit = look.mode === "ghost" ? null : look.outfit;
    if (bunnyReady(outfit, look.loadout)) return b.set(look);
    void prebuildBunny(outfit, look.loadout).then(() => {
      if (want !== this.bunnyWant || this.bunny !== b || this.disposed) return;
      b.set(this.bunnyLook());
      this.kick();
    });
  }

  private bunnyLook(): BunnyLook {
    return { mode: this.viewMode === "ghost" ? "ghost" : "solid", ...this.look, loadout: this.shown };
  }

  setView(v: StageView): void {
    if (v === this.viewMode || this.disposed) return;
    this.viewMode = v;
    if (this.host) this.host.dataset.view = v;
    if (v === "close") this.spinV = 2.2; // a little turn on the way in
    if (v === "bunny" || v === "ghost") {
      if (this.bunny) this.showBunny();
      else (this.bunny = new BunnyScene(this.bunnyLook())), this.bunny.setTint(...this.tintNow);
    }
    this.onView?.(v);
    this.kick();
  }

  /** Plays the knife's inspect (first person; from the close-up it switches back first; not in the bunny views). */
  inspect(): void {
    if (this.disposed || this.viewMode === "bunny" || this.viewMode === "ghost") return;
    if (this.viewMode !== "fp") this.setView("fp");
    this.vm.inspect();
    this.kick();
  }

  /** The inspect key is held (hold-to-loop tricks). */
  holdInspect(held: boolean): void {
    this.inspectHeld = held;
  }

  /** The bunny views' floor in the shown item's rarity colour (strength 0..1; quiet for common items). */
  tint(color: string | null, strength = 1): void {
    this.tintNow = [color, strength];
    this.bunny?.setTint(color, strength);
    this.kick();
  }
  private tintNow: [string | null, number] = [null, 1];

  /** A small confirm when something is equipped: a draw for a knife, an inspect for a finish, a spin up close. */
  flourish(kind: string): void {
    if (this.disposed || this.reduced) return;
    if (this.viewMode === "bunny" || this.viewMode === "ghost") {
      this.bunny?.flourish();
      this.kick();
      return;
    }
    if (this.viewMode === "close") {
      this.spinV += 7.5;
      this.kick();
      return;
    }
    if (kind === "knife") this.vm.draw();
    else if (kind === "finish") this.vm.inspect();
    this.kick();
  }

  // -------------------------------------------------------------------------------------------
  // Thumbnails

  /** A cached thumbnail, or null (then requestThumb). */
  static cached(key: string): HTMLCanvasElement | null {
    return thumbCache.get(key) ?? null;
  }

  requestThumb(job: ThumbJob, done: (c: HTMLCanvasElement) => void): void {
    const hit = thumbCache.get(job.key);
    if (hit) return done(hit);
    const list = this.waiting.get(job.key);
    if (list) return void list.push(done);
    this.waiting.set(job.key, [done]);
    if (!THUMB_STORE) return this.queueThumb(job);
    // Stored from an earlier visit: shown without drawing anything; else queued to draw.
    this.looking.add(job.key);
    void loadThumb(THUMB_STORE, storedKey(job)).then((c) => {
      this.looking.delete(job.key);
      if (this.disposed || !this.waiting.has(job.key)) return;
      if (!c) return this.queueThumb(job);
      this.deliver(job.key, c);
    });
  }

  private queueThumb(job: ThumbJob): void {
    this.jobs.push(job);
    this.kick();
  }

  /** A finished thumbnail: cached for the page and handed to the tiles waiting for it. */
  private deliver(key: string, c: HTMLCanvasElement): void {
    if (thumbCache.size >= MAX_THUMBS) thumbCache.delete(thumbCache.keys().next().value!);
    thumbCache.set(key, c);
    const cbs = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    for (const cb of cbs) cb(c);
  }

  /** Builds the next queued item models (two at a time, in idle time); their thumbnails draw once they're ready. */
  private buildItems(): void {
    for (const job of this.jobs) {
      if (this.building >= 2) return;
      if (job.kind !== "item" || job.scene !== undefined) continue;
      job.scene = null;
      this.building++;
      void Promise.all([import("../notify/item3d-scenes"), prebuildItem(job.spec)])
        .then(([m]) => (this.disposed || !this.jobs.includes(job) ? null : m.buildItemScene(job.spec)))
        // Its shaders compile in parallel (KHR_parallel_shader_compile) before the thumbnail draws it.
        .then((scene) => (!scene || this.disposed || !this.jobs.includes(job) ? scene : compileModel(this.renderer, scene.scene, this.itemCam, scene.scene, 1500).then(() => scene)))
        .then(
          (scene) => {
            if (!scene) return;
            if (this.disposed || !this.jobs.includes(job)) return scene.dispose();
            job.scene = scene;
          },
          () => (this.jobs = this.jobs.filter((j) => j !== job)),
        )
        .finally(() => {
          this.building--;
          this.buildItems();
          this.kick();
        });
    }
  }

  /** Drops queued thumbnails nobody shows any more (slot switched). */
  cancelThumbs(keep: (key: string) => boolean): void {
    for (const k of this.looking) if (!keep(k)) this.waiting.delete(k);
    this.jobs = this.jobs.filter((j) => keep(j.key) || (this.waiting.delete(j.key), j.kind === "item" && j.scene?.dispose(), false));
  }

  /** The next job that can draw now (item models only once built). */
  private nextJob(): ThumbJob | null {
    const i = this.jobs.findIndex((j) => j.kind !== "item" || !!j.scene);
    return i < 0 ? null : this.jobs.splice(i, 1)[0];
  }

  private runJob(job: ThumbJob): void {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const bw = this.canvas.width, bh = this.canvas.height;
    // Full size when the hero's canvas has room (it nearly always does), else as big as it allows.
    const k = Math.min(1, bw / THUMB_W, bh / THUMB_H);
    const tw = Math.floor(THUMB_W * k), th = Math.floor(THUMB_H * k);
    r.setScissorTest(true);
    r.setViewport(0, 0, tw / pr, th / pr);
    r.setScissor(0, 0, tw / pr, th / pr);
    r.clear();
    if (job.kind === "knife") this.drawKnifeThumb(job.knife, job.loadout);
    else if (job.kind === "glove") this.drawGloveThumb(job.loadout, tw, th);
    else if (job.scene) {
      this.drawItemThumb(job.scene, job.spec);
      // Disposed once the next model of its kind has drawn: disposing it now would release its shader programs, and
      // the next colourway / hat would compile the same ones again.
      const prev = this.lastItem.get(job.spec.kind);
      this.lastItem.set(job.spec.kind, job.scene);
      prev?.dispose();
    }
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    // A software canvas, like the tiles it's painted into (loadout-view.ts paintThumb): the copy out of WebGL is the one
    // readback, and painting it into a tile again (a category opened twice, the Loadout reopened) is a CPU blit instead
    // of another GPU readback per tile.
    out.getContext("2d", { willReadFrequently: true })!.drawImage(this.canvas, 0, bh - th, tw, th, 0, 0, tw, th);
    r.setScissorTest(false);
    r.setViewport(0, 0, bw / pr, bh / pr);
    if (THUMB_STORE) saveThumb(THUMB_STORE, storedKey(job), out);
    this.deliver(job.key, out);
  }

  /** The knife alone, tip up and to the right, its face turned a little to the light. */
  private drawKnifeThumb(id: string, l: CosmeticLoadout): void {
    const s = this.thumbShow;
    s.setKnife(knifeOf(id));
    s.setFinish(specOf(l));
    const q = knifeBasis().premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.38, 0.56, "YXZ")));
    s.root.quaternion.copy(q);
    // Fit the knife as turned to the 16:10 frame (a narrow lens: close to an orthographic product shot).
    const e = s.extentAt(q);
    const cam = this.thumbCam;
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const d = Math.max(e.y / tv, e.x / (tv * cam.aspect)) * 1.1 + e.z;
    cam.position.set(0, 0, d);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    this.renderer.render(this.thumbScene, cam);
  }

  /** A colourway / ghost / trail / hat as the unlock card shows it, at its hero angle. */
  private drawItemThumb(s: ItemScene, spec: PreviewSpec): void {
    const h = HERO[spec.kind];
    s.pivot.quaternion.setFromEuler(new THREE.Euler(h.tilt, h.yaw, 0, "XYZ"));
    s.pivot.scale.setScalar(1);
    s.pivot.position.set(0, 0, 0);
    const cam = this.itemCam;
    const fov = THREE.MathUtils.degToRad(cam.fov / 2);
    // A tile is wider than the card's square: the standing bunny can come closer.
    const fill = spec.kind === "bunny" || spec.kind === "ghost" ? 1.3 : spec.kind === "trail" ? 1.7 : h.fill;
    cam.position.set(0, 0, (s.radius / Math.sin(fov)) * (0.98 / fill));
    cam.lookAt(0, 0, 0);
    cam.near = cam.position.z * 0.05;
    cam.far = cam.position.z * 3;
    cam.updateProjectionMatrix();
    s.frame?.(1 / 60, cam, 1);
    this.renderer.render(s.scene, cam);
  }

  /** Your right fist in the gloves (holding your knife), as it sits on screen, cropped close. */
  private drawGloveThumb(l: CosmeticLoadout, w: number, h: number): void {
    const p = this.probe;
    p.setKnife(vmKnife(knifeOf(l.knife)));
    p.setLoadout(l);
    p.update(0, still(0, 0), NO_ATTACK);
    const b = this.measure(p).hand;
    this.renderer.clear();
    if (!b) return;
    const rect = fit(pad(b, 0.18, 0.18), THUMB_W / THUMB_H, 0.2);
    this.crop(p, rect, w, h);
    p.render(this.renderer, this.world);
  }

  // -------------------------------------------------------------------------------------------
  // Framing

  /** Screen bounds (fractions of the virtual 16:9 screen) of a viewmodel's blade, the rest of its knife, its right hand. */
  private measure(vm: Viewmodel): { blade: Rect | null; knife: Rect | null; hand: Rect | null } {
    const r = this.renderer;
    const cam = vm.camera;
    cam.clearViewOffset();
    this.world.aspect = 16 / 9;
    this.world.updateProjectionMatrix();
    // One render (into a single scissored pixel) updates the viewmodel's matrices and camera for the projection.
    const scissor = r.getScissorTest();
    const sc = new THREE.Vector4(), vp = new THREE.Vector4();
    r.getScissor(sc);
    r.getViewport(vp);
    r.setScissorTest(true);
    r.setScissor(0, 0, 1, 1);
    vm.render(r, this.world);
    r.setScissor(sc);
    r.setScissorTest(scissor);
    r.setViewport(vp);
    const mesh = vm.mesh;
    const g = mesh.geometry;
    const s = sampleOf(g);
    const P = g.getAttribute("position"), SI = g.getAttribute("skinIndex");
    const bm = mesh.skeleton.boneMatrices!;
    const M = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const bounds = (idx: number[]): Rect | null => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of idx) {
        M.fromArray(bm, SI.getX(i) * 16);
        v.fromBufferAttribute(P, i).applyMatrix4(M).applyMatrix4(mesh.matrixWorld).project(cam);
        if (v.z > 1) continue;
        const fx = (v.x + 1) / 2, fy = (1 - v.y) / 2;
        x0 = Math.min(x0, fx), x1 = Math.max(x1, fx), y0 = Math.min(y0, fy), y1 = Math.max(y1, fy);
      }
      return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
    };
    return { blade: bounds(s.blade), knife: bounds(s.knife), hand: bounds(s.hand) };
  }

  /** Points the viewmodel camera at `rect` (fractions of the virtual 16:9 screen) for a w x h viewport. */
  private crop(vm: Viewmodel, rect: Rect, w: number, h: number): void {
    const fw = w / (rect[2] - rect[0]);
    const fh = h / (rect[3] - rect[1]);
    vm.camera.setViewOffset(fw, fh, rect[0] * fw, rect[1] * fh, w, h);
  }

  /** The idle framing for the knife the hero shows (cached per knife and viewmodel settings). */
  private targetRect(): Rect {
    const v = prefs.get().viewmodel;
    const k = knifeOf(this.shown.knife);
    const key = `${k.id}|${v.hand}|${v.fov}|${v.x}|${v.y}|${v.z}|${this.probe.animSource}|${this.w}x${this.h}`;
    let rect = this.boundsCache.get(key);
    if (!rect) {
      this.probe.setKnife(vmKnife(k));
      this.probe.setLoadout(this.shown);
      this.probe.update(0, still(0, 0), NO_ATTACK);
      const m = this.measure(this.probe);
      // The whole blade, wherever it goes; the fist and grip as far as the screen shows them in game, plus up to
      // FIST_MARGIN below its bottom edge, so a low framing (v0.0.6's default) still shows the whole fist.
      const grip = belowEdge(onScreen(union(m.knife, m.hand)), union(m.knife, m.hand));
      const b = union(m.blade, grip) ?? [0.4, 0.3, 1, 1];
      // Room around the fist and blade, the knife in the middle (the nameplate is small, top left).
      rect = fit(pad(b, 0.16, 0.2), this.w / this.h, 0.62, [0.5, 0.54]);
      // Never look past the bottom / right edge of the real screen (the arm, the other hand and the grip run off it
      // there in game), unless the blade itself goes past it, or the fist does (by at most FIST_MARGIN).
      const maxY = Math.max(1, (m.blade?.[3] ?? 0) + 0.04, (grip?.[3] ?? 0) + (grip && grip[3] > 1 ? 0.02 : 0)), maxX = Math.max(1, (m.blade?.[2] ?? 0) + 0.04);
      // (But only so far: the knife's centre stays in the upper two thirds / left 70% of the view.)
      const H = rect[3] - rect[1], W = rect[2] - rect[0];
      const dy = Math.min(rect[3] - maxY, Math.max(0, (0.66 - ((b[1] + b[3]) / 2 - rect[1]) / H) * H));
      const dx = Math.min(rect[2] - maxX, Math.max(0, (0.7 - ((b[0] + b[2]) / 2 - rect[0]) / W) * W));
      if (dy > 0) (rect[1] -= dy), (rect[3] -= dy);
      if (dx > 0) (rect[0] -= dx), (rect[2] -= dx);
      this.boundsCache.set(key, rect);
    }
    if (this.vm.inspects.active) rect = scaleRect(rect, 1.22);
    return rect;
  }

  // -------------------------------------------------------------------------------------------
  // Frame

  private resize(): void {
    if (!this.host || this.disposed) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    // Device pixels: up to 1.5x (it's antialiased and redrawn every frame: past that an integrated GPU pays a lot for
    // little), and no more than ~2.5 megapixels on very large screens.
    const pr = Math.min(Math.max(1, devicePixelRatio), 1.5, Math.sqrt(2_500_000 / (w * h)));
    this.renderer.setPixelRatio(Math.max(1, pr));
    this.renderer.setSize(w, h, false);
    this.w = w;
    this.h = h;
    this.rect = null;
    this.frame(0);
  }

  private frame(dt: number): void {
    if (this.disposed || this.renderer.getContext().isContextLost()) return;
    this.t += dt;
    // A few thumbnails first (into a corner, copied out), then the hero over the whole canvas.
    if (this.jobs.length && this.canvas.width >= 160 && this.canvas.height >= 100) {
      this.buildItems();
      const t0 = performance.now();
      for (let job = this.nextJob(); job; job = performance.now() - t0 < 6 ? this.nextJob() : null) this.runJob(job);
    }
    if (this.viewMode === "fp") this.drawFirstPerson(dt);
    else if (this.viewMode === "close") this.drawCloseUp(dt);
    else this.drawBunny(dt);
  }

  private drawBunny(dt: number): void {
    const b = this.bunny;
    this.renderer.clear();
    if (!b) return;
    b.advance(dt);
    // A new bunny scene's programs compile in parallel before its first frame (as the hands', drawFirstPerson).
    if (this.bunnyReady !== b) {
      if (this.bunnyCompiling !== b) {
        this.bunnyCompiling = b;
        void b.compile(this.renderer).finally(() => {
          if (this.bunnyCompiling === b) this.bunnyReady = b;
          this.kick();
        });
      }
      return;
    }
    b.render(this.renderer, this.w, this.h);
  }
  private bunnyReady: BunnyScene | null = null;
  private bunnyCompiling: BunnyScene | null = null;

  private drawFirstPerson(dt: number): void {
    // Look-around: a slow wander (not with reduced motion) plus the drag, easing back when let go.
    const ease = 1 - Math.exp(-dt * 2.5);
    if (!this.dragging) {
      this.lookYaw -= this.lookYaw * ease;
      this.lookPitch -= this.lookPitch * ease;
    }
    const wander = this.reduced ? 0 : 1;
    const yaw = Math.sin(this.t * 0.5) * 6 * wander + this.lookYaw;
    const pitch = 2 + Math.sin(this.t * 0.33) * 3 * wander + this.lookPitch;
    this.vm.update(dt, still(yaw, pitch), { ...NO_ATTACK, inspect: this.inspectHeld });
    // v_knife_t's 12.5 s idle turns the fist over about halfway through (a fidget that hides most blades): the hero
    // loops its calm first seconds instead (they barely move, so the restart doesn't show).
    const vm = this.vm as unknown as { action: string; actionT: number };
    if (vm.action === "idle" && vm.actionT > IDLE_LOOP && !this.vm.inspects.active) {
      this.vm.seek("idle", 0.4);
      this.vm.timeScale = 1;
    }
    // (Measuring a new knife renders one scissored pixel: before the clear.)
    const target = this.targetRect();
    this.renderer.clear();
    if (!this.rect) this.rect = [...target];
    else {
      const k = 1 - Math.exp(-dt * 7);
      for (let i = 0; i < 4; i++) this.rect[i] += (target[i] - this.rect[i]) * k;
    }
    this.world.aspect = 16 / 9;
    this.world.updateProjectionMatrix();
    this.world.position.set(0, 0, 0);
    this.world.rotation.set(0, 0, 0);
    this.crop(this.vm, this.rect, this.w, this.h);
    // The first time in this context: its programs compile in parallel first (the 70 kB hands shader linked inside a
    // frame froze the page for 0.1-0.3 s on open, longer on Windows), the hero shows when they're ready.
    if (this.vmReady !== true) {
      if (this.vmReady === false) {
        this.vmReady = null;
        void compileModel(this.renderer, this.vm.scene, this.vm.camera, this.vm.scene, 3000).finally(() => {
          this.vmReady = true;
          this.kick();
        });
      }
      return;
    }
    this.vm.render(this.renderer, this.world);
  }
  /** The hero viewmodel's programs: not compiled in this context yet (false), compiling (null), ready (true). */
  private vmReady: boolean | null = false;

  private drawCloseUp(dt: number): void {
    // Turntable: inertia from drags and flourishes, a slow spin when left alone (not with reduced motion).
    if (!this.dragging) {
      const damp = Math.exp(-dt * 2.2);
      this.spinV *= damp;
      this.tiltV *= damp;
      this.idleSpin += ((this.reduced ? 0 : 0.42) - this.idleSpin) * (1 - Math.exp(-dt * 1.5));
      this.spin += (this.spinV + this.idleSpin) * dt;
      this.tilt += this.tiltV * dt;
      this.tilt += (0.08 - this.tilt) * (1 - Math.exp(-dt * 1.2));
    }
    this.tilt = Math.max(-0.7, Math.min(0.7, this.tilt));
    const bob = this.reduced ? 0 : Math.sin(this.t * 0.9) * 0.025;
    const q = knifeBasis().premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.tilt + bob, this.spin, 0.16, "XYZ")));
    this.show.root.quaternion.copy(q);
    const cam = this.closeCam;
    cam.aspect = this.w / this.h;
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    // Fit what the turntable can show: its length (and depth) across, its width (plus a little tilt) up and down.
    const hx = this.show.half;
    const across = Math.hypot(hx.z, hx.x) + hx.y * 0.16;
    const upDown = hx.y + Math.hypot(hx.z, hx.x) * 0.3;
    const d = Math.max(across / (tv * cam.aspect), upDown / tv) * 1.12;
    cam.position.set(0, 0, d);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    this.renderer.clear();
    this.renderer.render(this.closeScene, cam);
  }

  private kick(): void {
    if (this.raf || !this.visible || this.disposed) return;
    this.last = performance.now();
    const step = (now: number) => {
      this.raf = 0;
      if (!this.canvas.isConnected) return this.park();
      if (!this.visible || document.hidden) return;
      this.frame(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private onVis = () => {
    if (!document.hidden) this.kick();
  };

  /** Drag: look around in first person, turn the knife up close. */
  private bindDrag(c: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, input")) return;
      this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
      if (this.bunny) this.bunny.dragging = true;
      c.setPointerCapture(e.pointerId);
      c.classList.add("dragging");
      this.spinV = this.tiltV = 0;
      this.idleSpin = 0;
    };
    const move = (e: PointerEvent) => {
      const d = this.dragging;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (this.viewMode === "bunny") this.bunny?.drag(dx, this.w);
      else if (this.viewMode === "ghost") return;
      else if (this.viewMode === "close") {
        const k = 4.2 / Math.max(240, this.w);
        this.spin += dx * k;
        this.tilt += dy * k * 0.7;
        const dt = 1 / 60;
        this.spinV = (dx * k) / dt;
        this.tiltV = (dy * k * 0.7) / dt;
      } else {
        this.lookYaw = Math.max(-25, Math.min(25, this.lookYaw - dx * 0.12));
        this.lookPitch = Math.max(-14, Math.min(14, this.lookPitch + dy * 0.1));
      }
    };
    const end = (e: PointerEvent) => {
      if (this.dragging?.id !== e.pointerId) return;
      this.dragging = null;
      if (this.bunny) {
        this.bunny.dragging = false;
        this.bunny.release();
      }
      c.classList.remove("dragging");
      // Keep a fling, but not a wild one.
      this.spinV = Math.max(-9, Math.min(9, this.spinV));
      this.tiltV = Math.max(-3, Math.min(3, this.tiltV));
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", end);
      c.removeEventListener("pointercancel", end);
      c.classList.remove("dragging");
    };
  }

  /**
   * Gets hovering fast without hitches: every knife's first-person geometry and close-up mesh are built in idle time
   * (prewarmLoadout), and every finish's shader is compiled ahead, off the main thread where the browser can.
   */
  private warm(): void {
    prewarmLoadout(this.shown, () => {
      // Shaders: the close-up's finish variants (the viewmodel's share their programs).
      if (!this.disposed && this.canvas.isConnected && menuIdleAllowed()) void this.show.precompile(this.renderer, this.closeCam, FINISH_CODES).catch(() => {});
    });
  }

  /** Pending thumbnails: dropped (their tiles are gone with the view). */
  private dropThumbs(): void {
    for (const cbs of this.waiting.values()) cbs.length = 0;
    this.waiting.clear();
    for (const j of this.jobs) if (j.kind === "item") j.scene?.dispose();
    this.jobs = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bunnyWant++;
    stages.delete(this);
    clearTimeout(this.parkTimer);
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVis);
    this.offHost?.();
    this.offHost = null;
    this.host = null;
    this.onView = null;
    this.offOutfit();
    this.ro.disconnect();
    this.io.disconnect();
    for (const sc of this.lastItem.values()) sc.dispose();
    this.lastItem.clear();
    this.vm.dispose();
    this.probe.dispose();
    this.show.dispose();
    this.thumbShow.dispose();
    this.bunny?.dispose();
    this.dropThumbs();
    for (const c of thumbCache.values()) if (!c.isConnected) c.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

/** Knife-local -> world for a knife lying across the screen: tip to the right, flat face to the camera. */
function knifeBasis(): THREE.Quaternion {
  // Knife-local x (through the blade) -> +z (toward the camera), z (toward the tip) -> +x, y (across) -> z × x = -y.
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Grows bounds by fractions of their width / height. */
function pad(b: Rect, px: number, py: number): Rect {
  const w = b[2] - b[0], h = b[3] - b[1];
  return [b[0] - w * px, b[1] - h * py, b[2] + w * px, b[3] + h * py];
}

/**
 * Bounds (fractions of the 16:9 screen) -> a crop with the viewport's aspect that holds them with their centre at
 * `anchor` (fractions of the viewport; the hero keeps the bottom left for its caption), at least `minH` of the screen
 * tall (so a small knife isn't blown up past what the hands look like in game).
 */
function fit(b: Rect, aspect: number, minH: number, anchor: [number, number] = [0.5, 0.5]): Rect {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const [ax, ay] = anchor;
  // In screen units (16 x 9) so the aspect comparison is honest.
  let wu = Math.max((cx - b[0]) / ax, (b[2] - cx) / (1 - ax)) * 16;
  let hu = Math.max((cy - b[1]) / ay, (b[3] - cy) / (1 - ay), minH) * 9;
  if (wu / hu > aspect) hu = wu / aspect;
  else wu = hu * aspect;
  const fw = wu / 16, fh = hu / 9;
  return [cx - fw * ax, cy - fh * ay, cx - fw * ax + fw, cy - fh * ay + fh];
}

function scaleRect(r: Rect, s: number): Rect {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  const hw = ((r[2] - r[0]) / 2) * s, hh = ((r[3] - r[1]) / 2) * s;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

let warming: Promise<void> | null = null;
/**
 * The Loadout's models for this loadout (default: what you wear), built ahead a piece per idle callback, no GL needed:
 * your bunny in the prebuild worker; your knife in your gloves (the stage's first frame) and in every glove style (the
 * Gloves tab); every knife's close-up (the Knife tab's thumbnails) and first-person geometry in your gloves (hovering
 * knives). Called by the stage, and by the menu when the Loadout is a click away (a profile, Support), so even the
 * first open finds them built. Once per page; `done` runs when it's through.
 */
export function prewarmLoadout(l: CosmeticLoadout = getLoadout(), done?: () => void): Promise<void> {
  if (!menuIdleAllowed()) return Promise.resolve();
  warming ??= new Promise<void>((resolve) => {
    void prebuildBunny(getOutfit(), l);
    const ric = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 30));
    const mine = vmKnife(knifeOf(l.knife)) ?? undefined;
    const glove = gloveStyle(l.glove).style;
    // The first-person geometries below are built in the prebuild worker first (~10 ms each here, several times that
    // on a slow PC, about 30 of them): the steps then only sample them. Any not back yet are built here as before.
    const vmPairs: [KnifeDef, GloveStyleId][] = [[carrot, "knit"], [mine ?? carrot, glove], ...GLOVE_STYLE_IDS.map((style): [KnifeDef, GloveStyleId] => [mine ?? carrot, style]), ...KNIVES.map((k): [KnifeDef, GloveStyleId] => [k, glove])];
    const built = prebuildViewmodels(vmPairs);
    const steps: (() => void)[] = [
      () => sampleOf(viewmodelGeometry(mine, glove)),
      ...GLOVE_STYLE_IDS.map((style) => () => sampleOf(viewmodelGeometry(mine, style))),
      ...KNIVES.map((k) => () => prewarmShowcase(k)),
      ...KNIVES.map((k) => () => sampleOf(viewmodelGeometry(k, glove))),
    ];
    const next = () => {
      if (!menuIdleAllowed()) return resolve();
      const step = steps.shift();
      if (!step) return resolve();
      step();
      ric(next);
    };
    void built.then(() => ric(next));
  });
  if (done) void warming.then(done);
  return warming;
}

/** An item model's bunny / hat geometry, built in the prebuild worker (no-op for other kinds or when cached). */
function prebuildItem(spec: PreviewSpec): Promise<void> {
  if (spec.kind === "bunny") return prebuildBunny(spec.outfit, loadoutFor({ body: spec.body }));
  if (spec.kind === "ghost") return prebuildBunny(null, loadoutFor({}));
  if (spec.kind === "hat" && spec.hat) return prebuildBunny(null, loadoutFor({ hat: spec.hat }));
  return Promise.resolve();
}
