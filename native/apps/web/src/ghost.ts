// Race ghosts: faded player models replaying a run in sync with your timer.
//
// Sources (any combination, each per track): your PB (local IndexedDB), the server WR (api.leaderboard + api.replay),
// and a custom ghost (a loaded .bhr file or any leaderboard run, via player/race.ts requests).
// Every ghost is a re-simulated replay (exact per-tick frames), so it starts on the exact tick your timer starts
// (leaving the start zone), waits at its start line while you sit in the start zone, and keeps running to its own
// finish after you finish. Each shows a name/time tag with a live delta (progress along its path, closest-pos.ts) and an
// optional fading trail. The HUD split and speed difference use the primary ghost (Settings → Ghost → Compare with:
// by default PB, else WR, else custom).

import * as THREE from "three";
import { api, lastKnownMe } from "./api";
import { worldRecord } from "./shared-reads";
import { traceRay, type Core, type Settings } from "./core";
import type { GhostSim, MapPhysics } from "./map-physics";
import { formatDelta, type GhostInputs } from "./hud";
import { GHOST_COLORS, GHOST_CSS, type GhostKind } from "./player/colors";
import { getGhostCosmetics, onGhostCosmetics } from "./player/cosmetics";
import { PlayerModel, type PlayerPose } from "./player/model";
import { onRaceRequest, type RaceRequest } from "./player/race";
import { NameTag, TagSight, type SightTrace } from "./player/tag";
import { probeFromTrace } from "./player/bunny/legs";
import { Trail, trailShapeOf } from "./player/trail";
import { DEFAULT_LOADOUT, type CosmeticLoadout } from "./loadout";
import { cosmeticBetween, decodeReplay, inspectBetween, replayStyle, type CosmeticEvent, type Replay } from "./replay";
import { styleForTrack, type StyleId } from "./styles";
import { FRAME_CROUCHED, FRAME_GROUNDED, FRAME_LADDER, FRAME_STRIDE } from "./sim";
import { TickStepper, type TickSource } from "./player/tick-stepper";
import { mapVolumes, recordedModes, type MapVolumes } from "./player/map-volumes";
import { formatTime, type RunTimer } from "./timer";
import { uiHidden } from "./ui/hide-ui";
import { prefs } from "./ui/settings";
import { trackName } from "./zones";
import { SpatialMover } from "./audio";
import { GhostRoute } from "./ghost-route";
import { warmPrograms } from "./graphics/warm-programs";
import { ghostPlan, type GhostRouteMode } from "./ghost-route-data";
import { ClosestPos } from "./closest-pos";

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
  /** Route only: hide the model, trail, tag and sounds; the route (with `route`) and the split stay. */
  routeOnly?: boolean;
}

const TRAIL_SECONDS = 2.5;
const TRAIL_STEP = 2; // ticks between trail samples
/** Route frames of a ghost's search index built per rendered frame (closest-pos.ts). A fraction of a millisecond at worst. */
const CLOSEST_BUILD_SLICE = 2048;
/** The speed difference changes this often (s), like shavit's 10 Hz: readable, where every tick is a blur. */
const SPEED_DIFF_EVERY = 0.1;

