// Display-only turn pace, inspired by https://github.com/2x74/strafetrainer.
// Independent implementation: yaw change relative to atan(air push / speed), not gain or run sync.
import type { TickCmd } from "../timer";
import type { ChatCommand } from "../chat-commands";

export type TrainerCue = "ready" | "keys" | "direction" | "slow" | "good" | "fast" | "unsupported";
/** `side`: the strafe key held, -1 left, 1 right, 0 none (the follow-the-turn gauge mirrors on it). */
export interface TrainerReading { cue: TrainerCue; pace: number | null; side: number }
export interface TrainerSample {
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

  reset(): void {
    this.yaw = NaN;
    this.tick = -1;
    this.side = 0;
    this.clear();
    this.air = { sum: 0, n: 0 };
    this.landed = null;
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

  feed(cmd: TickCmd, s: TrainerSample): void {
    const previousYaw = this.yaw;
    const continuous = this.tick + 1 === s.tick;
    this.yaw = cmd.yaw;
    this.tick = s.tick;
    const idle = (cue: TrainerCue) => {
      this.clear();
      this.side = 0;
      this.reading = { cue, pace: null, side: 0 };
    };
    if (![s.speed, s.dt, s.maxSpeed, s.airAccelerate, cmd.yaw, cmd.side].every(Number.isFinite) || s.dt <= 0 || s.interrupted || !continuous || !Number.isFinite(previousYaw)) {
      this.air = { sum: 0, n: 0 };
      return idle("ready");
    }
    if (!["autohop", "legit", "scroll", "hsw"].includes(s.style)) return idle("unsupported");
    // A landing or the next takeoff closes the jump: its average pace (the per-jump sound), if strafed long enough.
    if (s.grounded || s.onLadder || s.jumped) {
      if (!s.onLadder && this.air.n >= 5) this.landed = this.air.sum / this.air.n;
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
