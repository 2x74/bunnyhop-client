// Shared deterministic run step + replay re-simulation (browser playback, ghosts and the headless verifier).

import { applyRestartPoint, EVENT_FLIGHT, EVENT_JUMPED, EVENT_TELEPORTED, type Core, type PlayerState, type Settings } from "./core";
import { replayPhysics, replaySettings, replayStyle, replayTimerRules, type Checkpoint, type Replay } from "./replay";
import { StyleFilter, strafeKeys, styleDef, styleStartReentryCap, type StyleDef } from "./styles";
import { blocksPrehops, RunTimer, TIMER_RULES, TIMER_RULES_V1, TIMER_RULES_V2, type TickCmd, type TimerUpdate } from "./timer";
import type { Zone } from "./zones";
import { pathSource, startObserving } from "./timing-trace";

interface RawExports {
  set_velocity?: (x: number, y: number, z: number) => void;
}

/** Overwrites player velocity via the `set_velocity` wasm export (appended to crates/core/src/wasm.rs). */
export function setVelocity(core: Core, v: readonly number[]): void {
  const x = (core as unknown as { x: RawExports }).x;
  if (!x.set_velocity) throw new Error("wasm build lacks set_velocity export; rebuild with tools/scripts/build-wasm.sh");
  x.set_velocity(v[0], v[1], v[2]);
}

/** Quantises a command to exactly what the sim consumes (f32 angles, i16 moves, u32 buttons: u16 + v7 weapon commands). */
export function quantize(forward: number, side: number, yaw: number, pitch: number, buttons: number): TickCmd {
  const i16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
  return { forward: i16(forward), side: i16(side), yaw: Math.fround(yaw), pitch: Math.fround(pitch), buttons: buttons >>> 0 };
}

/**
 * Timer created with the canonical (f32) tick interval so browser and verifier compute identical times. `rules`: the
 * start-zone rules (timer.ts TIMER_RULES_*): the current ones for live play, the replay's own on re-simulation. `map`: the
 * map's name (rules 4 block start-zone prehops on some maps, timer.ts START_ZONE_NO_PREHOP_V4).
 */
export function makeTimer(zones: readonly Zone[], settings: Settings, prespeedCap: number | null, style: StyleDef | null = null, rules = TIMER_RULES, map = ""): RunTimer {
  return new RunTimer(zones, Math.fround(settings.tickInterval), { prespeedCap, blockPrehops: blocksPrehops(style?.id, map, rules), strafeKeys: strafeKeys(style), rules, startReentryCap: style ? styleStartReentryCap(style.id) : null });
}

/** Apply start-zone prehop blocking before movement, shared by live play, recording and replay verification. */
export function beforeStep(core: Core, timer: RunTimer, cmd: TickCmd): void {
  // The timer measures sub-tick crossings on the step's accepted path (run-timing.ts). Observation only.
  startObserving(core);
  const velocity = timer.beforeStep(cmd, core.state());
  if (velocity) setVelocity(core, velocity);
}

/**
 * Everything that happens after core.step for one tick: timer/zone update and the prespeed clamp.
 * Returns the post-tick state (after any clamp), which is what checkpoints record. An Infinite flight tick (core
 * EVENT_FLIGHT, physics v24) goes to the timer's flightTick instead: it never starts or finishes a run.
 */
export function afterStep(core: Core, timer: RunTimer, cmd: TickCmd, events: number): { state: PlayerState; update: TimerUpdate } {
  let state = core.state();
  timer.pathSource = pathSource(core);
  const update = events & EVENT_FLIGHT ? timer.flightTick(state) : timer.update(cmd, events, state);
  if (update.clampVelocity) {
    setVelocity(core, update.clampVelocity);
    state = core.state();
  }
  return { state, update };
}

export function sameF32(a: number, b: number): boolean {
  // States come from f32 memory, so Object.is is a bit-exact comparison (except NaN payloads).
  return Object.is(Math.fround(a), Math.fround(b));
}

export function checkpointMatches(c: Checkpoint, s: PlayerState): boolean {
  return [0, 1, 2].every((i) => sameF32(c.position[i], s.position[i]) && sameF32(c.velocity[i], s.velocity[i]));
}

