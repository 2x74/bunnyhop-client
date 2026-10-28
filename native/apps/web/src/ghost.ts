// Race ghosts: faded player models replaying a run in sync with your timer.
//
// Sources (any combination, each per track): your PB (local IndexedDB), the server WR (api.leaderboard + api.replay),
// and a custom ghost (a loaded .bhr file or any leaderboard run, via player/race.ts requests).
// Every ghost is a re-simulated replay (exact per-tick frames), so it starts on the exact tick your timer starts
// (leaving the start zone), waits at its start line while you sit in the start zone, and keeps running to its own
// finish after you finish. Each shows a name/time tag with a live delta (progress along its path) and an optional
// fading trail. The HUD split uses the primary ghost (PB, else WR, else custom).

import * as THREE from "three";
import { api, lastKnownMe } from "./api";
import { worldRecord } from "./shared-reads";
import { Core, traceRay, type Settings } from "./core";
import { formatDelta, type GhostInputs } from "./hud";
import { GHOST_COLORS, GHOST_CSS, type GhostKind } from "./player/colors";
import { getGhostCosmetics, onGhostCosmetics } from "./player/cosmetics";
import { PlayerModel, type PlayerPose } from "./player/model";
import { onRaceRequest, type RaceRequest } from "./player/race";
import { NameTag, TagSight, type SightTrace } from "./player/tag";
import { Trail } from "./player/trail";
import { DEFAULT_LOADOUT, type CosmeticLoadout } from "./loadout";
import { cosmeticBetween, decodeReplay, inspectBetween, replayStyle, type CosmeticEvent, type Replay } from "./replay";
import { styleForTrack, type StyleId } from "./styles";
import { FRAME_CROUCHED, FRAME_GROUNDED, FRAME_STRIDE, simulate } from "./sim";
import { formatTime, type RunTimer } from "./timer";
import { uiHidden } from "./ui/hide-ui";
import { prefs } from "./ui/settings";
import { trackName } from "./zones";
import { SpatialMover } from "./audio";
import { GhostRoute } from "./ghost-route";
import { warmPrograms } from "./graphics/warm-programs";
import { routeGhostKind, type GhostRouteMode } from "./ghost-route-data";

/** A PB is always your own run: your account name, not the replay file's (the native client's say "native-player"). */
const pbName = (replay: Replay): string => lastKnownMe()?.name ?? replay.header.player;

export type { GhostKind };

export interface GhostData {
  kind: GhostKind;
  /** 0 = main, N = bonus N. */
  track: number;
  /** Style id of the ghost's run (PB / WR are shown only for the current style); "*" = any (custom ghosts). */
  style: string;
  /** Tag label, e.g. "PB · hunter". */
  name: string;
  /** Per-tick frames from simulate({ frames: true }) or the live recorder (FRAME_STRIDE floats per tick). */
  frames: Float32Array;
  /** Exact jump/teleport events at the same ticks (native replays/live PBs). */
  frameEvents?: Uint8Array;
  /** Ticks the ghost's timer started / finished. */
  startTick: number;
  endTick: number;
  tickInterval: number;
  /** Replay command columns (index = tick - 1), for strafe lean. */
  side?: Int16Array;
  forward?: Int16Array;
  /** Cosmetic events (carrot swings) by frame tick, shown as the third-person knife attack. */
  cosmetic?: CosmeticEvent[];
  /** Inspect events (replay.ts INSPECT_*), shown as the third-person inspect gesture. */
  inspect?: CosmeticEvent[];
  /** The loadout the run was played with (replay trailer): the ghost holds that knife. Absent: your PB ghost follows
   * your equipped loadout, other ghosts hold the carrot. */
  loadout?: CosmeticLoadout;
}

/** Per-frame look options (from prefs.ghost). */
export interface GhostLook {
  opacity: number;
  trail: boolean;
  nearFade: boolean;
  /** Name/time tag (default shown). */
  tag?: boolean;
  /** Persistent route for this ghost (independent of the fading trail). Off in menu/viewer ghosts by default. */
  route?: boolean;
  routeMode?: GhostRouteMode;
}

