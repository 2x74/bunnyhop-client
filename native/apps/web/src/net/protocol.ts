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
//   MSG_STATE (client -> room), 16 + n * 24 bytes
//     0  u8  type = MSG_STATE         1  u8  n samples (1..MAX_SAMPLES)   2 u8 weapon (WEAPON_REPORTED | id, 0x40 = the
//                                                                          USP's silencer is on (0.0.12); 0 = not reported)
//     3  u8  style (WIRE_STYLES idx)   4  u8  track                        5 u8 timer status (TIMER_*)
//     6  u16 ping ms (client RTT)      8  u32 timer ticks (running: elapsed; finished: final time)
//     12 u32 base tick (client's monotonic net tick of sample 0)
//     16 samples
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
/** Cosmetic: a carrot stab (secondary attack) since the previous sample. */
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

/** Wire order of styles (frozen: never reorder, only append). */
export const WIRE_STYLES: readonly StyleId[] = ["autohop", "legit", "wonly", "sideways", "hsw", "autostrafe", "scroll", "lowgrav"];
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

/** `weapon`: the weapon id in hand (core.ts WEAPON_IDS), null = don't report one; `silenced`: its silencer is on. */
export function encodeState(meta: NetMeta, samples: readonly NetSample[], weapon: number | null = null, silenced = false): Uint8Array<ArrayBuffer> {
  const n = Math.min(samples.length, MAX_SAMPLES);
  const buf = new Uint8Array(STATE_HEADER_BYTES + n * SAMPLE_BYTES);
  const dv = new DataView(buf.buffer);
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
  if (u8.length < STATE_HEADER_BYTES || u8.length > MAX_STATE_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== MSG_STATE) return null;
  const n = dv.getUint8(1);
  if (n < 1 || n > MAX_SAMPLES || u8.length !== STATE_HEADER_BYTES + n * SAMPLE_BYTES) return null;
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
  return { meta, samples, weapon: readWeaponByte(wb), silenced: readSilencedByte(wb) };
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
    o += len;
  }
  return { serverTime: dv.getUint32(2, true), blocks };
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
  /** Verified main-track PBs on the room's current map, seconds, by style. */
  pb: Partial<Record<StyleId, number>>;
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
  nameBadges?: string[]; giftsSent?: number; gifterColors?: string[]; gifterAnimated?: boolean;
  /** Staff-granted special badges (creators.ts SPECIAL_BADGES, 0.0.21). Absent from older servers. */
  special?: string[];
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
}

export interface MapInfo {
  name: string;
  tier: number | null;
  startedAt: number;
  /** Time limit (server ms); moves when the map is extended. */
  endsAt: number;
}

export interface PoolEntry {
  name: string;
  tier: number | null;
}

export type VoteOption = { map: string; tier: number | null } | { extend: true; minutes: number };
export const isExtend = (o: VoteOption): o is { extend: true; minutes: number } => "extend" in o;

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
    }
  | { t: "join"; player: RosterPlayer; quiet?: boolean }
  | { t: "leave"; slot: number; name: string; reason?: string; quiet?: boolean }
  | { t: "player"; slot: number; patch: Partial<Omit<RosterPlayer, "slot" | "id">> }
  /**
   * `role` (say lines): the speaker's staff role; `staff` / `verified` / `creator` / `booster` / `supporter`: their
   * marks; `nameColor` / `nameEffect` / `nameColor2`: a supporter's name look. Set by the room (never by the client);
   * absent from older servers.
   */
  | { t: "chat"; kind: ChatKind; text: string; slot?: number; name?: string; rank?: RankTag | null; role?: StaffRole | null; staff?: StaffBadge | null; verified?: boolean; creator?: CreatorKind | null; special?: string[]; booster?: boolean; supporter?: boolean; nameColor?: NameColorId | null; nameEffect?: NameEffect | null; nameColor2?: NameColorId | null; nameBadges?: string[]; giftsSent?: number; gifterColors?: string[]; gifterAnimated?: boolean; at: number }
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
  | { t: "spec"; target: number | null };

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
  /** Client leaving on purpose. */
  LEAVE: 4000,
} as const;
