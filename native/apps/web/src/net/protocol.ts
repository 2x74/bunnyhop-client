// Multiplayer wire protocol, shared by the browser (apps/web/src/net/*) and the room Durable Object
// (apps/api/src/rooms/*). DOM-free and dependency-free apart from type imports, so both sides compile the same code.
//
// Transport: one WebSocket per player per room, `GET /servers/:id/ws?v=<PROTOCOL_VERSION>&style=<id>`.
// The server refuses other versions (HTTP 426 before the upgrade), so a stale tab can't speak an old format.
//
//   text "ping" -> "pong"     RTT probe. Answered by the runtime's WebSocket auto-response, so it never wakes the
//                             room (hibernation stays possible while players sit in menus).
//   binary MSG_STATE          client -> room, ~5 Hz while playing (0.0.21; 10 Hz before): five 25 Hz samples of the
//                             local sim + a meta block. Durable Objects bill incoming WebSocket messages, so fewer,
//                             fuller batches halve the rooms' cost; receivers interpolate along the samples' velocity
//                             (interp.ts), which keeps the motion as smooth as before or smoother.
//   binary MSG_SNAPSHOT       room -> clients, <= 20 Hz: every player's new samples since the last flush, coalesced.
//   text JSON {t: ...}        everything low-rate (chat, votes, roster, map changes, announcements): ClientMsg/ServerMsg.
//
// There is no server-side physics: every client simulates itself exactly as in solo play, and runs are verified by
// re-simulating uploaded replays. The room only relays (and sanity-checks) what clients report, so nothing a client
// says here is ever trusted for times or records.
//
// Binary layouts (little endian):
//
//   MSG_STATE (client -> room), 16 + n * 24 bytes [+ input block]
//     0  u8  type = MSG_STATE         1  u8  n samples (1..MAX_SAMPLES)   2 u8 weapon (WEAPON_REPORTED | id, 0x40 = the
//                                                                          USP's silencer is on (0.0.12); 0 = not reported)
//     3  u8  style (WIRE_STYLES idx)   4  u8  track                        5 u8 timer status (TIMER_*)
//     6  u16 ping ms (client RTT)      8  u32 timer ticks (running: elapsed; finished: final time)
//     12 u32 base tick (client's monotonic net tick of sample 0)
//     16 samples
//     then (0.0.42) an optional input block, only to a room whose welcome says `room.inputs` (older rooms refuse any
//     state message longer than its samples), and only while someone spectates the sender.
//     then (0.0.43) an optional gain log, only to a room whose welcome says `room.logs`: u8 STATE_LOG_MARK (an input
//     block starts with its tick count, never this), then a GainLogReport (LOG_REPORT_BYTES, layout at writeLog).
//
//   input block (0.0.42): the sender's per-tick HUD feed since its last batch, for its spectators' HUD (keys, strafe
//   trainer, jump stats, JHUD). Everything in it is in the player's replay, or computed from it.
//     0 u8 n ticks (1..MAX_INPUT_TICKS)   1 u8 bytes per tick record (>= INPUT_TICK_BYTES; readers skip what they don't
//     know)   2 u8 n reports (0..MAX_INPUT_REPORTS)   3 u8 reserved (0)   4 u32 net tick of the first record (the
//     records are consecutive ticks, on the samples' clock)   8 f64 tick interval (s)   16 f32 sv_maxspeed
//     20 f32 sv_airaccelerate (the strafe trainer's push; the sender's current style)
//     24 tick records:
//       0 u8 keys (IK_*: W, S, A, D, jump, duck)
//       1 u8 moves: bits 0-1 forwardmove, 2-3 sidemove (0 none, 1 +MOVE_SPEED, 2 -MOVE_SPEED), 4-6 the trainer's
//            gain band (IG_*)
//       2 u8 state (IS_*: grounded, on a ladder, jumped, interrupted (teleport / respawn / noclip), reset (a restart:
//            per-tick HUD history starts over before this tick), turn yaw present)
//       3 f32 yaw (deg)   7 f32 vx   11 f32 vy (post-tick velocity, u/s)
//       15 f32 turn yaw (deg; Auto-strafe's lead view, hud/strafe-trainer.ts TrainerSample.turnYaw; NaN = none yet)
//     then reports, each: u8 kind (IR_*), u8 tick offset (record index), u8 payload length, payload. Readers skip
//     kinds they don't know.
//       IR_SSJ_EVERY / IR_SSJ_SIXTH (45 bytes): the jump's SSJ report in "every jump" / "every 6th" mode (ssj/stats.ts;
//         "6th jump" is the every-6th report of jump 6). u8 mask of the fields present (bits: diff, height, gain,
//         sync, eff, strafes, time, jss), u16 jump, u32 speed, i32 diff, i32 height, f32 gain, f32 sync, f32 eff,
//         u16 strafes, f64 time (s), f64 jss (JHUD ratio; every-jump reports only)
//       IR_START_PRE (4 bytes): u32 start-zone prespeed (u/s), 0xffffffff = cleared
//
//   sample, 24 bytes
//     0 u8 tick offset from base   1 u8 flags (SF_*)   2 f32 x  6 f32 y  10 f32 z (feet, Source units)
//     14 i16 vx  16 i16 vy  18 i16 vz (units/s)   20 u16 yaw (0..65535 = 0..360 deg)   22 i16 pitch (deg * 360)
//
//   MSG_SNAPSHOT (room -> clients), 6 bytes + blocks
//     0 u8 type = MSG_SNAPSHOT   1 u8 block count   2 u32 server time (Date.now() mod 2^32, informative)
//   block: 0 u8 slot  1 u8 n samples  2 u8 block flags (BF_META)
//     [BF_META: u8 style, u8 track, u8 timer, u16 ping, u32 timer ticks]   (9 bytes; sent on change and ~1/s)
//     u32 base tick, then n samples (same 24-byte layout).
//   then optional extensions (0.0.11+), each: u8 type, u16 payload length, payload. Older clients stop reading after
//   the last block (they never checked for trailing bytes), and readers skip types they don't know.
//     EXT_WEAPONS: (u8 block index, u8 weapon id) pairs: the weapon in hand of that block's player as of the block's
//                  newest sample. Sent when it changes and with the meta refresh (~1/s), not with every block.
//     EXT_SILENCED (0.0.12): u8 block indices, the blocks of this snapshot's EXT_WEAPONS entries whose gun has the
//                  silencer on (USP, physics v7); an entry not listed has it off. Sent with EXT_WEAPONS when any is on.
//     EXT_INPUT (0.0.42): u8 slot, then that player's input block as they sent it. Only in the snapshots sent to the
//                  players spectating that slot (one per input block in the flush), after the other extensions.
//     EXT_LOG (0.0.43): gain logs, other players' six-jump lines: (u8 slot, GainLogReport) entries. Only to sockets that
//                  asked for them ({ t: "logs" }), so older clients never get one.
//
// Weapons (physics v5 guns, research/WEAPONS.md): the held weapon is the core's weapon id (core.ts WEAPON_IDS: 0 none,
// 1 knife, 2+ guns). Clients report it in the state header (byte 2, reserved and 0 before 0.0.11, so old rooms ignore
// it and old clients report "unknown"); the room validates it (apps/api/src/rooms/weapons.ts) and relays changes in
// EXT_WEAPONS. A gun shot is SF_SLASH ("primary attack") on the sample, as for the knife: older clients play a knife
// swing for it, which is what they show the player holding anyway.

import type { StyleId } from "../styles";
import type { CosmeticLoadout } from "../loadout";
import type { StaffRole } from "../progression";
import type { CreatorKind, NameColorId, NameEffect, StaffBadge } from "../creators";
import type { AvatarDecoId, CardBorderId, CardEffectId, NameFontId, NameStyle } from "../supporter-looks";

export const PROTOCOL_VERSION = 1;