const TRAIL_SECONDS = 2.5;
const TRAIL_STEP = 2; // ticks between trail samples

export class Ghost {
  readonly root = new THREE.Group();
  readonly model: PlayerModel;
  private trail: Trail;
  private route: GhostRoute | null = null;
  private routeColor: THREE.ColorRepresentation;
  private tag: NameTag;
  private lastMatch = 0;
  private lastT = -1;
  private pose: PlayerPose & { position: number[]; velocity: number[] } = { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, crouched: false, grounded: true, sidemove: 0, forwardmove: 0 };
  private trailPts = new Float32Array(400 * 3);
  private tagPos = new THREE.Vector3();
  private tagAge = 1;
  private tagDelta: number | null = NaN;
  /** Tag occlusion + distance fade (farther than players' tags: a far-ahead ghost's delta still helps). */
  private sight = new TagSight(3000, 4500);
  /**
   * World line of sight for the tag (core traceRay). Null = no occlusion (menu background). The tag hides behind walls
   * like other players' tags unless Settings -> Ghost -> Names through walls.
   */
  trace: SightTrace | null = null;
  /** Player time minus ghost time at the same point on its path (seconds; negative = you're ahead). */
  delta: number | null = null;
  /** Ghost tick shown on the last update (drives the HUD's ghost keys overlay). */
  tick = 0;
  /** Race ghosts make quiet positional sounds (Settings → Audio → Ghost sounds); viewer compare ghosts don't. */
  audible = false;
  private sound: SpatialMover | null = null;

  constructor(readonly d: GhostData) {
    // --- cosmetics: your PB ghost wears your unlocked ghost / trail colours (player/cosmetics.ts, card editor)
    const mine = d.kind === "pb" ? getGhostCosmetics() : null;
    const color = mine?.ghost ?? GHOST_COLORS[d.kind];
    this.routeColor = color;
    this.model = new PlayerModel({ style: "ghost", color, rim: mine?.ghost2, loadout: d.loadout ?? (d.kind === "pb" ? undefined : { ...DEFAULT_LOADOUT }) });
    this.trail = new Trail(mine?.trail ?? color, undefined, mine?.trail2);
    this.tag = new NameTag(mine?.ghost ?? GHOST_CSS[d.kind]);
    if (mine)
      this.offCosmetics = onGhostCosmetics((c) => {
        this.model.setStyle("ghost", c.ghost, undefined, c.ghost2);
        this.trail.setColor(c.trail, c.trail2);
        this.routeColor = c.ghost;
        this.route?.setColor(c.ghost);
      });
    this.root.add(this.model.root, this.trail.mesh, this.tag.sprite);
    this.root.name = `ghost:${d.kind}:${d.track}`;
    this.resetSplit();
  }

  get kind(): GhostKind {
    return this.d.kind;
  }
  get track(): number {
    return this.d.track;
  }
  get frameCount(): number {
    return this.d.frames.length / FRAME_STRIDE;
  }
  /** The ghost's run time in ticks / seconds. */
  get ticks(): number {
    return this.d.endTick - this.d.startTick;
  }
  get time(): number {
    return this.ticks * this.d.tickInterval;
  }

  setRenderOrder(base: number): void {
    this.model.setRenderOrder(base);
  }

  private teleportBetween(i: number, j: number): boolean {
    const f = this.d.frames;
    const S = FRAME_STRIDE;
    return Math.abs(f[j * S] - f[i * S]) + Math.abs(f[j * S + 1] - f[i * S + 1]) + Math.abs(f[j * S + 2] - f[i * S + 2]) > 200;
  }

  /** Source-space position at a (fractional) ghost tick. */
  positionAt(t: number, out: number[] = [0, 0, 0]): number[] {
    const n = this.frameCount;
    t = Math.max(0, Math.min(n - 1, t));
    const i = Math.floor(t);
    const j = Math.min(n - 1, i + 1);
    const a = this.teleportBetween(i, j) ? 0 : t - i;
    const f = this.d.frames;
    for (let k = 0; k < 3; k++) out[k] = f[i * FRAME_STRIDE + k] + (f[j * FRAME_STRIDE + k] - f[i * FRAME_STRIDE + k]) * a;
    return out;
  }

