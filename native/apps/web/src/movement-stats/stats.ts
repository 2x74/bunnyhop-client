// Local, display-only movement analysis. No values are fed back into the core or ranked timer.
import { EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED, type PlayerState } from "../core";
import { EVENT_RESPAWNED, type TickCmd } from "../timer";
import { yawDelta } from "../autostrafe";
import { palette } from "../palette";

const BROKEN = EVENT_TELEPORTED | EVENT_RESPAWNED;
const MANUAL = new Set(["autohop", "legit", "scroll", "hsw"]);
export interface OffsetReport { ticks: number; overlap: boolean; gap: boolean }
/** "−1", "0", "+2": a real minus sign so the HUD's tabular figures line up. */
export const signedTicks = (n: number): string => (n < 0 ? `\u2212${-n}` : n > 0 ? `+${n}` : "0");
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What an offset means, in words: "key early, gap". */
export function offsetNote(r: OffsetReport): string {
  return [r.ticks < 0 ? "key early" : r.ticks > 0 ? "key late" : "same tick", r.overlap ? "overlap" : r.gap ? "gap" : ""].filter(Boolean).join(", ");
}
/** "Offset −1 (key early, gap)". */
export function offsetText(r: OffsetReport): string {
  return `Offset ${signedTicks(r.ticks)} (${offsetNote(r)})`;
}
/** "FJT 1 tick"; with the tick length, the chat's "FJT 1 tick (10 ms)". */
export function fjtText(ticks: number, tickInterval?: number): string {
  const ms = tickInterval ? ` (${Math.round(ticks * tickInterval * 1000)} ms)` : "";
  return `FJT ${plural(ticks, "tick")}${ms}`;
}

/** Pair A/D reversals with matching mouse reversals within 20 ticks, as bhop-get-stats does.
 * Negative = key changed before turn; -1/0 are the usual targets. Zero-yaw ticks preserve direction. */
export class OffsetTracker {
  private tick = -1;
  private yaw = NaN;
  private side = 0;
  private turn = 0;
  private keyAt: { tick: number; dir: number } | null = null;
  private turnAt: { tick: number; dir: number } | null = null;
  private overlap = false;
  private gap = false;
  reset(): void {
    this.tick = -1; this.yaw = NaN; this.side = this.turn = 0;
    this.keyAt = this.turnAt = null; this.overlap = this.gap = false;
  }
  feed(cmd: TickCmd, state: PlayerState, events: number, style: string): OffsetReport | null {
    const previousYaw = this.yaw, continuous = state.tick === this.tick + 1;
    if (!continuous || !MANUAL.has(style) || state.grounded || state.onLadder || (events & BROKEN) || !Number.isFinite(cmd.yaw)) this.reset();
    this.tick = state.tick; this.yaw = cmd.yaw;
    if (!continuous || !MANUAL.has(style) || state.grounded || state.onLadder || (events & BROKEN)) return null;
    const side = Math.sign(cmd.side);
    const turn = -Math.sign(yawDelta(previousYaw, cmd.yaw));
    if ((cmd.buttons & (1 << 9)) && (cmd.buttons & (1 << 10))) this.overlap = true;
    else if (!side) this.gap = true;
    if (side && this.side && side !== this.side) this.keyAt = { tick: state.tick, dir: side };
    if (turn && this.turn && turn !== this.turn) this.turnAt = { tick: state.tick, dir: turn };
    if (side) this.side = side;
    if (turn) this.turn = turn;
    if (this.keyAt && state.tick - this.keyAt.tick >= 20) this.keyAt = null;
    if (this.turnAt && state.tick - this.turnAt.tick >= 20) this.turnAt = null;
    if (!this.keyAt || !this.turnAt || this.keyAt.dir !== this.turnAt.dir) return null;
    const r = { ticks: this.keyAt.tick - this.turnAt.tick, overlap: this.overlap, gap: this.gap };
    this.keyAt = this.turnAt = null; this.overlap = this.gap = false;
    return r;
  }
}

/** Canonical timer jump count includes a takeoff inside the start zone. In-zone takeoffs are FJT 0.
 * Use actual run ticks, never seconds * a hardcoded tickrate (the older Source plugin assumes 100 Hz). */