/** Sim tick length (100 tick). */
export const TICK_MS = 10;
/** Ticks between samples (25 Hz; 20 Hz before 0.0.21). */
export const SAMPLE_TICKS = 4;
/**
 * Ticks between state batches (5 Hz; 10 Hz before 0.0.21): each batch carries SEND_TICKS / SAMPLE_TICKS samples. The
 * room's binary rate limit (apps/api src/rooms/room.ts BIN_BURST / BIN_REFILL_MS) allows either cadence, so old tabs
 * and new ones share a room.
 */
export const SEND_TICKS = 20;
/** Room fan-out cadence: snapshots are coalesced for at most this long. */
export const FLUSH_MS = 50;
/** Most samples one state message (or one snapshot block) may carry. */
export const MAX_SAMPLES = 8;
export const SAMPLE_BYTES = 24;
export const STATE_HEADER_BYTES = 16;
export const MAX_STATE_BYTES = STATE_HEADER_BYTES + MAX_SAMPLES * SAMPLE_BYTES;
/** Largest text frame a client may send (JSON control messages). */
export const MAX_TEXT_BYTES = 1024;
/** Chat line limit (CS:S `say` is 127 bytes; we count characters). */
export const MAX_CHAT_CHARS = 128;
/** Source world limit (MAX_COORD_INTEGER) plus a margin: samples outside it are dropped. */
export const WORLD_LIMIT = 16384 + 512;

export const MSG_STATE = 1;
export const MSG_SNAPSHOT = 2;

export const SF_GROUNDED = 1;
export const SF_CROUCHED = 2;
/** A jump happened since the previous sample. */
export const SF_JUMPED = 4;
/** Discontinuity (restart, trigger teleport): receivers snap instead of interpolating into this sample. */
export const SF_TELEPORT = 8;
/**
 * Cosmetic: a primary attack since the previous sample: a carrot slash (third-person knife layer), or with a gun in hand
 * (EXT_WEAPONS) a shot. Older clients ignore it.
 */
export const SF_SLASH = 16;
/**
 * Cosmetic: a carrot stab (secondary attack) since the previous sample; with a gun in hand (EXT_WEAPONS, 0.0.29) a
 * reload started or a tube gun's shell went in (third-person reload gesture). Sent only on samples without SF_SLASH.
 * Older clients ignore SF_STAB with a gun (a gun "attack" that isn't primary plays nothing), and the room relays it
 * like any attack flag (rate limited with the shots), so no room change.
 */
export const SF_STAB = 32;
/**
 * Cosmetic: the inspect (viewmodel/inspects/combo.ts), a 2-bit field in bits 6-7 (SF_INSPECT_MASK): 1 = an inspect
 * started since the previous sample, 2 = the next trick of the chain took over, 3 = the inspect key is held during
 * an inspect (a level, sent every sample while true; an event sample implies "unchanged"). Older clients only test
 * the bits they know, and the room relays flags untouched, so no protocol version bump.
 */
export const SF_INSPECT_SHIFT = 6;
export const SF_INSPECT_MASK = 0xc0;
/** The inspect field of sample flags (0..3, combo.ts SIG_*). */
export const inspectField = (flags: number): number => (flags & SF_INSPECT_MASK) >> SF_INSPECT_SHIFT;

export const BF_META = 1;

/** Snapshot extension: the players' weapons in hand (see the layout above). */
export const EXT_WEAPONS = 1;
/** Snapshot extension (0.0.12): which of the EXT_WEAPONS entries have the USP's silencer on. */
export const EXT_SILENCED = 2;
/** Snapshot extension (0.0.42): a watched player's input block, to their spectators only (see the layout above). */
export const EXT_INPUT = 3;
/** Snapshot extension (0.0.43): other players' gain logs, to the sockets that asked for them (see the layout above). */
export const EXT_LOG = 4;

/**
 * A gain log (0.0.43, ssj/logs.ts): the sender's last six jumps as their game counted them (jumps that turned with a
 * turn bind left out). Client-reported, display only: the room checks the ranges (gainLogValid), never the truth.
 */
export interface GainLogReport {
  /** The window's last jump (6, 12, 18 ...). */
  jump: number;
  /** Jumps counted (the window's six less the ones turned with a bind). */
  jumps: number;
  /** Gain %, 0 to 100 (ssj/stats.ts, as SSJ counts it). */
  gain: number;
  /** Sync %, 0 to 100. */
  sync: number;
  /** W / A / S / D presses in the air over the counted jumps. */
  strafes: number;
  /** Air ticks sampled over the counted jumps. */
  ticks: number;
}
/** u16 jump, u8 jumps, f32 gain, f32 sync, u16 strafes, u16 ticks. */
export const LOG_REPORT_BYTES = 15;
/** The state message's gain log tail starts with this byte (an input block's first byte is 1..MAX_INPUT_TICKS). */
export const STATE_LOG_MARK = 0xf0;
/** Fewest jumps a log counts (the rest of the six may have turned with a bind; more than that and there's no line). */
export const LOG_MIN_JUMPS = 4;
/** A log needs more than this many air ticks per counted jump (the CS:S gain logs' 300 ticks over 6 jumps at 100 tick). */
export const LOG_AIR_TICKS_PER_JUMP = 50;
/**
 * Styles whose jumps make gain logs in a room (0.0.43, owner: "it should be just normal"): the room relays nothing else,
 * and nothing from a practice attempt.
 */
export const GAIN_LOG_STYLES: ReadonlySet<string> = new Set<StyleId>(["autohop"]);

/** Whether a reported gain log is in range: what the room relays (else it drops it). */
export function gainLogValid(r: GainLogReport): boolean {
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  const pct = (v: number) => Number.isFinite(v) && v >= 0 && v <= 100;
  return int(r.jump, 6, 0xffff) && r.jump % 6 === 0 && int(r.jumps, LOG_MIN_JUMPS, 6) && pct(r.gain) && pct(r.sync) && int(r.strafes, 0, r.jumps * 20) && int(r.ticks, r.jumps * LOG_AIR_TICKS_PER_JUMP + 1, 6000);
}

function writeLog(dv: DataView, o: number, r: GainLogReport): void {
  dv.setUint16(o, Math.max(0, Math.min(0xffff, r.jump)), true);
  dv.setUint8(o + 2, Math.max(0, Math.min(255, r.jumps)));
  dv.setFloat32(o + 3, r.gain, true);
  dv.setFloat32(o + 7, r.sync, true);
  dv.setUint16(o + 11, Math.max(0, Math.min(0xffff, r.strafes)), true);
  dv.setUint16(o + 13, Math.max(0, Math.min(0xffff, r.ticks)), true);
}

function readLog(dv: DataView, o: number): GainLogReport {
  return { jump: dv.getUint16(o, true), jumps: dv.getUint8(o + 2), gain: dv.getFloat32(o + 3, true), sync: dv.getFloat32(o + 7, true), strafes: dv.getUint16(o + 11, true), ticks: dv.getUint16(o + 13, true) };
}

export const INPUT_HEADER_BYTES = 24;
/** A tick record without the turn yaw; with it, INPUT_TURN_BYTES. */
export const INPUT_TICK_BYTES = 15;
export const INPUT_TURN_BYTES = 19;
/** A batch is SEND_TICKS (20) ticks; room for a late one. */
export const MAX_INPUT_TICKS = 40;
export const MAX_INPUT_REPORTS = 8;
const MAX_REPORT_BYTES = 64;
const MAX_TICK_BYTES = 32;
export const MAX_INPUT_BYTES = INPUT_HEADER_BYTES + MAX_INPUT_TICKS * MAX_TICK_BYTES + MAX_INPUT_REPORTS * (3 + MAX_REPORT_BYTES);
/** Largest state message a room that takes input blocks accepts (and, 0.0.43, a gain log). */
export const MAX_STATE_INPUT_BYTES = STATE_HEADER_BYTES + MAX_SAMPLES * SAMPLE_BYTES + MAX_INPUT_BYTES + 1 + LOG_REPORT_BYTES;
/** cl_forwardspeed / cl_sidespeed: the only non-zero moves a keyboard command has (input.ts). */
export const MOVE_SPEED = 450;

