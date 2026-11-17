// The watched player's HUD feed in a room (0.0.42; protocol.ts input block, EXT_INPUT). The player's client records
// what its own HUD is fed every tick (keys, moves, view, velocity, the strafe trainer's gain band) and the jump stats its
// trackers report, and sends them with its state batches while someone spectates it. The spectators' clients play them
// into their own HUD at the tick the camera shows, so the keys, strafe trainer, jump stats and JHUD read the same as on
// the player's screen, in the spectator's own HUD settings. DOM-free for the tests.

import { EVENT_JUMPED, EVENT_TELEPORTED, type PlayerState, type Settings } from "../core";
import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT } from "../input";
import { barBand, barGain, type TrainerSample } from "../hud/strafe-trainer";
import type { SsjMode, SsjReport } from "../ssj/stats";
import type { JhudReport } from "../ssj/jhud";
import { EVENT_RESPAWNED, type TickCmd } from "../timer";
import {
  IG_GOOD,
  IG_LOSS,
  IG_NONE,
  IG_OK,
  IG_PERFECT,
  IG_ZERO,
  IK_BACK,
  IK_DUCK,
  IK_FORWARD,
  IK_JUMP,
  IK_LEFT,
  IK_RIGHT,
  IR_SSJ_EVERY,
  IR_SSJ_SIXTH,
  IR_START_PRE,
  IS_GROUNDED,
  IS_INTERRUPTED,
  IS_JUMPED,
  IS_LADDER,
  IS_RESET,
  MAX_INPUT_REPORTS,
  MAX_INPUT_TICKS,
  type NetInput,
  type NetInputReport,
  type NetInputTick,
  type NetSsjReport,
} from "./protocol";

const KEY_BITS: [number, number][] = [
  [IN_FORWARD, IK_FORWARD],
  [IN_BACK, IK_BACK],
  [IN_MOVELEFT, IK_LEFT],
  [IN_MOVERIGHT, IK_RIGHT],
  [IN_JUMP, IK_JUMP],
  [IN_DUCK, IK_DUCK],
];
export const keysOf = (buttons: number): number => KEY_BITS.reduce((k, [b, i]) => (buttons & b ? k | i : k), 0);
export const buttonsOf = (keys: number): number => KEY_BITS.reduce((b, [i, k]) => (keys & k ? b | i : b), 0);

/** The trainer's gain band of a tick (IG_*), from the core's observation (hud/strafe-trainer.ts barGain / barBand). */
export function gainBandOf(airSpeedGain: number | undefined, airBestGain: number | undefined): number {
  const g = barGain(airSpeedGain, airBestGain);
  if (g === null) return IG_NONE;
  const band = barBand(g);
  return g === 0 ? IG_ZERO : band === "high" ? IG_LOSS : band === "perfect" ? IG_PERFECT : band === "good" ? IG_GOOD : band === "ok" ? IG_OK : IG_ZERO;
}

/** A gain in band `code` (for the trainer, which only shows the band): NaN = none. */
export function bandGain(code: number): number {
  return code === IG_ZERO ? 0 : code === IG_LOSS ? -1 : code === IG_OK ? 0.5 : code === IG_GOOD ? 0.95 : code === IG_PERFECT ? 1 : NaN;
}

/** The trainer's settings of the batch (what the HUD's tick got with the command). */
export type InputSettings = Pick<NetInput, "tickInterval" | "maxSpeed" | "airAccelerate">;

/** A record as the HUD's tick reads it (hud.ts Hud.tick: the command, and the trainer's sample of the state). */
export function watchedSample(t: NetInputTick, s: InputSettings): { cmd: TickCmd; sample: TrainerSample } {
  return {
    cmd: { forward: t.forward, side: t.side, yaw: t.yaw, pitch: 0, buttons: buttonsOf(t.keys) },
    sample: {
      airSpeedGain: bandGain(t.gain), airBestGain: 1,
      speed: Math.sqrt(t.vx * t.vx + t.vy * t.vy), velYaw: Math.atan2(t.vy, t.vx) * 180 / Math.PI,
      grounded: !!(t.state & IS_GROUNDED), onLadder: !!(t.state & IS_LADDER), tick: t.tick,
      dt: s.tickInterval, maxSpeed: s.maxSpeed, airAccelerate: s.airAccelerate,
      interrupted: !!(t.state & IS_INTERRUPTED), jumped: !!(t.state & IS_JUMPED),
      ...(t.turnYaw !== undefined ? { turnYaw: t.turnYaw } : {}),
    },
  };
}