  /** Fills the model pose at fractional ghost tick t. `moving` false = parked (before start / after finish). */
  private sample(t: number, moving: boolean): PlayerPose {
    const d = this.d;
    const f = d.frames;
    const S = FRAME_STRIDE;
    const n = this.frameCount;
    t = Math.max(0, Math.min(n - 1, t));
    const i = Math.floor(t);
    const j = Math.min(n - 1, i + 1);
    const jump = this.teleportBetween(i, j);
    const a = jump ? 0 : t - i;
    const p = this.pose;
    this.positionAt(t, p.position);
    const y0 = f[i * S + 4];
    let dy = f[j * S + 4] - y0;
    dy = ((((dy + 180) % 360) + 360) % 360) - 180;
    p.yaw = y0 + dy * a;
    p.pitch = f[i * S + 5] + (f[j * S + 5] - f[i * S + 5]) * a;
    const flags = f[i * S + 3];
    p.crouched = (flags & FRAME_CROUCHED) !== 0;
    // Grounded if any tick since the last sample touched the ground (bhop lands for a single tick).
    let grounded = (flags & FRAME_GROUNDED) !== 0;
    if (!grounded && moving && this.lastT >= 0 && t > this.lastT && t - this.lastT < 30) {
      for (let k = Math.floor(this.lastT) + 1; k <= i && !grounded; k++) grounded = (f[k * S + 3] & FRAME_GROUNDED) !== 0;
    }
    p.grounded = grounded;
    if (moving && !jump && j > i) {
      for (let k = 0; k < 3; k++) p.velocity[k] = (f[j * S + k] - f[i * S + k]) / d.tickInterval;
    } else p.velocity[0] = p.velocity[1] = p.velocity[2] = 0;
    p.sidemove = moving && d.side && i > 0 ? d.side[Math.min(i, d.side.length - 1)] : 0;
    p.forwardmove = moving && d.forward && i > 0 ? d.forward[Math.min(i, d.forward.length - 1)] : 0;
    return p;
  }

  /**
   * Places the ghost `elapsed` ticks (fractional) into its run; null = parked at its start (your timer isn't running).
   * camera: three.js-space camera position (trail billboarding, tag fade).
   */
  update(elapsed: number | null, dt: number, camera: THREE.Vector3, o: GhostLook): void {
    const d = this.d;
    const t = elapsed === null ? d.startTick : Math.min(d.startTick + Math.max(0, elapsed), d.endTick);
    this.showAt(t, elapsed !== null && t < d.endTick, dt, camera, o, elapsed !== null);
  }

