// Tick-exact run timer (bhoptimer rules) + run stats.
// DOM-free and deterministic: the browser and the headless verifier run this exact code
// after every core.step, so times/stats recomputed from a replay match bit-for-bit.
// Only IEEE-exact arithmetic is used (+ - * / sqrt, Math.fround) — no Math.hypot/sin/etc,
// whose results may differ between JS engines (V8 vs JavaScriptCore).

import { playerInZone, splitCount, touching, trackOf, type Zone } from "./zones";

export type RunStatus = "idle" | "running" | "finished";

/** A stage/checkpoint split: first entry into split zone `index` of the run's track, `ticks` after the start. */
export interface Split {
  index: number;
  kind: "stage" | "checkpoint";
  ticks: number;
}

export interface TickCmd {
  forward: number;
  side: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export interface TickState {
  position: readonly number[];
  velocity: readonly number[];
  grounded: boolean;
  crouched: boolean;
  /** core tick after the step (1 after the first step following a reset). */
  tick: number;
  /**
   * Where this tick's trigger touch pass after the move happened (core PlayerState.touchPosition), before any
   * teleport it caused. Absent = same as `position`.
   */
  touchPosition?: readonly number[];
  touchCrouched?: boolean;
  /** On a ladder (core PlayerState.onLadder): never a valid start under timer rules 2. */
  onLadder?: boolean;
}

export interface TimerUpdate {
  started?: boolean;
  finished?: boolean;
  /** Re-entered the start zone while running/finished: attempt reset. */
  restarted?: boolean;
  /** Prespeed cap: velocity the caller must apply to the sim (core set_velocity) before the next step. */
  clampVelocity?: [number, number, number];
  /** Entered a new stage/checkpoint zone of the current track this tick. */
  split?: Split;
}

export interface TimerOptions {
  /** Horizontal speed cap applied on the run's first tick (bhoptimer-style prespeed limit). null = off. */
  prespeedCap: number | null;
  /** shavit_misc_prespeed 2: zero velocity on a landing-tick jump inside a start zone. */
  blockPrehops?: boolean;
  /** Keys that count as strafes (style dependent, see styles.strafeKeys). Default "ad". */
  strafeKeys?: "ad" | "ws" | "w";
  /** Start-zone rules version (TIMER_RULES_*). Default TIMER_RULES (the current rules). */
  rules?: number;
}

/**
 * Start-zone rules versions (research/TIMER-RULES.md). Every replay records the rules it was timed with (replay header
 * v7 `timerRules`; older replays are rules 1) and is re-timed with them, so a rules change never changes an existing run.
 * - 1: the start zone is a box: touching it (in any state) resets the attempt, the run starts on the first tick outside
 *   it. Lets a run start from a jump begun outside the zone or from mid-air (feedback ZNJNVAhd8ydQoIQL).
 * - 2 (bhoptimer v4 CanStartTimer with its defaults): the attempt is reset only on ticks the player could start from:
 *   inside the zone, on the ground (not on a ladder), horizontal speed within the prespeed cap, and settled on the
 *   ground (stood still since landing, landed at least 0.5 s ago, or moving at 50 u/s or less). The run starts on the
 *   first tick after the last such tick (walked out, jumped, or walked off a ledge inside the zone). Touching the zone
 *   in the air does nothing, so mid-air exits and ledge starts are impossible, and so is landing in the zone fast and
 *   jumping straight out again.
 */
export const TIMER_RULES_V1 = 1;
export const TIMER_RULES_V2 = 2;
/** The rules new runs are timed and recorded with. */
export const TIMER_RULES = TIMER_RULES_V2;
export const isTimerRules = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= TIMER_RULES_V1 && (v as number) <= TIMER_RULES;
/** Rules 2: seconds on the ground after landing before a moving player can start (bhoptimer `0.5 / GetTickInterval()`). */
export const START_GROUND_SECONDS = 0.5;
/** Rules 2: at or below this horizontal speed the ground timer is skipped (bhoptimer CanStartTimer `curVel <= 50.0`). */
export const START_SLOW_SPEED = 50;
/** Rules 2: squared speed at or below which a grounded player counts as settled (bhoptimer `GetVectorLength(absvel, true) <= 1000.0`). */
export const START_SETTLED_SPEED_SQ = 1000;

export const DEFAULT_TIMER_OPTIONS: TimerOptions = { prespeedCap: 290, strafeKeys: "ad", rules: TIMER_RULES };

export const EVENT_JUMPED = 1 << 1;
const EVENT_TELEPORTED = 1 << 0;
/** The player died and respawned this tick (crates/core/src/game.rs EVENT_RESPAWNED). */
export const EVENT_RESPAWNED = 1 << 3;

/**
 * bhoptimer-style run timer over a multi-track zone set.
 * - Rules 1: touching a start zone of track T puts the timer idle on track T (restarting any run in progress); leaving
 *   it starts a run on T (prespeed capped).
 * - Rules 2: only a valid start tick in it does that ("armed": on the ground, not on a ladder, within the prespeed
 *   cap, settled; see TIMER_RULES_V2). The first tick that isn't armed is the run's first tick (prespeed capped):
 *   walking out, jumping, or walking off a ledge inside the zone.
 *   The run is announced (`started`) once the player is out of the zone, with that first tick as its start, so
 *   jumping around inside the zone doesn't start and restart runs; landing back in the zone re-arms instead.
 *   Touching the zone in the air changes nothing: a run in progress continues, an idle timer stays idle.
 * - When start zones of several tracks overlap, the current track wins, then the lowest track. Only T's end zone
 *   finishes the run. The end zone is also checked where
 *   this tick's trigger touch pass happened: bhoptimer zones are triggers touched in the same pass as the map's own
 *   (the engine collects every trigger the hull overlaps after the move, then touches each), so entering the end zone
 *   finishes the run even if a trigger_teleport in that pass moves the player away (bhop_badges' end teleport covers
 *   94% of its end zone). Start zones and splits only use the position after the tick, as before.
 * - Stage/checkpoint zones of T record splits, each index at most once and in increasing order.
 */
export class RunTimer {
  status: RunStatus = "idle";
  /** Track of the current/last run (the track of the start zone last touched). 0 = main. */
  track = 0;
  startTick = 0;
  endTick = 0;
  lastTick = 0;
  jumps = 0;
  strafes = 0;
  perfectJumps = 0;
  /** Tick of the last eligible perfect hop, for cosmetic feedback. */
  lastPerfectTick = -1;
  measuredJumps = 0;
  private perfGroundTicks = 0;
  syncGood = 0;
  syncTotal = 0;
  /** Splits of the current/finished run, in order. */
  splits: Split[] = [];
  /** The player touched a start zone on the last update. */
  inStart = false;
  private wasInStart = false;
  /** Rules 2: on the ground in a start zone on the last update. */
  private armed = false;
  /** Rules 2: first tick of a run begun inside the zone (jump / ledge) the player hasn't left yet; 0 = none. */
  private pendingStart = 0;
  /**
   * Rules 2 ground timer (bhoptimer gI_FirstTouchedGroundForStartTimer), kept everywhere, not only in zones: 0 = in the
   * air, > 0 = tick the player landed, -1 = settled (nearly still on the ground since landing).
   */
  private groundSince = 0;
  private wasOnGround = false;
  private preGrounded: boolean | null = null;
  private lastSide = 0;
  private prevYaw = NaN;

