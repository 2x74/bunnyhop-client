// SSJ ("speed of sixth jump") jump stats, the bhop-server plugin players type !ssj for. Display only: computed from
// what the client already has every tick (the state before the tick, the command stepped, the tick's events), never
// fed back into the sim. DOM-free, so the formulas are tested under vitest (apps/api/test/ssj.test.ts).
//
// The numbers follow "SSJ: Advanced" (AlkATraZ, shavit's edit; the same code as neko-pm/ssj) line for line, so they
// match what players see on CS:S servers. Sources, definitions and the few things we can't reproduce: research/SSJ.md.
//
// Per tick, with the state from BEFORE the tick (the plugin reads it in OnPlayerRunCmd, before the movement runs):
//   on the ground: count ground ticks; more than BHOP_FRAMES (10) of them start the jump count over. The tick that
//     jumps (jump held on the first ground tick) is sampled like an air tick.
//   in the air (not on a ladder, not noclipping): sample.
//   sample: horizontal velocity v, wish direction d from the command's forward / side move and yaw:
//     gain tick = (30 - |v·d|) / 30 when v·d < 30 (Source air acceleration adds speed only then; 30 is its wish speed
//     cap), else 0; that tick is "in sync". Gain % = mean gain tick * 100, sync % = in-sync ticks / sampled ticks.
//     Efficiency = gain % * (straight-line distance / path length) of the sampled ticks.
//   a jump (the core's EVENT_JUMPED, CS:S's player_jump): jump number + 1, then the report for the mode, then the
//     counters start over for the next window (see onJump).

import { formatTime } from "../timer";

export type SsjMode = "sixth" | "every" | "everySixth";
export const SSJ_MODES: readonly SsjMode[] = ["sixth", "every", "everySixth"];

/** Fields a report can show, in the order they appear. */
export const SSJ_FIELDS = ["speed", "diff", "gain", "sync", "strafes", "eff", "height", "time"] as const;
export type SsjField = (typeof SSJ_FIELDS)[number];
export type SsjFields = Record<SsjField, boolean>;

export interface SsjPrefs {
  /** A chat line for each jump the mode picks (the plugin's "Enabled"). */
  chat: boolean;
  mode: SsjMode;
  fields: SsjFields;
}

/** Off until the player turns it on (!ssj or Settings → HUD → Jump stats); the plugins' common fields on. */
export const DEFAULT_SSJ: SsjPrefs = {
  chat: false,
  mode: "sixth",
  fields: { speed: true, diff: true, gain: true, sync: true, strafes: true, eff: false, height: false, time: false },
};

/** Ground ticks after which the jump count starts over (the plugins' BHOP_FRAMES). */
export const BHOP_FRAMES = 10;
/** Source's air acceleration caps the wish speed at 30 (CGameMovement::AirAccelerate). */
const AIR_WISH_CAP = 30;

// Source IN_* bits (input.ts).
const IN_JUMP = 1 << 1;
const IN_FORWARD = 1 << 3;
const IN_BACK = 1 << 4;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;
const STRAFE_KEYS = [IN_FORWARD, IN_MOVELEFT, IN_BACK, IN_MOVERIGHT];

/** Player state before a tick (core PlayerState fits). */
export interface SsjState {
  position: ArrayLike<number>;
  velocity: ArrayLike<number>;
  grounded: boolean;
  onLadder?: boolean;
}

/** The command stepped this tick (sim TickCmd fits). Yaw in degrees. */
export interface SsjCmd {
  forward: number;
  side: number;
  yaw: number;
  buttons: number;
}

export interface SsjTick {
  /** The tick jumped (EVENT_JUMPED). */
  jumped: boolean;
  /** Teleported this tick (EVENT_TELEPORTED): the count starts over after it. */
  teleported?: boolean;
  /** The player stood in a start zone before the tick: a jump from there starts the count over (neko-pm/ssj). */
  inStart?: boolean;
  /** Run time (s) if the timer is running, for the time field. */
  time?: number | null;
  /** Practice noclip: like the plugins' MOVETYPE_NOCLIP, nothing is sampled. */
  noclip?: boolean;
}

