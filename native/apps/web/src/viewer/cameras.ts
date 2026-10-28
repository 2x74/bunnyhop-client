// Spectator cameras (CS:S observer modes) for the replay viewer, the MP4 export and live third person.
//
//   eye    OBS_MODE_IN_EYE: the player's exact view, interpolated between ticks.
//   chase  OBS_MODE_CHASE / `thirdperson`: behind and above the player's eye, following their view yaw (smoothed),
//          optional mouse orbit locked to the player. CS:S baseline: CHASE_CAM_DISTANCE 96 units, the hull trace
//          (WALL_OFFSET 6) pulls the camera in when blocked and it eases back out (C_BasePlayer::CalcChaseCamView).
//   free   OBS_MODE_ROAMING: noclip fly, WASD + mouse, Shift faster, Space/Ctrl (or E/Q) up/down.
//   flyby  "free path": a deterministic drone that trails the run beside and above the player, looking at them.
// SpectatorCamera bundles eye / chase / free / flyby for any target state stream (live spectating reuses it);
// CameraRig adds the replay-only
//   auto   auto-director: a precomputed shot list (chase, in-eye, fixed tripods with line of sight, flyby) cut every
//          few seconds.
//
// Everything that runs during export takes dt explicitly and reads no clock, so a render is reproducible.
// Positions are Source space (z up); three.js space is (x, z, -y).

import * as THREE from "three";
import { F_TELEPORTED, sampleAt, type RunData, type ViewSample } from "./player";

export type CamMode = "eye" | "chase" | "free" | "flyby" | "auto";
export const CAM_MODES: { id: CamMode; label: string; key: string; title: string }[] = [
  { id: "eye", label: "In-eye", key: "1", title: "First person: the player's exact view" },
  { id: "chase", label: "Chase", key: "2", title: "Third person behind the player (drag to orbit, wheel to zoom, double-click to reset)" },
  { id: "free", label: "Free", key: "3", title: "Free roam: click to fly (WASD + mouse, Shift fast, Space/Ctrl up/down)" },
  { id: "flyby", label: "Flyby", key: "4", title: "Cinematic drone following the run" },
  { id: "auto", label: "Auto", key: "5", title: "Auto-director: cuts between chase, in-eye, tripod and flyby shots" },
];

/** Line-of-sight trace: fraction 0..1 of start->end that is clear for a cube of half-size radius. */
export type TraceFn = (start: ArrayLike<number>, end: ArrayLike<number>, radius: number) => number;

const D2R = Math.PI / 180;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Source point -> three.js vector. */
export function toThree(p: ArrayLike<number>, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p[0], p[2], -p[1]);
}

/** Places a camera at a Source-space eye position with Source view angles (degrees). */
export function setEye(camera: THREE.PerspectiveCamera, p: ArrayLike<number>, yaw: number, pitch: number): void {
  camera.position.set(p[0], p[2], -p[1]);
  camera.rotation.order = "YXZ";
  camera.rotation.set((-pitch * Math.PI) / 180, ((yaw - 90) * Math.PI) / 180, 0);
}

