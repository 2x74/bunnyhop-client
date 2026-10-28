// Attract mode: a map rendered live behind the main menu (darkened + blurred in CSS). Which map:
// ui/featured.ts backgroundPick() (your latest PB with a replay, else the featured map).
//
//   - With a PB replay, your PB ghost runs the course with a chase camera that trails along the
//     ghost's own path (so it never clips through walls).
//   - Otherwise a slow cinematic tour: one dolly shot per checkpoint (info_teleport_destination,
//     in course order), looking down the section; shot length is limited by a raycast so the camera
//     stops short of walls.
//
// Starts after first paint (the static gradient shows until the first frame is ready), renders at a
// reduced resolution (it is blurred anyway), caps at ~60 fps, pauses while the tab is hidden, and
// drops to a still frame on slow GPUs. prefers-reduced-motion and Settings → Graphics → Menu
// background ("still" / "off") are respected. The downloaded BSP is handed to the game if you then
// play the same map. Nothing here touches the simulation of the actual game (separate Core).

import * as THREE from "three";
import { disposeWorldTree as dispose } from "./world-resources";
import { Core } from "./core";
import { Ghost } from "./ghost";
import { buildWorld, type WorldView } from "./render";
import { decodeReplay, replayStyle, sha256Hex } from "./replay";
import { FRAME_STRIDE, simulate } from "./sim";
import { formatTime } from "./timer";
import { backgroundPick, featuredArtReady } from "./ui/featured";
import { localName } from "./ui/account";
import { prefs, type MenuBackground } from "./ui/settings";
import { backdropLive, backdropRendered, onBackdropWanted } from "./ui/backdrop";

export interface AttractInfo {
  map: string;
  author: string | null;
  kind: "ghost" | "tour";
  /** e.g. "Your PB · 00:18.340" or "Map tour". */
  caption: string;
}

type Listener = (info: AttractInfo | null) => void;
let info: AttractInfo | null = null;
const listeners = new Set<Listener>();
/** Subscribe to what the background is showing (null = nothing / static gradient). Calls fn now. */
export function onAttractInfo(fn: Listener): () => void {
  listeners.add(fn);
  fn(info);
  return () => listeners.delete(fn);
}
function setInfo(i: AttractInfo | null): void {
  info = i;
  for (const l of listeners) l(i);
}

const EYE = 64;
/**
 * Leaving the menu for a map (leave): a short pull back (anticipation), then a push forward that keeps accelerating
 * while the lens widens (a speed kick) until the loading screen's art slides over it.
 */
const LEAVE_BACK_MS = 110;
const LEAVE_MS = 520;
const LEAVE_BACK = 14;
const LEAVE_DIST = 230;
const LEAVE_FOV = 16;
const STYLE = "autohop";
/**
 * Background pixel ratio: ~0.6 of the screen's (it is only lightly defocused on the home screen), but never below
 * 0.75 CSS px so 1x screens stay crisp. The low step (slow GPUs) is 0.65 of that.
 */
const basePixelRatio = () => Math.max(0.75, Math.min(devicePixelRatio, 2) * 0.6);
const RES_SCALE = 1;
const LOW_RES_SCALE = 0.65;
const FRAME_MIN_MS = 1000 / 62;
/**
 * Slow-GPU detection: median frame time over 2 s windows, after a 4 s warm-up (texture uploads, shader compiles, the
 * menu's own entrance). A window counts as slow below ~24 fps; three slow windows in a row step down (lower
 * resolution, then a still frame). Hidden tabs and long hitches (tab switches, GC, a page load in another tab) are
 * ignored, so a busy moment on a real machine never freezes the background.
 */
const PERF_WARMUP_MS = 4000;
const PERF_WINDOW_MS = 2000;
const PERF_SLOW_MEDIAN_MS = 42;
const PERF_SLOW_WINDOWS = 3;

/** Source (x, y, z) -> three (x, z, -y). */
const toThree = (x: number, y: number, z: number, out = new THREE.Vector3()) => out.set(x, z, -y);

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function mode(): MenuBackground {
  const m = prefs.get().graphics.menuBackground;
  return m === "still" || m === "off" ? m : "live";
}

// ---------------------------------------------------------------------------------------------
// Camera directors