export interface SimOptions {
  /** Stop after this many ticks (default: whole replay). */
  untilTick?: number;
  /** Capture per-tick frames: [x, y, z, flags (FRAME_CROUCHED | FRAME_GROUNDED), yaw, pitch] for tick 0..N (index = tick). */
  frames?: boolean;
  /** After every tick. `ctx` exposes the live timer / style filter (the replay viewer keyframes them) and the command
   * actually stepped (after the style filter). */
  onTick?: (tick: number, state: PlayerState, events: number, ctx: SimTickContext) => void;
}

export interface SimTickContext {
  timer: RunTimer;
  filter: StyleFilter;
  cmd: TickCmd;
  update: TimerUpdate;
}

/** The recorded command for replay tick index i (produces tick i + 1). */
export function replayCommand(replay: Replay, i: number): TickCmd {
  return { forward: replay.forward[i], side: replay.side[i], yaw: replay.yaw[i], pitch: replay.pitch[i], buttons: replay.buttons[i] };
}

/**
 * One re-simulated replay tick: the style filter (from the pre-tick state `pre`), core.step and afterStep. simulate()
 * and the replay viewer's playback both go through this, so they apply identical rules.
 */
export function replayStep(core: Core, timer: RunTimer, filter: StyleFilter, replay: Replay, i: number, pre: PlayerState, retimer?: RunTimer | null) {
  const raw = replayCommand(replay, i);
  const cmd = filter.apply(raw, pre, timer.started);
  // The retimer only watches (SimRun retime): its prespeed velocities are never applied, so the physics stay as played.
  retimer?.beforeStep(cmd, pre);
  beforeStep(core, timer, cmd);
  const events = core.step(cmd.forward, cmd.side, cmd.yaw, cmd.pitch, cmd.buttons);
  const r = afterStep(core, timer, cmd, events);
  if (retimer) retimer.pathSource = timer.pathSource;
  const retimed = retimer ? retimer.update(cmd, events, r.state) : null;
  return { raw, cmd, events, state: r.state, update: r.update, retimed };
}

export interface SimResult {
  timer: RunTimer;
  final: PlayerState;
  ticks: number;
  checkpointsChecked: number;
  checkpointsMatch: boolean;
  firstMismatchTick: number | null;
  /** Track of the last run started during re-simulation (0 = main). */
  track: number;
  /** The tick at which the timer started/finished during re-simulation (0 if never). */
  startTick: number;
  endTick: number;
  frames?: Float32Array;
  /** Presentation-only jump/teleport events at each captured frame tick; never serialized into replays. */
  frameEvents?: Uint8Array;
  /** Recorded commands the replay's style filter had to change (blocked keys; 0 for a legitimate replay). */
  styleViolations: number;
  /** The style filter after the last simulated tick (ladder state), so playback can continue from here. */
  filter: StyleFilter;
  /** Tick produced by the first such command (i + 1 for command i), or null. */
  firstViolationTick: number | null;
  /** The first violating command as recorded. */
  firstViolation: TickCmd | null;
  /**
   * Rules 1 replays: the same run timed with the current start-zone rules (TIMER_RULES_V2) by a second timer that
   * watches the re-simulation without touching it (the physics, rules 1's exit-tick prespeed clamp included, are as
   * played). The run starts at the last valid ground start instead of on leaving the zone, so a mid-air exit counts
   * from its takeoff (research/TIMER-RULES.md "Retiming rules 1 runs"). Absent for rules 2+ replays.
   */
  retimed?: { timer: RunTimer; track: number; startTick: number; endTick: number };
  /**
   * Segmented replays (replay.segments): the checkpoint loads compared with the re-simulated state at their tick, and
   * the tick of the first load whose recorded state isn't exactly that state (or is out of tick order), else null. A
   * load can only restore a state the run reached at that tick and saved there (research/SEGMENTED.md). Absent without
   * loads.
   */
  segments?: { checked: number; mismatchTick: number | null };
  /**
   * Infinite flights (core EVENT_FLIGHT, physics v24): ticks flown, separate flights, the last tick flown, and the first
   * tick flown while a run was being timed (the timer ends the run there, so a finished run never has one). Absent
   * without flights.
   */
  flight?: { ticks: number; flights: number; lastTick: number; inRunTick: number | null };
}

