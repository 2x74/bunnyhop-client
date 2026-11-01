// Display-only turn pace, inspired by https://github.com/2x74/strafetrainer.
// Pace is yaw change relative to atan(air push / speed). Bar colour uses the core's clean AirAccelerate observation.
import type { TickCmd } from "../timer";
import type { ChatCommand } from "../chat-commands";

export type TrainerCue = "ready" | "keys" | "direction" | "slow" | "good" | "fast" | "unsupported";
/**
 * `side`: the strafe key held, -1 left, 1 right, 0 none (the follow-the-turn gauge mirrors on it).
 * `bar` / `barSide`: the Bar look's own average, where a tick with nothing to judge counts as 0, so the fill grows out of
 * its edge after a strafe switch and fades when the strafing stops. Absent when 0; previews and the layout editor leave
 * it out too, and the Bar look then shows `pace` and `side`.
 */
export interface TrainerReading { cue: TrainerCue; pace: number | null; side: number; bar?: number; barSide?: number; gain?: number | null }
export interface TrainerSample {
  /** Exact core observation (absent / NaN on older WASM or unjudgeable ticks). */
  airSpeedGain?: number;
  airBestGain?: number;
  /** Double-precision post-tick length for Bar parity; legacy replay pace keeps its f32 cache. */
  barSpeed?: number;
  speed: number;
  grounded: boolean;
  onLadder: boolean;
  tick: number;
  dt: number;
  maxSpeed: number;
  airAccelerate: number;
  style: string;
  interrupted?: boolean;
  /** This tick took off (core EVENT_JUMPED): perfect hops may never show a grounded tick between jumps. */
  jumped?: boolean;
}

export type TrainerZone = "good" | "ok" | "bad";
/** Highest pace the gauge shows (its right end). */
export const PACE_MAX = 200;
/** The amber band reaches this many times the on-pace width from 100%. */
const OK_SPAN = 3;

/** Which band `pace` falls in, with ±`width` % around 100 counted as on pace. */
export function trainerZone(pace: number, width: number): TrainerZone {
  const off = Math.abs(pace - 100);
  return off <= width ? "good" : off <= width * OK_SPAN ? "ok" : "bad";
}

/** Where the marker sits along the gauge (0 = left end, 1 = right end). Following the turn mirrors left strafes. */
export function trainerPosition(pace: number, side: number, follow: boolean): number {
  const x = Math.max(0, Math.min(PACE_MAX, pace)) / PACE_MAX;
  return follow && side < 0 ? 1 - x : x;
}

/** Fixed Bar bands, ordered by actual gain; names are stable custom-CSS hooks. */
export type BarBand = "perfect" | "good" | "ok" | "low" | "high";
/** u/s, calibrated against real replay float roundoff; see NATIVE-SPEC.md and trainer-gain-check.ts. */
export const BAR_SPEED_EPSILON = 0.0001;
export const BAR_PERFECT_GAIN = 0.99;
export const BAR_GOOD_GAIN = 0.9;
/** Neutralise speed noise before division: the tolerance is in u/s, not a speed-dependent gain ratio. */
export function barGain(delta: number | undefined, best: number | undefined): number | null {
  if (delta == null || best == null || !Number.isFinite(delta) || !Number.isFinite(best) || best <= 0) return null;
  return Math.abs(delta) <= BAR_SPEED_EPSILON ? 0 : delta / best;
}
/** Share of the Bar track filled (0..1): 100% pace reaches the centre tick, PACE_MAX the far end. */
export function barFill(pace: number | null): number {
  return pace !== null && pace > 0 ? Math.min(1, pace / PACE_MAX) : 0;
}
/** The edge the Bar's fill grows from: turning right (D) fills from the left, turning left (A) from the right. */
export function barEdge(side: number): "left" | "right" {
  return side < 0 ? "right" : "left";
}
/** Red is loss, white is zero / unjudgeable, orange → green → blue is increasing positive gain. */
export function barBand(gain: number | null | undefined): BarBand {
  if (gain == null || !Number.isFinite(gain) || gain === 0) return "low";
  if (gain < 0) return "high";
  if (gain > BAR_PERFECT_GAIN) return "perfect";
  return gain > BAR_GOOD_GAIN ? "good" : "ok";
}

