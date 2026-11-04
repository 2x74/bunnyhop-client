// Run styles (classic CS:S bhop timer styles). DOM-free and deterministic: the browser session, replay playback,
// ghosts, the headless verifier and the API all use this exact code, so a style's input rules are applied
// identically everywhere.
//
// Semantics follow shavit's bhoptimer (addons/sourcemod/configs/shavit-styles.cfg + OnPlayerRunCmd key blocking
// in shavit-core.sp):
//   - Legit Scroll (scroll) uses 250 run speed, 100 AA and CS:S stamina. Other styles use
//     the original settings. Legacy EZ Scroll keeps the internal key `legit`.
//   - Original physics: every style uses the same canonical settings (100 tick, sv_airaccelerate 1000, no stamina) except
//     for autohop. "Normal", W-Only, Sideways and HSW are autohop ("autobhop" "1" in the default cfg); EZ Scroll
//     has no autohop: jump must be re-pressed for every hop (the sim's normal jump latch, i.e. scroll binds).
//   - Key blocking (block_w/a/s/d, force_hsw) only applies in the air: bhoptimer skips it while the player has a
//     ground entity (force_groundkeys "0", the default), so W+A/W+D prestrafe on the ground is allowed. Ladders are
//     exempt too (bhoptimer skips MOVETYPE_LADDER), and so is the air after leaving a ladder until the next landing
//     (bhoptimer's ladder handling): see StyleFilter.
//   - A blocked key zeroes its movement axis and clears its button bit, exactly like bhoptimer zeroes vel[0]/vel[1]
//     and the IN_* bit. Decisions are made on the movement values (what the sim consumes; the sim ignores the
//     IN_FORWARD/BACK/MOVELEFT/MOVERIGHT bits), so a forged command can't slip a value past the filter.
//
// The filter runs on the command fed to core.step (session.command() before every tick, and simulate() during
// re-simulation). The client records the filtered command, so a legitimate replay is a fixed point of the filter:
// the verifier rejects any replay containing a command the filter would change (e.g. an A press on W-Only).
//
// The assisted style, Auto-strafe (bhoptimer shavit-tas "basic" autostrafe; autostrafe.ts), uses the same mechanism
// with a transform instead of a block: in the air the filter COMPUTES the strafe from the recorded view yaws, so the
// recorded command already holds the result and re-simulation reproduces it exactly. The rule per command, from the
// pre-tick state, when in the air (or on the first ground tick, the bhop jump tick) and not on / coming off a ladder:
// forwardmove 0 (W/S do nothing in the air); sidemove = -450 when the view yaw turned left since the previous command,
// +450 when it turned right; with no yaw change the player's own A/D, else the last direction for up to AUTO_HOLD_TICKS
// still ticks (frame gaps), else 0. IN_FORWARD/BACK/MOVELEFT/MOVERIGHT are rewritten to match (keys overlay). On the
// ground every key works as in Normal (prestrafe). Later physics versions change the air rule (StyleFilter.assist):
//   - v5+ (AUTOSTRAFE_S_STOPS_FROM): a command with forwardmove < 0 (S held) passes through unchanged.
//   - v8+ (AUTOSTRAFE_KEYS_FROM): a command with sidemove != 0 (A or D held) passes through unchanged too (full manual
//     strafing, for surf ramps), and forwardmove > 0 (W held) is kept: W moves you forward while the computed sidemove
//     carries on, so a still mouse past the hold ticks is pure forward. W never pauses the assist (beginners hold it).
//     As with the key blocks, the decisions read the movement values, never the IN_* bits, and the assisted command's
//     bits are rebuilt from its values (IN_FORWARD iff forwardmove > 0), so a forged command can't slip a value past.
//     A pass-through command (S, A or D held) is free like any Normal-style command (input-analysis flags values the
//     keyboard can't produce).
// The verifier enforces the rule exactly (a command that differs from the computed one is a style violation); what it
// cannot know, as for every style, is whether the view yaws came from a hand on a mouse.

import { DEFAULT_SETTINGS, PHYSICS_V1, type Settings } from "./core";

/** First physics version whose Auto-strafe lets S stop the assist in the air (StyleFilter). */
export const AUTOSTRAFE_S_STOPS_FROM = 5;
/** First physics version whose Auto-strafe lets A/D take over and W move forward in the air (StyleFilter). */
export const AUTOSTRAFE_KEYS_FROM = 8;
import type { TickCmd } from "./timer";
import { AUTO_HOLD_TICKS, AUTO_MOVE, strafeDir, yawDelta } from "./autostrafe";
import { TURN_HOLD_BITS, turnBindsAllowed } from "./turn-binds";