export interface SsjReport {
  /** Jump number in the chain (1 = the first jump after standing, or the last one taken off in a start zone). */
  jump: number;
  /** Horizontal speed at take-off, rounded down (u/s). */
  speed: number;
  /** Speed difference (rounded down speeds) to the window's start: jump 1 (6th) / jump 6k+1 (every 6th) / the previous jump (every). */
  diff: number | null;
  /** Height difference (rounded down z) to the same jump. */
  height: number | null;
  /** Gain %, rounded to 2 decimals like the plugin. */
  gain: number | null;
  /** Sync %. */
  sync: number | null;
  /** Efficiency %, rounded to 2 decimals. */
  eff: number | null;
  /** Strafe key presses in the air (W / A / S / D going down), over the same window. */
  strafes: number | null;
  /** Run time at the jump (s), null when the timer isn't running. */
  time: number | null;
}

/** Does `mode` report jump `n`? (6th: jump 6 only; every: all; every 6th: 6, 12, 18 ...) */
export function ssjShows(mode: SsjMode, n: number): boolean {
  return mode === "every" || (mode === "sixth" ? n === 6 : n > 0 && n % 6 === 0);
}

// SourcePawn floats are 32-bit and so is every step of the plugin's arithmetic: emulated with Math.fround, so the
// rounding at the second decimal lands where the server's does.
const f = Math.fround;
const TICK = f(0.01); // GetTickInterval() at 100 tick (the plugin's distances; only their ratio is used)
const EPS = f(1e-10);
const len2 = (x: number, y: number) => f(Math.sqrt(f(f(x * x) + f(y * y))));
/** SourcePawn RoundToFloor(x * 100.0 + 0.5) / 100.0. */
const round2 = (v: number) => f(Math.floor(f(f(v * 100) + 0.5)) / 100);

export class SsjTracker {
  /** Jump number of the current chain (0 = none yet). */
  jump = 0;
  /** The last tick went into the jump's stats (the JHUD's JSS covers the same ticks, jhud.ts). */
  sampled = false;
  private mode: SsjMode;
  private groundTicks = 0;
  private strafeTicks = 0;
  private syncedTicks = 0;
  private rawGain = 0;
  /** Path length and straight-line displacement of the sampled ticks. */
  private trajectory = 0;
  private dx = 0;
  private dy = 0;
  private strafes = 0;
  private prevButtons = 0;
  private initialSpeed = 0;
  private initialHeight = 0;
  private oldSpeed = 0;
  private oldHeight = 0;

  constructor(mode: SsjMode = DEFAULT_SSJ.mode) {
    this.mode = mode;
  }

  get currentMode(): SsjMode {
    return this.mode;
  }

  /** Switching modes starts the count over (each mode keeps its windows differently). */
  setMode(mode: SsjMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset();
  }

  /** Restart, teleport, a new replay: forget everything. */
  reset(): void {
    this.clearChain();
    this.groundTicks = 0;
    this.prevButtons = 0;
    this.initialSpeed = this.initialHeight = this.oldSpeed = this.oldHeight = 0;
  }

  /** The plugins' "on the ground too long" reset (also a jump from a start zone). */
  private clearChain(): void {
    this.jump = 0;
    this.clearWindow();
  }

  private clearWindow(): void {
    this.strafeTicks = this.syncedTicks = 0;
    this.rawGain = this.trajectory = this.dx = this.dy = 0;
    this.strafes = 0;
  }

  /** One tick: `pre` is the state before it, `cmd` the command stepped. Returns the report if the mode shows this jump. */
  tick(pre: SsjState, cmd: SsjCmd, t: SsjTick): SsjReport | null {
    this.sampled = false;
    if (t.noclip) {
      this.groundTicks = 0;
      this.prevButtons = cmd.buttons;
      return null;
    }
    if (!pre.grounded) for (const k of STRAFE_KEYS) if (cmd.buttons & k && !(this.prevButtons & k)) this.strafes++;
    this.prevButtons = cmd.buttons;
    if (pre.grounded) {
      if (this.groundTicks++ > BHOP_FRAMES) this.clearChain();
      if (cmd.buttons & IN_JUMP && this.groundTicks === 1) {
        if (t.inStart) this.clearChain();
        this.sample(pre, cmd);
        this.groundTicks = 0;
      }
    } else {
      if (!pre.onLadder) this.sample(pre, cmd);
      this.groundTicks = 0;
    }
    const report = t.jumped ? this.onJump(pre, t.time ?? null) : null;
    if (t.teleported) this.reset();
    return report;
  }