export class FirstJumpTracker {
  private reported = false;
  reset(): void { this.reported = false; }
  feed(t: { jumped: boolean; jumps: number; ticks: number; running: boolean; inStart: boolean; broken: boolean }): number | undefined {
    if (t.jumps === 0) this.reset();
    if (t.broken) { this.reported = true; return; }
    if (!this.reported && t.jumped && t.jumps === 1 && (t.running || t.inStart)) {
      this.reported = true;
      return t.running ? Math.max(0, t.ticks) : 0;
    }
  }
}

/** One strafe of a jump: from an A / D switch to the next. Gain and loss are horizontal speed (u/s). */
export interface StrafeStat {
  side: -1 | 1;
  ticks: number;
  gain: number;
  loss: number;
  /** Ticks of this strafe that added speed, in %. */
  sync: number;
}
/** One tick of the flight: horizontal distance from the takeoff point, height above it (body, not feet: an air duck's
 * step is taken out), horizontal speed. */
export interface FlightPoint { d: number; z: number; v: number }

export interface LjReport {
  kind: "LJ" | "BH";
  distance: number;
  displacement: number;
  pre: number;
  max: number;
  strafes: number;
  sync: number;
  airtime: number;
  crouched: boolean;
  /** Clean takeoff, but the player dropped below the takeoff height: distance is where they crossed it. */
  failed?: boolean;
  /** Per strafe (absent on reports made before strafe tracking). */
  strafeStats?: StrafeStat[];
  /** The flight, tick by tick (absent on older reports). */
  path?: FlightPoint[];
}

/** LJ distance colours, as KZ servers colour them: white, then blue, green, red, gold from these distances (units).
 * Calibrated on this game's physics (100 tick, sv_airaccelerate 1000, 260 u/s run speed): a scripted, perfectly synced
 * LJ off a ~280 prestrafe lands about 284, so gold is near the ceiling, as GOKZ's KZTimer tiers (265-280) are there.
 * Bhop jumps (BH) are not tiered: their distance mostly says how fast you already were. */
export const LJ_TIERS = [250, 260, 268, 275] as const;
/** The tiers' own colours (the share card, which other people see). On screen, ljColor follows the colour-blind palette. */
export const TIER_COLORS = ["#ffffff", "#5eb6ff", "#4dff88", "#ff5d5d", "#ffc53d"] as const;
export const TIER_NAMES = ["", "Impressive", "Perfect", "Godlike", "Ownage"] as const;
export function ljTier(r: Pick<LjReport, "kind" | "distance" | "failed">): number {
  if (r.kind !== "LJ" || r.failed) return 0;
  let t = 0;
  for (const d of LJ_TIERS) if (r.distance >= d) t++;
  return t;
}
export const ljColor = (r: Pick<LjReport, "kind" | "distance" | "failed">): string => palette().lj[ljTier(r)];

/** The short columns under the distance: pre, max, strafes, sync. Integers; only the distance has decimals. */
export function ljColumns(r: LjReport): [string, string][] {
  return [[`${Math.round(r.pre)}`, "pre"], [`${Math.round(r.max)}`, "max"], [`${r.strafes}`, "str"], [`${Math.round(r.sync)}%`, "sync"]];
}
/** "LJ 254.32" / "BH 271.85" / "LJ 241.10 fail". */
export function ljHead(r: LjReport): string {
  return `${r.kind} ${r.distance.toFixed(2)}${r.failed ? " fail" : ""}`;
}
/** The chat line, KZ style: "LJ 254.32 | 278 pre | 342 max | 6 str | 91% sync". */
export function ljText(r: LjReport): string {
  return [ljHead(r), ...ljColumns(r).map(([n, l]) => `${n} ${l}`)].join(" | ");
}
type Strafe = { side: -1 | 1; ticks: number; gain: number; loss: number; synced: number };
type Flight = { start: number[]; tick: number; kind: LjReport["kind"]; pre: number; max: number; side: number; samples: number; synced: number; valid: boolean;
  list: Strafe[]; path: FlightPoint[]; cross: { d: number; tick: number } | null; duck: number };
const round1 = (v: number) => Math.round(v * 10) / 10;
/** Flat, same-height jumps only. Source convention: horizontal origin displacement + 32-unit hull width.
 * Requires the core's clean-movement observation: rejects water, walls/ceilings, steps, movers, boosters and altered gravity.
 * 10 grounded ticks separates standing LJs from bhops; walking off a ledge never starts a flight.
 * A clean flight that drops more than 2 units below its takeoff is a fail, measured where it crossed the takeoff height. */