  /**
   * Shows the ghost at absolute (fractional) frame tick t, e.g. for menu backgrounds that play a whole replay.
   * moving: animate from the path (false = parked idle); running: show trail + delta.
   */
  showAt(t: number, moving: boolean, dt: number, camera: THREE.Vector3, o: GhostLook, running = moving): void {
    const d = this.d;
    const elapsed = running ? t - d.startTick : null;
    const snapped = this.lastT >= 0 && (t < this.lastT - 1 || t - this.lastT > 200);
    if (snapped) {
      this.model.snap();
      this.sight.reset();
    }
    const pose = this.sample(t, moving);
    const live = moving && this.lastT >= 0 && t > this.lastT && t - this.lastT < 50;
    pose.attack = live ? cosmeticBetween(d.cosmetic, Math.floor(this.lastT), Math.floor(t)) : 0;
    const ins = live ? inspectBetween(d.inspect, Math.floor(this.lastT), Math.floor(t)) : null;
    pose.inspect = ins?.sig ?? 0;
    pose.inspectHeld = ins?.held ?? false;
    this.model.setState(pose);
    if (this.audible && moving && prefs.get().audio.ghosts) (this.sound ??= new SpatialMover(0.45)).update(dt, this.pose.position, this.pose.velocity, pose.grounded, pose.crouched, false, snapped || this.lastT < 0);
    else this.sound?.moves.reset();
    this.lastT = t;
    this.tick = Math.floor(t);
    this.model.setOpacity(o.opacity);
    this.model.setNearFade(o.nearFade ? 14 : 0, o.nearFade ? 64 : 0);
    this.model.update(dt);

    if (o.route) {
      const mode = o.routeMode === "path" ? "path" : "jumps";
      if (this.route?.mode !== mode) {
        this.route?.dispose();
        this.route = new GhostRoute(d, this.routeColor, mode);
        this.root.add(this.route.root);
      }
      this.route.root.visible = true;
    } else if (this.route) this.route.root.visible = false;

    // Trail: the last few seconds of path (since the ghost's start), cut at teleports.
    if (o.trail && running) {
      const from = Math.max(d.startTick, t - TRAIL_SECONDS / d.tickInterval);
      const pts = this.trailPts;
      let count = 0;
      const tmp = [0, 0, 0];
      const push = (tt: number) => {
        this.positionAt(tt, tmp);
        pts[count * 3] = tmp[0];
        pts[count * 3 + 1] = tmp[2] + 6;
        pts[count * 3 + 2] = -tmp[1];
        count++;
      };
      const first = Math.ceil(from / TRAIL_STEP) * TRAIL_STEP;
      for (let k = first; k < t && count < 398; k += TRAIL_STEP) {
        if (count > 0 && this.teleportBetween(Math.max(0, k - TRAIL_STEP), k)) count = 0;
        push(k);
      }
      push(t);
      this.trail.set(pts, count, camera, Math.min(1, o.opacity * 1.2), 2.5);
    } else this.trail.clear();

    // Tag above the head; fades when the camera is right next to it.
    const root = this.model.root.position;
    this.tagPos.set(root.x, root.y + (this.pose.crouched ? 62 : 78), root.z);
    const dist = this.tagPos.distanceTo(camera);
    // Tag text (canvas redraw + upload) refreshes at most 10x a second.
    this.tagAge += dt;
    const shown = this.delta === null || elapsed === null ? null : this.delta;
    if (this.tagAge >= 0.1 || (shown === null) !== (this.tagDelta === null)) {
      this.tagAge = 0;
      this.tagDelta = shown;
      this.tag.set(d.track ? `${d.name} · ${trackName(d.track)}` : d.name, formatTime(this.time), shown === null ? null : formatDelta(shown), shown !== null && shown <= 0);
    }
    const seen = o.tag === false ? 0 : this.sight.update(dt, camera, this.tagPos, this.trace, prefs.get().tags.throughWalls);
    this.tag.place(this.tagPos, camera, seen * Math.min(1, Math.max(0, (dist - 50) / 90)) * (elapsed === null ? 0.85 : 1));
  }

  /**
   * Live delta vs this ghost: finds the ghost tick nearest to `pos` (searching near the last match, refined to a
   * fraction of a tick along the path) and returns elapsed time minus the ghost's time there (s; negative = ahead).
   */
  split(pos: readonly number[], elapsedTicks: number): number | null {
    const f = this.d.frames;
    const S = FRAME_STRIDE;
    const lo = Math.max(this.d.startTick, this.lastMatch - 300);
    const hi = Math.min(this.d.endTick, Math.max(this.lastMatch, this.d.startTick) + 600);
    let best = -1;
    let bestD = Infinity;
    for (let t = lo; t <= hi; t++) {
      const o = t * S;
      const dx = f[o] - pos[0];
      const dy = f[o + 1] - pos[1];
      const dz = f[o + 2] - pos[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD) (bestD = dd), (best = t);
    }
    if (best < 0 || bestD > 128 * 128) return null;
    this.lastMatch = best;
    // Project onto the segment toward the better neighbour for sub-tick progress.
    let frac = 0;
    const proj = (a: number, b: number) => {
      const ax = f[a * S], ay = f[a * S + 1], az = f[a * S + 2];
      const sx = f[b * S] - ax, sy = f[b * S + 1] - ay, sz = f[b * S + 2] - az;
      const l2 = sx * sx + sy * sy + sz * sz;
      return l2 > 1e-6 ? ((pos[0] - ax) * sx + (pos[1] - ay) * sy + (pos[2] - az) * sz) / l2 : 0;
    };
    if (best + 1 <= this.d.endTick) {
      const u = proj(best, best + 1);
      if (u > 0) frac = Math.min(1, u);
    }
    if (frac === 0 && best - 1 >= this.d.startTick) {
      const u = proj(best, best - 1);
      if (u > 0) frac = -Math.min(1, u);
    }
    return (elapsedTicks - (best + frac - this.d.startTick)) * this.d.tickInterval;
  }