export class StrafeTrainer {
  reading: TrainerReading = { cue: "ready", pace: null, side: 0 };
  /** Ticks averaged into the reading (1 = every tick as it comes). */
  smoothing = 8;
  /** ± % around 100 that counts as on pace (the cue's "good"). */
  zone = 10;
  private yaw = NaN;
  private tick = -1;
  private side = 0;
  private window: number[] = [];
  private sum = 0;
  private air = { sum: 0, n: 0 };
  private landed: number | null = null;
  /** The average pace of the last finished jump (the Bar look's number), kept until a reset. */
  lastJump: number | null = null;
  private barWindow: number[] = [];
  private barSum = 0;
  private barSide = 0;
  private groundTicks = 0;

  reset(): void {
    this.yaw = NaN;
    this.tick = -1;
    this.side = 0;
    this.clear();
    this.air = { sum: 0, n: 0 };
    this.landed = null;
    this.lastJump = null;
    this.clearBar();
    this.groundTicks = 0;
    this.reading = { cue: "ready", pace: null, side: 0 };
  }

  /** The average pace of the jump that just ended, once (null: none since, or nothing to judge). */
  takeLanding(): number | null {
    const v = this.landed;
    this.landed = null;
    return v;
  }

  private clear(): void {
    this.window.length = 0;
    this.sum = 0;
  }

  private clearBar(): void {
    this.barWindow.length = 0;
    this.barSum = 0;
    this.barSide = 0;
  }

  /** Adds a tick to the Bar's average and returns it: the window's empty part counts as 0. */
  private pushBar(raw: number): number {
    const n = Math.max(1, Math.round(this.smoothing));
    this.barWindow.push(raw);
    this.barSum += raw;
    while (this.barWindow.length > n) this.barSum -= this.barWindow.shift()!;
    return this.barSum / n;
  }

  feed(cmd: TickCmd, s: TrainerSample): void {
    const yaw = this.yaw;
    const continuous = this.tick + 1 === s.tick;
    this.feedPace(cmd, s);
    this.feedBar(cmd, s, yaw, continuous);
  }

  /** The original three looks' reading and jump statistics are deliberately unchanged. */
  private feedPace(cmd: TickCmd, s: TrainerSample): void {
    const previousYaw = this.yaw;
    const continuous = this.tick + 1 === s.tick;
    this.yaw = cmd.yaw;
    this.tick = s.tick;
    this.groundTicks = s.grounded ? this.groundTicks + 1 : 0;
    const idle = (cue: TrainerCue) => {
      this.clear();
      this.side = 0;
      this.reading = { cue, pace: null, side: 0 };
    };
    if (![s.speed, s.dt, s.maxSpeed, s.airAccelerate, cmd.yaw, cmd.side].every(Number.isFinite) || s.dt <= 0 || s.interrupted || !continuous || !Number.isFinite(previousYaw)) {
      this.air = { sum: 0, n: 0 };
      return idle("ready");
    }
    if (!["autohop", "legit", "scroll", "hsw"].includes(s.style)) {
      return idle("unsupported");
    }
    // A landing or the next takeoff closes the jump: its average pace (the per-jump sound), if strafed long enough.
    if (s.grounded || s.onLadder || s.jumped) {
      if (!s.onLadder && this.air.n >= 5) this.landed = this.lastJump = this.air.sum / this.air.n;
      this.air = { sum: 0, n: 0 };
    }
    if (s.grounded || s.onLadder) return idle("ready");
    if (s.speed < 100) return idle("ready");
    const side = Math.sign(cmd.side);
    if (!side) return idle("keys");
    const delta = ((cmd.yaw - previousYaw + 540) % 360 + 360) % 360 - 180;
    if (Math.abs(delta) > 0.001 && Math.sign(delta) === side) return idle("direction");
    // CSS air wishspeed is capped at 30 u/s; also respect lower per-tick acceleration.
    const push = Math.min(30, s.maxSpeed, s.airAccelerate * s.maxSpeed * s.dt);
    if (push <= 0) return idle("ready");
    const ideal = Math.atan2(push, s.speed) * 180 / Math.PI;
    const raw = Math.min(PACE_MAX, 100 * Math.abs(delta) / ideal);
    this.air.sum += raw;
    this.air.n++;
    // A strafe switch starts a fresh average: the old side's pace says nothing about this one.
    if (side !== this.side) this.clear();
    this.side = side;
    const n = Math.max(1, Math.round(this.smoothing));
    this.window.push(raw);
    this.sum += raw;
    while (this.window.length > n) this.sum -= this.window.shift()!;
    const pace = this.sum / this.window.length;
    const zone = trainerZone(pace, this.zone);
    this.reading = { cue: zone === "good" ? "good" : pace < 100 ? "slow" : "fast", pace, side };
  }