interface Director {
  /** Advance by dt seconds and position the camera. Returns true when a cut (fade) is wanted now. */
  update(dt: number, camera: THREE.PerspectiveCamera): void;
  /** Jump to a representative moment (still frames). */
  still(camera: THREE.PerspectiveCamera): void;
}

interface Shot {
  from: THREE.Vector3;
  to: THREE.Vector3;
  yaw: number;
  sway: number;
}

/** Natural sort so t2 < t10 and stage names keep course order. */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function anchors(core: Core): { pos: [number, number, number]; yaw: number }[] {
  const ents = core.entities();
  const parse = (s: string | undefined) => (s ?? "").trim().split(/\s+/).map(Number);
  const pick = (cls: RegExp) =>
    ents
      .filter((e) => cls.test(e.classname ?? "") && e.origin)
      .sort((a, b) => natural.compare(a.targetname ?? "", b.targetname ?? ""))
      .map((e) => {
        const o = parse(e.origin);
        const a = parse(e.angles);
        return { pos: [o[0], o[1], o[2]] as [number, number, number], yaw: isFinite(a[1]) ? a[1] : 0 };
      })
      .filter((x) => x.pos.every(isFinite));
  let list = pick(/^info_teleport_destination$/);
  if (list.length < 2) list = [...pick(/^info_player_(start|counterterrorist|terrorist)$/), ...list];
  // Drop near-duplicates (spawn grids, stacked destinations).
  const out: typeof list = [];
  for (const a of list) if (!out.some((b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 160)) out.push(a);
  return out;
}

class TourDirector implements Director {
  private shots: Shot[] = [];
  private i = 0;
  private t = 0;
  private readonly duration = 7.5;

  constructor(core: Core, world: THREE.Object3D, private fade: (out: boolean) => void) {
    const meshes: THREE.Object3D[] = [];
    world.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && Array.isArray((o as THREE.Mesh).material)) meshes.push(o);
    });
    world.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const free = (from: THREE.Vector3, dir: THREE.Vector3, max: number) => {
      ray.set(from, dir);
      ray.far = max;
      const hit = ray.intersectObjects(meshes, false)[0];
      return hit ? hit.distance : max;
    };
    const up = new THREE.Vector3(0, 1, 0);
    for (const a of anchors(core)) {
      const yaw = (a.yaw * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const eye = toThree(a.pos[0], a.pos[1], a.pos[2] + EYE);
      const ahead = free(eye, dir, 900);
      const behind = free(eye, dir.clone().negate(), 120);
      const ceil = free(eye, up, 220);
      const rise = Math.max(0, Math.min(110, ceil - 28));
      const back = Math.max(0, Math.min(56, behind - 24));
      const len = Math.max(0, Math.min(560, ahead - 150));
      const from = eye.clone().addScaledVector(dir, -back).addScaledVector(up, Math.min(18, rise));
      const to = eye.clone().addScaledVector(dir, len).addScaledVector(up, rise);
      this.shots.push({ from, to, yaw, sway: (this.shots.length % 2 ? 1 : -1) * 0.12 });
    }
    if (!this.shots.length) {
      // No entities to go by: slow orbit around the origin.
      const c = new THREE.Vector3(0, 200, 0);
      this.shots.push({ from: c.clone().add(new THREE.Vector3(-400, 0, 0)), to: c.clone().add(new THREE.Vector3(400, 80, 0)), yaw: 0, sway: 0.1 });
    }
  }

  get count(): number {
    return this.shots.length;
  }

  private place(camera: THREE.PerspectiveCamera, s: Shot, u: number): void {
    camera.position.lerpVectors(s.from, s.to, u);
    const yaw = s.yaw + s.sway * (u - 0.5);
    const pitch = -0.1 - 0.06 * u;
    const look = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
    camera.lookAt(camera.position.clone().add(look));
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.t += dt;
    const d = this.duration;
    if (this.t >= d) {
      this.t -= d;
      this.i = (this.i + 1) % this.shots.length;
    }
    // Fade through black around each cut (only when there is more than one shot).
    if (this.shots.length > 1) this.fade(this.t > d - 0.55 || this.t < 0.08);
    this.place(camera, this.shots[this.i], this.t / d);
  }

  still(camera: THREE.PerspectiveCamera): void {
    this.place(camera, this.shots[Math.min(1, this.shots.length - 1)], 0.35);
  }
}