export class LjTracker {
  private ground = 0;
  private flight: Flight | null = null;
  reset(): void { this.ground = 0; this.flight = null; }
  private report(f: Flight, displacement: number, ticks: number, dt: number, crouched: boolean, failed: boolean): LjReport | null {
    const airtime = ticks * dt;
    if (f.samples === 0 || airtime < 0.2 || airtime > 1.2 || displacement < 32) return null;
    return { kind: f.kind, distance: displacement + 32, displacement, pre: f.pre, max: f.max, strafes: f.list.length,
      sync: 100 * f.synced / f.samples, airtime, crouched, ...(failed ? { failed: true } : {}),
      strafeStats: f.list.map(s => ({ side: s.side, ticks: s.ticks, gain: s.gain, loss: s.loss, sync: s.ticks ? 100 * s.synced / s.ticks : 0 })),
      path: f.path };
  }
  feed(pre: PlayerState, post: PlayerState, cmd: TickCmd, events: number, dt: number, style: string): LjReport | null {
    if (events & BROKEN || pre.onLadder || post.onLadder || !MANUAL.has(style) || !Number.isFinite(dt) || dt <= 0 || post.tick !== pre.tick + 1 || ![...pre.position, ...post.position, ...pre.velocity, ...post.velocity].every(Number.isFinite)) { this.reset(); return null; }
    if (pre.grounded) this.ground++;
    let report: LjReport | null = null;
    if (this.flight) {
      const f = this.flight;
      f.valid &&= post.jumpStatsValid === true;
      const speed = Math.hypot(post.velocity[0], post.velocity[1]), before = Math.hypot(pre.velocity[0], pre.velocity[1]);
      const d = Math.hypot(post.position[0] - f.start[0], post.position[1] - f.start[1]), z = post.position[2] - f.start[2];
      // Actual positive horizontal acceleration, sampled only with a movement input.
      if (!pre.grounded) {
        f.samples++;
        const synced = !!(cmd.forward || cmd.side) && speed > before + 0.0001;
        if (synced) f.synced++;
        const side = Math.sign(cmd.side) as -1 | 0 | 1;
        if (side && side !== f.side) { f.list.push({ side, ticks: 0, gain: 0, loss: 0, synced: 0 }); f.side = side; }
        const s = f.list[f.list.length - 1];
        if (s) { s.ticks++; if (speed > before) s.gain += speed - before; else s.loss += before - speed; if (synced) s.synced++; }
      }
      f.max = Math.max(f.max, speed);
      // Ducking in the air pulls the feet (the origin) up: the path keeps the body's arc, without that step.
      if (!post.grounded && post.crouched !== pre.crouched) f.duck += post.position[2] - pre.position[2] - ((pre.velocity[2] + post.velocity[2]) / 2) * dt;
      f.path.push({ d: round1(d), z: round1(post.grounded ? z : z - f.duck), v: round1(speed) });
      // Where the flight first drops through the takeoff height (interpolated between the two ticks).
      if (!f.cross && z < 0) {
        const zp = pre.position[2] - f.start[2], dp = Math.hypot(pre.position[0] - f.start[0], pre.position[1] - f.start[1]);
        const t = zp > z ? zp / (zp - z) : 1;
        f.cross = { d: dp + (d - dp) * Math.min(1, Math.max(0, t)), tick: post.tick };
      }
      if (z < -2 && f.cross) {
        if (f.valid) report = this.report(f, f.cross.d, f.cross.tick - f.tick, dt, post.crouched, true);
        this.flight = null;
      } else if (events & EVENT_LANDED || post.grounded) {
        // Source categorizes ground up to 2 units above its surface, before the next tick snaps down.
        if (f.valid && Math.abs(z) <= 2) report = this.report(f, d, post.tick - f.tick, dt, post.crouched, false);
        this.flight = null;
      } else if ((post.tick - f.tick) * dt > 1.2) this.flight = null;
    }
    if (events & EVENT_JUMPED && pre.grounded && !pre.crouched) {
      const speed = Math.hypot(pre.velocity[0], pre.velocity[1]);
      this.flight = { start: [...pre.position], tick: pre.tick, kind: this.ground >= 10 && speed <= 300 ? "LJ" : "BH",
        pre: speed, max: Math.hypot(post.velocity[0], post.velocity[1]), side: 0, samples: 0, synced: 0,
        valid: post.jumpStatsValid === true, list: [], path: [{ d: 0, z: 0, v: round1(speed) }], cross: null, duck: 0 };
    }
    if (!pre.grounded) this.ground = 0;
    return report;
  }
}
