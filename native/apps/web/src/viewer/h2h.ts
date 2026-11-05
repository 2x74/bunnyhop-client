// Head to head (/h2h/<runA>/<runB>): two leaderboard runs of one map played together on one clock (h2h/align.ts), in
// the replay viewer. Owned by ReplayViewer while open (viewer.ts openH2H).
//
// Layouts (h2h/layout.ts): side by side, stacked, or ghost (one camera on the primary run, the other run as the
// viewer's compare ghost with its trail and live time gap). The two views are drawn into scissored viewports of the
// one renderer (the map drawn twice a frame), each with its own camera (the viewer's camera mode) and HUD. Under each
// run's view sits that run's own panel (viewer/h2h-panel.ts), the same on both. Swap makes the other run the primary
// (left / top view, the camera in ghost view); nothing is simulated again.
//
// Each run has its own sim core (viewer/player.ts keyframes): the primary's is the viewer's, the other's is made here.
// Before the other run's view is drawn, the world's moving brushes go to its own tick.
//
// MP4 export (viewer.ts h2hExportSource): the same views and panels at the export frame's size, side by side in 16:9
// and stacked in 9:16, with the canvas HUD in each view.

import * as THREE from "three";
import type { RunInfo } from "../api";
import { Core, traceRay, type BrushTransform } from "../core";
import { Ghost } from "../ghost";
import { gapSeries, partnerTick, runFrames, sharedEnd, type GapSeries } from "../h2h/align";
import { jumpRows, meanGain, type JumpRow } from "../h2h/jumps";
import { exportLayout, h2hRects, PANEL_FRAME, scaleRect, screenPanelHeight, type H2HLayout, type H2HRects, type Rect } from "../h2h/layout";
import { mouseTurns, runStrafeInput, strafeKeysOf, strafeTiming, type StrafeTiming } from "../h2h/strafe-timing";
import { softwareRenderer } from "../gfx-auto";
import { gpuInfo } from "../gpu-info";
import { PlayerModel } from "../player/model";
import type { Replay } from "../replay";
import { replayStyle } from "../replay";
import { h } from "../ui/dom";
import { prefs } from "../ui/settings";
import type { ArmsLook } from "./arms";
import { CameraRig, type CamMode, type TraceFn } from "./cameras";
import { CanvasHud, drawBranding, type CanvasHudOptions } from "./canvas-hud";
import { drawPanel, panelScale, type PanelScale } from "./h2h-panel";
import { ViewerHud } from "./hud";
import { ladderAt, prerollFrom, ReplayPlayer, sampleAt, type ViewSample } from "./player";
import { probeFromTrace } from "../player/bunny/legs";
import { replaySsj } from "./replay-ssj";

export type { H2HLayout } from "../h2h/layout";

/** Run colours: the site's amber for the faster run, the WR ghost's blue for the other. */
export const H2H_COLORS = ["#ffb43a", "#4fa8ff"] as const;

export interface H2HSide {
  runId: string;
  info: RunInfo;
  /** The account name (the replay file's own name is whatever its client wrote). */
  name: string;
  replay: Replay;
  bytes: Uint8Array;
  core: Core;
  player: ReplayPlayer;
  look: ArmsLook;
  color: string;
  /** Null on styles that don't strafe with A and D (Sideways, W-Only). */
  timing: StrafeTiming | null;
  /** Mouse turn per command (degrees, + = left). */
  turns: Float32Array;
  jumps: JumpRow[];
  gain: number | null;
}

export interface H2HHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: HTMLElement;
  /** The primary run's DOM HUD (the viewer's), placed over the primary's view. */
  mainHud: HTMLElement;
  render: (scene: THREE.Scene, camera: THREE.Camera, seconds: number) => void;
  /** Moves the world's brushes to a run's tick (WorldView.update). */
  worldUpdate: (origins: Map<number, BrushTransform>, seconds: number, effects: ReturnType<Core["effectStates"]>, propAnims?: ReturnType<Core["propAnims"]>) => void;
}

/** A Core with the map's physics, for the second run. */
export async function sideCore(wasm: Uint8Array, bsp: Uint8Array): Promise<Core> {
  const c = await Core.create(wasm as Uint8Array<ArrayBuffer>);
  c.loadMapPhysics(bsp);
  return c;
}

