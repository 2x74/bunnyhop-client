// Versioned, compact binary replay format (".bhr").
//
// A replay is the exact per-tick command stream fed to core.step() starting right after core.reset(),
// plus enough metadata to re-simulate it deterministically (map hash, physics settings, zones, prespeed cap).
// Time is never trusted from the file: verifiers re-simulate and recompute it with timer.ts.
//
// Container: gzip (CompressionStream) of the raw layout below. All integers little-endian.
//
//   magic        "BHRP"                          4
//   version      u16 (= 7 for timer rules 2+; a timer rules 1 replay is written as 6 for physics v2+, and a
//                physics v1 one as 4, or 5 when the restart point carries player names, exactly as before
//                physics versions and timer rules; 1-6 are still decoded)                       2
//   flags        u16  bit0 autohop               2
//   map          str8 (u8 len + utf8)
//   mapSha256    32 bytes
//   settings     f32 x7: tickInterval airAccelerate accelerate friction stopSpeed gravity maxSpeed
//   prespeedCap  f32 (0 = no cap)
//   startTick    u32   tick the run timer started (0 = never started)
//   endTick      u32   tick the end zone was entered (0 = unfinished)
//   totalTicks   u32   number of commands
//   track        u8    track of the run (0 = main, N = bonus N)                                     [v2]
//   spawn        u8 has, then if 1: f32 x3 position + f32 yaw: the core.setPosition restart point
//                applied right after core.reset() (start-zone restart), re-applied on re-simulation  [v3]
//                v5, after the yaw: str8 targetname, str8 classname the player gets there (setRestartNames;
//                bhoptimer map fixes, restart.ts; "" = default). Written as v5 only when one is set, so every
//                other replay stays v4 byte for byte.                                                [v5]
//                v6: the names are always present (with the restart point).                          [v6]
//   style        str8  style id (styles.ts: autohop, legit, wonly, sideways, hsw). Its key filter is
//                re-applied on re-simulation. v1-3: derived from the autohop flag (autohop / legit)  [v4]
//   physics      u8    physics version the run was played with (core.ts PHYSICS_*; re-simulated with it). Replays
//                before v6 have no field and are physics v1 (the original movement: playerclips not solid, no jump
//                during the unduck transition). Placed after the style so every fixed-offset field before it (the
//                API's totalTicks peek) stays put. Decoders that predate v6 reject v6 replays ("unsupported
//                version 6") instead of silently re-simulating v2 movement with v1 physics.           [v6]
//   timerRules   u8    start-zone rules the run was timed with (timer.ts TIMER_RULES_*; re-timed with them). Replays
//                before v7 have no field and are rules 1 (the start zone as a box: leaving it in the air starts the
//                run). Decoders that predate v7 reject v7 replays instead of re-timing them with rules 1.   [v7]
//   zones        varint count, then per zone: u8 kind (0 start, 1 end, 2 stage, 3 checkpoint), u8 track,
//                u8 index (stage/checkpoint number), f32 x3 mins, f32 x3 maxs                     [v2]
//                v1: no track byte (track 0); u8 count, then per zone: u8 kind (0 start, 1 end),
//                f32 x3 mins, f32 x3 maxs
//   clientBuild  str8  (e.g. "bunnyhop-web/<wasm sha256 prefix>")
//   player       str8
//   recordedAt   f64   unix ms
//   cpInterval   varint
//   cpCount      varint
//   commands     column-major, totalTicks entries per column:
//                  forward  zigzag varint of delta vs previous (i16 domain)
//                  side     zigzag varint of delta vs previous (i16 domain)
//                  buttons  varint of (buttons XOR previous): u16 before physics v7; v7 adds a weapon command id in
//                           bits 16..20 (input.ts IN_GIVE_*), so v7 buttons are u32 (the same bytes when unused)
//                  yaw      zigzag varint of int32 delta of the raw f32 bit pattern
//                  pitch    zigzag varint of int32 delta of the raw f32 bit pattern
//                v8 (counted yaw): the yaw column is replaced by the mouse counts it was made from (see "v8" below).
//   checkpoints  cpCount x { varint tick delta, f32 x3 position, f32 x3 velocity }
//                taken every cpInterval ticks (state after the tick, after any prespeed clamp) + the final tick.
//   cosmetics    optional trailer, any version (absent when there are none): u32 "BHCX", varint count, then per
//                event { varint tick delta, u8 kind } (kind 1 = carrot slash, 2 = stab; viewmodel/events.ts). Purely
//                cosmetic (third-person swings in replays, ghosts): never part of the simulation, ignored by
//                verification. Decoders that predate it stop after the checkpoints, so it needs no version bump;
//                a malformed trailer is dropped, never an error.
//   loadout      optional trailer after the cosmetics (absent = unknown, shown as the default carrot): u32 "BHLO",
//                str8 packed cosmetic loadout (loadout.ts packLoadout: knife, finish, gloves, crown, the owner's hat;
//                v0.0.5 trailers also carried a pattern seed / wear, now ignored),
//                so a replay or ghost shows the knife the run was played with. Same rules as the cosmetics trailer:
//                no version bump (older decoders stop before it, including the cosmetics reader, which rewinds on
//                a magic it doesn't know), ignored by verification, dropped when malformed.
//   inspects     optional trailer after the loadout (absent when there are none): u32 "BHCI", varint count, then per
//                event { varint tick delta, u8 kind } (1 = an inspect started, 2 = the next trick of the chain took
//                over, 3 = inspect key held, 4 = released; viewmodel/inspects/combo.ts), shown as the third-person
//                inspect gesture in replays and ghosts. Its own magic rather than new BHCX kinds: older clients play
//                every BHCX event as a swing. Same rules: no version bump (older decoders stop before it), never
//                verified, dropped when malformed.
//   turn speed   optional trailer after the inspects (absent = cl_yawspeed 210 and no fast turn, every replay before
//                v0.0.29): u32 "BHTS", f32 yawSpeed (cl_yawspeed, degrees per second), f32 angleSpeedKey (the fast-turn
//                multiplier, cl_anglespeedkey). The rates the +left / +right binds turned with for the whole recording
//                (turn-binds.ts turnDelta); the anticheat checks every turn rebase against them. Only the analysis
//                reads it: the commands re-simulate as always. No version bump (older decoders stop before it); unlike
//                the cosmetic trailers a malformed one is an error, never silently the legacy rate.