  constructor(
    public zones: readonly Zone[],
    public tickInterval: number,
    public options: TimerOptions = DEFAULT_TIMER_OPTIONS,
  ) {}

  /** Start-zone rules this timer applies (TIMER_RULES_*): record it in the replay header (`timerRules`). */
  get rules(): number {
    return this.options.rules ?? TIMER_RULES;
  }

  /** Call after core.reset(). */
  reset(): void {
    this.status = "idle";
    this.track = 0;
    this.startTick = this.endTick = this.lastTick = 0;
    this.wasInStart = this.inStart = this.armed = false;
    this.pendingStart = this.groundSince = 0;
    this.wasOnGround = false;
    this.preGrounded = null;
    this.perfGroundTicks = 0;
    this.prevYaw = NaN;
    this.clearStats();
  }

  private clearStats(): void {
    this.jumps = this.strafes = this.syncGood = this.syncTotal = 0;
    this.perfectJumps = this.measuredJumps = 0;
    this.lastPerfectTick = -1;
    this.lastSide = 0;
    this.splits = [];
  }

  /**
   * A run is under way: running, or (rules 2) its first tick has passed inside the start zone (a takeoff jump) and the
   * player hasn't left yet. Read by the client only (main.ts: third person is off during a ranked run).
   */
  get started(): boolean {
    return this.status === "running" || this.pendingStart !== 0;
  }

  /**
   * Practice noclip outside a run (practice-mode/): back to idle without a finish, keeping the track, so flying out of
   * a start zone doesn't start a run. Never called
   * on re-simulation (sim.ts, verifier.ts).
   */
  stop(): void {
    this.status = "idle";
    this.startTick = this.endTick = 0;
    this.wasInStart = this.inStart = this.armed = false;
    this.pendingStart = this.groundSince = 0;
    this.wasOnGround = false;
    this.preGrounded = null;
    this.perfGroundTicks = 0;
    this.prevYaw = NaN;
    this.clearStats();
  }