class GhostDirector implements Director {
  private t: number;
  private readonly t0: number;
  private readonly t1: number;
  private cam = new THREE.Vector3();
  private look = new THREE.Vector3();
  private snapped = false;
  private readonly n: number;

  constructor(
    private frames: Float32Array,
    startTick: number,
    endTick: number,
    private ghost: Ghost,
    private fade: (out: boolean) => void,
  ) {
    this.n = frames.length / FRAME_STRIDE;
    this.t0 = Math.max(0, startTick - 90);
    this.t1 = Math.min(this.n - 1, endTick + 110);
    this.t = this.t0;
  }

  private p(t: number): [number, number, number] {
    const [x, y, z] = this.ghost.positionAt(t);
    return [x, y, z];
  }

  /** Per-tick teleport check (path discontinuity). */
  private jumpAt(i: number): boolean {
    const f = this.frames;
    const a = i * FRAME_STRIDE;
    const b = (i + 1) * FRAME_STRIDE;
    return Math.abs(f[b] - f[a]) + Math.abs(f[b + 1] - f[a + 1]) + Math.abs(f[b + 2] - f[a + 2]) > 200;
  }

  private targets(t: number, cam: THREE.Vector3, look: THREE.Vector3): boolean {
    const p = this.p(t);
    // Camera sits on the ghost's own path ~210 units back (so it is always in open space).
    let k = Math.floor(t);
    let found = -1;
    for (let back = 0; back < 220 && k > 0; back++, k--) {
      if (this.jumpAt(k - 1)) break;
      const f = this.frames;
      const o = (k - 1) * FRAME_STRIDE;
      if (Math.hypot(f[o] - p[0], f[o + 1] - p[1]) >= 210) {
        found = k - 1;
        break;
      }
    }
    const ahead = this.p(Math.min(this.t1, t + 25));
    toThree(ahead[0], ahead[1], ahead[2] + 36, look);
    if (found >= 0) {
      const c = this.p(found);
      toThree(c[0], c[1], c[2] + EYE + 44, cam);
      return true;
    }
    // Standing still / just teleported: first person from the ghost's eye, its own view direction.
    const f = this.frames;
    const o = Math.max(0, Math.min(this.n - 1, Math.floor(t))) * FRAME_STRIDE;
    const yaw = (f[o + 4] * Math.PI) / 180;
    toThree(p[0], p[1], p[2] + EYE, cam);
    look.set(cam.x + Math.cos(yaw) * 300, cam.y - 30, cam.z - Math.sin(yaw) * 300);
    return false;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    const prev = this.t;
    this.t += dt * 100; // 100 tick
    let cut = false;
    if (this.t >= this.t1) {
      this.t = this.t0;
      cut = true;
    } else {
      for (let i = Math.floor(prev); i < Math.floor(this.t); i++) if (this.jumpAt(i)) cut = true;
    }
    this.fade(this.t > this.t1 - 45 || this.t < this.t0 + 12);
    const trailing = this.targets(this.t, this.tmpCam, this.tmpLook);
    this.ghost.root.visible = trailing;
    // Animated runner along the path (positions itself; no tag: it is sized for close range).
    this.ghost.showAt(this.t, true, dt, camera.position, { opacity: 0.7, trail: true, nearFade: false, tag: false }, this.t >= this.ghost.d.startTick);
    if (cut || !this.snapped) {
      this.cam.copy(this.tmpCam);
      this.look.copy(this.tmpLook);
      this.snapped = true;
    } else {
      const k = 1 - Math.exp(-dt / 0.22);
      const kl = 1 - Math.exp(-dt / 0.12);
      this.cam.lerp(this.tmpCam, k);
      this.look.lerp(this.tmpLook, kl);
    }
    camera.position.copy(this.cam);
    camera.lookAt(this.look);
  }
  private tmpCam = new THREE.Vector3();
  private tmpLook = new THREE.Vector3();