// v8 (counted yaw, research/ANTICHEAT.md §8.17): the client keeps the view yaw as an exact base plus whole mouse counts,
// yaw = countedYaw(base, count, k) = norm360(base - count * k) with k = sensitivity * m_yaw (CS:S units), so the yaw of
// every command follows from integers. A v8 replay stores, instead of the yaw column:
//   counts       per tick, zigzag varint of (count - previous tick's count); at a rebase tick, of the count itself
//   rebases      varint count, then per rebase { varint tick delta, u8 kind (YAW_SET_*), f64 base, f64 k }: the view was
//                set (spawn / restart, teleport, rotating pusher, a sensitivity change, or anything else = raw) and the
//                count restarted from 0
//   input stats  per tick, varint each: rAF frames, mouse motion events and mouse reports (coalesced) since the
//                previous command (client diagnostics, not simulated)
// in that order, right after the pitch column. The decoder rebuilds the yaw column bit for bit (Math.fround of
// countedYaw), so everything downstream (simulation, hashes, viewers) is unchanged. A recording whose counts aren't
// whole numbers (an OS-scaled mouse) is written as v7, without counts. v1-v7 decode exactly as before.
// v10: a turn-bind recording with fractional mouse counts keeps exact absolute f64 counts in place of the integer
// count deltas. Everything else follows v9 (including its stamina/count flags). This preserves both the original
// mouse motion and the manual-turn markers on scaled/accelerated mice; integer recordings retain v8/v9 encoding.

import { PHYSICS_V1, PHYSICS_V7, type RestartPoint, type Settings } from "./core";
import { TIMER_RULES_V1 } from "./timer";
import { trackOf, trackSuffix, type Zone, type ZoneKind } from "./zones";
import { packLoadout, unpackLoadout, type CosmeticLoadout } from "./loadout";
import { foldRange } from "./run-hash";
import type { TurnSpeed } from "./turn-binds";

export const REPLAY_MAGIC = 0x50524842; // "BHRP" little-endian
/** Version of new recordings (timer rules 2+). Rules 1 replays keep the v4 / v5 / v6 layout byte for byte. */
export const REPLAY_VERSION = 7;
/** Version of a recording with counted yaw (v8: REPLAY_VERSION + the counts; always timer rules 2+). */
export const REPLAY_VERSION_COUNTED = 8;
/** Version of a timer rules 1 replay with physics v2+. */
export const REPLAY_VERSION_PHYSICS = 6;
/** Highest decoded format: v8 counted yaw, v9 stamina, v10 fractional counts with turn provenance. */
export const REPLAY_VERSION_MAX = 10;
/** v9 adds stamina (flag 1) and explicitly marks counted yaw (flag 2); other styles retain their old formats. */
export const REPLAY_VERSION_STAMINA = 9;
export const REPLAY_VERSION_FRACTIONAL = 10;
const hasRestartNames = (h: Pick<ReplayHeader, "spawn">) => !!(h.spawn && (h.spawn.targetname || h.spawn.classname));
/** Physics version of a header (settings without the field: v1). */
export const replayPhysics = (h: Pick<ReplayHeader, "settings">): number => h.settings.physics ?? PHYSICS_V1;
/** Timer rules of a header (replays without the field: rules 1). */
export const replayTimerRules = (h: Pick<ReplayHeader, "timerRules">): number => h.timerRules ?? TIMER_RULES_V1;
/** View set kinds (v8 rebases): what set the view yaw before the count restarted. */
export const YAW_SET_SPAWN = 1;
export const YAW_SET_TELEPORT = 2;
export const YAW_SET_PUSHER = 3;
export const YAW_SET_SENSITIVITY = 4;
export const YAW_SET_RAW = 5;
/** Manual turn: changes the base while retaining the cumulative mouse counts and sensitivity. */
export const YAW_SET_TURN = 6;
/** A turn on the same tick as another view set retains that set's reason in the low bits. */
export const YAW_WITH_TURN = 1 << 7;
/** [0, 360) the way the client always wrapped yaw. */
export const norm360 = (x: number): number => ((x % 360) + 360) % 360;
/** v8: the view yaw from an exact base and whole mouse counts (degrees = counts * sensitivity * m_yaw, CS:S style). */
export const countedYaw = (base: number, count: number, k: number): number => norm360(base - count * k);

/** One command's view state (v8): the base, whole counts since it and k, the rebase epoch, and input stats. */
export interface LookSample {
  base: number;
  count: number;
  k: number;
  epoch: number;
  kind: number;
  frames: number;
  events: number;
  reports: number;
}

/** Counted-yaw data: whole counts in v8/v9, exact fractional counts in v10; rebases/input stats share the layout. */
export interface CountedYaw {
  count: Int32Array | Float64Array;
  rebases: { tick: number; kind: number; base: number; k: number }[];
  frames: Uint16Array;
  events: Uint16Array;
  reports: Uint16Array;
}