  private sample(pre: SsjState, cmd: SsjCmd): void {
    this.sampled = true;
    this.strafeTicks++;
    const vx = pre.velocity[0];
    const vy = pre.velocity[1];
    this.dx = f(this.dx + f(vx * TICK));
    this.dy = f(this.dy + f(vy * TICK));
    this.trajectory = f(this.trajectory + f(len2(vx, vy) * TICK));
    // GetAngleVectors(angles, fore, side) flattened: forward (cos y, sin y), right (sin y, -cos y).
    const y = f((cmd.yaw * Math.PI) / 180);
    const c = f(Math.cos(y));
    const s = f(Math.sin(y));
    const wx = f(f(c * cmd.forward) + f(s * cmd.side));
    const wy = f(f(s * cmd.forward) - f(c * cmd.side));
    // NormalizeVector is Source mathlib's VectorNormalize: |w| = sqrt(w·w + 1e-10). So with no movement keys the wish
    // speed is 1e-5, not 0: the plugin counts a keyless air tick as in sync with full gain (seen on a CS:S server,
    // tools/parity/ssj-check.ts). (It also caps at m_flMaxspeed, 250+ in CS:S, which never comes below 30.)
    const sq = f(f(f(wx * wx) + f(wy * wy)) + EPS);
    const inv = f(1 / Math.sqrt(sq));
    const wishspeed = f(sq * inv);
    const wishspd = Math.min(wishspeed, AIR_WISH_CAP);
    const current = f(f(vx * f(wx * inv)) + f(vy * f(wy * inv)));
    if (current < AIR_WISH_CAP) {
      this.syncedTicks++;
      this.rawGain = f(this.rawGain + f(f(wishspd - Math.abs(current)) / wishspd));
    }
  }

  private onJump(pre: SsjState, time: number | null): SsjReport | null {
    // A second jump event with no air tick since the last one is ignored (the plugin's double-fire guard).
    if (this.jump > 0 && this.strafeTicks <= 0) return null;
    const n = ++this.jump;
    const mode = this.mode;
    const speed = len2(pre.velocity[0], pre.velocity[1]);
    const z = pre.position[2];
    const report = ssjShows(mode, n) ? this.report(speed, z, time) : null;
    // What the next report covers: every jump in "every", from jump 6 on in "6th" (only 6 is shown), from each 6th
    // jump in "every 6th". Speed / height differences are to jump 1 (6th) or jump 6k + 1 (every 6th).
    if ((mode === "sixth" && n >= 6) || mode === "every" || (mode === "everySixth" && n % 6 === 0)) {
      this.clearWindow();
      this.oldSpeed = speed;
      this.oldHeight = z;
    }
    if ((mode === "sixth" && n === 1) || (mode === "everySixth" && n % 6 === 1)) {
      this.initialSpeed = speed;
      this.initialHeight = z;
      this.dx = this.dy = 0;
    }
    return report;
  }