const tmpT = new THREE.Vector3();
/** Camera at `from` looking at `at` (both Source space). */
export function lookFrom(camera: THREE.PerspectiveCamera, from: ArrayLike<number>, at: ArrayLike<number>): void {
  toThree(from, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(toThree(at, tmpT));
}

/**
 * What a spectator camera follows: one player's (interpolated) state for the rendered frame. The replay viewer feeds
 * replay samples; live spectating can feed any player's snapshot stream (viewer/player.ts ViewSample satisfies it).
 */
export interface SpectatorTarget {
  /** Feet position (Source units). */
  pos: ArrayLike<number>;
  /** Velocity (units/s). */
  vel: ArrayLike<number>;
  /** Eye height above the feet (64 standing, ~46 crouched; the sim eases it on duck). */
  viewZ: number;
  /** View angles, degrees. */
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
}

/** Eye point of a target. */
export function eyeOf(s: SpectatorTarget, out: number[] = [0, 0, 0]): number[] {
  out[0] = s.pos[0];
  out[1] = s.pos[1];
  out[2] = s.pos[2] + s.viewZ;
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface ChaseOptions {
  /** Ideal distance behind the pivot (CS:S CHASE_CAM_DISTANCE_MAX 96). */
  distance?: number;
  /** Camera pitch in degrees (down is positive), before orbit. */
  pitch?: number;
  /** Pivot = eye height minus this (CS:S chase cams orbit a point a little below the eyes). */
  eyeDrop?: number;
  /** How fast the camera yaw follows the player's view yaw (1/s): the slight lag of a spectator chase cam. */
  followRate?: number;
  /** How fast the pivot height follows eye height changes (crouch / uncrouch), 1/s. */
  heightRate?: number;
  /**
   * How fast the pivot follows the player's vertical position (1/s; 0 = rigid). A little vertical lag lets each hop
   * read as a rise and fall in frame instead of the whole view bobbing with the player.
   */
  zRate?: number;
}

/**
 * Eases eye-height steps the way a CS:S spectator's interpolated view of another player does: an airborne duck or
 * unduck shifts the origin and the view offset within one tick, which would pop the camera. The step becomes an
 * offset that decays over ~0.1 s (cl_interp). Ground ducks already ease in the sim (0.4 s) and pass through untouched.
 */
export class EyeSmoother {
  private lastZ = NaN;
  private lastView = 0;
  private lastCrouch = false;
  /** Current correction (units) to add to the eye / pivot height. */
  err = 0;

  snap(): void {
    this.lastZ = NaN;
    this.err = 0;
  }

  update(s: SpectatorTarget, dt: number): number {
    if (Number.isNaN(this.lastZ)) this.err = 0;
    else if (dt > 0) {
      const dv = s.viewZ - this.lastView;
      if (Math.abs(dv) > Math.max(1.5, 120 * dt)) this.err -= dv;
      if (s.crouched !== this.lastCrouch) {
        const dz = s.pos[2] - this.lastZ;
        if (Math.abs(dz) > 3 && Math.abs(dz) < 40) this.err -= dz;
      }
      this.err = clamp(this.err * Math.exp(-dt / 0.05), -40, 40);
      if (Math.abs(this.err) < 0.01) this.err = 0;
    }
    this.lastZ = s.pos[2];
    this.lastView = s.viewZ;
    this.lastCrouch = s.crouched;
    return this.err;
  }
}

/** OBS_MODE_CHASE: behind the player's view yaw, slightly above, collision-aware. */
export class ChaseCam {
  orbitYaw = 0;
  orbitPitch = 0;
  zoom = 1;
  private yaw = NaN;
  private pitchS = NaN;
  private dist = NaN;
  private height = NaN;
  private z = NaN;
  private o: Required<ChaseOptions>;
  private pivot = [0, 0, 0];
  private want = [0, 0, 0];
  readonly position = [0, 0, 0];

  constructor(o: ChaseOptions = {}) {
    this.o = { distance: 96, pitch: 14, eyeDrop: 8, followRate: 7, heightRate: 9, zRate: 10, ...o };
  }

  /** Forget smoothing (after seeks/cuts). */
  snap(): void {
    this.yaw = NaN;
  }

  resetOrbit(): void {
    this.orbitYaw = this.orbitPitch = 0;
    this.zoom = 1;
  }

  orbit(dx: number, dy: number): void {
    this.orbitYaw = wrap180(this.orbitYaw - dx * 0.3);
    this.orbitPitch = clamp(this.orbitPitch + dy * 0.25, -40, 70);
  }

  zoomBy(f: number): void {
    this.zoom = clamp(this.zoom * f, 0.4, 5);
  }

  update(camera: THREE.PerspectiveCamera, s: SpectatorTarget, dt: number, trace: TraceFn | null, eyeErr = 0): void {
    const o = this.o;
    const snap = Number.isNaN(this.yaw);
    const eye = s.viewZ - o.eyeDrop + eyeErr;
    // Vertical follow: lags a little (zRate), snaps across teleports.
    if (snap || Number.isNaN(this.z) || o.zRate <= 0 || Math.abs(s.pos[2] - this.z) > 160) this.z = s.pos[2];
    else this.z += (s.pos[2] - this.z) * damp(o.zRate, dt);
    if (snap) {
      this.yaw = s.yaw;
      this.pitchS = s.pitch;
      this.height = eye;
    } else {
      // Spectator feel: the yaw trails the player's view slightly; crouch / uncrouch eases the pivot height.
      this.yaw += wrap180(s.yaw - this.yaw) * damp(o.followRate, dt);
      this.pitchS += (s.pitch - this.pitchS) * damp(o.followRate * 0.5, dt);
      this.height += (eye - this.height) * damp(o.heightRate, dt);
    }
    const yaw = (this.yaw + this.orbitYaw) * D2R;
    // Mostly level, with a little of the player's own pitch so looking down at a jump tilts the view a bit.
    const pitch = clamp(o.pitch + this.orbitPitch + this.pitchS * 0.15, -60, 80) * D2R;
    const p = this.pivot;
    p[0] = s.pos[0];
    p[1] = s.pos[1];
    p[2] = this.z + this.height;
    const ideal = o.distance * this.zoom;
    const w = this.want;
    w[0] = p[0] - Math.cos(yaw) * Math.cos(pitch) * ideal;
    w[1] = p[1] - Math.sin(yaw) * Math.cos(pitch) * ideal;
    w[2] = p[2] + Math.sin(pitch) * ideal;
    // CS:S: a WALL_OFFSET hull trace pulls the camera in instantly; it eases back out when the way clears.
    const frac = trace ? trace(p, w, 6) : 1;
    const target = Math.max(4, ideal * frac - 2);
    if (snap || Number.isNaN(this.dist) || target < this.dist) this.dist = target;
    else this.dist += (target - this.dist) * damp(3, dt);
    const k = this.dist / ideal;
    for (let i = 0; i < 3; i++) this.position[i] = p[i] + (w[i] - p[i]) * k;
    lookFrom(camera, this.position, p);
  }
}

// ---------------------------------------------------------------------------------------------

/** OBS_MODE_ROAMING noclip camera. Interactive only: the viewer feeds mouse deltas and held keys. */
export class FreeCam {
  pos = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  readonly keys = new Set<string>();

  set(pos: ArrayLike<number>, yaw: number, pitch: number): void {
    this.pos = [pos[0], pos[1], pos[2]];
    this.yaw = yaw;
    this.pitch = pitch;
  }

  look(dx: number, dy: number, sens = 0.12): void {
    this.yaw = wrap180(this.yaw - dx * sens);
    this.pitch = clamp(this.pitch + dy * sens, -89, 89);
  }

  update(camera: THREE.PerspectiveCamera, dt: number): void {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const fast = k("ShiftLeft") || k("ShiftRight");
    const slow = k("AltLeft");
    const speed = (fast ? 1600 : slow ? 120 : 500) * dt;
    const y = this.yaw * D2R;
    const p = this.pitch * D2R;
    const fwd = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
    const right = [Math.sin(y), -Math.cos(y), 0];
    const f = k("KeyW") - k("KeyS");
    const r = k("KeyD") - k("KeyA");
    const u = k("Space") + k("KeyE") - k("ControlLeft") - k("KeyQ") - k("KeyC");
    for (let i = 0; i < 3; i++) this.pos[i] += (fwd[i] * f + right[i] * r) * speed;
    this.pos[2] += u * speed;
    setEye(camera, this.pos, this.yaw, this.pitch);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * "Free path" flyby: a critically damped drone that trails the player's direction of travel, beside and above them,
 * and always looks at them. Deterministic for a given dt sequence.
 */
export class FlybyCam {
  private pos = [NaN, 0, 0];
  private vel = [0, 0, 0];
  private heading = NaN;
  private look = [0, 0, 0];
  side = 1;

  snap(): void {
    this.pos[0] = NaN;
  }

  update(camera: THREE.PerspectiveCamera, s: SpectatorTarget, dt: number, trace: TraceFn | null): void {
    const sp = Math.hypot(s.vel[0], s.vel[1]);
    const travel = sp > 60 ? Math.atan2(s.vel[1], s.vel[0]) / D2R : s.yaw;
    if (Number.isNaN(this.heading) || Number.isNaN(this.pos[0])) this.heading = travel;
    else this.heading += wrap180(travel - this.heading) * damp(1.6, dt);
    const h = this.heading * D2R;
    const back = 150 + Math.min(120, sp * 0.12);
    const pivot = [s.pos[0], s.pos[1], s.pos[2] + 48];
    const want = [
      pivot[0] - Math.cos(h) * back + Math.sin(h) * 95 * this.side,
      pivot[1] - Math.sin(h) * back - Math.cos(h) * 95 * this.side,
      pivot[2] + 70,
    ];
    if (trace) {
      const f = trace(pivot, want, 8);
      for (let i = 0; i < 3; i++) want[i] = pivot[i] + (want[i] - pivot[i]) * Math.max(0.15, f - 0.02);
    }
    if (Number.isNaN(this.pos[0])) {
      this.pos = [...want];
      this.vel = [0, 0, 0];
      this.look = [...pivot];
    } else {
      // Critically damped spring (omega 3.2 rad/s) toward the wanted point.
      const w = 3.2;
      for (let i = 0; i < 3; i++) {
        const x = this.pos[i] - want[i];
        const a = -w * w * x - 2 * w * this.vel[i];
        this.vel[i] += a * dt;
        this.pos[i] += this.vel[i] * dt;
      }
      // If the spring cut through a wall, drop back to the traced point.
      if (trace && trace(pivot, this.pos, 4) < 0.98) for (let i = 0; i < 3; i++) (this.pos[i] = want[i]), (this.vel[i] = 0);
      for (let i = 0; i < 3; i++) this.look[i] += (pivot[i] - this.look[i]) * damp(9, dt);
    }
    lookFrom(camera, this.pos, this.look);
  }
}

// ---------------------------------------------------------------------------------------------

export type ShotKind = "chase" | "eye" | "tripod" | "flyby";
export interface Shot {
  from: number;
  to: number;
  kind: ShotKind;
  /** Tripod camera position (Source). */
  at?: [number, number, number];
}

/**
 * Auto-director shot list over [from, to] ticks: cuts every 2.5-5 s, cycling shot kinds, with tripods placed ahead of
 * the player where they keep line of sight to the path for the whole shot. Deterministic for a given replay.
 */
export function directShots(d: RunData, from: number, to: number, trace: TraceFn | null): Shot[] {
  const shots: Shot[] = [];
  const rate = d.tickrate;
  const cycle: ShotKind[] = ["chase", "tripod", "eye", "flyby", "tripod", "chase", "flyby", "tripod"];
  let t = from;
  let k = 0;
  let seed = (d.n * 2654435761) >>> 0;
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  while (t < to) {
    let len = Math.round((2.5 + rnd() * 2.5) * rate);
    // Cut on a teleport if one happens in the shot (a tripod can't follow it anyway).
    for (let i = t + rate; i < Math.min(to, t + len); i++) {
      if (d.flags[i] & F_TELEPORTED) {
        len = i - t;
        break;
      }
    }
    if (to - (t + len) < rate * 1.5) len = to - t;
    const end = Math.min(to, t + len);
    let kind = cycle[k++ % cycle.length];
    let at: [number, number, number] | undefined;
    if (kind === "tripod") {
      at = tripod(d, t, end, trace, rnd) ?? undefined;
      if (!at) kind = "chase";
    }
    shots.push({ from: t, to: end, kind, at });
    t = end;
  }
  return shots;
}

/** A fixed camera ahead of / beside the path of ticks [a, b] that sees most of it. */
function tripod(d: RunData, a: number, b: number, trace: TraceFn | null, rnd: () => number): [number, number, number] | null {
  const P = (t: number): [number, number, number] => [d.pos[t * 3], d.pos[t * 3 + 1], d.pos[t * 3 + 2] + 40];
  const mid = Math.round(a + (b - a) * 0.62);
  const p0 = P(a);
  const p1 = P(b);
  const pm = P(mid);
  const dir = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  let best: [number, number, number] | null = null;
  let bestScore = -1;
  const samples = 8;
  for (let c = 0; c < 14; c++) {
    const side = c % 2 ? 1 : -1;
    let cand: [number, number, number];
    if (c < 6) {
      // Ahead of the shot's end, raised, looking back down the path at the player coming in (works in corridors).
      const ahead = 80 + rnd() * 220;
      const off = side * rnd() * 70;
      cand = [p1[0] + Math.cos(dir) * ahead - Math.sin(dir) * off, p1[1] + Math.sin(dir) * ahead + Math.cos(dir) * off, p1[2] + 60 + rnd() * 140];
    } else {
      // Beside the path (open areas).
      const ang = dir + side * (0.6 + rnd() * 0.9);
      const dist = 140 + span * (0.25 + rnd() * 0.35);
      cand = [pm[0] + Math.cos(ang) * dist, pm[1] + Math.sin(ang) * dist, pm[2] + 40 + rnd() * 120];
    }
    if (trace) {
      // The camera point itself must be reachable from the path (not inside a wall).
      const from = c < 6 ? p1 : pm;
      const f = trace(from, cand, 8);
      if (f < 1) for (let i = 0; i < 3; i++) cand[i] = from[i] + (cand[i] - from[i]) * Math.max(0, f - 0.05);
      if (Math.hypot(cand[0] - from[0], cand[1] - from[1], cand[2] - from[2]) < 70) continue;
    }
    let seen = 0;
    for (let s = 0; s <= samples; s++) {
      const t = Math.round(a + ((b - a) * s) / samples);
      if (!trace || trace(cand, P(t), 1) > 0.995) seen++;
    }
    const score = seen + rnd() * 0.5;
    if (score > bestScore) (bestScore = score), (best = cand);
  }
  return bestScore >= samples * 0.7 ? best : null;
}

// ---------------------------------------------------------------------------------------------

export type SpectatorMode = "eye" | "chase" | "free" | "flyby";

/**
 * Reusable spectator camera (CS:S observer modes) for any target: the replay viewer, live third person and
 * spectating other players. Feed it the target's interpolated state every rendered frame:
 *
 *   const spec = new SpectatorCamera({ trace });     // trace: world collision (core traceRay), optional
 *   spec.mode = "chase";                              // "eye" | "chase" | "free" | "flyby"
 *   each frame: const showModel = spec.update(camera, targetState, dt);   // SpectatorTarget
 *   after a teleport / switching target: spec.snap();
 *
 * update() returns whether the target's player model should be drawn (false in first person).
 */
export class SpectatorCamera {
  mode: SpectatorMode = "chase";
  readonly chase: ChaseCam;
  readonly free = new FreeCam();
  readonly flyby = new FlybyCam();
  /** Eye-height step smoothing shared by in-eye and chase (EyeSmoother). */
  readonly eyeSmooth = new EyeSmoother();
  trace: TraceFn | null;
  private eyeTmp = [0, 0, 0];

  constructor(o: { trace?: TraceFn | null; chase?: ChaseOptions } = {}) {
    this.trace = o.trace ?? null;
    this.chase = new ChaseCam(o.chase);
  }

  /** Forget smoothing (teleports, seeks, cuts, new target). */
  snap(): void {
    this.chase.snap();
    this.flyby.snap();
    this.eyeSmooth.snap();
  }

  /** Starts free roam from the current view (camera = what's on screen now). */
  startFree(camera: THREE.PerspectiveCamera): void {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    this.free.set([camera.position.x, -camera.position.z, camera.position.y], (e.y * 180) / Math.PI + 90, (-e.x * 180) / Math.PI);
  }

  /** Places the camera for this frame's target state. Returns true if the target's model should be drawn. */
  update(camera: THREE.PerspectiveCamera, s: SpectatorTarget, dt: number, mode: SpectatorMode = this.mode): boolean {
    const err = this.eyeSmooth.update(s, dt);
    switch (mode) {
      case "eye": {
        const e = eyeOf(s, this.eyeTmp);
        e[2] += err;
        setEye(camera, e, s.yaw, s.pitch);
        return false;
      }
      case "free":
        this.free.update(camera, dt);
        return true;
      case "flyby":
        this.flyby.update(camera, s, dt, this.trace);
        return true;
      default:
        this.chase.update(camera, s, dt, this.trace, err);
        return true;
    }
  }
}

/**
 * The replay viewer's camera: the spectator modes plus the auto-director (a precomputed shot list over the replay,
 * including fixed tripods), sampled from the replay cache at a fractional tick.
 */
export class CameraRig {
  mode: CamMode = "chase";
  readonly spec = new SpectatorCamera();
  private shots: Shot[] = [];
  private shotIdx = -1;
  private tripodLook = [0, 0, 0];
  private tmp: ViewSample | undefined;

  get chase(): ChaseCam {
    return this.spec.chase;
  }
  get free(): FreeCam {
    return this.spec.free;
  }

  setShots(shots: Shot[]): void {
    this.shots = shots;
    this.shotIdx = -1;
  }

  get shotList(): readonly Shot[] {
    return this.shots;
  }

  snap(): void {
    this.spec.snap();
    this.shotIdx = -1;
  }

  startFree(camera: THREE.PerspectiveCamera): void {
    this.spec.startFree(camera);
  }

  private findShot(t: number): number {
    const s = this.shots;
    if (!s.length) return -1;
    if (this.shotIdx >= 0 && this.shotIdx < s.length && t >= s[this.shotIdx].from && t < s[this.shotIdx].to) return this.shotIdx;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (s[m].from <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** Places `camera` for display tick t. Returns true if the player model should be drawn (third-person shots). */
  update(camera: THREE.PerspectiveCamera, d: RunData, t: number, dt: number, trace: TraceFn | null): boolean {
    const s = (this.tmp = sampleAt(d, t, this.tmp));
    this.spec.trace = trace;
    if (this.mode !== "auto") return this.spec.update(camera, s, dt, this.mode);
    const i = this.findShot(t);
    if (i !== this.shotIdx) {
      // A cut: no smoothing carried across.
      this.spec.snap();
      this.spec.flyby.side = i % 2 ? 1 : -1;
      this.shotIdx = i;
      if (i >= 0 && this.shots[i].kind === "tripod") this.tripodLook = [s.pos[0], s.pos[1], s.pos[2] + 40];
    }
    const shot = i >= 0 ? this.shots[i] : null;
    if (shot?.kind === "tripod" && shot.at) {
      const l = this.tripodLook;
      const k = damp(6, dt);
      l[0] += (s.pos[0] - l[0]) * k;
      l[1] += (s.pos[1] - l[1]) * k;
      l[2] += (s.pos[2] + 40 - l[2]) * k;
      lookFrom(camera, shot.at, l);
      return true;
    }
    return this.spec.update(camera, s, dt, shot?.kind === "eye" ? "eye" : shot?.kind === "flyby" ? "flyby" : "chase");
  }
}