/** The version a header is encoded as. */
export const replayVersionFor = (h: Pick<ReplayHeader, "spawn" | "settings" | "timerRules" | "style">) =>
  h.settings.stamina || h.style === "lowgrav" ? REPLAY_VERSION_STAMINA : replayTimerRules(h) !== TIMER_RULES_V1 ? REPLAY_VERSION : replayPhysics(h) !== PHYSICS_V1 ? REPLAY_VERSION_PHYSICS : hasRestartNames(h) ? 5 : 4;
/** Low Gravity started with v9 format, physics v10 and timer rules 2; older combinations never existed. */
export const styleReplayAllowed = (h: ReplayHeader): boolean =>
  replayStyle(h) !== "lowgrav" || ((h.version ?? 0) >= 9 && replayPhysics(h) >= 10 && replayTimerRules(h) >= 2);
const ZONE_KIND_CODES: readonly ZoneKind[] = ["start", "end", "stage", "checkpoint"];
export const FLAG_AUTOHOP = 1 << 0;
const FLAG_STAMINA = 1 << 1;
const FLAG_COUNTED = 1 << 2;
/**
 * Null binds were on for some of the recording (null-binds.ts): with A + D (or W + S) held, the key pressed last moved
 * the player. Any version; only written when set, so other replays are byte-identical. Older decoders ignore it.
 * Information for the anticheat only: the commands are the resolved ones and re-simulate as always.
 */
export const FLAG_NULL_BINDS = 1 << 3;
/**
 * Timestamped input built some of the recorded commands (timed-input.ts): each tick took the mouse reports and movement
 * keys stamped before its boundary, not the frame's view. Any version; only written when set; older decoders ignore it.
 * Information for the anticheat only (the frame-rate measures don't apply): the commands re-simulate as always.
 */
export const FLAG_TIMED_INPUT = 1 << 4;
export const DEFAULT_CHECKPOINT_INTERVAL = 100;
export const COSMETIC_MAGIC = 0x58434842; // "BHCX" little-endian
export const LOADOUT_MAGIC = 0x4f4c4842; // "BHLO" little-endian
export const INSPECT_MAGIC = 0x49434842; // "BHCI" little-endian
export const TURN_SPEED_MAGIC = 0x53544842; // "BHTS" little-endian
/** Inspect trailer kinds (the first two are combo.ts SIG_START / SIG_NEXT). */
export const INSPECT_START = 1;
export const INSPECT_NEXT = 2;
export const INSPECT_HOLD = 3;
export const INSPECT_RELEASE = 4;
/** Most cosmetic events kept per replay (a swing every 0.4 s for an hour is 9000). */
export const MAX_COSMETIC_EVENTS = 20000;

/** A cosmetic event at a state tick (number of commands simulated before it happened). */
export interface CosmeticEvent {
  tick: number;
  kind: number;
}

export interface ReplayHeader {
  version: number;
  map: string;
  mapSha256: string; // hex
  settings: Settings;
  prespeedCap: number | null;
  startTick: number;
  endTick: number;
  totalTicks: number;
  /** Track the run was on (0 = main, N = bonus N). Version 1 replays are always track 0. */
  track: number;
  /** Start-zone restart point applied right after core.reset() (setPosition), if any. [v3] */
  spawn?: RestartPoint | null;
  /** Style id (styles.ts). Always set on decoded replays (v1-3: from the autohop flag); absent = styleName(settings). [v4] */
  style?: string;
  /** Start-zone rules the run was timed with (timer.ts TIMER_RULES_*). Absent = rules 1; always set on decoded replays. [v7] */
  timerRules?: number;
  zones: Zone[];
  clientBuild: string;
  player: string;
  recordedAt: number;
  checkpointInterval: number;
  /** Null binds were on during the recording (FLAG_NULL_BINDS). Absent when off. */
  nullBinds?: boolean;
  /** Timestamped input built some recorded command (FLAG_TIMED_INPUT). Absent when off. */
  timedInput?: boolean;
  /** The turn binds' rates for the whole recording (the "BHTS" trailer). Absent: 210°/s, no fast turn. */
  turnSpeed?: TurnSpeed;
}

export interface Checkpoint {
  tick: number;
  position: [number, number, number];
  velocity: [number, number, number];
}

export interface Replay {
  header: ReplayHeader;
  forward: Int16Array;
  side: Int16Array;
  /** Buttons (input.ts IN_*): u16 before physics v7; decoded replays and recordings are Uint32Array (v7 weapon commands
   * in bits 16..20). */
  buttons: Uint16Array | Uint32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  checkpoints: Checkpoint[];
  /** Cosmetic events (carrot swings), tick order. Optional trailer; never simulated or verified. */
  cosmetic?: CosmeticEvent[];
  /** The cosmetic loadout the run was played with (knife, finish, gloves). Optional trailer; never verified. */
  loadout?: CosmeticLoadout;
  /** Inspect events (INSPECT_* kinds), tick order. Optional trailer; never simulated or verified. */
  inspect?: CosmeticEvent[];
  /** v8: the mouse counts the yaw column was made from (absent: v1-v7, or a recording without whole counts). */
  counted?: CountedYaw;
}

/** Style implied by the physics settings alone (replays before v4 had no style field). */
export function styleName(settings: Settings): string {
  return settings.autohop ? "autohop" : "legit";
}

/** The run's style id: the header's style (v4) or, for older replays, the one implied by the autohop flag. */
export function replayStyle(h: Pick<ReplayHeader, "style" | "settings">): string {
  return h.style ?? styleName(h.settings);
}

// ---------------------------------------------------------------------------
// Recording