// Source IN_* button bits (same values as input.ts; duplicated to keep this module DOM-free).
const IN_JUMP = 1 << 1;
const IN_FORWARD = 1 << 3;
const IN_BACK = 1 << 4;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;

export type StyleId = "autohop" | "legit" | "wonly" | "sideways" | "hsw" | "autostrafe" | "scroll" | "lowgrav" | "segmented" | "infinite" | "backwards";

export interface StyleDef {
  /** Stable key: replay header, PB/ghost storage, leaderboard boards, API routes. */
  id: StyleId;
  name: string;
  /** Short tag (bhoptimer "shortname"). */
  short: string;
  /** Compact name for tight UI (picker buttons). */
  brief: string;
  autohop: boolean;
  /** Keys blocked in the air (bhoptimer block_w / block_a / block_s / block_d). */
  block: { w: boolean; a: boolean; s: boolean; d: boolean };
  /** Half-sideways: W must be held together with exactly one of A/D (bhoptimer force_hsw 1). */
  hsw: boolean;
  /**
   * Backwards (Influx influx_style_backwards, shavit-style-backwards): in the air, the movement keys only work while the
   * view faces within 36.87° of straight back against the velocity (StyleFilter.backwards, facesBackwards).
   */
  backwards?: boolean;
  /** One-line rule for menus. */
  rule: string;
  /** Assisted style: the strafe is computed in the air from the mouse (Auto-strafe; autostrafe.ts). */
  auto?: boolean;
  /**
   * Segmented (bhoptimer "segments" "1"): checkpoint loads during a timed run rewind the timer and the replay instead of
   * making the attempt practice (practice-mode/segments.ts, research/SEGMENTED.md). Normal movement otherwise.
   */
  segmented?: boolean;
  /**
   * Infinite (2x74/infinite): every fresh jump press in the air rises again at 290 u/s and keeps the horizontal speed
   * (core Settings airJump, crates/core game.rs AIR_JUMP_SPEED). No prespeed cap, starts from the air at any speed, the
   * start re-entry guard (styleStartReentryCap) and a faster noclip (practice-mode/noclip.ts noclipSpeed).
   */
  airJump?: boolean;
  /** Own boards and ranking; no XP, clear achievements or progression (earnsProgression). Overall points: ranking.ts STYLE_WEIGHT. */
  separate?: boolean;
}

const NONE = { w: false, a: false, s: false, d: false };

export const STYLE_DEFS: readonly StyleDef[] = [
  { id: "autohop", name: "Normal", short: "NM", brief: "Normal", autohop: true, block: NONE, hsw: false, rule: "Autohop: hold jump. Every key works." },
  { id: "legit", name: "EZ Scroll", short: "EZ", brief: "EZ Scroll", autohop: false, block: NONE, hsw: false, rule: "No autohop: press (scroll) jump for every hop." },
  { id: "scroll", name: "Legit Scroll", short: "SCR", brief: "Legit Scroll", autohop: false, block: NONE, hsw: false, rule: "Scroll each hop. 250 run speed, 100 air acceleration and CS:S stamina. No +left / +right." },
  { id: "wonly", name: "W-Only", short: "W", brief: "W-Only", autohop: true, block: { w: false, a: true, s: true, d: true }, hsw: false, rule: "Only W in the air. A, S and D are blocked." },
  { id: "sideways", name: "Sideways", short: "SW", brief: "Sideways", autohop: true, block: { w: false, a: true, s: false, d: true }, hsw: false, rule: "Only W and S in the air: face sideways and strafe with W/S." },
  { id: "hsw", name: "Half-Sideways", short: "HSW", brief: "Half-SW", autohop: true, block: { w: false, a: false, s: true, d: false }, hsw: true, rule: "Hold W plus A or D together in the air. S, pure W and pure A/D do nothing." },
  { id: "backwards", name: "Backwards", short: "BW", brief: "Backwards", autohop: true, block: NONE, hsw: false, backwards: true, rule: "Face back the way you came. In the air your keys only work while you look away from where you're going." },
  { id: "lowgrav", name: "Low Gravity", short: "LG", brief: "Low Gravity", autohop: true, block: NONE, hsw: false, separate: true, rule: "Half gravity (400). Hold jump; every key works. Separate ranking; no overall points or progression." },
  { id: "segmented", name: "Segmented", short: "SEG", brief: "Segmented", autohop: true, block: NONE, hsw: false, segmented: true, separate: true, rule: "Save checkpoints and load them mid-run: the timer and the replay go back to the checkpoint. Normal movement. Separate ranking; no overall points or progression." },
  { id: "infinite", name: "Infinite", short: "INF", brief: "Infinite", autohop: true, block: NONE, hsw: false, airJump: true, separate: true, rule: "Autohop on the ground. In the air every jump press rises again and keeps your speed, as many times as you like. Own ranking; counts a fifth towards the overall rank. No XP or progression." },
  // Assisted styles stay last in the menu. WIRE_STYLES is independently append-only.
  { id: "autostrafe", name: "Auto-strafe", short: "AS", brief: "Auto-strafe", autohop: true, block: NONE, hsw: false, auto: true, rule: "Move the mouse in the air and the game presses A/D for you. Hold A, D or S to take over." },
];

