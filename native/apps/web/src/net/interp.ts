// Snapshot interpolation for remote players (DOM-free).
//
// Every player stamps samples with its own net tick (100 per second, monotonic across restarts). The receiver maps
// a sender's ticks onto local time with an offset estimate per sender (offset = arrival - tick * 10 ms, tracking the
// fastest arrivals so jitter doesn't push it around) and renders behind the newest data by about the sender's batch
// interval plus measured jitter (which absorbs the room's coalescing), so two samples bracket the render time almost always
// whatever cadence the sender uses (0.0.21 clients: 25 Hz samples in 5 Hz batches; older ones 20 Hz in 10 Hz).
// Between two samples the position follows a cubic Hermite curve through both positions with both velocities as
// tangents (jump arcs and strafe curves stay round, not polylines); when the velocities don't explain the move
// (collisions, ramps, landings) it falls back to a straight line. Gaps fall back to a short velocity extrapolation,
// then hold. Teleport-flagged samples are snapped to, never slid into.
//
// The weapon in hand (protocol.ts EXT_WEAPONS) arrives with a block and takes effect at that block's newest sample, so
// a switch shows when the render time reaches it, in step with the movement. An attack on a sample is made with the
// weapon held before a change at that same sample (a switch blocks attacks for a second in the sim).

import { inspectField, SF_CROUCHED, SF_GROUNDED, SF_JUMPED, SF_SLASH, SF_STAB, SF_TELEPORT, TICK_MS, type NetSample } from "./protocol";

/** Least interpolation delay (a sender batching every 100 ms or faster). */
export const INTERP_MS = 100;
/** The batch interval assumed until a sender's has been measured, and the most it may count for. */
const BATCH_START_MS = 100;
const BATCH_MAX_MS = 400;
/** Extra delay allowed for measured jitter. */
const MAX_JITTER_MS = 120;
/** How far past the newest sample we extrapolate before holding. */
const MAX_EXTRAPOLATE_MS = 100;
const MAX_BUFFER = 96;

export interface InterpState {
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
  /** The rendered state jumped (teleport) since the previous sample() call: snap cameras / models. */
  snapped: boolean;
  /** A jump happened since the previous sample() call (PlayerPose.jumped). */
  jumped: boolean;
  /** Cosmetic swing since the previous sample() call: 0 none, 1 slash, 2 stab (PlayerPose.attack), reported once. */
  attack: number;
  /** Inspect signal since the previous sample() call (combo.ts SIG_START / SIG_NEXT, PlayerPose.inspect), reported once. */
  inspect: number;
  /** The sender holds the inspect key during an inspect (PlayerPose.inspectHeld). */
  inspectHeld: boolean;
  /** Weapon in hand at the render time (core.ts WEAPON_IDS); -1 = unknown (an older client or room: the knife). */
  weapon: number;
  /** The weapon `attack` was made with (a gun: a shot). */
  attackWeapon: number;
  /** The gun in hand started a reload or took a shell since the previous sample() call (protocol.ts SF_STAB with a gun). */
  reload: boolean;
  /** The gun in hand has its silencer on (0.0.12, protocol.ts EXT_SILENCED), and whether `attack` was a silenced shot. */
  silenced: boolean;
  attackSilenced: boolean;
  /** `weapon` changed since the previous sample() call (a switch, pickup or drop; not the first one heard of), reported once. */
  weaponChanged: boolean;
  /** Milliseconds since the newest sample was received (stale / paused senders). */
  age: number;
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export function blankState(): InterpState {
  return { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, crouched: false, grounded: true, snapped: true, jumped: false, attack: 0, inspect: 0, inspectHeld: false, weapon: -1, attackWeapon: -1, reload: false, silenced: false, attackSilenced: false, weaponChanged: false, age: 0 };
}

/** A weapon timeline code: the id, plus this bit when the gun's silencer is on (ids are <= 31). */
const SILENCED_BIT = 0x40;
const weaponCode = (weapon: number, silenced: boolean): number => (weapon < 0 ? -1 : weapon | (silenced && weapon >= 2 ? SILENCED_BIT : 0));
const codeWeapon = (code: number): number => (code < 0 ? -1 : code & ~SILENCED_BIT);

/**
 * Position between s0 and s1 at f (0..1) into `out`: cubic Hermite with the samples' velocities as tangents, per axis,
 * when they agree with the move; a straight line when they don't (a wall, a ramp or a landing changed the velocity
 * inside the interval) or on the ground vertically (steps).
 */
export function curve(out: [number, number, number], s0: NetSample, s1: NetSample, f: number): void {
  const dt = ((s1.tick - s0.tick) * TICK_MS) / 1000;
  const p0 = [s0.x, s0.y, s0.z];
  const p1 = [s1.x, s1.y, s1.z];
  const v0 = [s0.vx, s0.vy, s0.vz];
  const v1 = [s1.vx, s1.vy, s1.vz];
  // Velocities explain the move when their average matches the average speed over the interval (within 15% + 60 u/s).
  let smooth = dt > 0 && dt <= 0.12;
  for (let a = 0; a < 3 && smooth; a++) {
    const avg = (p1[a] - p0[a]) / dt;
    const mean = (v0[a] + v1[a]) / 2;
    if (Math.abs(avg - mean) > Math.abs(avg) * 0.15 + 60) smooth = false;
  }
  const f2 = f * f;
  const f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1;
  const h10 = f3 - 2 * f2 + f;
  const h01 = -2 * f3 + 3 * f2;
  const h11 = f3 - f2;
  const flat = s0.flags & s1.flags & SF_GROUNDED;
  for (let a = 0; a < 3; a++) {
    out[a] = smooth && !(a === 2 && flat) ? h00 * p0[a] + h10 * dt * v0[a] + h01 * p1[a] + h11 * dt * v1[a] : p0[a] + (p1[a] - p0[a]) * f;
  }
}

export class RemoteTrack {
  private buf: NetSample[] = [];
  /** local ms - tick * TICK_MS, tracked at the fastest arrivals. */
  private offset: number | null = null;
  private jitter = 0;
  private lastArrival = 0;
  /** The sender's batch interval (ms): the first one measured, then smoothed. */
  private batch = BATCH_START_MS;
  private batchMeasured = false;
  private lastRendered: NetSample | null = null;
  private lastJump = -1;
  private lastAttack = -1;
  private lastInspect = -1;
  /**
   * Weapon in effect at the render time, and changes still ahead of it (ascending ticks), as a code: the weapon id with
   * SILENCED_BIT when its silencer is on; -1 = unknown.
   */
  private weapon = -1;
  private weapons: { tick: number; weapon: number }[] = [];