/**
 * Sender side: what the HUD is fed each tick (hud.ts tap) becomes a record at the tick's net tick (commit, from
 * net/mp.ts afterTick), and the jump stats reports (ssj/index.ts LiveSsj relay) go with the tick they came on. take()
 * hands out the block for the next state batch. Records are kept only while net/mp.ts commits (someone watches).
 */
export class InputRecorder {
  /** Someone watches and the room takes input blocks (net/mp.ts): only then is anything kept. */
  on = false;
  private ticks: NetInputTick[] = [];
  private reports: NetInputReport[] = [];
  private settings: InputSettings | null = null;
  /** The HUD's tick waiting for its net tick, and the reports that came with it. */
  private fed: Omit<NetInputTick, "tick"> | null = null;
  private fedSettings: InputSettings | null = null;
  private waiting: NetInputReport[] = [];
  private resetNext = false;

  /** The HUD's per-tick feed (hud.ts Hud.tick). */
  hudTick(cmd: TickCmd, state: PlayerState, events: number, o: { settings: Settings; noclip?: boolean; turnYaw?: number }): void {
    if (!this.on) return;
    const interrupted = !!o.noclip || !!(events & (EVENT_TELEPORTED | EVENT_RESPAWNED));
    this.fed = {
      keys: keysOf(cmd.buttons),
      forward: cmd.forward,
      side: cmd.side,
      gain: gainBandOf(state.airSpeedGain, state.airBestGain),
      state: (state.grounded ? IS_GROUNDED : 0) | (state.onLadder ? IS_LADDER : 0) | (events & EVENT_JUMPED ? IS_JUMPED : 0) | (interrupted ? IS_INTERRUPTED : 0) | (this.resetNext ? IS_RESET : 0),
      yaw: cmd.yaw,
      vx: state.velocity[0],
      vy: state.velocity[1],
      ...(o.turnYaw !== undefined ? { turnYaw: o.turnYaw } : {}),
    };
    this.fedSettings = { tickInterval: o.settings.tickInterval, maxSpeed: o.settings.maxSpeed, airAccelerate: o.settings.airAccelerate };
    this.resetNext = false;
  }

  /** The HUD's per-tick history started over (a restart): the next record says so. */
  hudReset(): void {
    this.resetNext = true;
  }

  /** A jump stats report of the coming tick (LiveSsj runs before the HUD's tick). */
  report(r: { kind: typeof IR_SSJ_EVERY | typeof IR_SSJ_SIXTH; ssj: NetSsjReport } | { kind: typeof IR_START_PRE; speed: number | null }): void {
    if (!this.on) return;
    this.waiting.push({ ...r, tick: 0 } as NetInputReport);
    if (this.waiting.length > MAX_INPUT_REPORTS) this.waiting.shift();
  }

  /** The tick at net tick `tick` is done: its record (none if the HUD wasn't fed: a tick that restarted). */
  commit(tick: number): void {
    const fed = this.fed;
    const s = this.fedSettings;
    this.fed = null;
    if (fed && s) {
      // A block has one set of trainer settings: a restart into another style starts a new one.
      if (this.settings && (s.tickInterval !== this.settings.tickInterval || s.maxSpeed !== this.settings.maxSpeed || s.airAccelerate !== this.settings.airAccelerate)) this.ticks = [];
      this.settings = s;
      const last = this.ticks[this.ticks.length - 1];
      if (last && last.tick + 1 !== tick) this.ticks = [];
      this.ticks.push({ tick, ...fed });
      if (this.ticks.length > MAX_INPUT_TICKS) this.ticks.shift();
    }
    for (const r of this.waiting) this.reports.push({ ...r, tick });
    this.waiting = [];
    if (this.reports.length > MAX_INPUT_REPORTS) this.reports.splice(0, this.reports.length - MAX_INPUT_REPORTS);
  }