/** Input record keys (byte 0). */
export const IK_FORWARD = 1;
export const IK_BACK = 2;
export const IK_LEFT = 4;
export const IK_RIGHT = 8;
export const IK_JUMP = 16;
export const IK_DUCK = 32;
/** Input record state (byte 2). */
export const IS_GROUNDED = 1;
export const IS_LADDER = 2;
export const IS_JUMPED = 4;
export const IS_INTERRUPTED = 8;
export const IS_RESET = 16;
export const IS_TURN = 32;
/**
 * The strafe trainer's gain band of a tick (hud/strafe-trainer.ts barBand of barGain): none (not judgeable), zero
 * ("low"), a loss ("high"), then "ok", "good", "perfect".
 */
export const IG_NONE = 0;
export const IG_ZERO = 1;
export const IG_LOSS = 2;
export const IG_OK = 3;
export const IG_GOOD = 4;
export const IG_PERFECT = 5;
/** Input block report kinds. */
export const IR_SSJ_EVERY = 1;
export const IR_SSJ_SIXTH = 2;
export const IR_START_PRE = 3;
const SSJ_REPORT_BYTES = 45;

/** State header byte 2, bit 6 (0.0.12): the gun in hand has its silencer on. */
export const WEAPON_SILENCED = 0x40;
/** State header byte 2: the weapon field is set (a client that knows weapons; 0 = not reported, pre-0.0.11). */
export const WEAPON_REPORTED = 0x80;
/** Highest weapon id (core.ts WEAPON_IDS: 25 = m249). Bit 5 of the state byte is reserved (0); bit 6 is WEAPON_SILENCED. */
export const MAX_WEAPON_ID = 25;
export const WEAPON_NONE = 0;
export const WEAPON_ID_KNIFE = 1;

/** The state header's weapon byte for a weapon id (null / out of range = not reported), with its silencer on or off. */
export function weaponByte(id: number | null, silenced = false): number {
  return id !== null && Number.isInteger(id) && id >= 0 && id <= MAX_WEAPON_ID ? WEAPON_REPORTED | id | (silenced && id >= 2 ? WEAPON_SILENCED : 0) : 0;
}

/** Reads the state header's weapon byte: the weapon id, null = not reported (older client), -1 = invalid. */
export function readWeaponByte(b: number): number | null {
  if (b === 0) return null;
  const id = b & 0x1f;
  return b & WEAPON_REPORTED && !(b & 0x20) && id <= MAX_WEAPON_ID ? id : -1;
}

/** The silencer bit of a state header's weapon byte (only meaningful when readWeaponByte gives a gun). */
export const readSilencedByte = (b: number): boolean => (b & (WEAPON_REPORTED | WEAPON_SILENCED)) === (WEAPON_REPORTED | WEAPON_SILENCED);

export const TIMER_IDLE = 0;
export const TIMER_START = 1;
export const TIMER_RUNNING = 2;
export const TIMER_FINISHED = 3;

/**
 * Clients that don't say how many wire styles they know (no `wire=` on the socket URL: native v0.6.5 / v0.7.0, web
 * tabs before 0.0.36) are "legacy" to the room (0.0.36). Native's snapshot check (room-service.ts metaValid) refuses a
 * block meta with style > 7 and drops the whole snapshot, and native v0.6.5's roster check refuses a style it doesn't
 * know (Infinite) and drops the welcome. So for them the room leaves the meta off blocks whose style index is
 * LEGACY_META_STYLES or more (the samples still go), and shows roster styles from LEGACY_ROSTER_STYLES on as Normal.
 * Current clients send `wire=<WIRE_STYLES.length>` and get everything (a style past theirs gets the same treatment).
 */
export const LEGACY_META_STYLES = 8;
export const LEGACY_ROSTER_STYLES = 9;

/** Wire order of styles (frozen: never reorder, only append). */
export const WIRE_STYLES: readonly StyleId[] = ["autohop", "legit", "wonly", "sideways", "hsw", "autostrafe", "scroll", "lowgrav", "segmented", "infinite", "backwards", "adonly"];
export const styleIndex = (s: string): number => Math.max(0, WIRE_STYLES.indexOf(s as StyleId));

export const styleAt = (i: number): StyleId | null => WIRE_STYLES[i] ?? null;

export interface NetSample {
  /** Client net tick (monotonic across restarts; 100 per second). */
  tick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Degrees 0..360. */
  yaw: number;
  /** Degrees, + = looking down. */
  pitch: number;
  flags: number;
}

export interface NetMeta {
  style: number;
  track: number;
  timer: number;
  /** Running: ticks since the run started (at the batch's base tick). Finished: the final time in ticks. */
  timerTicks: number;
  ping: number;
}

export interface StateMsg {
  meta: NetMeta;
  samples: NetSample[];
  /** Weapon in hand (readWeaponByte): the id, null = not reported (older client), -1 = invalid. */
  weapon: number | null;
  /** Its silencer is on (0.0.12; false from older clients). */
  silenced: boolean;
  /** The input block (0.0.42), checked for shape, as sent; null when there is none. */
  input: Uint8Array | null;
  /** A gain log (0.0.43), as sent (not range-checked: gainLogValid); null or absent when there is none. */
  log?: GainLogReport | null;
}

/** One tick of a watched player's HUD feed (input block record). */
export interface NetInputTick {
  /** Sender's net tick (the samples' clock). */
  tick: number;
  /** IK_* bits. */
  keys: number;
  /** forwardmove / sidemove: 0 or ±MOVE_SPEED. */
  forward: number;
  side: number;
  /** IG_* band. */
  gain: number;
  /** IS_* bits. */
  state: number;
  yaw: number;
  vx: number;
  vy: number;
  /** With IS_TURN: Auto-strafe's lead view yaw (NaN: none yet). */
  turnYaw?: number;
}

/** A jump's SSJ report as the sender's trackers made it (ssj/stats.ts SsjReport, plus the JHUD's JSS). */
export interface NetSsjReport {
  jump: number;
  speed: number;
  diff: number | null;
  height: number | null;
  gain: number | null;
  sync: number | null;
  eff: number | null;
  strafes: number | null;
  time: number | null;
  jss: number | null;
}

export type NetInputReport =
  | { tick: number; kind: typeof IR_SSJ_EVERY | typeof IR_SSJ_SIXTH; ssj: NetSsjReport }
  | { tick: number; kind: typeof IR_START_PRE; speed: number | null };

export interface NetInput {
  tickInterval: number;
  maxSpeed: number;
  airAccelerate: number;
  ticks: NetInputTick[];
  reports: NetInputReport[];
}

export interface SnapshotBlock {
  slot: number;
  meta: NetMeta | null;
  samples: NetSample[];
  /** Weapon in hand as of the newest sample (EXT_WEAPONS), when the room sent it with this block. */
  weapon?: number;
  /** With `weapon`: its silencer is on (EXT_SILENCED; rooms before 0.0.12 never say so). */
  silenced?: boolean;
}

export interface Snapshot {
  serverTime: number;
  blocks: SnapshotBlock[];
  /** EXT_INPUT (0.0.42): input blocks of the player you spectate, in arrival order. */
  inputs?: { slot: number; input: NetInput }[];
  /** EXT_LOG (0.0.43): other players' gain logs. */
  logs?: { slot: number; log: GainLogReport }[];
}

// ---------------------------------------------------------------------------------------------
// Quantisation

const clampI16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v) | 0);
export const yawToU16 = (deg: number) => Math.round((((deg % 360) + 360) % 360) * (65536 / 360)) & 0xffff;
export const u16ToYaw = (v: number) => (v * 360) / 65536;
export const pitchToI16 = (deg: number) => clampI16(Math.max(-90, Math.min(90, deg)) * 360);
export const i16ToPitch = (v: number) => v / 360;

function writeSample(dv: DataView, o: number, s: NetSample, base: number): void {
  dv.setUint8(o, Math.max(0, Math.min(255, s.tick - base)));
  dv.setUint8(o + 1, s.flags & 0xff);
  dv.setFloat32(o + 2, s.x, true);
  dv.setFloat32(o + 6, s.y, true);
  dv.setFloat32(o + 10, s.z, true);
  dv.setInt16(o + 14, clampI16(s.vx), true);
  dv.setInt16(o + 16, clampI16(s.vy), true);
  dv.setInt16(o + 18, clampI16(s.vz), true);
  dv.setUint16(o + 20, yawToU16(s.yaw), true);
  dv.setInt16(o + 22, pitchToI16(s.pitch), true);
}