  still(camera: THREE.PerspectiveCamera): void {
    this.t = this.t0 + (this.t1 - this.t0) * 0.4;
    this.snapped = false;
    this.update(0, camera);
  }
}

// ---------------------------------------------------------------------------------------------

let current: Attract | null = null;

/**
 * Leaving the menu for a map (menu.ts, any map): the background camera pulls back a touch and pushes forward. False
 * when it can't (no live background, frozen behind a full screen, reduced motion): the menu then pushes the still in CSS.
 */
export function attractLeave(): boolean {
  return !!current?.leave();
}

export class Attract {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 2, 60000);
  private world: WorldView | null = null;
  private effectTime = 12;
  private updateEffects: (time: number) => void = () => {};
  private director: Director | null = null;
  private raf = 0;
  private last = 0;
  private stopped = false;
  private bsp: { name: string; bytes: Uint8Array } | null = null;
  private resScale = RES_SCALE;
  private perf = { since: 0, windowStart: 0, frames: [] as number[], slow: 0 };
  private live = false;
  private unwatch: (() => void) | null = null;
  private onResize = () => this.director && this.mode !== "live" && this.renderStill();
  /** leave() in progress (or over: the director stays paused and nothing is drawn until stop()). */
  private flight: { t0: number; from: THREE.Vector3; dir: THREE.Vector3; fov0: number; over: boolean } | null = null;
  private mode: MenuBackground;

  private constructor(
    private renderer: THREE.WebGLRenderer,
    private wasm: Promise<Uint8Array>,
    private download: (map: string) => Promise<Uint8Array>,
    /** Draws a frame the way the game does (graphics/pipeline.ts: the chosen look); `time` is visual seconds. */
    private draw: (scene: THREE.Scene, camera: THREE.Camera, time: number) => void,
  ) {
    this.mode = reducedMotion() ? "still" : mode();
  }

  /** Starts loading the background map (no-op when disabled). `download` is the game's own BSP fetch. */
  static start(
    renderer: THREE.WebGLRenderer,
    wasm: Promise<Uint8Array>,
    download: (map: string) => Promise<Uint8Array>,
    draw: (scene: THREE.Scene, camera: THREE.Camera, time: number) => void = (s, c) => renderer.render(s, c),
  ): Attract {
    const a = new Attract(renderer, wasm, download, draw);
    current = a;
    let lastMode = a.mode;
    let redraw = 0;
    a.unwatch = prefs.watch((p) => {
      a.world?.setPotato(p.graphics.potato);
      a.world?.setFullbright(p.graphics.fullbright);
      const m = reducedMotion() ? "still" : mode();
      // Any settings change resizes the shared canvas (main.ts resize()), which clears it: a still frame (Still, or
      // reduced motion) is drawn again on the next frame, or the menu would sit on black until the window resizes.
      if (m === "still" && m === lastMode && !redraw)
        redraw = requestAnimationFrame(() => {
          redraw = 0;
          if (a.mode === "still" && !a.live && a.director && !a.stopped) a.renderStill();
        });
      if (m === lastMode) return;
      lastMode = m;
      a.setMode(m);
    });
    if (a.mode !== "off") void a.load();
    // "Still" background (no loop): a freeze needs one frame to copy.
    onBackdropWanted(() => {
      if (!a.live && a.director && !a.stopped) a.renderStill();
    });
    return a;
  }

  leave(): boolean {
    if (!this.live || this.stopped || this.flight || !this.director || !backdropLive() || reducedMotion()) return false;
    document.body.classList.remove("attract-cut");
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.flight = { t0: performance.now(), from: this.camera.position.clone(), dir, fov0: this.camera.fov, over: false };
    return true;
  }

  /**
   * One leave step (in the render loop): ease out backwards, then ease in forwards (accelerating out of frame), the
   * lens widening with the push. False once it's over: the last frame stays on the canvas, nothing more is drawn.
   */
  private fly(now: number): boolean {
    const f = this.flight!;
    if (f.over) return false;
    const t = now - f.t0;
    let d: number;
    let w = 0;
    if (t < LEAVE_BACK_MS) {
      const u = t / LEAVE_BACK_MS;
      d = -LEAVE_BACK * (1 - (1 - u) ** 2);
    } else {
      const u = Math.min(1, (t - LEAVE_BACK_MS) / (LEAVE_MS - LEAVE_BACK_MS));
      const e = u * u * u;
      d = -LEAVE_BACK + (LEAVE_BACK + LEAVE_DIST) * e;
      w = u * u;
      if (u >= 1) f.over = true;
    }
    this.camera.position.copy(f.from).addScaledVector(f.dir, d);
    this.camera.fov = f.fov0 + LEAVE_FOV * w;
    this.camera.updateProjectionMatrix();
    return true;
  }

  /** BSP bytes, if the background already downloaded this map. */
  takeBsp(name: string): Uint8Array | null {
    return this.bsp?.name === name ? this.bsp.bytes : null;
  }

  private setMode(m: MenuBackground): void {
    if (this.stopped) return;
    this.mode = m;
    if (m === "off") {
      this.halt();
      document.body.classList.remove("attract-live");
      setInfo(null);
      return;
    }
    if (!this.director) {
      void this.load();
      return;
    }
    document.body.classList.add("attract-live");
    if (m === "still") {
      this.halt();
      this.renderStill();
    } else this.loop();
  }

  private async load(): Promise<void> {
    if (this.world || this.stopped) return;
    try {
      const pick = await backgroundPick(STYLE);
      if (!pick || this.stopped) return;
      const entry = pick.map;
      // Let the menu paint and settle (the featured card's art is the LCP) before the download competes with it.
      await new Promise((r) => setTimeout(r, 120));
      await featuredArtReady(2500);
      const bytes = await this.download(entry.name);
      if (this.stopped) return;
      this.bsp = { name: entry.name, bytes };
      const core = await Core.create((await this.wasm) as Uint8Array<ArrayBuffer>);
      if (this.stopped) return;
      await idle();
      core.loadMap(bytes);
      await idle();
      if (this.stopped) return;
      const world = await buildWorld(core, this.renderer, { bsp: bytes });
      if (this.stopped) return dispose(world.root);
      this.world = world;
      world.setPotato(prefs.get().graphics.potato);
      world.setFullbright(prefs.get().graphics.fullbright);
      this.effectTime = 12;
      this.updateEffects = time => world.update(core.brushOrigins(), time, core.effectStates());
      this.updateEffects(this.effectTime);
      this.scene.add(world.root);
      this.scene.onBeforeRender = (_r, _s, cam) => world.cull(cam);
      const fade = (out: boolean) => document.body.classList.toggle("attract-cut", out);

      let director: Director | null = null;
      const bytesPB = pick.pbReplay;
      if (bytesPB) {
        try {
          const replay = await decodeReplay(bytesPB);
          if (replay.header.map === entry.name && replay.header.mapSha256 === (await sha256Hex(bytes as Uint8Array<ArrayBuffer>))) {
            await idle();
            const sim = simulate(core, replay, replay.header.zones, { frames: true });
            if (sim.checkpointsMatch && sim.endTick && sim.frames) {
              // The PB ghost runner (ghost.ts / player/model.ts); its name tag is hidden in GhostDirector.update.
              const ghost = new Ghost({
                kind: "pb",
                track: sim.track,
                style: replayStyle(replay.header),
                name: `PB · ${replay.header.player || localName()}`,
                frames: sim.frames,
                startTick: sim.startTick,
                endTick: sim.endTick,
                tickInterval: Math.fround(replay.header.settings.tickInterval),
                side: replay.side,
                forward: replay.forward,
                cosmetic: replay.cosmetic,
                inspect: replay.inspect,
                loadout: replay.loadout,
              });
              this.scene.add(ghost.root);
              director = new GhostDirector(sim.frames, sim.startTick, sim.endTick, ghost, fade);
              const time = sim.timer.status === "finished" ? sim.timer.timeMs() / 1000 : (sim.endTick - sim.startTick) * Math.fround(replay.header.settings.tickInterval);
              setInfo({ map: entry.name, author: entry.author ?? null, kind: "ghost", caption: `Your PB · ${formatTime(time)}` });
            }
          }
        } catch (e) {
          console.warn("attract: PB replay unusable", e);
        }
      }
      if (!director) {
        director = new TourDirector(core, world.root, fade);
        setInfo({ map: entry.name, author: entry.author ?? null, kind: "tour", caption: "Map tour" });
      }
      this.director = director;
      if (this.stopped) return;
      addEventListener("resize", this.onResize);
      // Warm up: upload textures with one render before revealing.
      this.size();
      director.still(this.camera);
      this.renderer.compile(this.scene, this.camera);
      if (this.mode === "off") return;
      document.body.classList.add("attract-live");
      if (this.mode === "still") this.renderStill();
      else this.loop();
    } catch (e) {
      console.warn("attract: background disabled", e);
      setInfo(null);
    }
  }

  private size(): void {
    const pr = basePixelRatio() * this.resScale;
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) this.renderer.setPixelRatio(pr);
    const c = this.renderer.domElement;
    if (c.width !== Math.floor(innerWidth * pr) || c.height !== Math.floor(innerHeight * pr)) this.renderer.setSize(innerWidth, innerHeight, false);
    if (this.camera.aspect !== innerWidth / innerHeight) {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    }
  }

  private renderStill(): void {
    if (!this.director || this.stopped) return;
    this.size();
    this.director.still(this.camera);
    this.updateEffects(12);
    document.body.classList.remove("attract-cut");
    this.draw(this.scene, this.camera, 12);
    backdropRendered(this.renderer.domElement);
  }

  private loop(): void {
    if (this.raf || this.stopped) return;
    this.last = performance.now();
    this.live = true;
    this.perf = { since: this.last, windowStart: this.last, frames: [], slow: 0 };
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const dtMs = now - this.last;
      const menuFps = prefs.get().graphics.menuFps; // Settings → Graphics → FPS limit in menus
      if (dtMs < Math.max(FRAME_MIN_MS, menuFps > 0 ? 1000 / menuFps : 0) - 1) return;
      this.last = now;
      const dt = Math.min(dtMs, 100) / 1000;
      if (this.flight) {
        if (!this.fly(now)) return;
      } else this.director!.update(dt, this.camera);
      // Behind a full menu screen: drawn once into the blurred still (ui/backdrop.ts), then skipped.
      if (!backdropLive()) return;
      this.effectTime += dt;
      this.updateEffects(this.effectTime);
      this.size();
      this.draw(this.scene, this.camera, this.effectTime);
      backdropRendered(this.renderer.domElement);
      this.watchPerf(now, dtMs);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Slow GPU: first lower the resolution, then fall back to a still frame (not persisted). */
  private watchPerf(now: number, dtMs: number): void {
    const p = this.perf;
    if (document.hidden || dtMs > 250) {
      // Tab switch / long hitch: start a fresh window (and give it a moment to settle).
      p.windowStart = now;
      p.frames.length = 0;
      return;
    }
    if (now - p.since < PERF_WARMUP_MS) return;
    p.frames.push(dtMs);
    if (now - p.windowStart < PERF_WINDOW_MS) return;
    const sorted = p.frames.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    p.windowStart = now;
    p.frames = [];
    if (sorted.length < 10) return;
    p.slow = median > PERF_SLOW_MEDIAN_MS ? p.slow + 1 : 0;
    if (p.slow < PERF_SLOW_WINDOWS) return;
    p.slow = 0;
    p.since = now; // re-warm after a change
    if (this.resScale > LOW_RES_SCALE) {
      this.resScale = LOW_RES_SCALE;
      console.info(`attract: median frame ${median.toFixed(1)} ms, lowering background resolution`);
    } else {
      console.info(`attract: median frame ${median.toFixed(1)} ms at low resolution, switching background to a still frame`);
      this.halt();
      this.renderStill();
    }
  }

  private halt(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.live = false;
  }

  get running(): boolean {
    return this.live;
  }

  /** Stops rendering and frees GPU resources. The caller restores its own renderer size/pixel ratio. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (current === this) current = null;
    this.flight = null;
    this.halt();
    this.unwatch?.();
    removeEventListener("resize", this.onResize);
    document.body.classList.remove("attract-live", "attract-cut");
    if (this.world) dispose(this.world.root);
    this.scene.clear();
    this.world = null;
    this.director = null;
    setInfo(null);
  }
}

const idle = () => new Promise<void>((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 300 }) : setTimeout(r, 16)));
