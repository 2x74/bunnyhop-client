// A little live 3D model of a reward for a celebration card (notify/index.ts CelebrationSpec.model): the item drops
// and grows in with the emblem's spring, whirls into a 3/4 hero angle, catches one glint, then turns slowly while the
// card is up. Reduced motion: one still frame at the hero angle.
//
// Rendering: no WebGL context of its own. The game's renderer (shared-gl.ts) draws the model into a small render
// target of its own between frames (state saved and restored around it, so the game's frame never sees it), the
// pixels come back with an async readback (a pixel-pack buffer and a fence: no GPU stall) and land in the card's 2D
// canvas. One requestAnimationFrame loop serves every model on screen and runs only while one is: it stops when the
// card leaves, and the browser stops it in a background tab. A device that can't keep ~40 fps with the model up gets
// the reveal and then a still model (no idle spin).
//
// No hitch: a model is built in an idle slot (never while a run is going: the card waits then anyway) and its shaders
// compile in the background (KHR_parallel_shader_compile, compileAsync) before the first frame; built models are
// cached by look (item-preview.ts keys), so the same reward again is instant. If the game has no renderer on this page,
// its context is lost, or the model isn't ready soon after the card shows, the card keeps its flat icon.

import * as THREE from "three";
import { sharedRenderer } from "../shared-gl";
import { getLoadout, getOutfit } from "../player/cosmetics";
import { HERO, previewOf, turntable, type PreviewItem, type PreviewSpec } from "./item-preview";
import { simulateSpring, SPRINGS } from "./spring";
import type { ItemScene } from "./item3d-scenes";

/** What a celebration card holds: the model's element, and the call that says the card is now on screen. */
export interface LiveEmblem {
  readonly el: HTMLElement;
  /** The card is on screen: start (or wait for) the reveal. */
  show(): void;
}

/** The emblem pops 60 ms into a card (notify/index.ts showCelebration): the model's reveal starts with it. */
const REVEAL_DELAY = 60;
/** The model must be ready this soon after the card shows, else the card keeps its flat icon. */
const READY_WITHIN = 900;
/** The glint: when (ms into the reveal, with the card's shine sound) and how long its sweep takes. */
const GLINT_AT = 320;
const GLINT_MS = 460;
/** The reveal (whirl, drop, glint) is over by then. */
const REVEAL_MS = 820;
/** Device pixels per CSS pixel, at most. */
const MAX_DPR = 2;
const CACHE = 8;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------------------------
// Prepared models, by look

type Scenes = typeof import("./item3d-scenes");
let scenesModule: Promise<Scenes> | null = null;
const prepared = new Map<string, { scene: Promise<ItemScene>; users: number }>();

const idle = () => new Promise<void>((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 300 }) : setTimeout(r, 16)));

function prepare(spec: PreviewSpec, r: THREE.WebGLRenderer): Promise<ItemScene> {
  let hit = prepared.get(spec.key);
  if (hit) {
    // (Most recently used last.)
    prepared.delete(spec.key);
    prepared.set(spec.key, hit);
    return hit.scene;
  }
  const scene = (async () => {
    const m = await (scenesModule ??= import("./item3d-scenes"));
    await idle();
    const s = await m.buildItemScene(spec);
    await compile(r, s);
    return s;
  })();
  hit = { scene, users: 0 };
  prepared.set(spec.key, hit);
  scene.catch(() => prepared.delete(spec.key));
  // Keep a few looks; drop the oldest that nothing shows.
  for (const [k, v] of prepared) {
    if (prepared.size <= CACHE) break;
    if (v.users > 0 || k === spec.key) continue;
    prepared.delete(k);
    v.scene.then((s) => s.dispose(), () => {});
  }
  return scene;
}