function readSample(dv: DataView, o: number, base: number): NetSample {
  return {
    tick: (base + dv.getUint8(o)) >>> 0,
    flags: dv.getUint8(o + 1),
    x: dv.getFloat32(o + 2, true),
    y: dv.getFloat32(o + 6, true),
    z: dv.getFloat32(o + 10, true),
    vx: dv.getInt16(o + 14, true),
    vy: dv.getInt16(o + 16, true),
    vz: dv.getInt16(o + 18, true),
    yaw: u16ToYaw(dv.getUint16(o + 20, true)),
    pitch: i16ToPitch(dv.getInt16(o + 22, true)),
  };
}

/** A sample position the room accepts: finite and inside the Source world. */
export function sampleInWorld(s: Pick<NetSample, "x" | "y" | "z">): boolean {
  return Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z) && Math.abs(s.x) <= WORLD_LIMIT && Math.abs(s.y) <= WORLD_LIMIT && Math.abs(s.z) <= WORLD_LIMIT;
}

// ---------------------------------------------------------------------------------------------
// MSG_STATE

/**
 * `weapon`: the weapon id in hand (core.ts WEAPON_IDS), null = don't report one; `silenced`: its silencer is on;
 * `input`: an encoded input block (encodeInput), only for a room that takes them; `log`: a gain log (0.0.43), only for
 * a room that relays them.
 */
export function encodeState(meta: NetMeta, samples: readonly NetSample[], weapon: number | null = null, silenced = false, input: Uint8Array | null = null, log: GainLogReport | null = null): Uint8Array<ArrayBuffer> {
  const n = Math.min(samples.length, MAX_SAMPLES);
  const end = STATE_HEADER_BYTES + n * SAMPLE_BYTES + (input?.length ?? 0);
  const buf = new Uint8Array(end + (log ? 1 + LOG_REPORT_BYTES : 0));
  if (input) buf.set(input, STATE_HEADER_BYTES + n * SAMPLE_BYTES);
  const dv = new DataView(buf.buffer);
  if (log) {
    dv.setUint8(end, STATE_LOG_MARK);
    writeLog(dv, end + 1, log);
  }
  const base = n ? samples[0].tick >>> 0 : 0;
  dv.setUint8(0, MSG_STATE);
  dv.setUint8(1, n);
  dv.setUint8(2, weaponByte(weapon, silenced));
  dv.setUint8(3, meta.style);
  dv.setUint8(4, meta.track);
  dv.setUint8(5, meta.timer);
  dv.setUint16(6, Math.max(0, Math.min(65535, Math.round(meta.ping))), true);
  dv.setUint32(8, Math.max(0, Math.min(0xffffffff, Math.round(meta.timerTicks))), true);
  dv.setUint32(12, base, true);
  for (let i = 0; i < n; i++) writeSample(dv, STATE_HEADER_BYTES + i * SAMPLE_BYTES, samples[i], base);
  return buf;
}

/**
 * Parses and validates a client state message. Returns null for anything malformed: wrong type or size, sample count
 * out of range, unknown style / timer, non-increasing tick offsets. (World bounds are checked per sample by the room,
 * which drops only the offending samples.)
 */
export function decodeState(data: ArrayBuffer | Uint8Array): StateMsg | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < STATE_HEADER_BYTES || u8.length > MAX_STATE_INPUT_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== MSG_STATE) return null;
  const n = dv.getUint8(1);
  const end = STATE_HEADER_BYTES + n * SAMPLE_BYTES;
  if (n < 1 || n > MAX_SAMPLES || u8.length < end) return null;
  // After the samples: an input block, then a gain log (0.0.43), each optional; nothing else.
  let o = end;
  let input: Uint8Array | null = null;
  if (o < u8.length && u8[o] !== STATE_LOG_MARK) {
    const len = inputBlockLength(u8.subarray(o));
    if (len < 0) return null;
    input = u8.subarray(o, o + len);
    o += len;
  }
  let log: GainLogReport | null = null;
  if (o < u8.length) {
    if (u8[o] !== STATE_LOG_MARK || u8.length !== o + 1 + LOG_REPORT_BYTES) return null;
    log = readLog(dv, o + 1);
  }
  const meta: NetMeta = { style: dv.getUint8(3), track: dv.getUint8(4), timer: dv.getUint8(5), ping: dv.getUint16(6, true), timerTicks: dv.getUint32(8, true) };
  if (meta.style >= WIRE_STYLES.length || meta.timer > TIMER_FINISHED || meta.track > 64) return null;
  const base = dv.getUint32(12, true);
  const samples: NetSample[] = [];
  let lastOff = -1;
  for (let i = 0; i < n; i++) {
    const o = STATE_HEADER_BYTES + i * SAMPLE_BYTES;
    const off = dv.getUint8(o);
    if (off <= lastOff) return null;
    lastOff = off;
    samples.push(readSample(dv, o, base));
  }
  const wb = dv.getUint8(2);
  return log ? { meta, samples, weapon: readWeaponByte(wb), silenced: readSilencedByte(wb), input, log } : { meta, samples, weapon: readWeaponByte(wb), silenced: readSilencedByte(wb), input };
}

// ---------------------------------------------------------------------------------------------
// Input blocks (0.0.42)

const moveCode = (v: number) => (v > 0 ? 1 : v < 0 ? 2 : 0);
const codeMove = (c: number) => (c === 1 ? MOVE_SPEED : c === 2 ? -MOVE_SPEED : 0);

/**
 * Whether `u8` is exactly one well-formed input block: counts in range, the records and every report inside it, the
 * reserved byte 0. The values aren't checked (display only, like the samples' flags); the room relays it as it came.
 */
export function inputShapeOk(u8: Uint8Array): boolean {
  return inputBlockLength(u8) === u8.length;
}

/** The length of the well-formed input block `u8` starts with (inputShapeOk), or -1. */
function inputBlockLength(u8: Uint8Array): number {
  if (u8.length < INPUT_HEADER_BYTES) return -1;
  const n = u8[0];
  const rec = u8[1];
  const nr = u8[2];
  if (n < 1 || n > MAX_INPUT_TICKS || rec < INPUT_TICK_BYTES || rec > MAX_TICK_BYTES || nr > MAX_INPUT_REPORTS || u8[3] !== 0) return -1;
  let o = INPUT_HEADER_BYTES + n * rec;
  if (o > u8.length) return -1;
  for (let k = 0; k < nr; k++) {
    if (o + 3 > u8.length) return -1;
    const len = u8[o + 2];
    if (u8[o + 1] >= n || len > MAX_REPORT_BYTES || o + 3 + len > u8.length) return -1;
    o += 3 + len;
  }
  return o;
}