/** Everything head to head computes once per run. */
export function makeSide(o: { runId: string; info: RunInfo; replay: Replay; bytes: Uint8Array; core: Core; player: ReplayPlayer; look: ArmsLook; color: string }): H2HSide {
  const d = o.player.data;
  const keys = strafeKeysOf(replayStyle(o.replay.header));
  const jumps = jumpRows(replaySsj(d, "every"), d.startTick, d.endTick, d.interval);
  return {
    ...o,
    name: o.info.player.name || o.replay.header.player || "unknown",
    timing: keys ? strafeTiming(runStrafeInput(d, keys)) : null,
    turns: mouseTurns(Array.from({ length: d.n }, (_, i) => d.view[(i + 1) * 2]), d.n),
    jumps,
    gain: meanGain(jumps),
  };
}

/** Slow graphics: software rendering, or a Potato preset (Settings → Graphics: Lowest / Low). They start in ghost view. */
export function slowGraphics(): boolean {
  const gpu = gpuInfo();
  return prefs.get().graphics.potato || (gpu !== null && softwareRenderer(gpu.renderer));
}

export class HeadToHead {
  layout: H2HLayout;
  /** sides[primary] is the viewer's own run (its player, core, camera rig and HUD). */
  primary = 0;
  /** Per side: its gap against the other on its own ticks (gaps[0]: side 0 against side 1). */
  readonly gaps: [GapSeries, GapSeries];
  readonly rig = new CameraRig();
  readonly hud = new ViewerHud();
  /** The panels show (S). */
  panelsOn = true;
  /** The panels' "early" number (off unless the player turns it on, viewer.ts). */
  showEarly = false;
  readonly scale: PanelScale;
  private model: PlayerModel;
  private sample: ViewSample | undefined;
  private lastU = -1;
  /** One canvas per panel on screen, in the order of `sides` (each run keeps its panel when they swap places). */
  private panelEls: HTMLCanvasElement[];
  private drawn: string[] = ["", ""];
  /** Export in progress: its layout, rig for the other view and canvas HUDs. */
  private exp: { layout: H2HLayout; rig: CameraRig; huds: CanvasHud[]; size: string } | null = null;
  private offPrefs: () => void;

  constructor(
    readonly sides: [H2HSide, H2HSide],
    private host: H2HHost,
    layout: H2HLayout,
  ) {
    this.layout = layout;
    const [a, b] = sides;
    this.gaps = [gapSeries(a.player.data, b.player.data), gapSeries(b.player.data, a.player.data)];
    this.scale = panelScale(sides);
    const o = this.other;
    this.model = new PlayerModel({ style: "solid", playerGlow: o.look.glow, outfit: o.look.outfit, loadout: o.look.loadout });
    this.model.setNearFade(10, 34);
    this.model.root.visible = false;
    this.probeOther();
    host.scene.add(this.model.root);
    this.hud.el.classList.add("h2h-hud-other");
    this.panelEls = sides.map(() => h("canvas.h2h-panel", { "aria-hidden": "true" }) as HTMLCanvasElement);
    host.root.append(this.hud.el, ...this.panelEls);
    this.offPrefs = prefs.watch(() => this.hud.applyPrefs());
    this.hud.setTickRate(o.player.data.tickrate);
  }

  get main(): H2HSide {
    return this.sides[this.primary];
  }
  get other(): H2HSide {
    return this.sides[1 - this.primary];
  }

  /** The layout drawn now: the export's while one renders. */
  get viewLayout(): H2HLayout {
    return this.exp?.layout ?? this.layout;
  }

  /** The primary's display ticks the shared timeline spans (to the later of the two replays' ends). */
  get end(): number {
    return sharedEnd(this.main.player.data, this.other.player.data);
  }

  /** The later finish on the primary's clock (End key, the export's trim). */
  get lastFinish(): number {
    const p = this.main.player.data;
    const o = this.other.player.data;
    const of = o.endTick ? p.startTick + ((o.endTick - o.startTick) * o.interval) / p.interval : 0;
    return Math.max(p.endTick || p.n, Math.ceil(of));
  }