/**
 * Legit Scroll uses shavit_misc_prespeed 2 (block prehops, no speed cap). EZ Scroll keeps its legacy cap. Infinite has
 * no cap either: arriving at the start fast is the style (native-bridge styles.rs has_prespeed_cap).
 */
export function stylePrespeedCap(id: string): number | null { return id === "scroll" || BY_ID.get(id)?.airJump ? null : 290; }

/**
 * Infinite's start re-entry guard (shavit Shavit_OnEnterZone, timer.ts TimerOptions.startReentryCap): a run that enters
 * the start zone faster than this (horizontal u/s) loses its velocity, so the start can't be looped to farm speed. 3510
 * sits just above Infinite's 3500 noclip top speed. null = off, every other style (native-bridge styles.rs
 * start_reentry_cap).
 */
export const INFINITE_START_REENTRY_CAP = 3510;
export function styleStartReentryCap(id: string): number | null { return BY_ID.get(id)?.airJump ? INFINITE_START_REENTRY_CAP : null; }

export const DEFAULT_STYLE: StyleId = "autohop";
/** Bonus tracks are always run (and ranked) in Normal style, whatever style is selected for the main track. */
export const BONUS_STYLE: StyleId = "autohop";

/** The style a run on `track` uses when `selected` is the player's chosen (main-track) style. */
export function styleForTrack(selected: StyleId, track: number): StyleId {
  return track > 0 ? BONUS_STYLE : selected;
}

const BY_ID = new Map<string, StyleDef>(STYLE_DEFS.map((s) => [s.id, s]));

export function isStyleId(id: unknown): id is StyleId {
  return typeof id === "string" && BY_ID.has(id);
}

/** Style definition by id, or null for unknown ids. */
export function styleDef(id: string): StyleDef | null {
  return BY_ID.get(id) ?? null;
}