export function encodeInput(input: NetInput): Uint8Array<ArrayBuffer> {
  const n = Math.min(input.ticks.length, MAX_INPUT_TICKS);
  const ticks = input.ticks.slice(input.ticks.length - n);
  const rec = ticks.some((t) => t.turnYaw !== undefined) ? INPUT_TURN_BYTES : INPUT_TICK_BYTES;
  const base = n ? ticks[0].tick >>> 0 : 0;
  const reports = input.reports.filter((r) => r.tick >= base && r.tick < base + n).slice(0, MAX_INPUT_REPORTS);
  const size = (r: NetInputReport) => (r.kind === IR_START_PRE ? 4 : SSJ_REPORT_BYTES);
  const buf = new Uint8Array(INPUT_HEADER_BYTES + n * rec + reports.reduce((s, r) => s + 3 + size(r), 0));
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, n);
  dv.setUint8(1, rec);
  dv.setUint8(2, reports.length);
  dv.setUint32(4, base, true);
  dv.setFloat64(8, input.tickInterval, true);
  dv.setFloat32(16, input.maxSpeed, true);
  dv.setFloat32(20, input.airAccelerate, true);
  let o = INPUT_HEADER_BYTES;
  for (const t of ticks) {
    dv.setUint8(o, t.keys & 0x3f);
    dv.setUint8(o + 1, moveCode(t.forward) | (moveCode(t.side) << 2) | ((t.gain & 7) << 4));
    dv.setUint8(o + 2, (t.state & (IS_GROUNDED | IS_LADDER | IS_JUMPED | IS_INTERRUPTED | IS_RESET)) | (t.turnYaw !== undefined ? IS_TURN : 0));
    dv.setFloat32(o + 3, t.yaw, true);
    dv.setFloat32(o + 7, t.vx, true);
    dv.setFloat32(o + 11, t.vy, true);
    if (rec === INPUT_TURN_BYTES) dv.setFloat32(o + 15, t.turnYaw ?? NaN, true);
    o += rec;
  }
  for (const r of reports) {
    dv.setUint8(o, r.kind);
    dv.setUint8(o + 1, r.tick - base);
    dv.setUint8(o + 2, size(r));
    o += 3;
    if (r.kind === IR_START_PRE) dv.setUint32(o, r.speed === null ? 0xffffffff : Math.max(0, Math.min(0xfffffffe, Math.round(r.speed))), true);
    else {
      const s = r.ssj;
      const fields = [s.diff, s.height, s.gain, s.sync, s.eff, s.strafes, s.time, s.jss];
      dv.setUint8(o, fields.reduce<number>((m, v, i) => (v === null ? m : m | (1 << i)), 0));
      dv.setUint16(o + 1, Math.min(0xffff, s.jump), true);
      dv.setUint32(o + 3, Math.max(0, Math.min(0xffffffff, s.speed)), true);
      dv.setInt32(o + 7, s.diff ?? 0, true);
      dv.setInt32(o + 11, s.height ?? 0, true);
      dv.setFloat32(o + 15, s.gain ?? 0, true);
      dv.setFloat32(o + 19, s.sync ?? 0, true);
      dv.setFloat32(o + 23, s.eff ?? 0, true);
      dv.setUint16(o + 27, Math.min(0xffff, s.strafes ?? 0), true);
      dv.setFloat64(o + 29, s.time ?? 0, true);
      dv.setFloat64(o + 37, s.jss ?? 0, true);
    }
    o += size(r);
  }
  return buf;
}

/** Reads an input block (inputShapeOk first); reports of unknown kinds or sizes are skipped. */
export function decodeInput(u8: Uint8Array): NetInput | null {
  if (!inputShapeOk(u8)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = u8[0];
  const rec = u8[1];
  const base = dv.getUint32(4, true);
  const ticks: NetInputTick[] = [];
  let o = INPUT_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += rec) {
    const m = u8[o + 1];
    const state = u8[o + 2];
    const t: NetInputTick = { tick: (base + i) >>> 0, keys: u8[o] & 0x3f, forward: codeMove(m & 3), side: codeMove((m >> 2) & 3), gain: (m >> 4) & 7, state, yaw: dv.getFloat32(o + 3, true), vx: dv.getFloat32(o + 7, true), vy: dv.getFloat32(o + 11, true) };
    if (state & IS_TURN && rec >= INPUT_TURN_BYTES) t.turnYaw = dv.getFloat32(o + 15, true);
    ticks.push(t);
  }
  const reports: NetInputReport[] = [];
  for (let k = 0; k < u8[2]; k++) {
    const kind = u8[o];
    const tick = (base + u8[o + 1]) >>> 0;
    const len = u8[o + 2];
    const p = o + 3;
    o = p + len;
    if (kind === IR_START_PRE && len >= 4) {
      const v = dv.getUint32(p, true);
      reports.push({ tick, kind, speed: v === 0xffffffff ? null : v });
    } else if ((kind === IR_SSJ_EVERY || kind === IR_SSJ_SIXTH) && len >= SSJ_REPORT_BYTES) {
      const mask = u8[p];
      const has = (i: number) => (mask & (1 << i)) !== 0;
      reports.push({
        tick,
        kind,
        ssj: {
          jump: dv.getUint16(p + 1, true),
          speed: dv.getUint32(p + 3, true),
          diff: has(0) ? dv.getInt32(p + 7, true) : null,
          height: has(1) ? dv.getInt32(p + 11, true) : null,
          gain: has(2) ? dv.getFloat32(p + 15, true) : null,
          sync: has(3) ? dv.getFloat32(p + 19, true) : null,
          eff: has(4) ? dv.getFloat32(p + 23, true) : null,
          strafes: has(5) ? dv.getUint16(p + 27, true) : null,
          time: has(6) ? dv.getFloat64(p + 29, true) : null,
          jss: has(7) ? dv.getFloat64(p + 37, true) : null,
        },
      });
    }
  }
  return { tickInterval: dv.getFloat64(8, true), maxSpeed: dv.getFloat32(16, true), airAccelerate: dv.getFloat32(20, true), ticks, reports };
}

/** EXT_INPUT for a snapshot: `slot`'s input block (as the room got it), appended after the snapshot's other extensions. */
export function inputExtension(slot: number, input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + input.length);
  out[0] = EXT_INPUT;
  new DataView(out.buffer).setUint16(1, 1 + input.length, true);
  out[3] = slot;
  out.set(input, 4);
  return out;
}

