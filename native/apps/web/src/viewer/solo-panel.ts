// A single replay's panel: head to head's per-run panel (viewer/h2h-panel.ts: sync, gain, strafes, the run's speed,
// and the strafe strip with the mouse turn, the A / D lanes and the switch offsets) under the one view. Off unless the
// player turns Stats on in the viewer's More menu (S), remembered. Screen only: an MP4 export of one run has no panel.
//
// Like head to head's ghost layout, the view is drawn into the area above the panel (the renderer's viewport and
// scissor) and the viewer's controls become a solid footer (viewer.css .rv-solo-stats).

import * as THREE from "three";
import { scaleRect, screenPanelHeight, soloRects, type Rect } from "../h2h/layout";
import type { Replay } from "../replay";
import { h } from "../ui/dom";
import { H2H_COLORS, runPanelStats } from "./h2h";
import { drawPanel, panelScale, type PanelRun, type PanelScale } from "./h2h-panel";
import type { RunData } from "./player";

const STATS_KEY = "bunnyhop:rv-stats";

/** Whether single replays show their panel (off unless turned on). */
export const soloStatsShown = (): boolean => {
  try {
    return localStorage.getItem(STATS_KEY) === "1";
  } catch {
    return false;
  }
};

export function rememberSoloStats(on: boolean): void {
  try {
    localStorage.setItem(STATS_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export interface SoloPanelHost {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  root: HTMLElement;
  /** The viewer's DOM HUD, placed over the view. */
  hud: HTMLElement;
}

export class SoloPanel {
  private el = h("canvas.h2h-panel", { "aria-hidden": "true", hidden: true }) as HTMLCanvasElement;
  private run: (PanelRun & { scale: PanelScale }) | null = null;
  private drawn = "";
  private placed = false;

  constructor(private host: SoloPanelHost) {
    host.root.append(this.el);
  }

  /** The run's panel data, computed once per replay (a swap in head to head hands the viewer another run). */
  private runOf(replay: Replay, d: RunData, name: string): PanelRun & { scale: PanelScale } {
    if (this.run?.player.data !== d) {
      const run: PanelRun = { name, color: H2H_COLORS[0], player: { data: d }, ...runPanelStats(replay, d) };
      this.run = { ...run, scale: panelScale([run]) };
      this.drawn = "";
    }
    this.run.name = name;
    return this.run;
  }

  /**
   * One frame: the view above the panel (`renderView`), the HUD over the view, the panel under it. `footerPx`: the CSS
   * height of the controls (nothing is drawn there). `t`: the display tick.
   */
  draw(replay: Replay, d: RunData, name: string, t: number, footerPx: number, hudOn: boolean, early: boolean, renderView: () => void): void {
    const r = this.host.renderer;
    const canvas = r.domElement.getBoundingClientRect();
    const areaH = Math.max(2, canvas.height - Math.max(0, footerPx - Math.max(0, innerHeight - canvas.bottom)));
    const { view, panel } = soloRects(canvas.width, areaH, screenPanelHeight(areaH, "side"));
    this.place(this.host.hud, hudOn ? view : null, canvas);
    this.place(this.el, panel, canvas);
    this.placed = true;
    // The HUD is laid out for a full window: in a shorter view it scales with the view (as head to head's do).
    this.host.root.style.setProperty("--h2h-hud", Math.max(0.5, Math.min(1, view.h / 760, view.w / 1350)).toFixed(2));
    // The view, in renderer units (top-left origin), over a cleared frame: the panel's strip keeps no stale pixels.
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const W = size.x / r.getPixelRatio();
    const H = size.y / r.getPixelRatio();
    const v = scaleRect(view, W / Math.max(1, canvas.width));
    const cam = this.host.camera;
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.clear();
    r.setScissorTest(true);
    try {
      const y = H - v.y - v.h;
      r.setViewport(v.x, y, v.w, v.h);
      r.setScissor(v.x, y, v.w, v.h);
      cam.aspect = v.w / Math.max(1, v.h);
      cam.updateProjectionMatrix();
      renderView();
    } finally {
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      r.setScissor(0, 0, W, H);
    }
    // The panel: redrawn when the playhead, its size or what it shows changes.
    const run = this.runOf(replay, d, name);
    const tau = (Math.min(t, d.n) - d.startTick) * d.interval;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(panel.w * dpr));
    const hgt = Math.max(1, Math.round(panel.h * dpr));
    const key = `${w}x${hgt}@${tau.toFixed(4)}${early ? "e" : ""}:${name}`;
    if (this.drawn === key) return;
    this.drawn = key;
    if (this.el.width !== w || this.el.height !== hgt) (this.el.width = w), (this.el.height = hgt);
    drawPanel(this.el.getContext("2d")!, { x: 0, y: 0, w, h: hgt }, run, tau, run.scale, early);
  }

  private place(el: HTMLElement, r: Rect | null, canvas: DOMRect): void {
    el.hidden = !r;
    if (!r) return;
    el.style.left = `${canvas.left + r.x}px`;
    el.style.top = `${canvas.top + r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }

  /** The panel off (or head to head took over): the HUD goes back to the whole view. True if it was showing. */
  hide(): boolean {
    if (!this.placed) return false;
    this.placed = false;
    this.el.hidden = true;
    this.drawn = "";
    for (const p of ["left", "top", "width", "height"] as const) this.host.hud.style.removeProperty(p);
    this.host.root.style.removeProperty("--h2h-hud");
    return true;
  }

  dispose(): void {
    this.hide();
    this.run = null;
    this.el.remove();
  }
}