  /** The other run's tick at primary tick t, clamped to its replay. */
  otherTick(t: number): number {
    const o = this.other.player.data;
    return Math.max(0, Math.min(o.n, partnerTick(this.main.player.data, o, t)));
  }

  /** Swap which run is primary. The caller (viewer.ts) hands its own run over and takes the other. */
  swap(): void {
    this.primary = 1 - this.primary;
    const o = this.other;
    this.model.setOutfit(o.look.outfit);
    this.model.setLoadout(o.look.loadout);
    this.model.setPlayerGlow(o.look.glow);
    this.probeOther();
    this.hud.reset();
    this.hud.setTickRate(o.player.data.tickrate);
    this.rig.snap();
    this.model.snap();
    this.lastU = -1;
    this.drawn = ["", ""];
  }

  /** The other view's bunny plants its feet on the other run's world (its own core: player/bunny/legs.ts). */
  private probeOther(): void {
    const core = this.other.core;
    this.model.setGroundProbe(probeFromTrace((a, b) => traceRay(core, a, b, 0)));
  }

  setLayout(l: H2HLayout): void {
    this.layout = l;
    this.rig.snap();
    this.drawn = ["", ""];
  }

  /** The compare ghost for the ghost view: the other run's cached ticks as frames (nothing simulated again). */
  makeGhost(): Ghost {
    const o = this.other;
    const d = o.player.data;
    const { frames, events } = runFrames(d);
    const g = new Ghost({
      kind: o.color === H2H_COLORS[1] ? "wr" : "custom",
      track: d.runTrack,
      style: "*",
      name: o.name,
      frames,
      frameEvents: events,
      startTick: d.startTick,
      endTick: d.endTick || d.n,
      tickInterval: d.interval,
      side: o.replay.side,
      forward: o.replay.forward,
      cosmetic: o.replay.cosmetic,
      loadout: o.replay.loadout,
    });
    g.setRenderOrder(30);
    return g;
  }

  /** The primary's gap and speed difference against the other, on its ticks (the viewer's compare series). */
  get mainGap(): GapSeries {
    return this.gaps[this.primary];
  }

  /** Run seconds at primary tick t. */
  private tau(t: number): number {
    const d = this.main.player.data;
    return (t - d.startTick) * d.interval;
  }

  /**
   * One frame on screen. `footerPx`: the CSS height of the controls under the views (nothing is drawn there).
   * `renderMain` draws the primary at display tick t (viewer.ts render).
   */
  draw(t: number, dt: number, footerPx: number, mode: CamMode, renderMain: (t: number, dt: number) => void, hudOn: boolean): void {
    const r = this.host.renderer;
    const canvas = r.domElement.getBoundingClientRect();
    const areaH = Math.max(2, canvas.height - Math.max(0, footerPx - Math.max(0, innerHeight - canvas.bottom)));
    const layout = this.layout;
    const rects = h2hRects(layout, canvas.width, areaH, this.panelsOn ? screenPanelHeight(areaH, layout) : 0);
    this.placeDom(rects, canvas, hudOn);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const k = size.x / r.getPixelRatio() / Math.max(1, canvas.width);
    this.drawViews(rects.views.map((v) => scaleRect(v, k)), size.y / r.getPixelRatio(), t, dt, mode, this.rig, renderMain);
    if (layout !== "ghost" && hudOn) {
      const o = this.other.player.data;
      const u = this.otherTick(t);
      const g = this.gaps[1 - this.primary];
      const i = Math.max(0, Math.min(o.n, Math.floor(u)));
      const dv = g.delta[i];
      const sv = g.speedDiff[i - (i % 10)];
      this.hud.update(o, u, Number.isFinite(dv) ? dv : null, Number.isFinite(sv) ? sv : null);
    }
    // Panels: redrawn when the playhead or their size changes.
    const tau = this.tau(Math.min(t, this.end));
    const order = [this.main, this.other];
    order.forEach((s, slot) => {
      const el = this.panelEls[this.sides.indexOf(s)];
      const pr = rects.panels[slot];
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(1, Math.round(pr.w * dpr));
      const hgt = Math.max(1, Math.round(pr.h * dpr));
      const key = `${w}x${hgt}@${tau.toFixed(4)}${this.showEarly ? "e" : ""}`;
      if (this.drawn[slot] === key || !this.panelsOn) return;
      this.drawn[slot] = key;
      if (el.width !== w || el.height !== hgt) (el.width = w), (el.height = hgt);
      drawPanel(el.getContext("2d")!, { x: 0, y: 0, w, h: hgt }, s, tau, this.scale, this.showEarly);
    });
  }