  /** The block for the next batch (reports on ticks before its first record move to that one), or null. */
  take(): NetInput | null {
    const ticks = this.ticks;
    const s = this.settings;
    this.ticks = [];
    if (!ticks.length || !s) return null;
    const first = ticks[0].tick;
    const reports = this.reports.map((r) => (r.tick < first ? { ...r, tick: first } : r));
    this.reports = [];
    return { ...s, ticks, reports };
  }

  /** Nobody watches: keep nothing (the reset mark stays for the next record). */
  clear(): void {
    this.ticks = [];
    this.reports = [];
    this.waiting = [];
    this.fed = null;
  }
}

/** The jump stats report your Jumps setting shows, from a watched player's reports (6th jump: jump 6 of every 6th). */
export function shownSsj(r: NetInputReport, mode: SsjMode): SsjReport | null {
  if (r.kind === IR_START_PRE) return null;
  const ok = mode === "every" ? r.kind === IR_SSJ_EVERY : r.kind === IR_SSJ_SIXTH && (mode === "everySixth" || r.ssj.jump === 6);
  if (!ok) return null;
  const { jss: _jss, ...ssj } = r.ssj;
  return ssj;
}

/** The JHUD's report of a jump (every-jump reports carry it). */
export function jhudOf(r: NetInputReport): JhudReport | null {
  return r.kind === IR_SSJ_EVERY ? { jump: r.ssj.jump, speed: r.ssj.speed, gain: r.ssj.gain, sync: r.ssj.sync, jss: r.ssj.jss } : null;
}

/** How long after the last block the watched player's feed counts as live (the HUD shows their keys meanwhile). */
export const FEED_LIVE_MS = 1000;

/**
 * Spectator side: the watched player's blocks, played out by net tick. take(upTo) hands out the records and reports at
 * or before the tick the camera shows (net/interp.ts renderTick), in order.
 */
export class InputFeed {
  private ticks: { t: NetInputTick; s: InputSettings }[] = [];
  private reports: NetInputReport[] = [];
  private last = -1;
  private at = -Infinity;

  push(input: NetInput, now: number): void {
    const s: InputSettings = { tickInterval: input.tickInterval, maxSpeed: input.maxSpeed, airAccelerate: input.airAccelerate };
    for (const t of input.ticks) if (t.tick > this.last && (!this.ticks.length || t.tick > this.ticks[this.ticks.length - 1].t.tick)) this.ticks.push({ t, s });
    this.reports.push(...input.reports);
    // A sender that stopped (menus) or a stuck clock: never hold more than a few seconds.
    if (this.ticks.length > 400) this.ticks.splice(0, this.ticks.length - 400);
    if (this.reports.length > 64) this.reports.splice(0, this.reports.length - 64);
    this.at = now;
  }

  /** Records and reports up to tick `upTo` (reports after their tick's record). */
  take(upTo: number, tick: (t: NetInputTick, s: InputSettings) => void, report: (r: NetInputReport) => void): void {
    let i = 0;
    for (; i < this.ticks.length && this.ticks[i].t.tick <= upTo; i++) {
      const { t, s } = this.ticks[i];
      tick(t, s);
      this.last = t.tick;
      for (let k = 0; k < this.reports.length; k++)
        if (this.reports[k].tick <= t.tick) report(this.reports.splice(k--, 1)[0]);
    }
    this.ticks.splice(0, i);
  }

  live(now: number): boolean {
    return now - this.at < FEED_LIVE_MS;
  }

  reset(): void {
    this.ticks = [];
    this.reports = [];
    this.last = -1;
    this.at = -Infinity;
  }
}