  get size(): number {
    return this.buf.length;
  }

  get newest(): NetSample | null {
    return this.buf[this.buf.length - 1] ?? null;
  }

  /**
   * Current render delay (ms) behind the sender's newest data: INTERP_MS for a 100 ms cadence (as before 0.0.21), plus
   * whatever a sender's longer batch interval adds, plus measured jitter (which absorbs the room's coalescing).
   */
  get delay(): number {
    return INTERP_MS + Math.max(0, this.batch - BATCH_START_MS) + Math.min(MAX_JITTER_MS, this.jitter);
  }

  push(samples: readonly NetSample[], now: number): void {
    if (!samples.length) return;
    const last = this.buf[this.buf.length - 1];
    for (const s of samples) {
      if (last && s.tick <= last.tick) continue;
      if (this.buf.length && s.tick <= this.buf[this.buf.length - 1].tick) continue;
      this.buf.push(s);
    }
    if (this.buf.length > MAX_BUFFER) this.buf.splice(0, this.buf.length - MAX_BUFFER);
    const newest = samples[samples.length - 1];
    // The batch interval: the span of ticks this batch covers since the previous one (not wall time, which jitters).
    const prevNewest = last?.tick;
    if (prevNewest !== undefined && newest.tick > prevNewest) {
      const span = (newest.tick - prevNewest) * TICK_MS;
      // A longer gap is a pause (menus) or loss, not the sender's cadence.
      if (span <= BATCH_MAX_MS) this.batch = this.batchMeasured ? this.batch * 0.8 + span * 0.2 : span;
      this.batchMeasured ||= span <= BATCH_MAX_MS;
    }
    const cand = now - newest.tick * TICK_MS;
    if (this.offset === null || cand < this.offset || cand - this.offset > 750) {
      // First data, a faster path, or the sender paused (menus stop its ticks): resync.
      if (this.offset !== null && cand - this.offset > 750) this.jitter = 0;
      this.offset = cand;
    } else {
      const late = cand - this.offset;
      this.jitter = this.jitter * 0.9 + late * 0.1;
      this.offset += late * 0.002; // slow drift toward the typical path (clock skew)
    }
    this.lastArrival = now;
  }

  /**
   * The weapon in hand from `tick` (the newest sample of the block it came with) on. A repeat of the latest value is
   * ignored.
   */
  pushWeapon(weapon: number, tick: number, silenced = false): void {
    weapon = weaponCode(weapon, silenced);
    const last = this.weapons[this.weapons.length - 1];
    if ((last ? last.weapon : this.weapon) === weapon) return;
    if (last && tick <= last.tick) last.weapon = weapon;
    else this.weapons.push({ tick, weapon });
    if (this.weapons.length > 32) this.weapons.splice(0, this.weapons.length - 32);
  }

  /** The weapon in hand right now (the room's welcome): no timeline. */
  setWeapon(weapon: number, silenced = false): void {
    this.weapon = weaponCode(weapon, silenced);
    this.weapons = [];
  }

  /** The weapon in effect just before `tick` (changes at `tick` itself not yet). */
  private weaponBefore(tick: number): number {
    let w = this.weapon;
    for (const c of this.weapons) {
      if (c.tick >= tick) break;
      w = c.weapon;
    }
    return w;
  }