/** Compiles a model's programs for the render target (their variant differs from the screen's) in the background. */
async function compile(r: THREE.WebGLRenderer, s: ItemScene): Promise<void> {
  const rt = target(64);
  const prev = r.getRenderTarget();
  let p: Promise<unknown>;
  r.setRenderTarget(rt);
  try {
    p = r.compileAsync(s.scene, camera);
  } finally {
    r.setRenderTarget(prev);
  }
  await p;
}

// ---------------------------------------------------------------------------------------------
// Render targets and the camera

const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 4000);
const euler = new THREE.Euler();
const clearColor = new THREE.Color();
const targets = new Map<number, THREE.WebGLRenderTarget>();
let targetsIdle = 0;

/** The (square, multisampled, sRGB) render target for a size in device pixels. */
function target(px: number): THREE.WebGLRenderTarget {
  let t = targets.get(px);
  if (!t) {
    t = new THREE.WebGLRenderTarget(px, px, { samples: 4, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
    targets.set(px, t);
  }
  return t;
}

// sRGB <-> linear for un-premultiplying the edge pixels the readback returns.
const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const toSrgb = (x: number) => Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(Math.min(1, x), 1 / 2.4) - 0.055));

// The emblem's spring (bouncy), sampled once.
const POP = simulateSpring(SPRINGS.bouncy);
const pop = (ms: number) => {
  const i = ms / POP.dt;
  const k = Math.floor(i);
  if (k >= POP.samples.length - 1) return 1;
  return POP.samples[k] + (POP.samples[k + 1] - POP.samples[k]) * (i - k);
};

// ---------------------------------------------------------------------------------------------
// One loop for every model on screen

const live = new Set<Preview>();
let raf = 0;
/** Dev counters (evidence: frames drawn, CPU ms spent drawing them). */
const stats = { frames: 0, cpuMs: 0, reads: 0, dropped: 0, rested: 0 };
/** Dev (frame sheets): a fixed reveal time in ms instead of the clock. */
const dev = { at: null as number | null };

function kick(): void {
  if (raf || !live.size || document.hidden) return;
  raf = requestAnimationFrame(tick);
}

/**
 * The page's frame interval (ms, smoothed) while models show. A device that can't hold ~40 fps with the model up (a
 * weak or software GPU) gets the reveal, then a still model: no idle spin.
 */
let frameMs = 16.7;
let lastTick = 0;
const SLOW_MS = 24;