  resetSplit(): void {
    this.lastMatch = this.d.startTick;
    this.delta = null;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  private offCosmetics: (() => void) | null = null;

  dispose(): void {
    this.sound?.dispose();
    this.offCosmetics?.();
    this.root.removeFromParent();
    this.model.dispose();
    this.trail.dispose();
    this.route?.dispose();
    this.tag.dispose();
  }
}

// ---------------------------------------------------------------------------------------------

export interface GhostHost {
  scene: THREE.Scene;
  /** Main core (only used for loadPB during startup, before the run's first reset). */
  core: Core;
  map: string;
  /** Selected (main-track) style; bonus tracks always use Normal (styles.ts styleForTrack). See GhostManager.setStyle. */
  style: StyleId;
  mapSha256: string;
  settings: Settings;
  bsp: Uint8Array;
  wasmBytes: Uint8Array;
  toast: (msg: string, ms?: number) => void;
  /** PB ghost commands per track changed (HUD ghost keys overlay); null = removed. */
  onPBInputs?: (track: number, inputs: GhostInputs | null) => void;
  /** Compiles a new ghost's programs before it's first drawn (null: they compile in its first frame). */
  renderer?: THREE.WebGLRenderer;
}

const KIND_ORDER: GhostKind[] = ["pb", "wr", "custom"];

export class GhostManager {
  private ghosts = new Map<string, Ghost>();
  private aux: Promise<Core> | null = null;
  /** WR fetch state per `${style}:${track}`. */
  private wr = new Map<string, "loading" | "done">();
  /** Replay commands of each PB ghost (key as `ghosts`), for the HUD ghost keys overlay. */
  private pbInputs = new Map<string, GhostInputs>();
  private hidden = false;
  private last = performance.now();
  private lastStatus = "idle";
  private finishedAt = 0;
  private finishedTicks = 0;
  private lastSplitTick = -1;
  private primaryDelta: number | null = null;
  private camPos = new THREE.Vector3();
  /** The last frame's camera (new ghosts compile for it). */
  private camera: THREE.Camera | null = null;
  private unsub: () => void;
  /** Smoothed cost of frame() in ms (all ghosts: sampling, animation, trail, tags). */
  perf = { ms: 0, max: 0 };

  constructor(private h: GhostHost) {
    this.unsub = onRaceRequest((r) => void this.onRequest(r));
  }

  private key = (kind: GhostKind, style: string, track: number) => `${kind}:${style}:${track}`;

  /** Style whose PB / WR ghosts are raced on `track` (the selected style; Normal on bonus tracks). */
  styleFor(track: number): StyleId {
    return styleForTrack(this.h.style, track);
  }

  get(kind: GhostKind, track: number): Ghost | null {
    return this.ghosts.get(this.key(kind, kind === "custom" ? "*" : this.styleFor(track), track)) ?? null;
  }

  /** A PB ghost for (style, track) is loaded. */
  hasPB(style: string, track: number): boolean {
    return this.ghosts.has(this.key("pb", style, track));
  }

  /** Switches the selected style: PB / WR ghosts of that style become the active ones (HUD ghost keys follow). */
  setStyle(style: StyleId): void {
    this.h.style = style;
    const tracks = new Set([...this.ghosts.values()].filter((g) => g.kind === "pb").map((g) => g.track));
    for (const t of tracks) this.h.onPBInputs?.(t, this.pbInputs.get(this.key("pb", this.styleFor(t), t)) ?? null);
  }

  list(): Ghost[] {
    return [...this.ghosts.values()];
  }