/** Display name ("W-Only"); unknown ids are shown as-is. */
export function styleLabel(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

/** Canonical physics settings of a style (ranked runs must use exactly these). */
export function styleSettings(id: StyleId): Settings {
  return { ...DEFAULT_SETTINGS, autohop: BY_ID.get(id)?.autohop ?? true, ...(id === "lowgrav" ? { gravity: 400 } : {}), ...(id === "scroll" ? { maxSpeed: 250, airAccelerate: 100, stamina: true } : {}), ...(BY_ID.get(id)?.airJump ? { airJump: true } : {}) };
}

/** Next style in menu order (F3 quick switch). */
export function nextStyle(id: string, dir = 1): StyleId {
  const i = STYLE_DEFS.findIndex((s) => s.id === id);
  const n = STYLE_DEFS.length;
  return STYLE_DEFS[(((i < 0 ? 0 : i + dir) % n) + n) % n].id;
}

/** True if the style restricts movement keys (has an input filter). */
export function restrictsKeys(d: StyleDef): boolean {
  return d.hsw || d.block.w || d.block.a || d.block.s || d.block.d;
}

/** Player state the filter depends on: the state BEFORE the tick (bhoptimer reads m_hGroundEntity in OnPlayerRunCmd). */
export interface StyleContext {
  grounded: boolean;
  onLadder?: boolean;
  /** Physics v22: the landing can still be taken back (PlayerState.edgeLanding). */
  edgeLanding?: boolean;
  /** Pre-tick velocity (Backwards reads x and y; PlayerState has it). */
  velocity?: ArrayLike<number>;
}

// ---------------------------------------------------------------------------------------------
// Backwards (Influx MAX_DOT -0.8). The decision must be bit-identical in the browser, the verifier (V8) and the native
// client's Rust filter (native-bridge styles.rs bw_dir / faces_backwards) on every OS, so it uses only f64 + - * % and
// comparisons: no Math.cos / sin / sqrt / atan2 (their last bits differ between engines and libms), no fused multiply-add,
// no f32 arithmetic. The yaw arrives as an f32 value (quantize) and the velocity as f32 values (core state), both exact
// in f64. The evaluation order in every expression below is part of the spec.

/** Backwards: ground ticks after a landing that are still checked (the jump tick and 4 more: Influx's 50 ms). */
export const BW_GROUND_GRACE = 5;
/** Backwards: below this horizontal speed² (35 u/s, Swoobles' floor) the heading isn't judged. */
export const BW_MIN_SPEED_SQ = 1225;
/** Backwards: cos²(36.87°), Influx's MAX_DOT -0.8 squared. */
export const BW_DOT_SQ = 0.64;

const BW_D2R = 0.017453292519943295; // Math.PI / 180 as an f64 literal
// Taylor coefficients on |x| <= pi/4; each literal is 1/n! in f64 exactly.
const S3 = -0.16666666666666666, S5 = 0.008333333333333333, S7 = -0.0001984126984126984, S9 = 2.7557319223985893e-6, S11 = -2.505210838544172e-8;
const C2 = -0.5, C4 = 0.041666666666666664, C6 = -0.001388888888888889, C8 = 2.48015873015873e-5, C10 = -2.755731922398589e-7, C12 = 2.08767569878681e-9;

/** (cos, sin) of a yaw in degrees, bit-identical in every JS engine and in Rust (styles.rs bw_dir). Max error 7e-12. */
export function bwDir(yaw: number): [number, number] {
  let r = yaw % 360;
  if (r > 180) r -= 360;
  else if (r < -180) r += 360;
  let q = 0;
  if (r > 135) (q = 2), (r -= 180);
  else if (r > 45) (q = 1), (r -= 90);
  else if (r < -135) (q = 2), (r += 180);
  else if (r < -45) (q = 3), (r += 90);
  const x = r * BW_D2R;
  const x2 = x * x;
  const s = x * (1 + x2 * (S3 + x2 * (S5 + x2 * (S7 + x2 * (S9 + x2 * S11)))));
  const c = 1 + x2 * (C2 + x2 * (C4 + x2 * (C6 + x2 * (C8 + x2 * (C10 + x2 * C12)))));
  return q === 0 ? [c, s] : q === 1 ? [-s, c] : q === 2 ? [-c, -s] : [s, -c];
}

/**
 * Whether a view yaw faces backwards against a horizontal velocity: dot(view, v / |v|) <= -0.8 with the square root and
 * the division multiplied out. null: under BW_MIN_SPEED_SQ, not judged.
 */
export function facesBackwards(yaw: number, vx: number, vy: number): boolean | null {
  const sp2 = vx * vx + vy * vy;
  if (sp2 < BW_MIN_SPEED_SQ) return null;
  const [c, s] = bwDir(yaw);
  const d = c * vx + s * vy;
  return d <= 0 && d * d >= BW_DOT_SQ * sp2;
}

/** True for Backwards (StyleDef.backwards). */
export function isBackwards(id: string): boolean {
  return !!BY_ID.get(id)?.backwards;
}

/**
 * Applies a style's key rules to the command for the next tick. Returns `cmd` itself (same object) when nothing is
 * blocked, else a new command. Idempotent: filter(filter(c)) === filter(c) as values.
 */
export function filterCommand(style: StyleDef | null, cmd: TickCmd, ctx: StyleContext): TickCmd {
  // A recorded restricted-style command must be a fixed point of this filter, including on the ground / ladders.
  if (style && !turnBindsAllowed(style.id) && (cmd.buttons & TURN_HOLD_BITS)) cmd = { ...cmd, buttons: cmd.buttons & ~TURN_HOLD_BITS };
  if (!style || !restrictsKeys(style) || ctx.grounded || ctx.onLadder) return cmd;
  let f = cmd.forward;
  let s = cmd.side;
  let b = cmd.buttons;
  const k = style.block;
  if (k.w && ((b & IN_FORWARD) !== 0 || f > 0)) (f = 0), (b &= ~IN_FORWARD);
  if (k.a && ((b & IN_MOVELEFT) !== 0 || s < 0)) (s = 0), (b &= ~IN_MOVELEFT);
  if (k.s && ((b & IN_BACK) !== 0 || f < 0)) (f = 0), (b &= ~IN_BACK);
  if (k.d && ((b & IN_MOVERIGHT) !== 0 || s > 0)) (s = 0), (b &= ~IN_MOVERIGHT);
  if (style.hsw) {
    // bhoptimer force_hsw 1: W without A/D and A/D without W are blocked (S is blocked above).
    const fw = f > 0;
    const lr = s !== 0;
    if (fw && !lr) (f = 0), (b &= ~(IN_FORWARD | IN_BACK));
    if (lr && !fw) (s = 0), (b &= ~(IN_MOVELEFT | IN_MOVERIGHT));
    // A keyboard always sends equal forward/side magnitudes (cl_forwardspeed = cl_sidespeed); an uneven pair would be
    // a near-pure W or A/D wish direction, so the larger axis is cut down to the smaller one.
    if (f !== 0 && s !== 0 && f !== Math.abs(s)) {
      const m = Math.min(f, Math.abs(s));
      f = m;
      s = s < 0 ? -m : m;
    }
  }
  if (f === cmd.forward && s === cmd.side && b === cmd.buttons) return cmd;
  return { forward: f, side: s, yaw: cmd.yaw, pitch: cmd.pitch, buttons: b };
}

/** Which keys count as a strafe for the run stats (bhoptimer strafe_count_w/a/s/d). */
export type StrafeKeys = "ad" | "ws" | "w";

export function strafeKeys(style: StyleDef | null): StrafeKeys {
  if (style?.id === "wonly") return "w";
  if (style?.id === "sideways") return "ws";
  return "ad";
}

/**
 * True for the assisted style (Auto-strafe): the strafe is computed in the air rather than keys blocked. Assisted runs
 * have their own boards and style ranking but no overall points, no XP and no clear achievements (ranking.ts,
 * apps/api/src/progress.ts).
 */
export function isAssisted(id: string): boolean {
  return !!BY_ID.get(id)?.auto;
}

/** True for Segmented: checkpoint loads rewind the run instead of ending it (StyleDef.segmented). */
export function isSegmented(id: string): boolean {
  return !!BY_ID.get(id)?.segmented;
}

/** Styles whose runs can earn XP, clear achievements and overall progression. */
export function earnsProgression(id: string): boolean {
  return isStyleId(id) && !isAssisted(id) && !BY_ID.get(id)?.separate;
}

const MOVE_BITS = IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT;

/**
 * Stateful wrapper around filterCommand for one run: keys stay unblocked from the moment the player is on a ladder
 * until they next land, like bhoptimer. Assisted styles also keep the previous command's view yaw, the last strafe
 * direction and the ground streak (header comment). Create one per run and call reset() after every core.reset().
 * Only plain fields: the replay viewer keyframes it with a shallow clone.
 */
export class StyleFilter {
  private fromLadder = false;
  /** View yaw of the previous command (NaN: none since the reset). */
  private prevYaw = NaN;
  /** Last mouse strafe direction (-1 left, +1 right, 0 none) and the still ticks since. */
  private autoDir = 0;
  private still = 0;
  /** Consecutive ticks that started on the ground (2 after a reset: a spawn is not a landing). */
  private groundTicks = 2;
  /** Backwards: consecutive commands that started on the ground (BW_GROUND_GRACE + 1 after a reset: a spawn is not a landing). */
  private bwGround = BW_GROUND_GRACE + 1;
  /** Backwards: the last command's movement keys were zeroed (display only; the rule never reads it). */
  bwBlocked = false;

  /**
   * Auto-strafe from physics v5 (v0.0.10): holding S in the air pauses the computed strafe, so S slows you down and A/D
   * are your own (owner, 2026-10-07: you couldn't stop over small holes). Older replays keep the v1-v4 rule.
   */
  private readonly sStops: boolean;
  /**
   * Auto-strafe from physics v8 (v0.0.13): holding A or D in the air hands the strafe back to the player (surf ramps),
   * and W moves you forward alongside the computed strafe (Golden_Tick, 2026-10-08: stuck after a jump-up crouch).
   */
  private readonly keys: boolean;

  constructor(public style: StyleDef | null, physics: number = PHYSICS_V1) {
    this.sStops = physics >= AUTOSTRAFE_S_STOPS_FROM;
    this.keys = physics >= AUTOSTRAFE_KEYS_FROM;
  }

  reset(): void {
    this.fromLadder = false;
    this.prevYaw = NaN;
    this.autoDir = 0;
    this.still = 0;
    this.groundTicks = 2;
    this.bwGround = BW_GROUND_GRACE + 1;
    this.bwBlocked = false;
  }

  /** `state` is the player state BEFORE the tick. */
  apply(cmd: TickCmd, state: StyleContext): TickCmd {
    if (state.onLadder) this.fromLadder = true;
    else if (state.grounded) this.fromLadder = false;
    if (this.style?.auto) return this.assist(cmd, state);
    if (this.style?.backwards) return this.backwards(cmd, state);
    // A v22 edge landing without a jump is an air tick: the core takes the landing back before it moves.
    const grounded = state.grounded && !(state.edgeLanding && !(cmd.buttons & IN_JUMP));
    return filterCommand(this.style, cmd, { grounded, onLadder: state.onLadder || this.fromLadder });
  }

  /**
   * Backwards: on air ticks and the first BW_GROUND_GRACE ground ticks after a landing (the bhop jump tick included), a
   * command whose view doesn't face backwards (facesBackwards) loses its movement: forward and side 0 and the
   * IN_FORWARD / BACK / MOVELEFT / MOVERIGHT bits cleared (jump, duck, use and weapons pass). Exempt: on a ladder and in
   * the air after one until the next landing, longer on the ground, and under 35 u/s. The decision reads only the
   * command's yaw, the pre-tick state and the ground streak, and never changes the yaw, so it is idempotent and a
   * recorded command is a fixed point. Like Normal, turn binds, null binds and Release W are allowed.
   */
  private backwards(cmd: TickCmd, state: StyleContext): TickCmd {
    this.bwGround = state.grounded ? Math.min(this.bwGround + 1, BW_GROUND_GRACE + 1) : 0;
    this.bwBlocked = false;
    if (state.onLadder || this.fromLadder || this.bwGround > BW_GROUND_GRACE) return cmd;
    const v = state.velocity;
    if (!v) return cmd;
    if (facesBackwards(cmd.yaw, v[0], v[1]) !== false) return cmd;
    const b = cmd.buttons & ~MOVE_BITS;
    if (cmd.forward === 0 && cmd.side === 0 && b === cmd.buttons) return cmd;
    this.bwBlocked = true;
    return { forward: 0, side: 0, yaw: cmd.yaw, pitch: cmd.pitch, buttons: b };
  }

  /** Auto-strafe: the computed strafe (header comment). */
  private assist(cmd: TickCmd, state: StyleContext): TickCmd {
    const d = yawDelta(this.prevYaw, cmd.yaw);
    this.prevYaw = cmd.yaw;
    const dir = strafeDir(d);
    if (dir) (this.autoDir = dir), (this.still = 0);
    else this.still++;
    this.groundTicks = state.grounded ? Math.min(this.groundTicks + 1, 2) : 0;
    if (state.onLadder || this.fromLadder || this.groundTicks > 1) return cmd;
    if (this.sStops && cmd.forward < 0) return cmd; // S held (v5+): no assist this tick, S and A/D work as typed
    if (this.keys && cmd.side !== 0) return cmd; // A or D held (v8+): the player's own strafe, W included
    const f = this.keys && cmd.forward > 0 ? cmd.forward : 0; // W moves forward from v8; before, W / S did nothing
    let s: number;
    if (dir) s = dir * AUTO_MOVE;
    else if (cmd.side !== 0) s = cmd.side; // v1-v7: the player's own A/D while the mouse is still
    else s = this.still <= AUTO_HOLD_TICKS ? this.autoDir * AUTO_MOVE : 0;
    s += 0; // no -0
    let b = cmd.buttons & ~MOVE_BITS;
    if (f > 0) b |= IN_FORWARD;
    if (s > 0) b |= IN_MOVERIGHT;
    else if (s < 0) b |= IN_MOVELEFT;
    if (f === cmd.forward && s === cmd.side && b === cmd.buttons) return cmd;
    return { forward: f, side: s, yaw: cmd.yaw, pitch: cmd.pitch, buttons: b };
  }
}