export const FRAME_STRIDE = 6;
/** Frame field 3 bit flags. */
export const FRAME_CROUCHED = 1;
export const FRAME_GROUNDED = 2;
/**
 * On a ladder (presentation only: ghosts climb, player/bunny/legs.ts). The same bit as the replay viewer's F_LADDER
 * (viewer/player.ts), so frames built from viewer data (h2h/align.ts) carry it unchanged. Frames saved before it lack it.
 */
export const FRAME_LADDER = 64;
export const frameFlags = (s: Pick<PlayerState, "crouched" | "grounded"> & { onLadder?: boolean }): number =>
  (s.crouched ? FRAME_CROUCHED : 0) | (s.grounded ? FRAME_GROUNDED : 0) | (s.onLadder ? FRAME_LADDER : 0);

/** Re-simulates a replay from core.reset() with the given zones. The map must already be loaded. */
export function simulate(core: Core, replay: Replay, zones: readonly Zone[], opts: SimOptions = {}): SimResult {
  const run = new SimRun(core, replay, zones, opts);
  run.step();
  return run.result();
}

/**
 * A re-simulation that runs in slices: step(n) simulates up to n more ticks, result() once done. simulate() runs one
 * to the end in a single step; the API's queue consumer steps long replays in slices so it can report progress and
 * let other work into the isolate between them (apps/api/src/verify.ts). Slicing never changes the result: the same
 * ticks run in the same order on the same core, which nothing else may touch until the run is done.
 */
export class SimRun {
  /** Ticks this run simulates. */
  readonly n: number;
  private i = 0;
  private readonly timer: RunTimer;
  private readonly filter: StyleFilter;
  private readonly frames?: Float32Array;
  private readonly frameEvents?: Uint8Array;
  private state: PlayerState;
  private cp = 0;
  private checked = 0;
  private firstMismatch: number | null = null;
  private startTick = 0;
  private endTick = 0;
  private track = 0;
  private violations = 0;
  private firstViolationTick: number | null = null;
  private firstViolation: TickCmd | null = null;
  /** Rules 1 replays: the current-rules timer (SimResult.retimed). */
  private readonly retimer: RunTimer | null = null;
  private retimed = { track: 0, startTick: 0, endTick: 0 };
  /** Segmented loads (replay.segments): the next one to compare, those compared, the first that isn't the run's state. */
  private seg = 0;
  private segChecked = 0;
  private segMismatch: number | null = null;
  /** Infinite flights (SimResult.flight). */
  private flight: { ticks: number; flights: number; lastTick: number; inRunTick: number | null } | null = null;

  constructor(
    private readonly core: Core,
    private readonly replay: Replay,
    zones: readonly Zone[],
    private readonly opts: SimOptions = {},
  ) {
    const h = replay.header;
    core.setSettings(replaySettings(h));
    core.reset();
    // Start-zone restart point recorded at tick 0 (see core.setPosition / replay header v3).
    if (h.spawn) applyRestartPoint(core, h.spawn);
    this.timer = makeTimer(zones, h.settings, h.prespeedCap, styleDef(replayStyle(h)), replayTimerRules(h), h.map);
    this.timer.reset();
    if (replayTimerRules(h) === TIMER_RULES_V1) {
      this.retimer = makeTimer(zones, h.settings, h.prespeedCap, styleDef(replayStyle(h)), TIMER_RULES_V2, h.map);
      this.retimer.reset();
    }
    const n = (this.n = Math.min(opts.untilTick ?? h.totalTicks, h.totalTicks));
    this.frames = opts.frames ? new Float32Array((n + 1) * FRAME_STRIDE) : undefined;
    this.frameEvents = opts.frames ? new Uint8Array(n + 1) : undefined;
    this.state = core.state();
    this.checkSegments(0, this.state);
    this.putFrame(0, this.state, n > 0 ? replay.yaw[0] : this.state.teleportAngles[1], n > 0 ? replay.pitch[0] : this.state.teleportAngles[0]);
    // The style's key filter is re-applied to every recorded command (from the pre-tick state, as the client did).
    this.filter = new StyleFilter(styleDef(replayStyle(h)), replayPhysics(h));
  }

  /** Ticks simulated so far. */
  get ticksDone(): number {
    return this.i;
  }

  get done(): boolean {
    return this.i >= this.n;
  }

  /** A checkpoint has mismatched: the replay is already invalid, whatever the rest does. */
  get desynced(): boolean {
    return this.firstMismatch !== null;
  }

