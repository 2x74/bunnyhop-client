// How the Daily Challenge podium (ui/daily-podium.ts) gets onto a canvas.
//
//   shared  The page has the game's renderer (shared-gl.ts: every page of the game itself, the menus included). The
//           scene is drawn into a render target of its own between the game's frames (state saved and put back, as
//           notify/item3d.ts does), read back without stalling the GPU and put on a 2D canvas. No WebGL context is made.
//   own     A page with no game renderer (a lab page, a test): a small renderer of its own on the canvas.
//
// Both draw the same scene with the same camera; `snapshot` draws one frame at any size (the Discord image).

import * as THREE from "three";
import { softwareContext } from "../gfx-auto";
import { sharedRenderer } from "../shared-gl";

export interface Painter {
  readonly kind: "shared" | "own";
  readonly canvas: HTMLCanvasElement;
  /** The canvas's size in device pixels. */
  size(w: number, h: number): void;
  /** Compiles what `root` needs to be drawn in `scene`, in the background where the browser can. Never rejects. */
  warm(root: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera): Promise<void>;
  /** One frame. False: skipped (the last ones are still on their way back) or impossible (the renderer went away). */
  draw(scene: THREE.Scene, camera: THREE.Camera): boolean;
  /** One frame at w x h device pixels on a canvas of its own (synchronous: for a picture, not for every frame). */
  snapshot(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null;
  /** Draw calls and triangles of the last frame drawn. */
  readonly cost: { calls: number; triangles: number };
  /** False once it can't draw any more (the game's renderer is gone or its context is lost). */
  alive(): boolean;
  dispose(): void;
}

const CLEAR = 0x101116;
const withTimeout = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]).then(() => {}, () => {});

class SharedPainter implements Painter {
  readonly kind = "shared" as const;
  readonly canvas = document.createElement("canvas");
  readonly cost = { calls: 0, triangles: 0 };
  private ctx = this.canvas.getContext("2d")!;
  private rt: THREE.WebGLRenderTarget | null = null;
  private img: ImageData | null = null;
  private bufs: Uint8Array[] = [];
  private reads = 0;
  private seq = 0;
  private drawn = -1;
  private gone = false;
  private clear = new THREE.Color();

  constructor(private r: THREE.WebGLRenderer) {}

  alive(): boolean {
    return !this.gone && sharedRenderer() === this.r;
  }

  size(w: number, h: number): void {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.dispose();
    this.rt = target(w, h);
    this.canvas.width = w;
    this.canvas.height = h;
    this.img = null;
    this.bufs = [];
    // Frames on their way back are for the old size.
    this.drawn = this.seq;
  }

  /** Runs `fn` with the game's renderer pointed at `rt`, then puts back everything it changed. */
  private borrow<T>(rt: THREE.WebGLRenderTarget, fn: (r: THREE.WebGLRenderer) => T): T {
    const r = this.r;
    const prevTarget = r.getRenderTarget(), prevClear = r.getClearColor(this.clear), prevAlpha = r.getClearAlpha(), prevAuto = r.autoClear, prevReset = r.info.autoReset;
    r.info.autoReset = false;
    r.autoClear = true;
    r.setClearColor(CLEAR, 1);
    r.setRenderTarget(rt);
    try {
      return fn(r);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAuto;
      r.info.autoReset = prevReset;
    }
  }

  warm(root: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    if (!this.alive()) return Promise.resolve();
    const rt = this.rt ?? target(8, 8);
    let p: Promise<unknown>;
    try {
      p = this.borrow(rt, (r) => r.compileAsync(root, camera, scene));
    } catch {
      p = Promise.resolve();
    }
    if (rt !== this.rt) void p.then(() => rt.dispose(), () => rt.dispose());
    return withTimeout(p, 4000);
  }

  private render(rt: THREE.WebGLRenderTarget, scene: THREE.Scene, camera: THREE.Camera): void {
    this.borrow(rt, (r) => {
      const calls = r.info.render.calls, tris = r.info.render.triangles;
      r.render(scene, camera);
      this.cost.calls = r.info.render.calls - calls;
      this.cost.triangles = r.info.render.triangles - tris;
    });
  }