  /** Interpolated state at local time `now`. Returns false until there is data. */
  sample(now: number, out: InterpState): boolean {
    const b = this.buf;
    if (!b.length || this.offset === null) return false;
    const t = (now - this.offset - this.delay) / TICK_MS; // render tick
    // Drop samples we've moved past (keep one before t). A jump flag on any sample the render time just passed is a
    // jump event for the model (PlayerPose.jumped), reported once.
    let i = 0;
    while (i + 1 < b.length && b[i + 1].tick <= t) i++;
    out.jumped = false;
    out.attack = 0;
    out.reload = false;
    out.inspect = 0;
    out.weaponChanged = false;
    for (let k = 0; k <= i; k++) {
      const s = b[k];
      if (s.flags & SF_JUMPED && s.tick <= t && s.tick > this.lastJump) {
        out.jumped = true;
        this.lastJump = s.tick;
      }
      if (s.flags & (SF_SLASH | SF_STAB) && s.tick <= t && s.tick > this.lastAttack) {
        const w = this.weaponBefore(s.tick);
        if (codeWeapon(w) >= 2) {
          // A gun: SF_SLASH a shot, SF_STAB a reload / shell (protocol.ts SF_STAB). A reload keeps the last shot's report.
          if (s.flags & SF_SLASH) {
            out.attack = 1;
            out.attackWeapon = codeWeapon(w);
            out.attackSilenced = (w & SILENCED_BIT) !== 0;
          }
          if (s.flags & SF_STAB) out.reload = true;
        } else {
          out.attack = s.flags & SF_STAB ? 2 : 1;
          out.attackWeapon = codeWeapon(w);
          out.attackSilenced = w >= 0 && (w & SILENCED_BIT) !== 0;
        }
        this.lastAttack = s.tick;
      }
      if (s.tick <= t && s.tick > this.lastInspect) {
        const f = inspectField(s.flags);
        if (f === 1 || f === 2) out.inspect = f;
        else out.inspectHeld = f === 3;
        this.lastInspect = s.tick;
      }
    }
    if (i > 0) b.splice(0, i);
    // Weapon changes the render time has reached.
    const w0 = this.weapon;
    while (this.weapons.length && this.weapons[0].tick <= t) this.weapon = this.weapons.shift()!.weapon;
    out.weapon = codeWeapon(this.weapon);
    out.silenced = this.weapon >= 0 && (this.weapon & SILENCED_BIT) !== 0;
    // (The first weapon heard of is no switch, and neither is the silencer going on or off.)
    out.weaponChanged = w0 >= 0 && codeWeapon(this.weapon) !== codeWeapon(w0);
    const s0 = b[0];
    const s1 = b[1];
    let src: NetSample = s0;
    if (s1 && t >= s0.tick) {
      const f = Math.min(1, (t - s0.tick) / (s1.tick - s0.tick));
      if (s1.flags & SF_TELEPORT) {
        src = f >= 1 ? s1 : s0;
        this.write(out, src, 0);
      } else {
        curve(out.pos, s0, s1, f);
        out.vel[0] = s0.vx + (s1.vx - s0.vx) * f;
        out.vel[1] = s0.vy + (s1.vy - s0.vy) * f;
        out.vel[2] = s0.vz + (s1.vz - s0.vz) * f;
        out.yaw = (s0.yaw + wrap180(s1.yaw - s0.yaw) * f + 360) % 360;
        out.pitch = s0.pitch + (s1.pitch - s0.pitch) * f;
        const near = f < 0.5 ? s0 : s1;
        out.crouched = (near.flags & SF_CROUCHED) !== 0;
        out.grounded = (near.flags & SF_GROUNDED) !== 0;
        src = near;
      }
    } else {
      // Past the newest sample (or before the first): extrapolate a little along the velocity, then hold.
      const ahead = Math.max(0, Math.min(MAX_EXTRAPOLATE_MS, (t - s0.tick) * TICK_MS)) / 1000;
      this.write(out, s0, ahead);
    }
    out.snapped = this.lastRendered === null || (src !== this.lastRendered && (src.flags & SF_TELEPORT) !== 0 && src.tick > this.lastRendered.tick);
    this.lastRendered = src;
    out.age = now - this.lastArrival;
    return true;
  }

  private write(out: InterpState, s: NetSample, ahead: number): void {
    out.pos[0] = s.x + s.vx * ahead;
    out.pos[1] = s.y + s.vy * ahead;
    out.pos[2] = s.z + (s.flags & SF_GROUNDED ? 0 : s.vz * ahead);
    out.vel[0] = s.vx;
    out.vel[1] = s.vy;
    out.vel[2] = s.vz;
    out.yaw = s.yaw;
    out.pitch = s.pitch;
    out.crouched = (s.flags & SF_CROUCHED) !== 0;
    out.grounded = (s.flags & SF_GROUNDED) !== 0;
  }

  clear(): void {
    this.buf = [];
    this.offset = null;
    this.jitter = 0;
    this.batch = BATCH_START_MS;
    this.batchMeasured = false;
    this.lastRendered = null;
    this.lastJump = -1;
    this.weapon = -1;
    this.weapons = [];
  }
}