  private put(g: Ghost, inputs?: GhostInputs): Ghost {
    const k = this.key(g.kind, g.d.style, g.track);
    if (g.kind === "pb") {
      if (inputs) this.pbInputs.set(k, inputs);
      else this.pbInputs.delete(k);
      if (g.d.style === this.styleFor(g.track)) this.h.onPBInputs?.(g.track, inputs ?? null);
    }
    this.ghosts.get(k)?.dispose();
    g.audible = true;
    g.trace = (a, b) => traceRay(this.h.core, a, b, 0);
    this.ghosts.set(k, g);
    // Stable render order: each ghost gets its own depth-prepass + colour pair.
    [...this.ghosts.values()].forEach((x, i) => x.setRenderOrder(20 + i * 2));
    this.h.scene.add(g.root);
    g.setVisible(false);
    // Ghosts show from the next start, so their programs have time to compile without blocking a frame.
    if (this.h.renderer) void warmPrograms(this.h.renderer, g.root, this.camera ?? (this.camera = new THREE.PerspectiveCamera()), this.h.scene).catch(() => {});
    return g;
  }

  remove(kind: GhostKind, track?: number): void {
    for (const [k, g] of this.ghosts) {
      if (g.kind === kind && (track === undefined || g.track === track)) {
        if (kind === "pb") {
          this.pbInputs.delete(k);
          if (g.d.style === this.styleFor(g.track)) this.h.onPBInputs?.(g.track, null);
        }
        g.dispose();
        this.ghosts.delete(k);
      }
    }
  }

  // --- Sources ---------------------------------------------------------------------------------

  private fromSim(kind: GhostKind, name: string, replay: Replay, sim: ReturnType<typeof simulate>): Ghost {
    return this.put(
      new Ghost({
        kind,
        track: sim.track,
        style: kind === "custom" ? "*" : replayStyle(replay.header),
        name,
        frames: sim.frames!,
        frameEvents: sim.frameEvents,
        startTick: sim.startTick,
        endTick: sim.endTick,
        tickInterval: Math.fround(replay.header.settings.tickInterval),
        side: replay.side,
        forward: replay.forward,
        cosmetic: replay.cosmetic,
        inspect: replay.inspect,
        loadout: replay.loadout,
      }),
      replay,
    );
  }

  /**
   * A custom ghost straight from recorded positions (FRAME_STRIDE floats per tick: x, y, z, flags, yaw, pitch), e.g. a
   * CS:GO bot replay converted by tools/zones/shavit-replay.ts. Nothing is simulated: it's a positional replay, shown
   * in sync with your timer like any ghost (debug hook `ghostFrames`, dev tooling only).
   */
  fromFrames(name: string, frames: Float32Array, startTick: number, endTick: number, tickInterval: number, track = 0): Ghost {
    return this.put(new Ghost({ kind: "custom", track, style: "*", name, frames, startTick, endTick, tickInterval: Math.fround(tickInterval) }));
  }

  /** PB ghost from a stored replay, re-simulated on the MAIN core. Startup only: the caller resets the core afterwards. */
  async loadPB(bytes: Uint8Array, track: number): Promise<void> {
    const replay = await decodeReplay(bytes);
    if (replay.header.mapSha256 !== this.h.mapSha256) throw new Error("PB replay is for a different map build");
    const sim = simulate(this.h.core, replay, replay.header.zones, { frames: true });
    this.h.core.setSettings(this.h.settings);
    if (!sim.checkpointsMatch || !sim.endTick || sim.track !== track) {
      this.h.toast("Your PB ghost doesn't work on this version.", 6000);
      return;
    }
    this.fromSim("pb", `PB · ${pbName(replay)}`, replay, sim);
  }

  /** Account PB loaded after startup: the auxiliary core leaves the live attempt untouched. */
  async loadSyncedPB(bytes: Uint8Array, track: number, current: () => boolean): Promise<[number, number][] | null> {
    const replay = await decodeReplay(bytes);
    if (!current() || replay.header.mapSha256 !== this.h.mapSha256) return null;
    const core = await this.auxCore();
    if (!current()) return null;
    const sim = simulate(core, replay, replay.header.zones, { frames: true });
    if (!current() || !sim.checkpointsMatch || !sim.endTick || sim.track !== track) return null;
    this.fromSim("pb", `PB · ${pbName(replay)}`, replay, sim);
    return sim.timer.splits.map((s) => [s.index, s.ticks]);
  }