  private feedBar(cmd: TickCmd, s: TrainerSample, previousYaw: number, continuous: boolean): void {
    if (!Number.isFinite(s.speed) || !Number.isFinite(s.dt) || !Number.isFinite(s.maxSpeed)
      || !Number.isFinite(s.airAccelerate) || !Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.side) || !Number.isFinite(cmd.forward)
      || s.dt <= 0 || s.interrupted || !continuous || !Number.isFinite(previousYaw)
      || (s.style !== "autohop" && s.style !== "legit" && s.style !== "scroll" && s.style !== "hsw")) {
      this.clearBar();
      return;
    }
    // Colour always describes THIS tick, including a held W or a turn against the key. Never carry a red
    // through a landing or a trigger. Fill still smooths turn pace; gain cannot be recovered from that average.
    const speed = s.barSpeed ?? s.speed;
    const active = !s.grounded && !s.onLadder && speed >= 100 && !!(cmd.side || cmd.forward);
    this.reading.gain = active ? barGain(s.airSpeedGain, s.airBestGain) : null;
    const delta = ((cmd.yaw - previousYaw + 540) % 360 + 360) % 360 - 180;
    const side = Math.sign(cmd.side) || -Math.sign(delta) || this.barSide || 1;
    const push = Math.min(30, s.maxSpeed, s.airAccelerate * s.maxSpeed * s.dt);
    let bar: number;
    const against = !!cmd.side && Math.abs(delta) > 0.001 && Math.sign(delta) === Math.sign(cmd.side);
    if (active && !against && push > 0) {
      if (side !== this.barSide) this.clearBar();
      this.barSide = side;
      bar = this.pushBar(Math.min(PACE_MAX, 100 * Math.abs(delta) / (Math.atan2(push, speed) * 180 / Math.PI)));
    } else {
      // One grounded tick holds the geometry of a hop, but its colour is neutral immediately.
      bar = this.groundTicks === 1 ? this.barSum / Math.max(1, Math.round(this.smoothing)) : this.pushBar(0);
    }
    if (bar > 1e-6) {
      this.reading.bar = bar;
      this.reading.barSide = this.barSide;
    }
  }
}

export function trainerCommand(get: () => boolean, set: (on: boolean) => void): ChatCommand {
  return { name: "strafetrainer", aliases: ["st"], args: "[on|off]", help: "strafe trainer", group: "more", where: "both",
    about: "Toggle the turn-pace trainer. Aim for 100%. Settings → HUD has its look, presets and smoothing; Edit layout moves it. Works with Normal, EZ Scroll, Legit Scroll and Half-Sideways.",
    run: (ctx, arg) => {
      const value = arg.toLowerCase();
      if (value && value !== "on" && value !== "off") return void ctx.reply("Usage: !strafetrainer [on|off]");
      const on = value ? value === "on" : !get();
      set(on);
      ctx.reply(`Strafe trainer ${on ? "on" : "off"}. Settings → HUD to change how it looks.`);
    },
  };
}