function tick(now: number): void {
  raf = 0;
  if (lastTick && now - lastTick < 250) frameMs += (now - lastTick - frameMs) * 0.1;
  lastTick = now;
  for (const p of live) if (!p.step(now)) live.delete(p);
  if (live.size) kick();
  else {
    lastTick = 0;
    // Nothing on screen for a while: give the render targets' memory back.
    clearTimeout(targetsIdle);
    targetsIdle = window.setTimeout(() => {
      if (live.size) return;
      for (const t of targets.values()) t.dispose();
      targets.clear();
    }, 30_000);
  }
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", kick);

class Preview implements LiveEmblem {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private scene: ItemScene | null = null;
  private failed = false;
  private prepping = false;
  private shownAt: number | null = null;
  private revealAt: number | null = null;
  private last = 0;
  private reads = 0;
  private seq = 0;
  private drawnSeq = -1;
  private released = false;
  /** Reduced motion or Potato (low-end PCs): one still frame instead of the turntable. */
  private still = reduced() || (typeof document !== "undefined" && document.body.classList.contains("potato"));
  private px = 0;
  private holding = false;
  /** Readback buffers, reused (at most two reads are in flight, the third is free to blit from). */
  private bufs: Uint8Array[] = [];

  constructor(
    private spec: PreviewSpec,
    private r: THREE.WebGLRenderer,
  ) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.el = document.createElement("span");
    this.el.className = "nt-model";
    this.setState("wait");
    this.el.setAttribute("aria-hidden", "true");
    this.el.append(this.canvas);
  }

  /**
   * data-state, and `.nt-model-off` on the card's emblem wrap (notify.css hides the flat emblem under a model that
   * isn't off; a class, not a :has() rule, which made every DOM change on the page restyle the whole document).
   */
  private setState(state: "wait" | "live" | "off"): void {
    this.el.dataset.state = state;
    this.el.parentElement?.classList.toggle("nt-model-off", state === "off");
  }

  /** Builds the model (idle time) unless that's under way. */
  prep(): void {
    if (this.prepping) return;
    this.prepping = true;
    const scene = prepare(this.spec, this.r);
    // (Counted from now, so a burst of other looks can't evict it while it builds.)
    const e = prepared.get(this.spec.key);
    if (e) e.users++;
    this.holding = !!e;
    // A card that never shows (merged into another, or long queued) stops pinning it after a while.
    window.setTimeout(() => this.shownAt === null && this.unpin(), 60_000);
    scene.then(
      (s) => {
        if (this.released) return;
        this.scene = s;
        this.maybeReveal(performance.now());
      },
      (e) => {
        console.warn("unlock model:", e);
        this.fail();
      },
    );
  }

  show(): void {
    if (this.shownAt !== null || this.failed) return;
    const now = performance.now();
    this.shownAt = now;
    const css = this.el.getBoundingClientRect().width || 112;
    this.px = Math.max(32, Math.min(320, Math.round(css * Math.min(MAX_DPR, devicePixelRatio || 1))));
    this.canvas.width = this.canvas.height = this.px;
    this.prep();
    this.maybeReveal(now);
    // Not ready in time: the flat icon stays (no late swap).
    window.setTimeout(() => this.revealAt === null && this.fail(), READY_WITHIN);
  }

  private maybeReveal(now: number): void {
    if (this.revealAt !== null || this.shownAt === null || !this.scene || this.failed) return;
    if (!sharedRenderer()) return this.fail();
    this.revealAt = Math.max(now, this.shownAt + REVEAL_DELAY);
    this.last = now;
    live.add(this);
    kick();
  }

  private fail(): void {
    if (this.failed || this.revealAt !== null) return;
    this.failed = true;
    this.setState("off");
  }

  /** One frame; false when this model is done (its card left, or its still frame is drawn). */
  step(now: number): boolean {
    if (!this.el.isConnected || !this.scene) {
      this.release();
      return false;
    }
    const r = sharedRenderer();
    if (!r) {
      this.setState("off");
      this.release();
      return false;
    }
    const t = this.still ? Infinity : (import.meta.env?.DEV && dev.at !== null ? dev.at : now - this.revealAt!);
    if (t < 0) return true;
    // Slow frames: the reveal plays, then the model rests where it landed.
    if (!this.still && t > REVEAL_MS && frameMs > SLOW_MS) {
      stats.rested++;
      this.release();
      return false;
    }
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    // At most two readbacks in flight (each ~1 frame): beyond that skip a frame rather than queue up.
    if (this.reads >= 2) {
      stats.dropped++;
      return true;
    }
    const t0 = performance.now();
    this.render(r, t, dt);
    stats.cpuMs += performance.now() - t0;
    stats.frames++;
    if (this.el.dataset.state !== "live") this.setState("live");
    return !this.still;
  }

  private render(r: THREE.WebGLRenderer, t: number, dt: number): void {
    const s = this.scene!;
    const pose = turntable(this.spec.kind, t, pop);
    s.pivot.quaternion.setFromEuler(euler.set(pose.tilt, pose.yaw, 0, "XYZ"));
    s.pivot.scale.setScalar(pose.scale);
    s.pivot.position.set(0, pose.lift * s.radius * 0.32, 0);
    const fov = THREE.MathUtils.degToRad(camera.fov / 2);
    camera.position.set(0, 0, (s.radius / Math.sin(fov)) * (1.04 / HERO[this.spec.kind].fill));
    camera.lookAt(0, 0, 0);
    camera.near = camera.position.z * 0.05;
    camera.far = camera.position.z * 3;
    camera.updateProjectionMatrix();
    s.frame?.(dt, camera, Number.isFinite(t) ? Math.min(1, t / 520) : 1);
    const rt = target(this.px);
    // Borrow the game's renderer: our target, a transparent clear; everything put back after.
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(clearColor);
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    const prevReset = r.info.autoReset;
    r.info.autoReset = false;
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(rt);
    try {
      r.render(s.scene, camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAuto;
      r.info.autoReset = prevReset;
    }
    const px = this.px;
    const seq = ++this.seq;
    const slot = seq % 3;
    if (this.bufs[slot]?.length !== px * px * 4) this.bufs[slot] = new Uint8Array(px * px * 4);
    const buf = this.bufs[slot];
    this.reads++;
    stats.reads++;
    r.readRenderTargetPixelsAsync(rt, 0, 0, px, px, buf).then(
      () => {
        this.reads--;
        if (!this.released && seq > this.drawnSeq) this.blit(buf, t, seq);
      },
      () => {
        this.reads--;
      },
    );
  }

  /** Readback (bottom-up rows, premultiplied in linear light) -> the card's canvas, plus the glint. */
  private blit(src: Uint8Array, t: number, seq: number): void {
    this.drawnSeq = seq;
    const px = this.px;
    if (!this.img || this.img.width !== px) this.img = this.ctx.createImageData(px, px);
    const out = this.img.data;
    const row = px * 4;
    for (let y = 0; y < px; y++) {
      const si = (px - 1 - y) * row;
      const di = y * row;
      for (let x = 0; x < row; x += 4) {
        const i = si + x, o = di + x;
        const a = src[i + 3];
        out[o + 3] = a;
        if (a === 255 || a === 0) {
          out[o] = src[i];
          out[o + 1] = src[i + 1];
          out[o + 2] = src[i + 2];
        } else {
          const k = 255 / a;
          out[o] = toSrgb(toLinear[src[i]] * k);
          out[o + 1] = toSrgb(toLinear[src[i + 1]] * k);
          out[o + 2] = toSrgb(toLinear[src[i + 2]] * k);
        }
      }
    }
    const c = this.ctx;
    c.putImageData(this.img, 0, 0);
    // A still frame is all reduced motion needs: the model is free for others.
    if (this.still) this.release();
    // The glint: one bright diagonal band across the model only (source-atop), as it lands.
    const g = (t - GLINT_AT) / GLINT_MS;
    if (g > 0 && g < 1) {
      const x = -0.3 * px + g * 1.6 * px;
      const band = c.createLinearGradient(x - px * 0.12, 0, x + px * 0.12, px * 0.3);
      band.addColorStop(0, "rgba(255, 255, 255, 0)");
      band.addColorStop(0.5, `rgba(255, 252, 240, ${0.62 * Math.sin(g * Math.PI)})`);
      band.addColorStop(1, "rgba(255, 255, 255, 0)");
      c.save();
      c.globalCompositeOperation = "source-atop";
      c.fillStyle = band;
      c.fillRect(0, 0, px, px);
      c.restore();
    }
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.unpin();
  }

  private unpin(): void {
    const e = prepared.get(this.spec.key);
    if (e && this.holding) e.users = Math.max(0, e.users - 1);
    this.holding = false;
  }
}

/**
 * The live model for a reward (a cosmetic or an achievement), or null when it can't have one (no game renderer on
 * this page, or nothing to show for it): the card then shows its flat icon as before. `runGoing`: the model is built
 * when the card shows instead of in the next idle slot.
 */
export function liveEmblem(item: PreviewItem, runGoing = false): LiveEmblem | null {
  const r = sharedRenderer();
  if (!r) return null;
  const l = getLoadout();
  const spec = previewOf(item, { knife: l.knife, finish: l.finish, outfit: getOutfit() });
  if (!spec) return null;
  const p = new Preview(spec, r);
  if (!runGoing) p.prep();
  return p;
}

if (import.meta.env?.DEV && typeof window !== "undefined") Object.assign(window, { __item3d: { stats, live, prepared, targets, dev } });