/** Accumulates commands as they are fed to the sim. */
export class ReplayRecorder {
  private n = 0;
  private forward = new Int16Array(4096);
  private side = new Int16Array(4096);
  private buttons = new Uint32Array(4096);
  private yaw = new Float32Array(4096);
  private pitch = new Float32Array(4096);
  /** v8: each command's view state (null: none given, e.g. a scripted command). */
  private looks: (LookSample | null)[] = [];
  checkpoints: Checkpoint[] = [];
  cosmetic: CosmeticEvent[] = [];
  inspect: CosmeticEvent[] = [];
  /** Null binds resolved some recorded command (header.nullBinds). */
  nullBinds = false;
  /** Timestamped input built some recorded command (header.timedInput). */
  timedInput = false;
  /** The turn binds' rates for this whole recording (header.turnSpeed); set at its start (session.ts). */
  turnSpeed: TurnSpeed | null = null;

  constructor(public checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL) {}

  get length(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
    this.looks = [];
    this.nullBinds = false;
    this.timedInput = false;
    this.turnSpeed = null;
    this.checkpoints = [];
    this.cosmetic = [];
    this.inspect = [];
  }

  /** Records a cosmetic event (e.g. a carrot swing) at the current tick. Never affects the commands. */
  event(kind: number): void {
    if (this.cosmetic.length < MAX_COSMETIC_EVENTS) this.cosmetic.push({ tick: this.n, kind: kind & 0xff });
  }

  /** Records an inspect event (INSPECT_* kind) at the current tick. Never affects the commands. */
  inspectEvent(kind: number): void {
    if (this.inspect.length < MAX_COSMETIC_EVENTS) this.inspect.push({ tick: this.n, kind: kind & 0xff });
  }

  private grow(): void {
    const g = <T extends Int16Array | Uint32Array | Float32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.forward = g(this.forward);
    this.side = g(this.side);
    this.buttons = g(this.buttons);
    this.yaw = g(this.yaw);
    this.pitch = g(this.pitch);
  }

  /** Records one command. Values must already be exactly what was passed to core.step. `look`: its view state (v8). */
  push(forward: number, side: number, yaw: number, pitch: number, buttons: number, look: LookSample | null = null): void {
    if (this.n === this.forward.length) this.grow();
    const i = this.n++;
    this.looks[i] = look;
    this.forward[i] = forward;
    this.side[i] = side;
    this.buttons[i] = buttons;
    this.yaw[i] = yaw;
    this.pitch[i] = pitch;
    if (this.forward[i] !== forward || this.side[i] !== side || this.buttons[i] !== buttons || this.yaw[i] !== yaw || this.pitch[i] !== pitch) {
      throw new Error(`replay: command at tick ${i} not representable (forward/side must be i16, yaw/pitch f32, buttons u32)`);
    }
  }

  /** Folds recorded commands [from, to) into a run hash (run-hash.ts; run sessions, run-clock.ts). */
  fold(h: number, from: number, to: number): number {
    const c = { forward: this.forward, side: this.side, buttons: this.buttons, yaw: this.yaw, pitch: this.pitch };
    return foldRange(h, c, Math.max(0, from), Math.min(to, this.n));
  }

  /** Call after each tick with the post-tick state; records a checkpoint every interval ticks. */
  maybeCheckpoint(tick: number, position: readonly number[], velocity: readonly number[]): void {
    if (tick % this.checkpointInterval === 0) this.addCheckpoint(tick, position, velocity);
  }

  addCheckpoint(tick: number, position: readonly number[], velocity: readonly number[]): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && last.tick === tick) return;
    this.checkpoints.push({
      tick,
      position: [position[0], position[1], position[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
    });
  }

  /** Snapshot as a Replay (copies). */
  build(header: Omit<ReplayHeader, "totalTicks" | "checkpointInterval" | "version">): Replay {
    const n = this.n;
    return {
      header: { ...header, version: replayVersionFor(header), totalTicks: n, checkpointInterval: this.checkpointInterval, ...(this.nullBinds ? { nullBinds: true } : {}), ...(this.timedInput ? { timedInput: true } : {}), ...(this.turnSpeed ? { turnSpeed: { ...this.turnSpeed } } : {}) },
      forward: this.forward.slice(0, n),
      side: this.side.slice(0, n),
      buttons: this.buttons.slice(0, n),
      yaw: this.yaw.slice(0, n),
      pitch: this.pitch.slice(0, n),
      checkpoints: this.checkpoints.map((c) => ({ ...c, position: [...c.position], velocity: [...c.velocity] })),
      cosmetic: this.cosmetic.map((e) => ({ ...e })),
      inspect: this.inspect.map((e) => ({ ...e })),
      ...withCounted(this.looks, this.yaw, n),
    };
  }
}

/**
 * Counted-yaw data, or nothing when it can't be represented (a missing view state; fractional counts without turns
 * retain the old v7 fallback). Each recorded yaw must be exactly Math.fround(countedYaw(...)) of its
 * view state; a command where it isn't (a view set this module wasn't told about) becomes a raw rebase at its own yaw,
 * so the encoding is always lossless.
 */