  /** PB ghost straight from the frames recorded live during the run that just set it. */
  setPB(track: number, frames: Float32Array, replay: Replay, startTick: number, endTick: number, frameEvents?: Uint8Array): void {
    this.put(
      new Ghost({
        kind: "pb",
        track,
        style: replayStyle(replay.header),
        name: `PB · ${pbName(replay)}`,
        frames,
        frameEvents,
        startTick,
        endTick,
        tickInterval: Math.fround(this.h.settings.tickInterval),
        side: replay.side,
        forward: replay.forward,
        cosmetic: replay.cosmetic,
        inspect: replay.inspect,
        loadout: replay.loadout,
      }),
      replay,
    );
  }

  /** Second wasm instance (physics only) so ghosts can be re-simulated mid-session without touching the live run. */
  private auxCore(): Promise<Core> {
    this.aux ??= (async () => {
      const c = await Core.create(this.h.wasmBytes as Uint8Array<ArrayBuffer>);
      c.loadMapPhysics(this.h.bsp);
      return c;
    })();
    return this.aux;
  }

  /** Adds a ghost from .bhr bytes (re-simulated on the aux core). Returns null (with a toast) if unusable. */
  async addReplay(bytes: Uint8Array, kind: GhostKind, name?: string): Promise<Ghost | null> {
    let replay: Replay;
    try {
      replay = await decodeReplay(bytes);
    } catch (e) {
      this.h.toast(`Not a replay file: ${(e as Error).message ?? e}`, 5000);
      return null;
    }
    const hd = replay.header;
    if (hd.map !== this.h.map) {
      this.h.toast(`That replay is for ${hd.map}. Load it on that map to race it.`, 5000);
      return null;
    }
    if (hd.mapSha256 !== this.h.mapSha256) this.h.toast("Ghost replay was recorded on a different build of this map", 5000);
    const core = await this.auxCore();
    const sim = simulate(core, replay, hd.zones, { frames: true });
    if (!sim.checkpointsMatch) {
      console.warn(`ghost: replay desyncs at tick ${sim.firstMismatchTick}`);
      this.h.toast("That ghost doesn't play back on this version.", 6000);
      return null;
    }
    if (!sim.endTick) {
      this.h.toast("That ghost never finishes, so it's hidden.", 5000);
      return null;
    }
    const label = name ?? (kind === "wr" ? `WR · ${hd.player}` : hd.player);
    return this.fromSim(kind, label, replay, sim);
  }

  /** Fetches and races the server WR of a track in the current style (once per style and track per session). */
  private async ensureWR(track: number): Promise<void> {
    const style = this.styleFor(track);
    const wk = `${style}:${track}`;
    if (this.wr.has(wk)) return;
    this.wr.set(wk, "loading");
    try {
      const top = await worldRecord(this.h.map, style, track);
      if (!top) return;
      const bytes = await api.replay(top.runId);
      await this.addReplay(bytes, "wr", `WR · ${top.player.name}`);
    } catch (e) {
      console.warn("WR ghost:", e);
    } finally {
      this.wr.set(wk, "done");
    }
  }

  private async onRequest(r: RaceRequest): Promise<void> {
    if (r.kind === "clear") return this.remove("custom");
    let bytes: Uint8Array;
    let name: string | undefined;
    if (r.kind === "run") {
      try {
        bytes = await api.replay(r.runId);
      } catch {
        this.h.toast("Couldn't download that run's replay", 5000);
        return;
      }
      name = r.name;
    } else {
      bytes = r.bytes;
      name = r.name;
    }
    this.remove("custom");
    const g = await this.addReplay(bytes, "custom", name);
    if (g) {
      this.h.toast(`Racing ${g.d.name} (${formatTime(g.time)})${g.track ? " on " + trackName(g.track) : ""}`, 4000);
      if (!prefs.get().ghost.custom || !prefs.get().showGhost) prefs.update((p) => ((p.ghost.custom = true), (p.showGhost = true)));
    }
  }

  // --- Run events ------------------------------------------------------------------------------