  private putFrame(t: number, s: PlayerState, yaw: number, pitch: number): void {
    const frames = this.frames;
    if (!frames) return;
    const o = t * FRAME_STRIDE;
    frames[o] = s.position[0];
    frames[o + 1] = s.position[1];
    frames[o + 2] = s.position[2];
    frames[o + 3] = frameFlags(s);
    frames[o + 4] = yaw;
    frames[o + 5] = pitch;
  }

  /** Simulates up to `max` more ticks (default: the rest). */
  step(max = Infinity): void {
    const { core, timer, filter, replay, opts } = this;
    const checkpoints = replay.checkpoints;
    const end = Math.min(this.n, this.i + max);
    for (let i = this.i; i < end; i++) {
      const timed = timer.started;
      const r = replayStep(core, timer, filter, replay, i, this.state, this.retimer);
      const { raw, cmd, events } = r;
      if (events & EVENT_FLIGHT) {
        const f = (this.flight ??= { ticks: 0, flights: 0, lastTick: -1, inRunTick: null });
        if (f.lastTick !== i) f.flights++; // (a flight that goes on from the last tick is the same flight)
        f.ticks++;
        f.lastTick = i + 1;
        if (timed && f.inRunTick === null) f.inRunTick = i + 1;
      }
      if (cmd !== raw && this.violations++ === 0) (this.firstViolationTick = i + 1), (this.firstViolation = raw);
      const state = (this.state = r.state);
      // The timer's start tick: rules 2 announce a run begun inside the zone (a jump) once the player leaves it.
      if (r.update.started) (this.startTick = timer.startTick), (this.track = timer.track);
      if (r.update.restarted) this.startTick = this.endTick = 0;
      if (r.update.finished) this.endTick = state.tick;
      if (r.retimed) {
        const t = this.retimed;
        if (r.retimed.started) (t.startTick = this.retimer!.startTick), (t.track = this.retimer!.track);
        if (r.retimed.restarted) t.startTick = t.endTick = 0;
        if (r.retimed.finished) t.endTick = state.tick;
      }
      const tick = i + 1;
      while (this.cp < checkpoints.length && checkpoints[this.cp].tick < tick) this.cp++;
      if (this.cp < checkpoints.length && checkpoints[this.cp].tick === tick) {
        this.checked++;
        if (!checkpointMatches(checkpoints[this.cp], state) && this.firstMismatch === null) this.firstMismatch = tick;
        this.cp++;
      }
      this.checkSegments(tick, state);
      this.putFrame(tick, state, cmd.yaw, cmd.pitch);
      if (this.frameEvents) this.frameEvents[tick] = events & (EVENT_JUMPED | EVENT_TELEPORTED);
      opts.onTick?.(tick, state, events, { timer, filter, cmd, update: r.update });
    }
    this.i = end;
  }

  /** Compares the Segmented loads recorded at `tick` with the state after `tick` commands (SimResult.segments). */
  private checkSegments(tick: number, s: PlayerState): void {
    const loads = this.replay.segments;
    if (!loads) return;
    while (this.seg < loads.length && loads[this.seg].tick <= tick) {
      const l = loads[this.seg++];
      this.segChecked++;
      // (A load behind the current tick is out of order: the encoder never writes one.)
      if ((l.tick !== tick || !checkpointMatches(l, s)) && this.segMismatch === null) this.segMismatch = l.tick;
    }
  }

  /** The result (call once done; before that it describes the ticks simulated so far). */
  result(): SimResult {
    return {
      timer: this.timer,
      final: this.state,
      ticks: this.i,
      checkpointsChecked: this.checked,
      checkpointsMatch: this.firstMismatch === null,
      firstMismatchTick: this.firstMismatch,
      track: this.track,
      startTick: this.startTick,
      endTick: this.endTick,
      frames: this.frames,
      frameEvents: this.frameEvents,
      styleViolations: this.violations,
      filter: this.filter,
      firstViolationTick: this.firstViolationTick,
      firstViolation: this.firstViolation,
      ...(this.retimer ? { retimed: { timer: this.retimer, ...this.retimed } } : {}),
      ...(this.replay.segments ? { segments: { checked: this.segChecked, mismatchTick: this.segMismatch } } : {}),
      ...(this.flight ? { flight: { ...this.flight } } : {}),
    };
  }
}