function withCounted(looks: readonly (LookSample | null)[], yaw: Float32Array, n: number): { counted?: CountedYaw } {
  if (n === 0) return {};
  const fractional = looks.some((l) => l && !Number.isInteger(l.count));
  // Preserve the historical fallback unless turns need their metadata retained.
  if (fractional && !looks.some((l) => l && (l.kind === YAW_SET_TURN || (l.kind & YAW_WITH_TURN) !== 0))) return {};
  const count = fractional ? new Float64Array(n) : new Int32Array(n);
  const frames = new Uint16Array(n);
  const events = new Uint16Array(n);
  const reports = new Uint16Array(n);
  const rebases: CountedYaw["rebases"] = [];
  // The client's view state (epoch) and the one the encoding follows (`enc`): they differ only after a raw set, when
  // the encoding counts from the recorded yaw (offset: the client's count at that tick).
  let epoch = -1;
  let enc = { base: 0, k: 0, offset: 0 };
  const clampU16 = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v) || 0));
  const fits = (base: number, c: number, k: number, y: number) => Object.is(Math.fround(countedYaw(base, c, k)), y);
  for (let i = 0; i < n; i++) {
    const l = looks[i];
    if (!l || !Number.isFinite(l.count) || Math.abs(l.count) > 0x3fffffff || !Number.isFinite(l.base) || !Number.isFinite(l.k)) return {};
    frames[i] = clampU16(l.frames);
    events[i] = clampU16(l.events);
    reports[i] = clampU16(l.reports);
    if (l.epoch !== epoch || i === 0) {
      epoch = l.epoch;
      enc = { base: l.base, k: l.k, offset: 0 };
      rebases.push({ tick: i, kind: l.kind, base: l.base, k: l.k });
    }
    const c = l.count - enc.offset;
    if (fits(enc.base, c, enc.k, yaw[i])) {
      count[i] = c;
      continue;
    }
    // Not what the encoding's state says. After a raw set, back to the client's own base if that fits again (a raw set
    // too: nothing explains the switch); otherwise a raw set at the recorded yaw.
    if ((enc.offset !== 0 || enc.base !== l.base || enc.k !== l.k) && fits(l.base, l.count, l.k, yaw[i])) {
      enc = { base: l.base, k: l.k, offset: 0 };
      count[i] = l.count;
      rebases.push({ tick: i, kind: YAW_SET_RAW, base: l.base, k: l.k });
      continue;
    }
    enc = { base: yaw[i], k: l.k, offset: l.count };
    count[i] = 0;
    rebases.push({ tick: i, kind: YAW_SET_RAW, base: yaw[i], k: l.k });
    if (!fits(yaw[i], 0, l.k, yaw[i])) return {}; // not even representable raw: v7
  }
  return { counted: { count, rebases, frames, events, reports } };
}

// ---------------------------------------------------------------------------
// Binary encoding

class Writer {
  private buf = new Uint8Array(1 << 16);
  private dv = new DataView(this.buf.buffer);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v;
  }
  u16(v: number) {
    this.ensure(2);
    this.dv.setUint16(this.len, v, true);
    this.len += 2;
  }
  u32(v: number) {
    this.ensure(4);
    this.dv.setUint32(this.len, v, true);
    this.len += 4;
  }
  f32(v: number) {
    this.ensure(4);
    this.dv.setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number) {
    this.ensure(8);
    this.dv.setFloat64(this.len, v, true);
    this.len += 8;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  str8(s: string) {
    let b = new TextEncoder().encode(s);
    if (b.length > 255) b = b.subarray(0, 255);
    this.u8(b.length);
    this.bytes(b);
  }
  /** Unsigned LEB128 for values in [0, 2^32). */
  varint(v: number) {
    v >>>= 0;
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  /** Zigzag-encoded signed 32-bit varint. */
  svarint(v: number) {
    this.varint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private dv: DataView;
  pos = 0;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error("replay: truncated");
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  str8() {
    return new TextDecoder().decode(this.bytes(this.u8()));
  }
  varint() {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) throw new Error("replay: bad varint");
    }
    return v >>> 0;
  }
  svarint() {
    const v = this.varint();
    return (v >>> 1) ^ -(v & 1);
  }
}