  /**
   * Practice noclip (practice-mode/) during a run: the clock keeps counting to `tick` (a practice attempt now, never
   * submitted), and no zone, split or stat is read while flying. The first tick back on the ground starts fresh for
   * landings and sync. Never called on re-simulation (sim.ts, verifier.ts).
   */
  coast(tick: number): void {
    this.lastTick = tick;
    this.lastPerfectTick = -1;
    this.perfGroundTicks = 0;
    this.preGrounded = null;
    this.wasOnGround = false;
    this.groundSince = 0;
    this.prevYaw = NaN;
  }

  /** Called before movement, including while outside start zones, so landings are detected consistently. */
  beforeStep(cmd: TickCmd, s: TickState): [number, number, number] | null {
    const grounded = s.grounded && !s.onLadder;
    const landed = this.preGrounded === false && grounded;
    this.preGrounded = grounded;
    if (!this.options.blockPrehops || !landed || !(cmd.buttons & (1 << 1))) return null;
    // shavit-misc's prespeed mode 2 acts on the first grounded command with jump held.
    // An ordinary takeoff after ground prestrafe keeps its speed; consecutive prehops lose theirs.
    return this.zones.some((z) => z.kind === "start" && playerInZone(s.position, s.crouched, z)) ? [0, 0, 0] : null;
  }

  /** Number of split zones (distinct stage/checkpoint indices) on the current track. */
  splitTotal(): number {
    return splitCount(this.zones, this.track);
  }

  /** Ticks elapsed in the current/finished run. */
  ticks(atTick = this.lastTick): number {
    if (this.status === "running") return atTick - this.startTick;
    if (this.status === "finished") return this.endTick - this.startTick;
    return 0;
  }

  /** Seconds (canonical: ticks * tick interval). */
  time(atTick = this.lastTick): number {
    return this.ticks(atTick) * this.tickInterval;
  }

  syncPercent(): number {
    return this.syncTotal ? (100 * this.syncGood) / this.syncTotal : 0;
  }

  /** Shavit: only hops within 0.1 s of landing are measured; one grounded tick is perfect. */
  perfPercent(): number {
    return this.measuredJumps ? 100 * this.perfectJumps / this.measuredJumps : 0;
  }