/** EXT_LOG for a snapshot (0.0.43): gain logs as (slot, report) entries, appended after the snapshot's other extensions. */
export function logExtension(logs: readonly { slot: number; log: GainLogReport }[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(3 + logs.length * (1 + LOG_REPORT_BYTES));
  const dv = new DataView(out.buffer);
  out[0] = EXT_LOG;
  dv.setUint16(1, logs.length * (1 + LOG_REPORT_BYTES), true);
  logs.forEach((l, k) => {
    const o = 3 + k * (1 + LOG_REPORT_BYTES);
    out[o] = l.slot;
    writeLog(dv, o + 1, l.log);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// MSG_SNAPSHOT

const META_BYTES = 9;
export const blockBytes = (n: number, meta: boolean) => 3 + (meta ? META_BYTES : 0) + 4 + n * SAMPLE_BYTES;

/** One player's block for a snapshot (the room encodes it once when the state arrives). */
export function encodeBlock(slot: number, meta: NetMeta | null, samples: readonly NetSample[]): Uint8Array<ArrayBuffer> {
  const n = Math.min(samples.length, MAX_SAMPLES);
  const buf = new Uint8Array(blockBytes(n, !!meta));
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, slot);
  dv.setUint8(1, n);
  dv.setUint8(2, meta ? BF_META : 0);
  let o = 3;
  if (meta) {
    dv.setUint8(o, meta.style);
    dv.setUint8(o + 1, meta.track);
    dv.setUint8(o + 2, meta.timer);
    dv.setUint16(o + 3, Math.max(0, Math.min(65535, Math.round(meta.ping))), true);
    dv.setUint32(o + 5, Math.max(0, Math.min(0xffffffff, Math.round(meta.timerTicks))), true);
    o += META_BYTES;
  }
  const base = n ? samples[0].tick >>> 0 : 0;
  dv.setUint32(o, base, true);
  o += 4;
  for (let i = 0; i < n; i++) writeSample(dv, o + i * SAMPLE_BYTES, samples[i], base);
  return buf;
}

/** A weapon entry of a snapshot (EXT_WEAPONS): `block` indexes the snapshot's blocks. */
export interface BlockWeapon {
  block: number;
  weapon: number;
  /** The gun's silencer is on (EXT_SILENCED). */
  silenced?: boolean;
}

/**
 * Concatenates blocks into one snapshot (the same bytes go to every socket in the room), plus the weapons extension
 * when `weapons` has entries.
 */
export function encodeSnapshot(serverTime: number, blocks: readonly Uint8Array[], weapons: readonly BlockWeapon[] = []): Uint8Array<ArrayBuffer> {
  const count = Math.min(255, blocks.length);
  const wpn = weapons.filter((w) => w.block >= 0 && w.block < count && w.weapon >= 0 && w.weapon <= MAX_WEAPON_ID);
  let len = 6;
  for (let i = 0; i < count; i++) len += blocks[i].length;
  const body = len;
  if (wpn.length) len += 3 + wpn.length * 2;
  const quiet = wpn.filter((w) => w.silenced);
  if (quiet.length) len += 3 + quiet.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MSG_SNAPSHOT);
  dv.setUint8(1, count);
  dv.setUint32(2, serverTime >>> 0, true);
  let o = 6;
  for (let i = 0; i < count; i++) {
    out.set(blocks[i], o);
    o += blocks[i].length;
  }
  if (wpn.length) {
    dv.setUint8(body, EXT_WEAPONS);
    dv.setUint16(body + 1, wpn.length * 2, true);
    wpn.forEach((w, k) => {
      dv.setUint8(body + 3 + k * 2, w.block);
      dv.setUint8(body + 4 + k * 2, w.weapon);
    });
  }
  if (quiet.length) {
    const at = body + 3 + wpn.length * 2;
    dv.setUint8(at, EXT_SILENCED);
    dv.setUint16(at + 1, quiet.length, true);
    quiet.forEach((w, k) => dv.setUint8(at + 3 + k, w.block));
  }
  return out;
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 6) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== MSG_SNAPSHOT) return null;
  const count = dv.getUint8(1);
  const blocks: SnapshotBlock[] = [];
  let o = 6;
  for (let b = 0; b < count; b++) {
    if (o + 7 > u8.length) return null;
    const slot = dv.getUint8(o);
    const n = dv.getUint8(o + 1);
    const flags = dv.getUint8(o + 2);
    const hasMeta = (flags & BF_META) !== 0;
    if (n > MAX_SAMPLES || o + blockBytes(n, hasMeta) > u8.length) return null;
    o += 3;
    let meta: NetMeta | null = null;
    if (hasMeta) {
      meta = { style: dv.getUint8(o), track: dv.getUint8(o + 1), timer: dv.getUint8(o + 2), ping: dv.getUint16(o + 3, true), timerTicks: dv.getUint32(o + 5, true) };
      o += META_BYTES;
    }
    const base = dv.getUint32(o, true);
    o += 4;
    const samples: NetSample[] = [];
    for (let i = 0; i < n; i++, o += SAMPLE_BYTES) samples.push(readSample(dv, o, base));
    blocks.push({ slot, meta, samples });
  }
  // Extensions (0.0.11+): skipped when unknown; a truncated one ends the reading (the blocks stay good).
  let inputs: Snapshot["inputs"];
  let logs: Snapshot["logs"];
  while (o + 3 <= u8.length) {
    const type = dv.getUint8(o);
    const len = dv.getUint16(o + 1, true);
    o += 3;
    if (o + len > u8.length) break;
    if (type === EXT_WEAPONS)
      for (let k = 0; k + 1 < len; k += 2) {
        const b = dv.getUint8(o + k);
        const w = dv.getUint8(o + k + 1);
        if (b < blocks.length && w <= MAX_WEAPON_ID) {
          blocks[b].weapon = w;
          blocks[b].silenced = false;
        }
      }
    else if (type === EXT_SILENCED)
      for (let k = 0; k < len; k++) {
        const blk = blocks[dv.getUint8(o + k)];
        if (blk && blk.weapon !== undefined) blk.silenced = true;
      }
    else if (type === EXT_INPUT && len > 1) {
      const input = decodeInput(u8.subarray(o + 1, o + len));
      if (input) (inputs ??= []).push({ slot: dv.getUint8(o), input });
    } else if (type === EXT_LOG)
      for (let k = 0; k + 1 + LOG_REPORT_BYTES <= len; k += 1 + LOG_REPORT_BYTES) (logs ??= []).push({ slot: dv.getUint8(o + k), log: readLog(dv, o + k + 1) });
    o += len;
  }
  return { serverTime: dv.getUint32(2, true), blocks, ...(inputs ? { inputs } : {}), ...(logs ? { logs } : {}) };
}

// ---------------------------------------------------------------------------------------------
// JSON control messages

export interface RankTag {
  id: string;
  name: string;
  color: string;
}

export interface RosterPlayer {
  playerGlow?: import("../player/glow-config").PlayerGlow | null;
  slot: number;
  id: string;
  name: string;
  /** "guest" | "discord" ... */
  provider: string;
  /** Overall rank title (profiles/ranks); null = unranked. */
  rank: RankTag | null;
  admin: boolean;
  /** Last style the player reported. */
  style: StyleId;
  /** Slot being spectated, null while playing. */
  spec: number | null;
  /** Server-detected inactivity; absent from older servers means present. */
  afk?: boolean;
  /** Verified main-track PBs on the room's current map, seconds, by style. */
  pb: Partial<Record<StyleId, number>>;
  /** When each of those PBs was set (personal_bests.achieved_at, ms): the scoreboard's tie order. Absent from older servers. */
  pbAt?: Partial<Record<StyleId, number>>;
  joinedAt: number;
  /** Bunny colourway (progression "outfit-*" cosmetic) the player wears; absent from older servers. */
  outfit?: string | null;
  /**
   * First-person loadout (loadout.ts: knife, finish, gloves, crown), shown on their third-person
   * bunny. Absent from older servers (and ignored by older clients); read it with cleanLoadout().
   */
  loadout?: CosmeticLoadout | null;
  /**
   * Staff role, set by the room from its own data (OWNER_ID, room admins, moderators): "owner" / "admin" / "moderator"
   * get an Owner / Admin / Mod tag in chat, the scoreboard and on the name tag. Absent from older servers (fall back to
   * `admin`); older clients ignore it. `admin` stays true for admins and the owner only.
   */
  role?: StaffRole | null;
  /**
   * Admin-granted marks (creators.ts), set by the room from the account (users.verified / users.creator): a blue check
   * and a YouTube / Twitch creator icon next to the name. Absent from older servers; older clients ignore them.
   */
  verified?: boolean;
  creator?: CreatorKind | null;
  /**
   * Server Booster badge (creators.ts BOOSTER_SVG): boosting the Discord server, set by the room from the account and
   * patched live. Absent from older servers; older clients ignore it.
   */
  booster?: boolean;
  /**
   * Staff badge (creators.ts staffBadgeOf: the owner's is "developer"), from `role`; patched live with it when a role is
   * granted or revoked. Absent from older servers (clients derive it from `role`).
   */
  staff?: StaffBadge | null;
  /**
   * Supporter badge (creators.ts SUPPORTER_SVG; not hidden by the player) and a supporter's name look: colour
   * (creators.ts NAME_COLORS id, null = white), effect (NAME_EFFECTS, null = plain) and the gradient's second colour,
   * set by the room from the account and patched live. A shadowed player's show to themselves only. Absent from older
   * servers; older clients ignore them.
   */
  supporter?: boolean;
  nameColor?: NameColorId | null;
  nameEffect?: NameEffect | null;
  nameColor2?: NameColorId | null;
  /** v0.0.37: a supporter's name font (supporter-looks.ts NAME_FONTS id). Absent = the default font; older clients ignore it. */
  nameFont?: NameFontId | null;
  /** v0.0.40: bold / italic (supporter-looks.ts NameStyle). Absent = plain; older clients ignore it. */
  nameStyle?: NameStyle | null;
  nameBadges?: string[]; giftsSent?: number; gifterColors?: string[]; gifterAnimated?: boolean;
  /** Staff-granted special badges (creators.ts SPECIAL_BADGES, 0.0.21). Absent from older servers. */
  special?: string[];
  /** Profile flag (countries.ts code; null = none), shown on the scoreboard. Absent from older servers. */
  country?: string | null;
  /**
   * Practising (0.0.36): the player's current attempt is practice (practice mode, a checkpoint teleport or noclip;
   * practice-mode/attempt.ts), so it is never submitted. The others show a "practice" tag instead of a run time. The
   * client says so with { t: "practice" }; patched live. Absent from older servers; older clients ignore it.
   */
  practice?: boolean;
  /** Voice: muted from talking in this room by staff or the lobby's host (patched live). Absent: not muted. */
  voiceMuted?: boolean;
  /** A supporter's avatar decoration (supporter-looks.ts AVATAR_DECOS), read at join. Absent: none. */
  avatarDeco?: AvatarDecoId | null;
  /** The player card's looks (the voice talker list draws a talker in them), read at join. Absent: the default card. */
  card?: RosterCard | null;
}