export class Ghost {
  readonly root = new THREE.Group();
  readonly model: PlayerModel;
  private trail: Trail;
  private route: GhostRoute | null = null;
  private routeColor: THREE.ColorRepresentation;
  private tag: NameTag;
  /** The closest-position search on this ghost's route (made on first use: menu backgrounds never need it). */
  private closest: ClosestPos | null = null;
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
  private sightTrace: SightTrace | null = null;
  /** World line of sight (tags) and the ground under the feet (planting on slopes, player/bunny/legs.ts). */
  get trace(): SightTrace | null {
    return this.sightTrace;
  }
  set trace(t: SightTrace | null) {
    this.sightTrace = t;
    this.model.setGroundProbe(t ? probeFromTrace(t) : null);
  }
  /** Player time minus ghost time at the same point on its path (seconds; negative = you're ahead). */
  delta: number | null = null;
  /** The ghost's horizontal speed at the last match of split() (u/s); NaN: no match, or its route teleports there. */
  matchSpeed = NaN;
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
    this.trail = new Trail(mine?.trail ?? color, undefined, mine?.trail2, trailShapeOf(mine?.shapeId));
    this.tag = new NameTag(mine?.ghost ?? GHOST_CSS[d.kind]);
    if (mine)
      this.offCosmetics = onGhostCosmetics((c) => {
        this.model.setStyle("ghost", c.ghost, undefined, c.ghost2);
        this.trail.setColor(c.trail, c.trail2);
        this.trail.setShape(trailShapeOf(c.shapeId));
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

  /** The map's water for the swim mode (player/map-volumes.ts); null = the loaded map's (the menu background sets its own). */
  volumes: MapVolumes | null = null;
  private stepper = new TickStepper();
  private wasMoving = false;
  private tickSrc: TickSource | null = null;

  /** The ghost's frames as a TickSource (the TickStepper's whole-tick poses, pre-roll, teleports). */
  private tickSource(): TickSource {
    return (this.tickSrc ??= {
      interval: this.d.tickInterval,
      n: this.frameCount - 1,
      poseAt: (k) => {
        const q = this.sample(k, true);
        return { ...q, position: [...this.pose.position], velocity: [...this.pose.velocity] };
      },
      prerollTo: (k) => {
        // The ghost's last 0.6 s before tick k, stopping at a teleport.
        const ticks = 1 / this.d.tickInterval;
        let from = Math.max(0, k - 0.6 * ticks);
        for (let j = k; j > from && j > 0; j--) if (this.teleportBetween(j - 1, j)) from = j;
        return (u) => {
          const tt = k - u * ticks;
          if (tt < from) return null;
          const q = this.sample(tt, true);
          return { ...q, position: [...this.pose.position], velocity: [...this.pose.velocity] };
        };
      },
      teleported: (k) => k > 0 && this.teleportBetween(k - 1, k),
    });
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
    // Climbing from the frames (FRAME_LADDER), swimming from the map's water (player/map-volumes.ts).
    const modes = recordedModes((flags & FRAME_LADDER) !== 0, p.position, p.crouched, this.volumes ?? mapVolumes());
    p.ladder = modes.ladder;
    p.water = modes.water;
    // The tick's own ground flag: showAt steps the model through every tick crossed (advanceModel), so it sees a bhop's
    // one-tick contact at any frame rate.
    p.grounded = (flags & FRAME_GROUNDED) !== 0;
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
    if (snapped) this.sight.reset();
    const live = moving && this.lastT >= 0 && t > this.lastT && t - this.lastT < 50;
    // touched: any frame tick since the last frame on the ground (footsteps: a bhop's contact lasts one tick).
    let touched = false;
    if (live) for (let k = Math.floor(this.lastT) + 1; k <= Math.floor(t) && !touched; k++) touched = (d.frames[k * FRAME_STRIDE + 3] & FRAME_GROUNDED) !== 0;
    const only = o.routeOnly === true;
    this.model.root.visible = !only;
    this.model.setOpacity(o.opacity);
    this.model.setNearFade(o.nearFade ? 14 : 0, o.nearFade ? 64 : 0);
    if (moving) {
      // On the ghost's clock (viewer/player.ts TickStepper): the model updates on each frame tick's own pose and blends
      // between ticks, so its pose at a ghost time doesn't depend on the frame rate; a seek or a start pre-rolls.
      const ins = live ? inspectBetween(d.inspect, Math.floor(this.lastT), Math.floor(t)) : null;
      const events = { attack: live ? cosmeticBetween(d.cosmetic, Math.floor(this.lastT), Math.floor(t)) : 0, inspect: ins?.sig ?? 0, inspectHeld: ins?.held ?? false };
      this.stepper.show(this.model, this.tickSource(), t, snapped || this.lastT < 0 || !this.wasMoving, events);
    } else {
      if (snapped) this.model.snap();
      this.stepper.reset();
    }
    this.wasMoving = moving;
    const pose = this.sample(t, moving);
    touched ||= pose.grounded;
    if (!moving) {
      this.model.setState(pose);
      this.model.update(dt);
    }
    if (this.audible && moving && !only && prefs.get().audio.ghosts) (this.sound ??= new SpatialMover(0.45)).update(dt, this.pose.position, this.pose.velocity, touched, pose.crouched, false, snapped || this.lastT < 0);
    else this.sound?.moves.reset();
    this.lastT = t;
    this.tick = Math.floor(t);

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
    if (o.trail && running && !only) {
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
      // The sample the trail starts at: shapes laid per sample (player/trail.ts) stay where they were laid.
      let start = first;
      for (let k = first; k < t && count < 398; k += TRAIL_STEP) {
        if (count > 0 && this.teleportBetween(Math.max(0, k - TRAIL_STEP), k)) count = 0;
        if (!count) start = k;
        push(k);
      }
      push(t);
      this.trail.set(pts, count, camera, Math.min(1, o.opacity * 1.2), 2.5, start / TRAIL_STEP);
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
    const seen = o.tag === false || only ? 0 : this.sight.update(dt, camera, this.tagPos, this.trace, prefs.get().tags.throughWalls);
    this.tag.place(this.tagPos, camera, seen * Math.min(1, Math.max(0, (dist - 50) / 90)) * (elapsed === null ? 0.85 : 1));
  }

  private get search(): ClosestPos {
    return (this.closest ??= new ClosestPos(this.d.frames, this.d.startTick, this.d.endTick, this.d.tickInterval, this.d.frameEvents));
  }

  /** Builds the route search's index, `maxFrames` route frames' worth at most, so a long replay costs no frame. */
  prepareSplit(maxFrames = Infinity): void {
    const c = this.search;
    if (!c.ready) c.build(maxFrames);
  }

  /**
   * Live delta vs this ghost: finds the closest point on its route to `pos` (near the last match, closest-pos.ts) and
   * returns elapsed time minus the ghost's time there (s; negative = ahead). Null: nowhere near the route. Allocates nothing.
   */
  split(pos: readonly number[], elapsedTicks: number): number | null {
    const c = this.search;
    if (!c.find(pos[0], pos[1], pos[2])) {
      this.matchSpeed = NaN;
      return null;
    }
    this.matchSpeed = c.speed;
    return (elapsedTicks - (c.tick - this.d.startTick)) * this.d.tickInterval;
  }

  resetSplit(): void {
    this.closest?.reset();
    this.delta = null;
    this.matchSpeed = NaN;
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
  /** Main core (the ghosts' name tag sight traces). */
  core: Core;
  map: string;
  /** Selected style (styles.ts styleForTrack: every track but the tutorial's final course). See GhostManager.setStyle. */
  style: StyleId;
  mapSha256: string;
  settings: Settings;
  /** The map's worker core: every ghost's re-simulation runs there, never on the main thread. */
  physics: Pick<MapPhysics, "ghost">;
  toast: (msg: string, ms?: number) => void;
  /** PB ghost commands per track changed (HUD ghost keys overlay); null = removed. */
  onPBInputs?: (track: number, inputs: GhostInputs | null) => void;
  /** Compiles a new ghost's programs before it's first drawn (null: they compile in its first frame). */
  renderer?: THREE.WebGLRenderer;
}

const KIND_ORDER: GhostKind[] = ["pb", "wr", "custom"];

export class GhostManager {
  private ghosts = new Map<string, Ghost>();
  /** WR fetch state per `${style}:${track}`. */
  private wr = new Map<string, "loading" | "done">();
  /** Replay commands of each PB ghost (key as `ghosts`), for the HUD ghost keys overlay. */
  private pbInputs = new Map<string, GhostInputs>();
  private viewing = false;
  private lessons = false;
  /** No ghosts at all (and so no split): watching a replay, or in a tutorial lesson. */
  private get hidden(): boolean {
    return this.viewing || this.lessons;
  }
  private last = performance.now();
  private lastStatus = "idle";
  private finishedAt = 0;
  private finishedTicks = 0;
  private lastSplitTick = -1;
  private lastSpeedTick = -1;
  private primaryDelta: number | null = null;
  /** Your speed minus the primary ghost's at the closest point on its route (u/s). Null: nothing to compare. */
  speedDelta: number | null = null;
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

  /** Style whose PB / WR ghosts are raced on `track` (the selected style; styles.ts styleForTrack). */
  styleFor(track: number): StyleId {
    return styleForTrack(this.h.style, track, this.h.map);
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

  private fromSim(kind: GhostKind, name: string, replay: Replay, sim: GhostSim): Ghost {
    return this.put(
      new Ghost({
        kind,
        track: sim.track,
        style: kind === "custom" ? "*" : replayStyle(replay.header),
        name,
        frames: sim.frames,
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

  /** The PB ghost of `track` from its stored replay, re-simulated on the worker core (the live attempt is untouched). */
  async loadSyncedPB(bytes: Uint8Array, track: number, current: () => boolean): Promise<[number, number][] | null> {
    const replay = await decodeReplay(bytes);
    if (!current() || replay.header.mapSha256 !== this.h.mapSha256) return null;
    const sim = await this.h.physics.ghost(bytes);
    if (!current() || !sim.checkpointsMatch || !sim.endTick || sim.track !== track) return null;
    this.fromSim("pb", `PB · ${pbName(replay)}`, replay, sim);
    return sim.splits;
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

  /** Adds a ghost from .bhr bytes (re-simulated on the worker core). Returns null (with a toast) if unusable. */
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
    const sim = await this.h.physics.ghost(bytes);
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
    this.lastSpeedTick = -1;
    this.speedDelta = null;
  }

  onReset(): void {
    this.onRunStart();
  }

  /** Hidden while watching a replay. */
  setHidden(hidden: boolean): void {
    this.viewing = hidden;
    if (hidden) for (const g of this.ghosts.values()) g.setVisible(false);
  }

  /** Hidden in the tutorial's lessons (tutorial/mode.ts): the demo ghost is the only one there until the final course. */
  setLessons(on: boolean): void {
    this.lessons = on;
    if (on) for (const g of this.ghosts.values()) g.setVisible(false);
  }

  // --- Per frame -------------------------------------------------------------------------------

  /**
   * Updates all ghosts for the current run state. Returns the HUD split (primary ghost delta) or null.
   * pos: player position (Source); camera: the render camera; playerSpeed: horizontal speed over the last tick's move
   * (u/s, what the ghost's is measured from), null if there is none. speedDelta is set from it.
   */
  frame(timer: RunTimer, alpha: number, pos: readonly number[], camera: THREE.Camera | null, playerSpeed: number | null = null): number | null {
    if (camera) this.camera = camera;
    const t0 = performance.now();
    const dt = Math.min(0.1, (t0 - this.last) / 1000);
    this.last = t0;
    const p = prefs.get();
    const gp = p.ghost;
    const track = timer.track;
    const style = this.styleFor(track);
    const hideUi = uiHidden();
    const plan = ghostPlan(p, KIND_ORDER.filter((kind) => !!this.get(kind, track)), this.hidden, hideUi);
    if (plan.fetchWR && api.available() && !this.wr.has(`${style}:${track}`)) void this.ensureWR(track);

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
    const look: GhostLook = hideUi ? { ...gp, tag: false } : gp;
    const { routeKind, routeOnlyKind } = plan;
    const compare = gp.compare;
    for (const g of this.ghosts.values()) {
      const vis = !this.hidden && p.showGhost && gp[g.kind] && g.track === track && (g.d.style === "*" || g.d.style === style);
      g.setVisible(vis);
      if (!vis) continue;
      g.prepareSplit(CLOSEST_BUILD_SLICE);
      if (doSplit) {
        const s = g.split(pos, timer.ticks());
        if (s !== null) g.delta = s;
      } else if (timer.status === "finished") {
        g.delta = (timer.ticks() - g.ticks) * timer.tickInterval;
      } else if (timer.status === "idle") g.delta = null;
      g.update(elapsed, dt, this.camPos, gp.route || gp.routeOnly ? { ...look, route: g.kind === routeKind, routeOnly: g.kind === routeOnlyKind } : look);
      if (compare === "auto" ? !primary || KIND_ORDER.indexOf(g.kind) < KIND_ORDER.indexOf(primary.kind) : g.kind === compare) primary = g;
    }
    this.primaryDelta = primary?.delta ?? null;
    if (!primary || timer.status !== "running") this.speedDelta = null;
    else if (doSplit && (this.lastSpeedTick < 0 || Math.abs(timer.ticks() - this.lastSpeedTick) >= SPEED_DIFF_EVERY / timer.tickInterval)) {
      this.lastSpeedTick = timer.ticks();
      const ghostSpeed = primary.matchSpeed;
      if (ghostSpeed !== ghostSpeed) this.speedDelta = null;
      else if (playerSpeed !== null) this.speedDelta = playerSpeed - ghostSpeed;
    }
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