const hexToBytes = (hex: string) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
};
const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function encodeRaw(r: Replay): Uint8Array {
  const h = r.header;
  const n = h.totalTicks;
  const w = new Writer();
  w.u32(REPLAY_MAGIC);
  const counted = r.counted && replayTimerRules(h) !== TIMER_RULES_V1 ? r.counted : null;
  const fractional = counted?.count instanceof Float64Array;
  const version = fractional ? REPLAY_VERSION_FRACTIONAL : h.settings.stamina || h.style === "lowgrav" ? REPLAY_VERSION_STAMINA : counted ? REPLAY_VERSION_COUNTED : replayVersionFor(h);
  w.u16(version);
  w.u16((h.settings.autohop ? FLAG_AUTOHOP : 0) | (h.settings.stamina ? FLAG_STAMINA : 0) | (version >= REPLAY_VERSION_STAMINA && counted ? FLAG_COUNTED : 0) | (h.nullBinds ? FLAG_NULL_BINDS : 0) | (h.timedInput ? FLAG_TIMED_INPUT : 0));
  w.str8(h.map);
  w.bytes(hexToBytes(h.mapSha256));
  const s = h.settings;
  for (const v of [s.tickInterval, s.airAccelerate, s.accelerate, s.friction, s.stopSpeed, s.gravity, s.maxSpeed]) w.f32(v);
  w.f32(h.prespeedCap ?? 0);
  w.u32(h.startTick);
  w.u32(h.endTick);
  w.u32(n);
  w.u8(h.track ?? 0);
  if (h.spawn) {
    w.u8(1);
    for (const v of [...h.spawn.position, h.spawn.yaw]) w.f32(v);
    if (version >= 5) {
      w.str8(h.spawn.targetname ?? "");
      w.str8(h.spawn.classname ?? "");
    }
  } else {
    w.u8(0);
  }
  w.str8(replayStyle(h));
  if (version >= 6) {
    const physics = replayPhysics(h);
    if (!Number.isInteger(physics) || physics < 1 || physics > 255) throw new Error(`replay: physics version ${physics} not representable`);
    w.u8(physics);
  }
  if (version >= 7) {
    const rules = replayTimerRules(h);
    if (!Number.isInteger(rules) || rules < 1 || rules > 255) throw new Error(`replay: timer rules ${rules} not representable`);
    w.u8(rules);
  }
  w.varint(h.zones.length);
  for (const z of h.zones) {
    w.u8(ZONE_KIND_CODES.indexOf(z.kind));
    w.u8(trackOf(z));
    w.u8(z.index ?? 0);
    for (const v of [...z.mins, ...z.maxs]) w.f32(v);
  }
  w.str8(h.clientBuild);
  w.str8(h.player);
  w.f64(h.recordedAt);
  w.varint(h.checkpointInterval);
  w.varint(r.checkpoints.length);

  let prev = 0;
  for (let i = 0; i < n; i++) w.svarint(r.forward[i] - prev), (prev = r.forward[i]);
  prev = 0;
  for (let i = 0; i < n; i++) w.svarint(r.side[i] - prev), (prev = r.side[i]);
  prev = 0;
  for (let i = 0; i < n; i++) w.varint(r.buttons[i] ^ prev), (prev = r.buttons[i]);
  for (const col of counted ? [r.pitch] : [r.yaw, r.pitch]) {
    const bits = new Int32Array(col.buffer, col.byteOffset, n);
    prev = 0;
    for (let i = 0; i < n; i++) w.svarint((bits[i] - prev) | 0), (prev = bits[i]);
  }
  if (counted) {
    let rb = 0;
    prev = 0;
    for (let i = 0; i < n; i++) {
      const rebase = rb < counted.rebases.length && counted.rebases[rb].tick === i;
      while (rb < counted.rebases.length && counted.rebases[rb].tick === i) rb++;
      if (fractional) w.f64(counted.count[i]);
      else w.svarint(rebase ? counted.count[i] : (counted.count[i] - prev) | 0);
      prev = counted.count[i];
    }
    w.varint(counted.rebases.length);
    prev = 0;
    for (const b of counted.rebases) {
      w.varint(b.tick - prev);
      prev = b.tick;
      w.u8(b.kind & 0xff);
      w.f64(b.base);
      w.f64(b.k);
    }
    for (const col of [counted.frames, counted.events, counted.reports]) for (let i = 0; i < n; i++) w.varint(col[i]);
  }
  prev = 0;
  for (const c of r.checkpoints) {
    w.varint(c.tick - prev);
    prev = c.tick;
    for (const v of [...c.position, ...c.velocity]) w.f32(v);
  }
  const cos = r.cosmetic ?? [];
  if (cos.length) {
    w.u32(COSMETIC_MAGIC);
    const n = Math.min(cos.length, MAX_COSMETIC_EVENTS);
    w.varint(n);
    prev = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.max(prev, cos[i].tick);
      w.varint(t - prev);
      w.u8(cos[i].kind & 0xff);
      prev = t;
    }
  }
  if (r.loadout) {
    w.u32(LOADOUT_MAGIC);
    w.str8(packLoadout(r.loadout));
  }
  const ins = r.inspect ?? [];
  if (ins.length) {
    w.u32(INSPECT_MAGIC);
    const n = Math.min(ins.length, MAX_COSMETIC_EVENTS);
    w.varint(n);
    prev = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.max(prev, ins[i].tick);
      w.varint(t - prev);
      w.u8(ins[i].kind & 0xff);
      prev = t;
    }
  }
  if (h.turnSpeed) {
    w.u32(TURN_SPEED_MAGIC);
    w.f32(h.turnSpeed.yawSpeed);
    w.f32(h.turnSpeed.angleSpeedKey);
  }
  return w.result();
}

/**
 * Decodes a raw (uncompressed) replay. `commands: false` reads the whole file the same way (so it fails on the same
 * malformed input) but keeps no command columns (empty arrays): the API's upload checks only need the header and the
 * trailers, and a multi-hour replay's columns are 14 bytes a tick (apps/api/src/replay-io.ts).
 */