  private report(speed: number, z: number, time: number | null): SsjReport {
    const n = this.jump;
    // "Every jump" shows only the speed on jump 1 (there's no previous jump to compare with).
    const full = this.mode !== "every" || n > 1;
    const refSpeed = this.mode === "every" ? this.oldSpeed : this.initialSpeed;
    const refZ = this.mode === "every" ? this.oldHeight : this.initialHeight;
    const ticks = this.strafeTicks;
    const coeff = ticks > 0 ? f(f(this.rawGain / ticks) * 100) : 0;
    const dist = Math.min(len2(this.dx, this.dy), this.trajectory);
    const eff = dist > 0 && this.trajectory > 0 ? f(f(coeff * dist) / this.trajectory) : 0;
    return {
      jump: n,
      speed: Math.floor(speed),
      diff: full ? Math.floor(speed) - Math.floor(refSpeed) : null,
      height: full ? Math.floor(z) - Math.floor(refZ) : null,
      gain: full && ticks > 0 ? round2(coeff) : null,
      sync: full && ticks > 0 ? f(f(100 * this.syncedTicks) / ticks) : null,
      eff: full && ticks > 0 ? round2(eff) : null,
      strafes: full ? this.strafes : null,
      time,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Text

/** A number in a report line; `good` marks a gain worth the one accent colour. */
export interface SsjNum {
  n: string;
  good?: boolean;
}
/** One item of a report ("Gain 87.5%"): text and numbers. */
export type SsjItem = (string | SsjNum)[];

/** Gain this high gets the accent (bhop-get-stats colours 80-90 "good", 90+ "really good"). */
export const GOOD_GAIN = 80;

/** Shown precision is truncated, never rounded up (bhop-get-stats without decimals): 99.96% sync isn't "100%". */
const trunc1 = (v: number) => (Math.trunc(v * 10) / 10).toFixed(1);
const signed = (v: number) => (v > 0 ? `+${v}` : String(v));

/**
 * The report as items, in field order: "Jump 6", "1013 u/s (+87)", "Gain 87.5%", "Sync 92%", "5 strafes", "Eff 78%",
 * "Height +8", "Time 00:12.340". Fields without a value (jump 1 in "every jump") are left out.
 */
export function ssjItems(r: SsjReport, f: SsjFields): SsjItem[] {
  const out: SsjItem[] = [["Jump ", { n: String(r.jump) }]];
  if (f.speed) out.push([{ n: String(r.speed) }, " u/s", ...(f.diff && r.diff !== null ? [" (", { n: signed(r.diff) }, ")"] : [])]);
  else if (f.diff && r.diff !== null) out.push([{ n: signed(r.diff) }, " u/s"]);
  if (f.gain && r.gain !== null) out.push(["Gain ", { n: `${trunc1(r.gain)}%`, good: r.gain >= GOOD_GAIN }]);
  if (f.sync && r.sync !== null) out.push(["Sync ", { n: `${Math.trunc(r.sync)}%` }]);
  if (f.strafes && r.strafes !== null) out.push([{ n: String(r.strafes) }, r.strafes === 1 ? " strafe" : " strafes"]);
  if (f.eff && r.eff !== null) out.push(["Eff ", { n: `${Math.trunc(r.eff)}%` }]);
  if (f.height && r.height !== null) out.push(["Height ", { n: signed(r.height) }]);
  if (f.time && r.time !== null) out.push(["Time ", { n: formatTime(r.time) }]);
  return out;
}

export const SSJ_SEP = " · ";

/** Plain text of a report: "Jump 6 · 1013 u/s (+87) · Gain 87.5% · Sync 92% · 5 strafes". */
export function ssjText(r: SsjReport, f: SsjFields): string {
  return ssjItems(r, f)
    .map((it) => it.map((t) => (typeof t === "string" ? t : t.n)).join(""))
    .join(SSJ_SEP);
}

/** Independent of SSJ's reporting mode: the grounded speed BEFORE the first start-zone takeoff.
 * Returning undefined leaves the HUD alone; null clears it. Never samples the capped post-jump velocity. */
export class StartPreTracker {
  private wasInStart = false;
  private captured = false;

  reset(): void {
    this.wasInStart = false;
    this.captured = false;
  }

  tick(pre: SsjState, t: SsjTick): number | null | undefined {
    if (t.teleported || t.noclip) {
      this.reset();
      return null;
    }
    const entered = !!t.inStart && !this.wasInStart;
    this.wasInStart = !!t.inStart;
    if (entered) this.captured = false;
    if (t.inStart && pre.grounded && t.jumped && !this.captured) {
      this.captured = true;
      return Math.floor(Math.hypot(pre.velocity[0], pre.velocity[1]));
    }
    return entered ? null : undefined;
  }
}