  onRunStart(): void {
    for (const g of this.ghosts.values()) g.resetSplit();
    this.primaryDelta = null;
    this.lastSplitTick = -1;
  }

  onReset(): void {
    this.onRunStart();
  }

  /** Hidden while watching a replay. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) for (const g of this.ghosts.values()) g.setVisible(false);
  }

  // --- Per frame -------------------------------------------------------------------------------

  /**
   * Updates all ghosts for the current run state. Returns the HUD split (primary ghost delta) or null.
   * pos: player position (Source); camera: the render camera.
   */
  frame(timer: RunTimer, alpha: number, pos: readonly number[], camera: THREE.Camera | null): number | null {
    if (camera) this.camera = camera;
    const t0 = performance.now();
    const dt = Math.min(0.1, (t0 - this.last) / 1000);
    this.last = t0;
    const p = prefs.get();
    const gp = p.ghost;
    const track = timer.track;
    const style = this.styleFor(track);
    if (gp.wr && p.showGhost && api.available() && !this.wr.has(`${style}:${track}`) && !this.hidden) void this.ensureWR(track);

    // Elapsed ticks: running = live timer; finished = keep the ghosts running to their own finish; idle = parked.
    if (timer.status === "finished" && this.lastStatus !== "finished") {
      this.finishedAt = t0;
      this.finishedTicks = timer.ticks();
    }
    this.lastStatus = timer.status;
    const elapsed =
      timer.status === "running" ? timer.ticks() + alpha : timer.status === "finished" ? this.finishedTicks + (t0 - this.finishedAt) / 1000 / timer.tickInterval : null;
    if (camera) camera.getWorldPosition(this.camPos);

    // Live deltas every 4 ticks (all ghosts on this track); the HUD uses the primary one.
    const doSplit = timer.status === "running" && (this.lastSplitTick < 0 || Math.abs(timer.ticks() - this.lastSplitTick) >= 4);
    if (doSplit) this.lastSplitTick = timer.ticks();
    let primary: Ghost | null = null;
    // No name tags while the UI is hidden (ui/hide-ui.ts); the ghosts themselves stay.
    const hideUi = uiHidden();
    const look = hideUi ? { ...gp, tag: false } : gp;
    const routeKind = gp.route && !hideUi && !this.hidden && p.showGhost ? routeGhostKind(gp.routeSource, KIND_ORDER.filter((kind) => gp[kind] && !!this.get(kind, track))) : null;
    for (const g of this.ghosts.values()) {
      const vis = !this.hidden && p.showGhost && gp[g.kind] && g.track === track && (g.d.style === "*" || g.d.style === style);
      g.setVisible(vis);
      if (!vis) continue;
      if (doSplit) {
        const s = g.split(pos, timer.ticks());
        if (s !== null) g.delta = s;
      } else if (timer.status === "finished") {
        g.delta = (timer.ticks() - g.ticks) * timer.tickInterval;
      } else if (timer.status === "idle") g.delta = null;
      g.update(elapsed, dt, this.camPos, gp.route ? { ...look, route: g.kind === routeKind } : look);
      if (!primary || KIND_ORDER.indexOf(g.kind) < KIND_ORDER.indexOf(primary.kind)) primary = g;
    }
    this.primaryDelta = primary?.delta ?? null;
    const ms = performance.now() - t0;
    this.perf.ms += (ms - this.perf.ms) * 0.05;
    this.perf.max = Math.max(this.perf.max * 0.999, ms);
    return timer.status === "idle" ? null : this.primaryDelta;
  }

  /** Current tick of the PB ghost on `track` (HUD ghost keys overlay), or null when it isn't shown. */
  pbTick(track: number): number | null {
    const g = this.get("pb", track);
    return g && !this.hidden && prefs.get().ghost.pb ? g.tick : null;
  }

  /** The ghost the HUD split is measured against (for labels). */
  primaryKind(track: number): GhostKind | null {
    const p = prefs.get();
    for (const k of KIND_ORDER) if (p.showGhost && p.ghost[k] && this.get(k, track)) return k;
    return null;
  }

  dispose(): void {
    this.unsub();
    for (const g of this.ghosts.values()) g.dispose();
    this.ghosts.clear();
  }
}