export function decodeRaw(buf: Uint8Array, opts: { commands?: boolean } = {}): Replay {
  const r = new Reader(buf);
  if (r.u32() !== REPLAY_MAGIC) throw new Error("replay: bad magic");
  const version = r.u16();
  if (version < 1 || version > REPLAY_VERSION_MAX) throw new Error(`replay: unsupported version ${version}`);
  const flags = r.u16();
  const map = r.str8();
  const mapSha256 = bytesToHex(r.bytes(32));
  const f = Array.from({ length: 7 }, () => r.f32());
  const settings: Settings = {
    tickInterval: f[0],
    airAccelerate: f[1],
    accelerate: f[2],
    friction: f[3],
    stopSpeed: f[4],
    gravity: f[5],
    maxSpeed: f[6],
    autohop: (flags & FLAG_AUTOHOP) !== 0,
    physics: PHYSICS_V1,
  };
  if (version >= REPLAY_VERSION_STAMINA) settings.stamina = (flags & FLAG_STAMINA) !== 0;
  const cap = r.f32();
  const startTick = r.u32();
  const endTick = r.u32();
  const n = r.u32();
  const zones: Zone[] = [];
  let track = 0;
  let spawn: RestartPoint | null = null;
  let style = styleName(settings);
  let timerRules = TIMER_RULES_V1;
  if (version === 1) {
    for (let i = r.u8(); i > 0; i--) {
      const kind = r.u8() === 0 ? "start" : "end";
      const v = Array.from({ length: 6 }, () => r.f32());
      zones.push({ kind, mins: [v[0], v[1], v[2]], maxs: [v[3], v[4], v[5]] });
    }
  } else {
    track = r.u8();
    if (version >= 3 && r.u8() === 1) {
      const v = Array.from({ length: 4 }, () => r.f32());
      spawn = { position: [v[0], v[1], v[2]], yaw: v[3] };
      if (version >= 5) {
        const targetname = r.str8();
        const classname = r.str8();
        if (targetname) spawn.targetname = targetname;
        if (classname) spawn.classname = classname;
      }
    }
    if (version >= 4) style = r.str8();
    if (version >= 6) settings.physics = r.u8();
    if (version >= 7) timerRules = r.u8();
    for (let i = r.varint(); i > 0; i--) {
      const kind = ZONE_KIND_CODES[r.u8()];
      if (!kind) throw new Error("replay: bad zone kind");
      const zt = r.u8();
      const index = r.u8();
      const v = Array.from({ length: 6 }, () => r.f32());
      const z: Zone = { kind, mins: [v[0], v[1], v[2]], maxs: [v[3], v[4], v[5]] };
      if (zt) z.track = zt;
      if (kind === "stage" || kind === "checkpoint") z.index = index;
      zones.push(z);
    }
  }
  const clientBuild = r.str8();
  const player = r.str8();
  const recordedAt = r.f64();
  const checkpointInterval = r.varint();
  const cpCount = r.varint();

  const keep = opts.commands ?? true;
  const cols = keep ? n : 0;
  const forward = new Int16Array(cols);
  const side = new Int16Array(cols);
  // u32 (physics v7 weapon commands in bits 16..20); earlier replays only ever have u16 buttons, and are read as such.
  const buttonMask = (settings.physics ?? PHYSICS_V1) >= PHYSICS_V7 ? 0xffffffff : 0xffff;
  const buttons = new Uint32Array(cols);
  const yaw = new Float32Array(cols);
  const pitch = new Float32Array(cols);
  const fractional = version === REPLAY_VERSION_FRACTIONAL;
  const isCounted = version === REPLAY_VERSION_COUNTED || (version >= REPLAY_VERSION_STAMINA && (flags & FLAG_COUNTED) !== 0);
  if (fractional && !isCounted) throw new Error("replay: fractional counts require counted yaw");
  let counted: CountedYaw | undefined;
  let prev = 0;
  if (!keep) {
    for (let i = 0; i < (fractional ? 4 : 5) * n; i++) r.varint(); // v8: pitch and counts replace yaw; v10 counts are f64
    if (fractional) for (let i = 0; i < n; i++) readFractionalCount(r);
    if (isCounted) {
      for (let i = r.varint(); i > 0; i--) (r.varint(), r.u8(), r.f64(), r.f64());
      for (let i = 0; i < 3 * n; i++) r.varint();
    }
  } else {
    for (let i = 0; i < n; i++) forward[i] = prev = prev + r.svarint();
    prev = 0;
    for (let i = 0; i < n; i++) side[i] = prev = prev + r.svarint();
    prev = 0;
    for (let i = 0; i < n; i++) buttons[i] = (prev = prev ^ r.varint()) & buttonMask;
    for (const col of isCounted ? [pitch] : [yaw, pitch]) {
      const bits = new Int32Array(col.buffer);
      prev = 0;
      for (let i = 0; i < n; i++) bits[i] = prev = (prev + r.svarint()) | 0;
    }
    if (isCounted) counted = readCounted(r, n, yaw, fractional);
  }
  const checkpoints: Checkpoint[] = [];
  prev = 0;
  for (let i = 0; i < cpCount; i++) {
    const tick = (prev += r.varint());
    const v = Array.from({ length: 6 }, () => r.f32());
    checkpoints.push({ tick, position: [v[0], v[1], v[2]], velocity: [v[3], v[4], v[5]] });
  }
  const cosmetic = readCosmetics(r);
  const loadout = readLoadout(r);
  const inspect = readInspects(r);
  const turnSpeed = readTurnSpeed(r);
  return {
    header: {
      version,
      map,
      mapSha256,
      settings,
      prespeedCap: cap > 0 ? cap : null,
      startTick,
      endTick,
      totalTicks: n,
      track,
      spawn,
      style,
      timerRules,
      zones,
      clientBuild,
      player,
      recordedAt,
      checkpointInterval,
      ...(flags & FLAG_NULL_BINDS ? { nullBinds: true } : {}),
      ...(flags & FLAG_TIMED_INPUT ? { timedInput: true } : {}),
      ...(turnSpeed ? { turnSpeed } : {}),
    },
    forward,
    side,
    buttons,
    yaw,
    pitch,
    checkpoints,
    ...(cosmetic.length ? { cosmetic } : {}),
    ...(loadout ? { loadout } : {}),
    ...(inspect.length ? { inspect } : {}),
    ...(counted ? { counted } : {}),
  };
}

/** v10: an exact, bounded mouse count (header-only uploads check the same values as full reads). */
function readFractionalCount(r: Reader): number {
  const count = r.f64();
  if (!Number.isFinite(count) || Math.abs(count) > 0x3fffffff) throw new Error("replay: bad fractional mouse count");
  return count;
}
/** Reads counts/rebases/input stats and reconstructs every yaw bit. v10 stores absolute f64 counts. */
function readCounted(r: Reader, n: number, yaw: Float32Array, fractional = false): CountedYaw {
  const raw = fractional ? new Float64Array(n) : new Int32Array(n);
  for (let i = 0; i < n; i++) raw[i] = fractional ? readFractionalCount(r) : r.svarint();
  const rebases: CountedYaw["rebases"] = [];
  let tick = 0;
  for (let i = r.varint(); i > 0; i--) {
    tick += r.varint();
    const kind = r.u8();
    const base = r.f64();
    const k = r.f64();
    if (tick >= n || (rebases.length && tick < rebases[rebases.length - 1].tick)) throw new Error("replay: bad rebase tick");
    rebases.push({ tick, kind, base, k });
  }
  if (n > 0 && (!rebases.length || rebases[0].tick !== 0)) throw new Error("replay: counted yaw without a base at tick 0");
  const count = fractional ? new Float64Array(n) : new Int32Array(n);
  let rb = 0;
  let base = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    let rebase = false;
    while (rb < rebases.length && rebases[rb].tick === i) ({ base, k } = rebases[rb++]), (rebase = true);
    count[i] = fractional || rebase ? raw[i] : (count[i - 1] + raw[i]) | 0;
    yaw[i] = countedYaw(base, count[i], k);
  }
  const col = () => {
    const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.min(0xffff, r.varint());
    return a;
  };
  const frames = col();
  const events = col();
  const reports = col();
  return { count, rebases, frames, events, reports };
}