  draw(scene: THREE.Scene, camera: THREE.Camera): boolean {
    const rt = this.rt;
    if (!rt || !this.alive()) return false;
    // At most two frames on their way back: beyond that skip one rather than queue up.
    if (this.reads >= 2) return false;
    this.render(rt, scene, camera);
    const w = rt.width, h = rt.height, seq = ++this.seq, slot = seq % 3;
    if (this.bufs[slot]?.length !== w * h * 4) this.bufs[slot] = new Uint8Array(w * h * 4);
    const buf = this.bufs[slot];
    this.reads++;
    this.r.readRenderTargetPixelsAsync(rt, 0, 0, w, h, buf).then(
      () => {
        this.reads--;
        if (this.gone || seq <= this.drawn || this.rt !== rt) return;
        this.drawn = seq;
        if (!this.img || this.img.width !== w || this.img.height !== h) this.img = this.ctx.createImageData(w, h);
        flip(buf, this.img.data, w, h);
        this.ctx.putImageData(this.img, 0, 0);
      },
      () => {
        this.reads--;
      },
    );
    return true;
  }

  snapshot(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null {
    if (!this.alive()) return null;
    const rt = target(w, h);
    try {
      this.render(rt, scene, camera);
      const buf = new Uint8Array(w * h * 4);
      this.r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!, img = g.createImageData(w, h);
      flip(buf, img.data, w, h);
      g.putImageData(img, 0, 0);
      return c;
    } catch {
      return null;
    } finally {
      rt.dispose();
    }
  }

  dispose(): void {
    this.gone = true;
    this.rt?.dispose();
    this.rt = null;
    this.bufs = [];
    this.img = null;
    this.canvas.width = this.canvas.height = 0;
  }
}

/** A multisampled sRGB render target of this size (what the read-back bytes are in). */
function target(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
}

/** Read-back rows are bottom-up; the picture is opaque by design (the backdrop covers the frame), so alpha is set full. */
function flip(src: Uint8Array, out: Uint8ClampedArray, w: number, h: number): void {
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  const px = new Uint32Array(out.buffer, out.byteOffset, w * h);
  // (Little-endian everywhere WebGL runs: alpha is the high byte.)
  for (let i = 0; i < px.length; i++) px[i] |= 0xff000000;
}

class OwnPainter implements Painter {
  readonly kind = "own" as const;
  readonly canvas = document.createElement("canvas");
  readonly cost = { calls: 0, triangles: 0 };
  private r: THREE.WebGLRenderer;
  private w = 2;
  private h = 2;

  constructor() {
    this.r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: "low-power" });
    if (softwareContext(this.r.getContext())) {
      this.dispose();
      throw new Error("software WebGL");
    }
    this.r.setPixelRatio(1);
    this.r.setClearColor(CLEAR, 1);
  }

  alive(): boolean {
    try {
      return !this.r.getContext().isContextLost();
    } catch {
      return false;
    }
  }

  size(w: number, h: number): void {
    this.w = Math.max(2, Math.round(w));
    this.h = Math.max(2, Math.round(h));
    this.r.setSize(this.w, this.h, false);
  }

  warm(root: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    let p: Promise<unknown>;
    try {
      p = this.r.compileAsync(root, camera, scene);
    } catch {
      p = Promise.resolve();
    }
    return withTimeout(p, 4000);
  }

  draw(scene: THREE.Scene, camera: THREE.Camera): boolean {
    if (!this.alive()) return false;
    this.r.render(scene, camera);
    this.cost.calls = this.r.info.render.calls;
    this.cost.triangles = this.r.info.render.triangles;
    return true;
  }

  snapshot(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null {
    if (!this.alive()) return null;
    const pw = this.w, ph = this.h;
    this.r.setSize(w, h, false);
    try {
      this.r.render(scene, camera);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(this.canvas, 0, 0);
      return c;
    } catch {
      return null;
    } finally {
      this.r.setSize(pw, ph, false);
    }
  }

  dispose(): void {
    try {
      this.r.dispose();
      this.r.forceContextLoss();
    } catch {
      /* already gone */
    }
  }
}

/** WebGL renderers made here and not yet disposed (the page's measurements: 0 on the game's own pages). */
export const paintStats = { ownContexts: 0 };

/**
 * A painter for this page, or null when the podium can't be drawn in 3D here (no WebGL, or it runs in software, where
 * three bunnies' shaders alone would hold the page for seconds): the caller keeps the plain map picture.
 */
export function makePainter(): Painter | null {
  const game = sharedRenderer();
  if (game) return softwareContext(game.getContext()) ? null : new SharedPainter(game);
  try {
    const p = new OwnPainter();
    paintStats.ownContexts++;
    const dispose = p.dispose.bind(p);
    let done = false;
    p.dispose = () => {
      if (done) return;
      done = true;
      paintStats.ownContexts--;
      dispose();
    };
    return p;
  } catch {
    return null;
  }
}