/** A player card's looks: frame and background (progression.ts cosmetics), a supporter's border and effect. */
export interface RosterCard {
  frame?: string;
  background?: string;
  border?: CardBorderId;
  effect?: CardEffectId;
}

export interface RoomInfo {
  id: string;
  name: string;
  region: string;
  maxPlayers: number;
  tiers: [number, number];
  /**
   * A private lobby (0.0.16; apps/api src/rooms/config.ts): not in the server list, joined by invite (?lobby=<code>, the
   * id without "p-"), any map. `host`: the slot of the player with host commands (!map, !mapvote, !extend, !kick, !mute),
   * null while the room is empty of eligible players; changes come as { t: "host" }. Absent from public rooms.
   */
  private?: boolean;
  host?: number | null;
  /** Voice chat (net/voice-wire.ts) relays here: 1 = push to talk, alltalk. Absent: an older room, send no voice. */
  voice?: number;
  /**
   * (0.0.42) The room takes input blocks on state messages and relays them to your spectators (EXT_INPUT): 1. Absent:
   * an older room, which refuses them, so send none.
   */
  inputs?: number;
  /**
   * (0.0.43) The room relays gain logs (state message tail, EXT_LOG), and this is its gain bar: the lines it shows
   * everyone are at or above it. Absent: an older room, so send none and ask for none.
   */
  logs?: number;
  /**
   * (0.0.44) The Daily room (apps/api src/rooms: a room with mode "daily"): it always plays the day's Daily Challenge
   * map, with no votes. Absent from every other room.
   */
  daily?: RoomDaily;
}

/**
 * The day a Daily room plays (welcome `room.daily`, `map.daily`, GET /servers `daily`): the day (the UTC date it starts
 * on), its style, the next day's map once the room knows it (from 15:50 UTC), and when the day ends (server ms, 16:00
 * UTC; the room changes map a little after, so runs started before it can finish).
 */
export interface RoomDaily {
  day: string;
  style: string;
  nextMap?: string;
  endsAt: number;
}

export interface MapInfo {
  name: string;
  tier: number | null;
  startedAt: number;
  /** Time limit (server ms); moves when the map is extended. */
  endsAt: number;
  /** (0.0.44) In a Daily room: the day this map is played for. */
  daily?: RoomDaily;
}

export interface PoolEntry {
  name: string;
  tier: number | null;
}

/**
 * A ballot option. Extend's `needs` (0.0.43): it wins only with this many votes (the room's 60% bar, once the map's free
 * extends are used). Absent: it wins by plurality like a map. Older clients ignore it and show the option as before.
 */
export type VoteOption = { map: string; tier: number | null } | { extend: true; minutes: number; needs?: number };
export const isExtend = (o: VoteOption): o is { extend: true; minutes: number; needs?: number } => "extend" in o;
/** The ballot's count beside Extend: "2", or with its bar "2 of 3 needed". */
export const extendTally = (o: { needs?: number }, count: number): string => (o.needs ? `${count} of ${o.needs} needed` : String(count));

export interface VoteView {
  id: number;
  /** "end": end-of-map vote (may offer Extend); "rtv": rock the vote (changes map right after). */
  kind: "end" | "rtv";
  options: VoteOption[];
  endsAt: number;
  counts: number[];
}

export interface Nomination {
  map: string;
  name: string;
}

export interface MapChange {
  map: string;
  tier: number | null;
  /** Server time the room switches maps; clients reload onto the new map then. */
  at: number;
  /** (0.0.44) In a Daily room, when the room sends it: the day the new map is played for. */
  daily?: RoomDaily;
}

export type AnnounceKind = "wr" | "sr" | "top10" | "pb";

export interface Announcement {
  runId?: string;
  pb?: boolean;
  kind: AnnounceKind;
  slot: number | null;
  name: string;
  map: string;
  style: string;
  track: number;
  time: number;
  /** Rank on the global board (verified). */
  rank: number | null;
  /** Previous server record holder's time, when kind = "sr". */
  prev?: number | null;
}

export type ChatKind = "say" | "server" | "admin" | "private";

/**
 * How a race ended (apps/api src/rooms/race.ts). finish / draw / forfeit / left / timeout / cancelled are kept in D1
 * (races.outcome); declined / expired / withdrawn end a challenge that never started.
 */
export type RaceOutcome = "finish" | "draw" | "forfeit" | "left" | "timeout" | "cancelled" | "declined" | "expired" | "withdrawn";

/** One racer as a `race` message shows them. */
export interface RaceSide {
  /** Slot in the room, null while not connected. */
  slot: number | null;
  name: string;
  /**
   * Their finish: run time (s), real time since GO (s, the server's: GO to the replay's arrival), and its verification.
   * The earliest that counts or is verifying, else the last rejected one. null: none yet.
   */
  finish: { time: number; real: number; status: "verifying" | "verified" | "rejected" } | null;
  out?: "forfeit" | "left" | null;
}

/**
 * A 1v1 race (0.0.16 `!race`), as one of its two racers sees it. Server times. `a` challenged `b`; `you` is your side.
 * challenge (until expiresAt) -> countdown (until goAt: both are put on the track's start) -> live (until endsAt) ->
 * settling (no more runs; waiting for verification) -> over (winner / outcome; sent once).
 */
export interface RaceView {
  id: string;
  state: "challenge" | "countdown" | "live" | "settling" | "over";
  map: string;
  style: StyleId;
  track: number;
  a: RaceSide;
  b: RaceSide;
  you: "a" | "b";
  expiresAt: number | null;
  goAt: number | null;
  endsAt: number | null;
  winner?: "a" | "b" | null;
  outcome?: RaceOutcome;
}

/** Additive room-race control message; all timestamps are server epoch milliseconds. */
export interface RoomRaceView {
  id: string;
  state: "joining" | "countdown" | "live" | "settling" | "over";
  map: string;
  style: StyleId;
  track: number;
  joinUntil: number;
  goAt: number | null;
  endsAt: number | null;
  /** Index into racers; -1 for a nonparticipant. */
  you: number;
  racers: { name: string; slot: number | null; place: number | null; dnf: "forfeit" | "left" | "timeout" | null;
    finish: { time: number; real: number } | null; checking: boolean }[];
  outcome?: "finish" | "timeout" | "cancelled";
}