/**
 * Inspect state for a replay frame: the last start / next event with from < tick <= to (INSPECT_START / _NEXT, 0 =
 * none) and whether the inspect key is held at `to`. Events are in tick order.
 */
export function inspectBetween(ev: readonly CosmeticEvent[] | undefined, from: number, to: number): { sig: number; held: boolean } {
  if (!ev || !ev.length) return { sig: 0, held: false };
  let lo = 0;
  let hi = ev.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ev[m].tick > to) hi = m;
    else lo = m + 1;
  }
  // ev[0 .. lo) have tick <= to; walk back for the latest signal in (from, to] and the latest held edge.
  let sig = 0;
  let held: boolean | null = null;
  for (let i = lo - 1; i >= 0; i--) {
    const e = ev[i];
    if (held === null && (e.kind === INSPECT_HOLD || e.kind === INSPECT_RELEASE)) held = e.kind === INSPECT_HOLD;
    if (!sig && e.tick > from && (e.kind === INSPECT_START || e.kind === INSPECT_NEXT)) sig = e.kind;
    if (held !== null && (sig || e.tick <= from)) break;
  }
  return { sig: to > from ? sig : 0, held: !!held };
}

/** Kind of the last cosmetic event with from < tick <= to (0 = none). Events are in tick order. */
export function cosmeticBetween(ev: readonly CosmeticEvent[] | undefined, from: number, to: number): number {
  if (!ev || !ev.length || to <= from) return 0;
  let lo = 0;
  let hi = ev.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ev[m].tick > from) hi = m;
    else lo = m + 1;
  }
  let k = 0;
  for (let i = lo; i < ev.length && ev[i].tick <= to; i++) k = ev[i].kind;
  return k;
}

/** The optional cosmetic trailer (see the format notes); anything unexpected yields no events. */
function readCosmetics(r: Reader): CosmeticEvent[] {
  if (r.remaining < 4) return [];
  const at = r.pos;
  try {
    if (r.u32() !== COSMETIC_MAGIC) {
      r.pos = at;
      return [];
    }
    const n = r.varint();
    if (n > MAX_COSMETIC_EVENTS || n * 2 > r.remaining) return [];
    const out: CosmeticEvent[] = [];
    let tick = 0;
    for (let i = 0; i < n; i++) {
      tick += r.varint();
      out.push({ tick, kind: r.u8() });
    }
    return out;
  } catch {
    r.pos = at;
    return [];
  }
}

/** The optional inspect trailer (see the format notes); anything unexpected yields no events. */
function readInspects(r: Reader): CosmeticEvent[] {
  if (r.remaining < 4) return [];
  const at = r.pos;
  try {
    if (r.u32() !== INSPECT_MAGIC) {
      r.pos = at;
      return [];
    }
    const n = r.varint();
    if (n > MAX_COSMETIC_EVENTS || n * 2 > r.remaining) {
      r.pos = at;
      return [];
    }
    const out: CosmeticEvent[] = [];
    let tick = 0;
    for (let i = 0; i < n; i++) {
      tick += r.varint();
      out.push({ tick, kind: r.u8() });
    }
    return out;
  } catch {
    r.pos = at;
    return [];
  }
}

/** The optional turn-speed trailer (see the format notes): null when absent; a truncated or non-finite one throws. */
function readTurnSpeed(r: Reader): TurnSpeed | null {
  if (r.remaining < 4) return null;
  const at = r.pos;
  if (r.u32() !== TURN_SPEED_MAGIC) {
    r.pos = at;
    return null;
  }
  if (r.remaining < 8) throw new Error("replay: bad turn speed");
  const yawSpeed = r.f32();
  const angleSpeedKey = r.f32();
  if (!Number.isFinite(yawSpeed) || !Number.isFinite(angleSpeedKey)) throw new Error("replay: bad turn speed");
  return { yawSpeed, angleSpeedKey };
}

/** The optional loadout trailer (see the format notes); null when absent or malformed. */
function readLoadout(r: Reader): CosmeticLoadout | null {
  if (r.remaining < 5) return null;
  const at = r.pos;
  try {
    if (r.u32() !== LOADOUT_MAGIC) {
      r.pos = at;
      return null;
    }
    return unpackLoadout(r.str8());
  } catch {
    r.pos = at;
    return null;
  }
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Encodes and gzips a replay. */
export async function encodeReplay(r: Replay): Promise<Uint8Array> {
  return pipe(encodeRaw(r), new CompressionStream("gzip"));
}

/** Decodes a gzipped (or raw) replay. */
export async function decodeReplay(bytes: Uint8Array): Promise<Replay> {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await pipe(bytes, new DecompressionStream("gzip")) : bytes;
  return decodeRaw(raw);
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function replayFileName(h: ReplayHeader): string {
  const t = h.endTick ? ((h.endTick - h.startTick) * h.settings.tickInterval).toFixed(3) : "dnf";
  const tr = trackSuffix(h.track ?? 0);
  return `${h.map}${tr ? "_" + tr : ""}_${replayStyle(h)}_${t}s_${new Date(h.recordedAt).toISOString().replace(/[:.]/g, "-")}.bhr`;
}