  update(cmd: TickCmd, events: number, s: TickState): TimerUpdate {
    const out: TimerUpdate = {};
    this.lastTick = s.tick;
    if (s.onLadder || events & (EVENT_JUMPED | EVENT_TELEPORTED | EVENT_RESPAWNED)) this.lastPerfectTick = -1;
    // End zone touched by this tick's trigger pass, before a teleport in that pass moved the player out of it (not when
    // the player died in it: the respawn ends the run).
    const passEnd =
      this.status === "running" &&
      !!s.touchPosition &&
      (events & EVENT_RESPAWNED) === 0 &&
      touching(s.touchPosition, s.touchCrouched ?? s.crouched, this.zones, "end", this.track) !== null;
    const start = touching(s.position, s.crouched, this.zones, "start", this.track) ?? touching(s.position, s.crouched, this.zones, "start");
    const inStart = start !== null;

    if (this.rules === TIMER_RULES_V1) {
      if (start && !passEnd) {
        if (this.status !== "idle") out.restarted = true;
        this.status = "idle";
        this.track = trackOf(start);
        this.clearStats();
      } else if (this.status === "idle" && this.wasInStart) {
        this.status = "running";
        this.startTick = s.tick;
        this.clearStats();
        out.started = true;
        this.capPrespeed(s, out);
      }
    } else {
      const armed = this.validStart(s) && start !== null;
      if (armed && !passEnd) {
        if (this.status !== "idle") out.restarted = true;
        this.status = "idle";
        this.track = trackOf(start);
        this.clearStats();
        this.pendingStart = 0;
        this.armed = true;
      } else {
        if (this.status === "idle" && this.armed) {
          // Left the armed state: this is the run's first tick (bhoptimer's last StartTimer was the tick before).
          this.pendingStart = s.tick;
          this.capPrespeed(s, out);
        }
        this.armed = false;
        if (this.status === "idle" && this.pendingStart && !inStart) {
          this.status = "running";
          this.startTick = this.pendingStart;
          this.pendingStart = 0;
          out.started = true;
        }
      }
    }
    this.wasInStart = this.inStart = inStart;

    // Stats count from the run's first tick (rules 2: also while it is still inside the zone, e.g. the takeoff jump).
    if (this.status === "running" || this.pendingStart) {
      if (events & EVENT_JUMPED) {
        this.jumps++;
        if (!s.onLadder && !(events & EVENT_RESPAWNED) && this.perfGroundTicks > 0 && this.perfGroundTicks < Math.ceil(Math.fround(0.1 / this.tickInterval))) {
          this.measuredJumps++;
          if (this.perfGroundTicks === 1) { this.perfectJumps++; if (!(events & (EVENT_TELEPORTED | EVENT_RESPAWNED))) this.lastPerfectTick = s.tick; }
        }
      }
      // Strafes (bhoptimer strafe_count_*): A/D changes, W/S changes on Sideways, fresh W presses on W-Only.
      const keys = this.options.strafeKeys ?? "ad";
      const axis = keys === "ad" ? (cmd.side > 0 ? 1 : cmd.side < 0 ? -1 : 0) : cmd.forward > 0 ? 1 : cmd.forward < 0 ? -1 : 0;
      if (keys === "w") {
        if (axis > 0 && this.lastSide <= 0) this.strafes++;
        this.lastSide = axis;
      } else {
        if (axis !== 0 && axis !== this.lastSide) this.strafes++;
        if (axis !== 0) this.lastSide = axis;
      }
      if (!s.grounded && this.prevYaw === this.prevYaw) {
        let d = cmd.yaw - this.prevYaw;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        if (d !== 0) {
          this.syncTotal++;
          // Good sync: the movement keys push toward the side we're turning to. Yaw increases turning left; the wish
          // direction's side relative to velocity is the sign of cross(velocity, wish) (positive = left of travel).
          // This works for every style: A/D on Normal, W/S while facing sideways, W while turning on W-Only.
          const yr = (cmd.yaw * Math.PI) / 180;
          const fx = Math.cos(yr);
          const fy = Math.sin(yr);
          // Source: forward = (cos, sin), right = (sin, -cos); sidemove > 0 is right.
          const wx = cmd.forward * fx + cmd.side * fy;
          const wy = cmd.forward * fy - cmd.side * fx;
          const cross = s.velocity[0] * wy - s.velocity[1] * wx;
          if ((d > 0 && cross > 0) || (d < 0 && cross < 0)) this.syncGood++;
        }
      }
    }
    if (this.status === "running") {
      const last = this.splits.length ? this.splits[this.splits.length - 1].index : -1;
      for (const z of this.zones) {
        if ((z.kind !== "stage" && z.kind !== "checkpoint") || trackOf(z) !== this.track || (z.index ?? 0) <= last) continue;
        if (!playerInZone(s.position, s.crouched, z)) continue;
        const split: Split = { index: z.index ?? 0, kind: z.kind, ticks: s.tick - this.startTick };
        this.splits.push(split);
        out.split = split;
        break;
      }
      if (passEnd || touching(s.position, s.crouched, this.zones, "end", this.track)) {
        this.status = "finished";
        this.endTick = s.tick;
        out.finished = true;
      }
    }
    this.perfGroundTicks = s.grounded && !s.onLadder && !(events & EVENT_RESPAWNED) ? this.perfGroundTicks + 1 : 0;
    this.prevYaw = cmd.yaw;
    return out;
  }

  /**
   * Rules 2: whether this tick could start a run if it is in a start zone (bhoptimer CanStartTimer with nozaxisspeed 1,
   * prespeed 2): on the ground (not on a ladder), horizontal speed within the prespeed cap, and either at most 50 u/s,
   * settled, or landed at least START_GROUND_SECONDS ago. Updates the ground timer, so it runs every tick.
   */
  private validStart(s: TickState): boolean {
    const onGround = s.grounded && !s.onLadder;
    const [vx, vy, vz] = s.velocity;
    const speedSq = vx * vx + vy * vy;
    if (!onGround) this.groundSince = 0;
    else if (!this.wasOnGround || this.groundSince === 0) this.groundSince = s.tick;
    else if (this.groundSince > 0 && speedSq + vz * vz <= START_SETTLED_SPEED_SQ) this.groundSince = -1;
    this.wasOnGround = onGround;
    if (!onGround) return false;
    const speed = Math.sqrt(speedSq);
    const cap = this.options.prespeedCap;
    if (cap !== null && speed > cap) return false;
    return speed <= START_SLOW_SPEED || this.groundSince < 0 || s.tick - this.groundSince >= Math.round(START_GROUND_SECONDS / this.tickInterval);
  }

  /** Prespeed cap on the run's first tick: horizontal speed scaled down to the cap (vertical kept). */
  private capPrespeed(s: TickState, out: TimerUpdate): void {
    const cap = this.options.prespeedCap;
    if (cap === null) return;
    const vx = s.velocity[0];
    const vy = s.velocity[1];
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > cap) {
      const f = cap / speed;
      out.clampVelocity = [Math.fround(vx * f), Math.fround(vy * f), s.velocity[2]];
    }
  }
}

export function formatTime(seconds: number, sign = false): string {
  const neg = seconds < 0;
  let ms = Math.round(Math.abs(seconds) * 1000);
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  const str = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  return (neg ? "-" : sign ? "+" : "") + str;
}