export type ServerMsg =
  | {
      t: "welcome";
      v: number;
      you: number;
      youId: string;
      admin: boolean;
      room: RoomInfo;
      now: number;
      map: MapInfo;
      nextMap: string | null;
      change: MapChange | null;
      vote: VoteView | null;
      myVote: number | null;
      rtv: { count: number; needed: number };
      nominations: Nomination[];
      pool: PoolEntry[];
      players: RosterPlayer[];
      /** Latest meta per slot (timer / style / ping), so the scoreboard is filled before the first snapshot. */
      metas: Record<number, NetMeta>;
      /** Weapon in hand per slot (validated ids), for players whose client reports one. Absent from older servers. */
      weapons?: Record<number, number>;
      /** Your race (0.0.16), when you're in one (a reconnect). Absent from older servers. */
      race?: RaceView | null;
      roomRace?: RoomRaceView | null;
    }
  | { t: "join"; player: RosterPlayer; quiet?: boolean }
  | { t: "leave"; slot: number; name: string; reason?: string; quiet?: boolean }
  | { t: "player"; slot: number; patch: Partial<Omit<RosterPlayer, "slot" | "id">> }
  /**
   * `role` (say lines): the speaker's staff role; `staff` / `verified` / `creator` / `booster` / `supporter`: their
   * marks; `nameColor` / `nameEffect` / `nameColor2` / `nameFont`: a supporter's name look. Set by the room (never by the client);
   * absent from older servers.
   */
  | { t: "chat"; kind: ChatKind; text: string; slot?: number; name?: string; rank?: RankTag | null; role?: StaffRole | null; staff?: StaffBadge | null; verified?: boolean; creator?: CreatorKind | null; special?: string[]; booster?: boolean; supporter?: boolean; nameColor?: NameColorId | null; nameEffect?: NameEffect | null; nameColor2?: NameColorId | null; nameFont?: NameFontId | null; nameStyle?: NameStyle | null; nameBadges?: string[]; giftsSent?: number; gifterColors?: string[]; gifterAnimated?: boolean; at: number }
  | { t: "gift"; batchId: string; count: number; names: string[]; sender: { id: string; name: string }; recipients: { id: string; name: string }[] }
  | { t: "vote"; vote: VoteView; myVote?: number | null }
  | { t: "voteEnd"; id: number; winner: VoteOption | null }
  | { t: "rtv"; count: number; needed: number }
  | { t: "nominations"; list: Nomination[] }
  | { t: "map"; map: MapInfo; nextMap: string | null }
  | { t: "change"; change: MapChange }
  | { t: "announce"; a: Announcement }
  /**
   * To one player: the room just recorded an achievement for them (progression.ts id, e.g. Play with the Owner). The
   * client celebrates it like a run's unlocks; older clients ignore the unknown type (the private chat line still shows).
   */
  | { t: "achievement"; id: string }
  | { t: "kicked"; reason: string }
  /** Private lobbies: the host moved to `slot` (null: nobody here can host). Older clients ignore it. */
  | { t: "host"; slot: number | null }
  /** To a racer (0.0.16 `!race`): their race changed (null: none). An "over" race comes once. Older clients ignore it. */
  | { t: "race"; race: RaceView | null }
  | { t: "roomRace"; race: RoomRaceView | null }
  | { t: "error"; code: string; message: string };

export type ClientMsg =
  /**
   * `local` (0.0.12): the client already answered the line (!help, an unknown command; chat-commands.ts "log"). The room
   * only writes it to the chat log, nobody sees it, and a plain !help gets the staff commands for staff. Older servers
   * ignore the flag and treat the line as typed.
   */
  | { t: "chat"; text: string; local?: true }
  | { t: "vote"; option: number }
  | { t: "rtv" }
  | { t: "nominate"; map: string }
  /** Start/stop spectating (target slot, or null to play again). */
  | { t: "spec"; target: number | null }
  /**
   * (0.0.30) The knife and finish held now (the knife pool's pick, player/cosmetics.ts): the room checks the pair is
   * the player's equipped one or in their saved pool and patches their roster loadout. Older servers drop it.
   */
  | { t: "knife"; knife: string; finish: string }
  /**
   * (0.0.36) The attempt is practice (on) or a real run again (off): the room patches the roster's `practice` for the
   * others. Cosmetic: the room never trusts it for records (only verified replays are announced). Sent on change (at
   * most about twice a second) and after every welcome. Older servers drop it.
   */
  | { t: "practice"; on: boolean }
  /**
   * Voice chat (net/voice-wire.ts): this socket wants voice frames (`listen`; voice on in its settings). Sent after
   * every welcome of a room that says `voice` and on change. Without it the room sends this socket no voice at all,
   * so older clients and native builds without voice never get the frames. Older servers drop it.
   */
  | { t: "voice"; listen: boolean }
  /**
   * Voice: staff or a private lobby's host mutes (`on`) or unmutes a player's voice for this room. `minutes` absent:
   * the room's default. The room checks who may; everyone gets the roster's `voiceMuted` patch.
   */
  | { t: "voiceMute"; slot: number; on: boolean; minutes?: number }
  /**
   * (0.0.43) Gain logs: send me other players' lines with at least `min` % gain (EXT_LOG), or none (null). Sent after
   * every welcome of a room that says `logs` and on change; without it the room sends this socket none. Older servers
   * drop it.
   */
  | { t: "logs"; min: number | null };

/** Validates a client control frame. Returns null for anything malformed (the room drops it). */
export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > MAX_TEXT_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const uint = (v: unknown, max = 0xffff_ffff): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case "chat":
      if (typeof o.text !== "string" || o.text.length > MAX_CHAT_CHARS * 4) return null;
      return o.local === true ? { t: "chat", text: o.text, local: true } : { t: "chat", text: o.text };
    case "vote":
      return Number.isInteger(o.option) && (o.option as number) >= 0 && (o.option as number) < 16 ? { t: "vote", option: o.option as number } : null;
    case "rtv":
      return { t: "rtv" };
    case "nominate":
      return typeof o.map === "string" && o.map.length <= 64 ? { t: "nominate", map: o.map } : null;
    case "knife":
      return typeof o.knife === "string" && typeof o.finish === "string" && o.knife.length <= 48 && o.finish.length <= 48 ? { t: "knife", knife: o.knife, finish: o.finish } : null;
    case "practice":
      return typeof o.on === "boolean" ? { t: "practice", on: o.on } : null;
    case "voice":
      return typeof o.listen === "boolean" ? { t: "voice", listen: o.listen } : null;
    case "logs":
      return o.min === null ? { t: "logs", min: null } : typeof o.min === "number" && o.min >= 0 && o.min <= 100 ? { t: "logs", min: o.min } : null;
    case "voiceMute":
      return uint(o.slot, 255) && typeof o.on === "boolean" && (o.minutes === undefined || uint(o.minutes, 7 * 24 * 60) && o.minutes > 0)
        ? { t: "voiceMute", slot: o.slot, on: o.on, ...(o.minutes !== undefined ? { minutes: o.minutes as number } : {}) }
        : null;
    case "spec":
      if (o.target === null) return { t: "spec", target: null };
      return Number.isInteger(o.target) && (o.target as number) >= 0 && (o.target as number) < 256 ? { t: "spec", target: o.target as number } : null;
    default:
      return null;
  }
}

/** Server -> client frames are trusted but still parsed defensively. */
export function parseServerMsg(text: string): ServerMsg | null {
  try {
    const v = JSON.parse(text) as ServerMsg;
    if (v?.t === "gift") {
      const person = (p: unknown): boolean => !!p && typeof p === "object" && typeof (p as {id?:unknown}).id === "string" && typeof (p as {name?:unknown}).name === "string" && (p as {name:string}).name.length <= 32;
      if (typeof v.batchId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.batchId) || !person(v.sender) || !Array.isArray(v.recipients) || v.recipients.length > 1000 || !v.recipients.every(person) || !Number.isInteger(v.count) || v.count < 1 || v.count > 1000 || !Array.isArray(v.names) || v.names.length > 3 || !v.names.length || !v.names.every((n) => typeof n === "string" && n.length <= 32)) return null;
    }
    return v && typeof v === "object" && typeof (v as { t?: unknown }).t === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Close codes the room uses (4000-4999 are application codes). */
export const CLOSE = {
  /** Client: leaving because the room changed maps (reconnects right after; no leave message). */
  MAP_CHANGE: 4001,
  /** Same account connected again elsewhere. */
  REPLACED: 4002,
  FULL: 4003,
  NO_MAPS: 4004,
  KICKED: 4005,
  BANNED: 4006,
  /** Too many malformed / over-limit messages. */
  ABUSE: 4008,
  /** A private lobby that has closed (or never existed): the invite is dead. */
  LOBBY_CLOSED: 4009,
  /**
   * The room heard nothing from this socket for too long (0.0.43, apps/api rooms/room.ts LIVENESS_MS): it closes it
   * as dead and holds the player's place. Not final: a client that is still there reconnects.
   */
  TIMED_OUT: 4010,
  /** Client, 3000-3999 (not a room code, so the room holds the place): this socket stopped answering (net/room.ts). */
  STALE: 3001,
  /** Client leaving on purpose. */
  LEAVE: 4000,
} as const;

/**
 * A close someone chose: a normal closure (1000) or one of the room's own codes (4000-4999: a leave, a map change, a
 * kick). Anything else (1001 going away, 1005 no status, 1006 abnormal, 1011/1012 server restart) is a dropped
 * connection the client reconnects after (net/room.ts), and the room holds the player's place for it.
 */
export function deliberateClose(code: number): boolean {
  return code === 1000 || (code >= 4000 && code <= 4999);
}