  /** HUDs over their views and the panels under them (CSS px, over the canvas). */
  private placeDom(rects: H2HRects, canvas: DOMRect, hudOn: boolean): void {
    const at = (el: HTMLElement, r: Rect | undefined) => {
      el.hidden = !r;
      if (!r) return;
      el.style.left = `${canvas.left + r.x}px`;
      el.style.top = `${canvas.top + r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    };
    at(this.host.mainHud, hudOn ? rects.views[0] : undefined);
    at(this.hud.el, hudOn ? rects.views[1] : undefined);
    // The HUDs are laid out for a full window: in a shorter view they'd overlap, so they scale with its height.
    const vh = rects.views[0].h;
    this.host.root.style.setProperty("--h2h-hud", Math.max(0.5, Math.min(1, vh / 760)).toFixed(2));
    const order = [this.main, this.other];
    order.forEach((s, slot) => at(this.panelEls[this.sides.indexOf(s)], this.panelsOn ? rects.panels[slot] : undefined));
  }

  /** Both views (`views` in renderer units, top-left origin; `H`: the renderer's height in the same units). */
  private drawViews(views: Rect[], H: number, t: number, dt: number, mode: CamMode, rig: CameraRig, renderMain: (t: number, dt: number) => void): void {
    const r = this.host.renderer;
    const cam = this.host.camera;
    const main = this.main.player.data;
    const vp = (v: Rect) => {
      const y = H - v.y - v.h;
      r.setViewport(v.x, y, v.w, v.h);
      r.setScissor(v.x, y, v.w, v.h);
      cam.aspect = v.w / Math.max(1, v.h);
      cam.updateProjectionMatrix();
    };
    const W = r.getDrawingBufferSize(new THREE.Vector2()).x / r.getPixelRatio();
    // Clear the whole frame first: the panels' strip of the canvas would keep stale pixels otherwise.
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.clear();
    r.setScissorTest(true);
    try {
      vp(views[0]);
      renderMain(Math.min(t, main.n), dt);
      if (views[1]) {
        vp(views[1]);
        this.drawOther(t, dt, mode, rig);
      }
    } finally {
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      r.setScissor(0, 0, W, H);
    }
  }

  /** The other run's view: its sim to its tick, the world's brushes to its state, its camera and (third person) model. */
  private drawOther(t: number, dt: number, mode: CamMode, rig: CameraRig): void {
    const o = this.other;
    const d = o.player.data;
    const u = this.otherTick(t);
    o.player.seek(Math.floor(u));
    this.host.worldUpdate(o.player.brushOrigins(), u * d.interval, o.core.effectStates(), o.core.propAnims());
    // The viewer's camera mode where it applies to a second view; free roam and the auto-director stay on the primary.
    const m: CamMode = mode === "free" || mode === "auto" ? "eye" : mode;
    if (rig.mode !== m) (rig.mode = m), rig.snap();
    // A first frame or a jump: the camera and the bunny pre-roll the other run's last moments (seek-safe, like the
    // primary in viewer.ts).
    if (this.lastU < 0 || Math.abs(u - this.lastU) > 30) {
      rig.snap();
      this.model.preroll(prerollFrom(d, u));
    }
    this.lastU = u;
    const trace: TraceFn = (a, b, rad) => traceRay(o.core, a, b, rad);
    const cam = this.host.camera;
    const showModel = rig.update(cam, d, u, dt, trace);
    const s = (this.sample = sampleAt(d, u, this.sample));
    this.model.root.visible = showModel;
    this.model.setState({ visualTime: u * d.interval, position: s.pos, velocity: s.vel, yaw: s.yaw, pitch: s.pitch, crouched: s.crouched, grounded: s.grounded, forwardmove: s.forward, sidemove: s.side, ladder: ladderAt(d, u) });
    this.model.update(dt);
    // The primary's bunny and ghost aren't in the other run's view.
    const hidden = this.host.scene.children.filter((c) => c.visible && (c.name.startsWith("ghost:") || c.userData.h2hPrimary));
    for (const c of hidden) c.visible = false;
    try {
      this.host.render(this.host.scene, cam, u * d.interval);
    } finally {
      for (const c of hidden) c.visible = true;
      this.model.root.visible = false;
    }
  }

  // ------------------------------------------------------------------------------------------- export

  /** Before an export: a fresh camera rig for the other view (no viewing history in the frames). */
  beginExport(): void {
    this.exp = { layout: "side", rig: new CameraRig(), huds: [], size: "" };
    this.lastU = -1;
    this.model.snap();
  }

  endExport(): void {
    this.exp = null;
    this.lastU = -1;
    this.drawn = ["", ""];
    this.rig.snap();
  }

  /** The export frame's rectangles at w x h (frame pixels). */
  private exportRects(w: number, hgt: number): H2HRects {
    const layout = exportLayout(w, hgt);
    return h2hRects(layout, w, hgt, Math.round(Math.min(w, hgt) * PANEL_FRAME));
  }

  /** Export: both views into the renderer at its current size (the export's render size), camera mode from `rig`. */
  exportRender(t: number, dt: number, rig: CameraRig, renderMain: (t: number, dt: number) => void): void {
    const e = this.exp;
    if (!e) return;
    const r = this.host.renderer;
    const size = r.getSize(new THREE.Vector2());
    e.layout = exportLayout(size.x, size.y);
    const rects = this.exportRects(size.x, size.y);
    this.drawViews(rects.views, size.y, t, dt, rig.mode, e.rig, renderMain);
  }

  /** Export: each view's canvas HUD and each run's panel over the composited frame (w x h). */
  exportOverlay(g: CanvasRenderingContext2D, w: number, hgt: number, t: number, o: CanvasHudOptions, branding: boolean): void {
    const e = this.exp;
    if (!e) return;
    const rects = this.exportRects(w, hgt);
    const key = `${w}x${hgt}`;
    if (e.size !== key) (e.size = key), (e.huds = rects.views.map((v) => new CanvasHud(v.w, v.h)));
    const runs = [this.main, this.other];
    rects.views.forEach((v, slot) => {
      const s = runs[slot];
      const d = s.player.data;
      const st = slot === 0 ? Math.min(t, d.n) : this.otherTick(t);
      const gap = this.gaps[this.sides.indexOf(s)];
      const i = Math.max(0, Math.min(d.n, Math.floor(st)));
      const dv = gap.delta[i];
      const sv = gap.speedDiff[i - (i % 10)];
      g.save();
      g.beginPath();
      g.rect(v.x, v.y, v.w, v.h);
      g.clip();
      g.translate(v.x, v.y);
      e.huds[slot].draw(g, d, st, Number.isFinite(dv) ? dv : null, { ...o, crosshair: false, stats: false }, Number.isFinite(sv) ? sv : null);
      g.restore();
    });
    const tau = this.tau(Math.min(t, this.end));
    runs.forEach((s, slot) => drawPanel(g, rects.panels[slot], s, tau, this.scale, this.showEarly));
    if (branding) {
      // The wordmark at the top of the frame, clear of the panels.
      g.save();
      g.translate(0, hgt * 0.05 - hgt * (w < hgt ? 0.82 : 0.94));
      drawBranding(g, w, hgt);
      g.restore();
    }
  }

  dispose(): void {
    this.offPrefs();
    this.model.root.removeFromParent();
    this.model.dispose();
    this.hud.el.remove();
    for (const el of this.panelEls) el.remove();
    for (const el of [this.host.mainHud]) for (const p of ["left", "top", "width", "height"] as const) el.style.removeProperty(p);
    this.host.mainHud.hidden = false;
    // The primary's player and core belong to the viewer; the other's are disposed here.
    this.other.player.dispose();
  }
}
