// Mouse/keyboard input mapped to Source-style user commands.
// Sensitivity matches CS:S: degrees = counts * sensitivity * m_yaw (0.022 by default; Settings → Mouse & view → m_yaw).
//
// Binds are KeyboardEvent.code strings plus mouse pseudo-codes: Mouse1 and up (buttons, Source's names: binds.ts mouseCode),
// MWheelUp / MWheelDown, and MouseWheel (either direction). Wheel binds pulse for one tick,
// like `bind mwheeldown +jump` in CS:S.

import { InputSampler, type SamplerOptions, type SamplerPolicy, type SampledInput, type SamplerReset, type Payload, type SamplerEvidence } from "./input-sampler";
import { mapViewPitch } from "./input-view";
import { validateMotion } from "./input-motion";
import { TIMED_KEY_BITS, TIMED_PRESSES, TimedInput } from "./timed-input";
import type { Action } from "./ui/settings";
import { DEFAULT_BINDS, guardSideMouseButtons, isWeaponAction, mouseCode, type BindAction } from "./binds";
import { cursorFree, cursorHeld, endFreeCursorAsPause, setCursorFree } from "./free-cursor";
import { MouseFilter, type MotionSample } from "./mouse-filter";
import { IN_GIVE_SHIFT, IN_WEAPON_COMMAND_MASK } from "./weapon-rules";
import { noteInputEvent } from "./input-trust";
import { countedYaw, norm360, YAW_SET_RAW, YAW_SET_SENSITIVITY, YAW_SET_SPAWN, YAW_SET_TURN, YAW_WITH_TURN, type LookSample } from "./replay";
import { DEFAULT_TURN_SPEED, IN_LEFT, IN_RIGHT, IN_TURN_FAST, TURN_HOLD_BITS, turnDelta, type TurnSpeed } from "./turn-binds";
import { resolveNullBinds } from "./null-binds";
import { WRelease, type WReleaseContext } from "./w-release";
import { keyForCode } from "./console/names";
import { mixesMoveAndTurn, MOVE_TURN_REFUSAL, runPress, runRelease, type Aliases, type ChainOps } from "./console/bind-run";
import { noteLockPath } from "./lock-path";

/**
 * Whether `unadjustedMovement` really turns raw input on here (only for the diagnostics label): Chromium does (Windows,
 * macOS, ChromeOS; Linux refuses it and the lock falls back). Firefox before 152 has it pref-gated, so the option is
 * silently ignored and the lock "succeeds" without it; Safari doesn't have it.
 */
function rawHonoured(): boolean {
  if (typeof navigator === "undefined") return false;
  const ff = /\bFirefox\/(\d+)/.exec(navigator.userAgent);
  if (ff) return Number(ff[1]) >= 152;
  return /\bChrom(e|ium)\//.test(navigator.userAgent);
}

/** pointerrawupdate (Chromium; Firefox 140+): one event per mouse report, not per frame. */
const HAS_RAW_UPDATE = typeof window !== "undefined" && "onpointerrawupdate" in window;
/** pointerrawupdate exists here (the input experiment's default source). */
export const hasRawUpdate = (): boolean => HAS_RAW_UPDATE;
/**
 * Above this many raw updates a second the uncapped loop goes back to pointermove for the session (Aimperion
 * RAW_MAX_HZ): an 8 kHz mouse dispatches 8,000 events a second on the main thread for frames that can't use them all.
 * Headroom over 2,000 so a 2 kHz mouse's jitter across a second boundary doesn't trip it (4 kHz and up still do).
 */
const RAW_MAX_HZ = 2500;
/** Raw updates silent this long while pointermove still carries motion: the raw stream stalled, pointermove takes over. */
const RAW_STALL_MS = 250;
/** Modifier keys the free camera reads whether or not they are bound (Input.freeIntent). */
const MOD_CODES = new Set(["ShiftLeft", "ShiftRight", "AltLeft", "AltRight"]);
/** A refused pointer lock request's reason: the DOMException's name. */
const errName = (e: unknown): string => (e && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "error");

/** A pointermove's coalesced mouse reports (Chromium, Firefox, Safari 18.2+), or null. */
function reportsOf(e: MouseEvent): ArrayLike<MotionSample> | null {
  const p = e as PointerEvent;
  return typeof p.getCoalescedEvents === "function" ? p.getCoalescedEvents() : null;
}

export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
/** +use (Source IN_USE): doors, buttons. Allowed in every style; recorded in replays like any other button. */
export const IN_USE = 1 << 5;
/**
 * +attack / +attack2 (Source IN_ATTACK / IN_ATTACK2): the knife's swing and stab, held while the `attack` / `attack2`
 * binds are (they stay viewmodel actions too). From physics v4 the sim swings the knife (crates/core game/knife.rs):
 * it presses damage-activated buttons. Recorded in replays like any other button.
 */
export const IN_ATTACK = 1 << 0;
export const IN_ATTACK2 = 1 << 11;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
/**
 * Weapon inputs (physics v4, crates/core game/weapons.rs, research/WEAPONS.md), all set for the one tick after the key
 * press and recorded in replays: a 2-bit slot number in buttons bits 14..15 (Input.requestSlot; ignored when the
 * slot's weapon isn't held), drop the active gun (bit 12) and reload (bit 13, Source's IN_RELOAD). Older replays never
 * have these bits.
 */
export const IN_DROP = 1 << 12;
export const IN_RELOAD = 1 << 13;
export const IN_SLOT_SHIFT = 14;
export const IN_SLOT_MASK = 3 << IN_SLOT_SHIFT;
/** Infinite flight (core.ts IN_FLIGHT): set by the session while Infinite's noclip is on, never by the input itself. */
export { IN_FLIGHT } from "./core";
/** Slot numbers: primary (sniper), secondary (pistol), knife. */
export const SLOT_PRIMARY = 1;
export const SLOT_PISTOL = 2;
export const SLOT_KNIFE = 3;

export interface UserCmd {
  pitch: number; // degrees, +down
  yaw: number; // degrees, CCW from +X (Source convention)
  forwardmove: number;
  sidemove: number;
  buttons: number;
  /** v8: the view state the yaw was computed from (replay.ts LookSample); recorded with the command. */
  look?: LookSample;
  /** Null binds resolved this command's movement keys (null-binds.ts); the replay header records it. */
  nullBinds?: boolean;
  /** Timestamped input built this command (timed-input.ts); the replay header records it. */
  timed?: boolean;
  /** Its presses and wheel pulses were timed too (timed-input.ts TIMED_PRESSES); the replay header records it. */
  timedPresses?: boolean;
  /** Release W on jump was on for this command (w-release.ts); the replay header records it. */
  wRelease?: boolean;
}

export interface InputSettings {
  sensitivity: number;
  verticalSensitivityEnabled?: boolean;
  verticalSensitivity?: number;
  m_yaw: number;
  m_pitch: number;
}

/** Movement actions -> Source IN_* button bits. Other actions are dispatched via onAction. */
export const ACTION_BITS: Partial<Record<Action, number>> = {
  forward: IN_FORWARD,
  back: IN_BACK,
  left: IN_MOVELEFT,
  right: IN_MOVERIGHT,
  jump: IN_JUMP,
  duck: IN_DUCK,
  /** Crouch jump: one key held = jump and duck held, exactly as both keys pressed together. */
  crouchJump: IN_JUMP | IN_DUCK,
  use: IN_USE,
};

export { DEFAULT_BINDS } from "./binds";

/** The bound actions whose holds go into commands as buttons (sample()), by the button they hold. */
const ACTION_PRESS_BITS: Partial<Record<BindAction, number>> = { attack: IN_ATTACK, attack2: IN_ATTACK2, turnLeft: IN_LEFT, turnRight: IN_RIGHT, turnFast: IN_TURN_FAST };
/** Those buttons: sample() adds them by its own rules (turn binds by style, the knife while locked). */
const ACTION_PRESS_MASK = IN_ATTACK | IN_ATTACK2 | TURN_HOLD_BITS;

/** The input experiment's sampler sees Hold jump (toggle) as a key with this code (never a KeyboardEvent.code). */
export const JUMP_TOGGLE_CODE = "+jump_toggle";

/** Key events aimed at a text input / textarea / contenteditable (not game input). */
export function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

export interface SamplerDelivery {
  readonly version: 1; readonly session: number; readonly epoch: number; readonly observedChildren: number | null;
  readonly delivery: number; readonly source: string; readonly accepted: boolean; readonly reason: string;
  readonly reports: number; readonly eventTime: number; readonly arrivalTime: number;
  readonly entries: readonly Readonly<{movementX:number; movementY:number; timeStamp:number; report:number; k:number; pitchK:number}>[];
  readonly children: readonly Readonly<MotionSample>[];
  readonly childrenTruncated: boolean;
  readonly parentX: number; readonly parentY: number; readonly acceptedX: number; readonly acceptedY: number;
}

export class Input {
  private sampler: InputSampler | null = null;
  private samplerDelivery = 0;
  private samplerSession = 0;
  /** Latest selected/companion callback decision; bounded, separate from command consumption. */
  samplerMotion: Readonly<SamplerDelivery> | null = null;
  /** Optional synchronous capture sink. No retained unbounded delivery log. Must not throw. */
  onSamplerDelivery: ((delivery: Readonly<SamplerDelivery>) => void) | null = null;
  /** Persist each barrier immediately, including consecutive reset calls. Must not throw. */
  onSamplerReset: ((reset: Readonly<SamplerReset>) => void) | null = null;
  /** Local required-version codec sink; attach before enableSampler, keep through disable. */
  onSamplerEvidence: ((event: SamplerEvidence) => void) | null = null;
  private samplerView() {
    return {base:this.yawBase, count:this.yawCount, k:this.yawK, epoch:this.yawEpoch, kind:this.yawKind, pitch:this.pitch};
  }
  enableSampler(options: SamplerOptions): void {
    if (this.sampler) throw new Error("Sampler already enabled; disable or reset first");
    if (options.source === "pointerrawupdate" && !HAS_RAW_UPDATE) throw new Error("pointerrawupdate is unavailable; choose an explicit supported source");
    const sampler = new InputSampler(options, {...this.samplerView(), pitch:mapViewPitch(this.pitch)}, ++this.samplerSession, this.onSamplerEvidence ? e => this.onSamplerEvidence?.(e) : undefined);
    this.releaseAll();
    this.sampler = sampler;
    this.syncSamplerPreview();
    this.onSamplerReset?.(sampler.lastReset);
    this.framesSince = this.eventsSince = this.reportsSince = 0;
  }
  disableSampler(): void {
    this.resetSampler(performance.now(), "disable");
    this.sampler = null;
    this.releaseAll();
  }
  /** Release barrier: discard pending motion and retain the committed view. Capture stop may retain physical holds. */
  resetSampler(now = performance.now(), reason = "integration-reset", preserveHeld = false): void {
    if (!this.sampler) return;
    this.sampler.reset(now, this.sampler.committedView, reason, preserveHeld);
    this.syncSamplerPreview();
    this.onSamplerReset?.(this.sampler.lastReset);
    if (!preserveHeld) this.heldCodes.clear();
    this.wheelBits = this.slot = this.weaponBits = this.give = 0;
    this.framesSince = this.eventsSince = this.reportsSince = 0;
  }
  private syncSamplerPreview(): void {
    if (!this.sampler) return;
    const v = this.sampler.previewView;
    this.yawBase=v.base; this.yawCount=v.count; this.yawK=v.k;
    this.yawEpoch=v.epoch; this.yawKind=v.kind; this.pitch=v.pitch;
  }
  rebasePhysicsView(yaw: number, pitch: number, kind: number): void {
    if (!this.sampler && this.timedActive) {
      // A teleport or a pusher turn sets the view as of the last command; motion stamped after it still applies (counted
      // with the current k, as it was received: the next motion after a sensitivity change rebases, previewLook).
      this.yawBase = norm360(yaw);
      this.lastTurn = 0;
      this.yawCount = this.ti.pendingX;
      this.yawEpoch++;
      this.yawKind = kind;
      this.cmdPitch = pitch;
      this.viewPitch = Math.max(-89, Math.min(89, pitch + this.ti.pendingP));
      return;
    }
    if (!this.sampler) { this.pitch=pitch; this.setYaw(yaw,kind); return; }
    this.sampler.rebase(yaw,mapViewPitch(pitch),kind);
    this.syncSamplerPreview();
  }
  /** A new world/attempt discards old pending input and clock, preserving legacy physical holds. */
  restartSamplerView(yaw: number, pitch: number, kind: number): void {
    if (!this.sampler) { this.pitch=pitch; this.setYaw(yaw,kind); return; }
    const view={...this.sampler.committedView,base:norm360(yaw),count:0,pitch:mapViewPitch(pitch),kind,epoch:this.sampler.committedView.epoch+1};
    this.sampler.reset(performance.now(),view,'world-restart',true);
    this.syncSamplerPreview();
    this.onSamplerReset?.(this.sampler.lastReset);
    this.wheelBits=this.slot=this.weaponBits=this.give=0;
    this.framesSince=this.eventsSince=this.reportsSince=0;
  }
  get samplerState() { return this.sampler ? {pending:this.sampler.pending, failed:this.sampler.failed, rejectedEpoch:this.sampler.rejectedEpoch, rejectedEpochX:this.sampler.rejectedEpochX, rejectedEpochY:this.sampler.rejectedEpochY, lastReset:this.sampler.lastReset} : null; }
  pumpSampler(now: number, apply?: (sample: SampledInput) => void, policy: SamplerPolicy = {}): SampledInput[] {
    if (!this.sampler) throw new Error("Sampler is not enabled");
    this.nullBinds = !!policy.nullBinds; // the keys overlay (held) shows what the commands resolve
    const rows = this.sampler.pump(now, {frames:this.framesSince, events:this.eventsSince, reports:this.reportsSince}, apply, {turnSpeed:this.turnSpeed, ...policy});
    if (rows.length) this.framesSince = this.eventsSince = this.reportsSince = 0;
    this.syncSamplerPreview();
    return rows;
  }
  private queue(payload: Payload, eventTime = performance.now(), arrivalTime = performance.now()): boolean {
    return this.sampler?.enqueue(payload, eventTime, arrivalTime) ?? true;
  }
  private releaseCode(code: string, e: Event): void {
    const bound = this.cmdHeld.get(code);
    if (bound !== undefined) {
      this.cmdHeld.delete(code);
      this.runChain(code, e, (ops) => runRelease(bound, this.aliases, ops));
    }
    this.untilKeyup.delete(code);
    if (this.timedActive && this.heldCodes.has(code) && this.timedBitsOf(code)) this.ti.addEdge(this.ti.stamp(e.timeStamp, performance.now()), code, false);
    this.heldCodes.delete(code);
    if (this.isBound(code)) this.queue({type:"key", code, down:false, bits:0}, e.timeStamp);
  }
  settings: InputSettings = { sensitivity: 2, m_yaw: 0.022, m_pitch: 0.022 };
  /** The turn binds' rates (cl_yawspeed / cl_anglespeedkey); the session sets them when a recording starts. */
  turnSpeed: TurnSpeed = { ...DEFAULT_TURN_SPEED };
  /** Request raw (unaccelerated) mouse input when locking. */
  rawInput = true;
  /** The view's pitch as the camera shows it (all motion so far). */
  private viewPitch = 0;
  get pitch(): number {
    return this.viewPitch;
  }
  /** Sets the pitch (the next command's too: pending pitch motion is forgotten). */
  set pitch(v: number) {
    this.viewPitch = v;
    this.cmdPitch = v;
    this.ti.dropPitch();
  }
  /**
   * Timestamped input (timed-input.ts; Settings → Mouse & view → Timestamped input): commands take the mouse motion and
   * movement keys stamped up to their tick's boundary (sample({ at })), the camera everything. Off: as before, a command
   * takes the view and keys as of the frame that runs it.
   */
  get timed(): boolean {
    return this.timedOn;
  }
  set timed(v: boolean) {
    v = !!v;
    if (v === this.timedOn) return;
    this.commitPending();
    this.wheelBits |= this.ti.pendingPulse(); // (the next command, as a frame-sampled notch)
    this.ti.clearPulses();
    this.timedOn = v;
    this.seedTimedKeys();
  }
  private timedOn = true;
  /**
   * Timed presses (timed-input.ts TIMED_PRESSES, the switch): with timed input on, every bound button and wheel pulse
   * goes onto its tick by timestamp, not only W/A/S/D. Tests set it to compare with frame-sampled presses.
   */
  timedPresses = TIMED_PRESSES;
  private readonly ti = new TimedInput();
  /** The buttons a key timed input holds gave at its press (a command bind's virtual key keeps them until its release lands). */
  private readonly pressBits = new Map<string, number>();
  /** The pitch the last command took (timed input; the view's pitch otherwise). */
  private cmdPitch = 0;
  /** Motion event serial (timed input's per-command event count). */
  private motionSerial = 0;
  private get timedActive(): boolean {
    return this.timedOn && !this.sampler;
  }
  private get pressesTimed(): boolean {
    return this.timedPresses && this.timedActive;
  }
  /**
   * The buttons `code` holds if timed input takes it by timestamp, else 0: W/A/S/D keys, and with timed presses every
   * bound button (jump, duck, use, the knife's attacks, the turn binds).
   */
  private timedBitsOf(code: string): number {
    const b = this.codeBits.get(code) ?? 0;
    if (!this.timedPresses) return b & TIMED_KEY_BITS ? b : 0;
    const a = this.codeAction.get(code);
    return b | (a ? (ACTION_PRESS_BITS[a] ?? 0) : 0);
  }
  /** Timed input's adapted holdback and its report counts (input stats, the experiment's sampler holdback). */
  get timedStats(): { holdbackMs: number; reports: number; late: number; pending: number; unreliable: boolean } {
    return { holdbackMs: this.ti.holdbackMs, reports: this.ti.reports, late: this.ti.late, pending: this.ti.pending, unreliable: this.ti.unreliable };
  }
  /** Everything pending goes into the next command (timed input turned off, keys released, a sensitivity change). */
  private commitPending(): void {
    const t = this.ti.flushMotion((_x, p) => (this.cmdPitch = Math.max(-89, Math.min(89, this.cmdPitch + p))));
    this.cmdPitch = this.viewPitch;
    // The next command carries this motion: it counts its events too (the anticheat's turning-without-event share).
    this.carryEvents += t.events;
    this.carryReports += t.reports;
  }
  private carryEvents = 0;
  private carryReports = 0;
  /** Timed keys held right now become the timed state (turned on, rebinding): no edge for them is pending. */
  private seedTimedKeys(): void {
    this.ti.releaseKeys();
    this.pressBits.clear();
    for (const c of this.heldCodes) {
      const b = this.timedBitsOf(c);
      if (!b) continue;
      this.ti.keys.add(c);
      this.pressBits.set(c, b);
    }
  }

  /** A timed key went down at `e`'s time (not already held). */
  private timedPress(code: string, e: Event): void {
    const b = this.timedBitsOf(code);
    if (!b) return;
    this.pressBits.set(code, b);
    this.ti.addEdge(this.ti.stamp(e.timeStamp, performance.now()), code, true);
  }

  /** A wheel notch's buttons for one command: the next sample() frame-sampled, its own tick timed (TimedInput.addPulse). */
  private pulse(bits: number, e: Event): void {
    this.wheelBits |= bits;
    if (this.pressesTimed) this.ti.addPulse(this.ti.stamp(e.timeStamp, performance.now()), bits);
  }

  /**
   * The view yaw is counted (v8 replays, replay.ts countedYaw): an exact base plus the whole mouse counts since it,
   * yaw = norm360(base - count * k) with k = sensitivity * m_yaw. Anything that sets the view (spawn, teleport, a
   * rotating pusher, a sensitivity change) starts a new base (setYaw); plain assignment to `yaw` does too, as a raw set.
   * Manual turn binds shift the base without resetting those counts.
   */
  private yawBase = 0;
  private yawCount = 0;
  private yawK = 0.044;
  private yawEpoch = 0;
  private yawKind = YAW_SET_SPAWN;
  private sampledYawEpoch = -1;
  /** v8 input stats since the last command: rAF frames, motion events, mouse reports. */
  private framesSince = 0;
  private eventsSince = 0;
  private reportsSince = 0;
  get yaw(): number {
    return countedYaw(this.yawBase, this.yawCount, this.yawK);
  }
  /**
   * Degrees the turn binds added on the last command (0: it didn't turn). Render only: `viewYaw` spreads that step over
   * the frames until the next tick. The commands, the replay and the simulated view never see it.
   */
  private lastTurn = 0;
  /**
   * The camera's yaw `alpha` (main.ts frame(): accumulator / tick) of the way from the last tick to the next. A held turn
   * bind turns the view a fixed step per tick; drawn at `yaw` the camera would stand still between ticks and jump a whole
   * step on the frame after one (at 240+ FPS most frames show no turn: it looks like tapping, or like a low frame rate).
   * Here the last step is eased in like positions are (prev -> curr): up to one tick behind, never ahead of the command.
   * Mouse motion is unaffected.
   */
  viewYaw(alpha: number): number {
    if (!this.lastTurn || !this.locked) return this.yaw; // (paused: the accumulator is 0, show the full step)
    const a = Math.min(1, Math.max(0, alpha));
    return norm360(this.yaw - this.lastTurn * (1 - a));
  }
  set yaw(v: number) {
    this.setYaw(v, YAW_SET_RAW);
  }
  /** Sets the view yaw (a new counted base): `kind` says what set it (replay.ts YAW_SET_*). */
  setYaw(v: number, kind: number): void {
    if (this.sampler) throw new Error("Use rebasePhysicsView or restartSamplerView while sampler is enabled");
    this.ti.dropYaw(); // a set view: motion before it is gone, as the camera shows
    this.lastTurn = 0;
    this.yawBase = norm360(v);
    this.yawCount = 0;
    this.yawK = this.settings.sensitivity * this.settings.m_yaw;
    this.yawEpoch++;
    this.yawKind = kind;
  }
  /** Playing: the pointer is locked, or released for the chat (free-cursor.ts) with the game still running. */
  locked = false;
  /** How the current lock was obtained: raw input (unadjustedMovement), OS-accelerated, or not locked. */
  lockMode: "raw" | "os" | "none" = "none";
  /** Why the browser last refused a raw lock (a DOMException name; "" = never), for the input stats. */
  rawError = "";
  /** Raw lock requests refused for a reason other than NotSupportedError (no lock taken: the next click asks again). */
  rawRefusals = 0;
  /** The browser said it can't do raw (NotSupportedError): plain locks from now on. */
  private rawUnsupported = false;
  /** A lock that asked for raw input came back with the OS's acceleration (lock-path.ts: main.ts says so once). */
  onOsAccel: (() => void) | null = null;
  /** Spike filter, post-lock discard and input stats (mouse-filter.ts); `filter.enabled` is Settings → Spike filter. */
  readonly filter = new MouseFilter();
  /** Read coalesced reports even with the filter off (the diagnostics overlay's polling-rate estimate). */
  collectReports = false;
  /** Event carrying motion during this lock: 1 pointermove (has coalesced reports), 2 mousemove, 3 pointerrawupdate; 0 undecided. */
  private motionSource: 0 | 1 | 2 | 3 = 0;
  /**
   * Use pointerrawupdate (main.ts: Settings → Graphics → Exceed monitor FPS): the uncapped frame loop draws between
   * vsyncs, and only raw updates bring the mouse motion for those frames (pointermove comes once per vsync).
   */
  rawUpdates = false;
  /** This lock reads pointerrawupdate (rawUpdates when the lock was taken, and not tripped since). */
  private useRaw = false;
  /** Too many raw updates a second this session (RAW_MAX_HZ): pointermove from now on. */
  private rawTripped = false;
  /** Time of the last raw update with motion, and the per-second count for RAW_MAX_HZ. */
  private lastRawT = 0;
  private rawSecond = 0;
  private rawInSecond = 0;
  /** The first pointermove after leaving raw updates mid-lock: its motion was already counted from the raw updates. */
  private skipNextMove = false;
  /** Non-movement bound action pressed (restart, practice tools, weapon slots); `code` is the key that fired it. */
  onAction: ((a: BindAction, code: string) => void) | null = null;
  /** Any other key pressed while locked (zone editor digits, etc.). */
  onKey: ((code: string) => void) | null = null;
  /**
   * A key some on-screen UI owns right now (the numbered menus' digits): its press is ignored here, so no bind and no
   * held movement, turn or attack comes from it. Its keyup still releases a key that was already held.
   */
  ownsKey: ((code: string) => boolean) | null = null;
  /** Keys released by releaseAllUntilKeyup (or taken by ownsKey): their key repeats stay ignored until a keyup or a fresh press. */
  private untilKeyup = new Set<string>();
  /**
   * Freecam (freecam.ts) and room spectating's free look: while set, mouse motion turns this camera instead of the view
   * (degrees, at the player's sensitivity, m_yaw / m_pitch and vertical sensitivity). It never reaches the counted yaw,
   * the pitch, the timed-input queue or the per-command motion stats, so commands are exactly those of a still mouse.
   * Not with the input experiment's sampler (freecam.ts freecamUnavailable).
   */
  lookSink: ((dYawDeg: number, dPitchDeg: number) => void) | null = null;
  /** The same for the wheel: notches (+1 up, -1 down) go here instead of wheel binds and their actions. */
  wheelSink: ((steps: number) => void) | null = null;
  /** Shift / Alt held, bound or not (the free camera's faster / slower). */
  private mods = new Set<string>();

  private codeBits = new Map<string, number>();
  private codeAction = new Map<string, BindAction>();
  /** Weapon slot requested for the next command (0 = none). */
  private slot = 0;
  /** Weapon drop / reload bits for the next command. */
  private weaponBits = 0;
  /** Weapon command for the next command: the weapon id to give, plus v10 restore flags (weapon-rules.ts IN_GIVE_*; 0 = none). */
  private give = 0;
  private heldCodes = new Set<string>();
  private wheelBits = 0;
  /**
   * Hold jump (toggle) (the jumpToggle bind, console jump_toggle): while on, every command has IN_JUMP exactly as if a
   * jump key were held down. It works like Source's kbutton_t with a console `+jump` (in_main.cpp KeyDown / KeyUp with
   * no key number): a real jump key pressed meanwhile adds a second holder, and letting go of it leaves the jump held
   * until the toggle goes off. Nothing new is recorded: the replay and the verifier see an ordinary held jump.
   * releaseAll (blur, focus, a hidden tab, pointer lock lost: menus, the chat, the console) turns it off; main.ts also
   * turns it off on restarts (style and map changes restart too).
   */
  private jumpLatched = false;
  /** The toggle went on or off (the HUD cue). */
  onJumpToggle: ((on: boolean) => void) | null = null;
  /**
   * Command binds (Prefs.cmdBinds, console/bind-run.ts): key code -> command text, and the aliases they use. A held
   * `+x` is a virtual key `<code>><action>` in heldCodes, with x's bit or action, pressed and released through
   * press / releaseCode exactly like a physical key bound to x: so the commands equal holding those keys.
   */
  private cmdCodes = new Map<string, string>();
  private aliases: Aliases = {};
  /** Command keys down now -> the text they ran (their release runs its - commands). */
  private cmdHeld = new Map<string, string>();
  /** Virtual keys held by command binds -> their action. */
  private virtual = new Map<string, Action>();
  /** A command bind's once-commands (`say gg`, `slot1`, cvars): main.ts runs them through the console. */
  onCommand: ((command: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.setBinds(DEFAULT_BINDS);
    document.addEventListener("pointerlockchange", () => {
      this.locked = this.pointerLocked || cursorFree();
      if (this.pointerLocked) {
        this.motionSource = 0;
        this.useRaw = this.rawUpdates && HAS_RAW_UPDATE && !this.rawTripped;
        this.skipNextMove = false;
        this.filter.rearm(performance.now());
        this.resetSampler(performance.now(), "lock");
        this.restoreDown();
      } else {
        this.releaseAll();
        this.lockMode = "none";
      }
    });
    // Mouse look. Both events are rAF-aligned (one per frame, movementX the sum of the mouse reports since the last
    // one); pointermove also carries the reports themselves, which the spike filter reads. Chromium and Firefox fire
    // pointermove first, so it wins the latch; mousemove takes over where pointermove carries no motion under the lock.
    // Exactly one of them is applied per lock: never both (that would double the sensitivity). Deltas go straight into
    // the view angles: the camera reads them every frame and each tick's command samples them, so nothing is lost or
    // applied twice however frames and ticks interleave. Not pointerrawupdate: one dispatch per mouse report (up to
    // 8000 a second) for a picture that is drawn once per frame anyway, except with the uncapped frame loop
    // (rawUpdates), whose frames between vsyncs need the motion pointermove only brings at the next vsync. Then raw
    // updates come first and win the latch (Firefox 140-147 send them with zero motion: those never latch).
    document.addEventListener("pointermove", (e) => (noteInputEvent(e), e.pointerType === "mouse" && this.motion(e, 1)), { passive: true });
    document.addEventListener("mousemove", (e) => (noteInputEvent(e), this.motion(e, 2)), { passive: true });
    if (HAS_RAW_UPDATE) document.addEventListener("pointerrawupdate" as "pointermove", (e) => (noteInputEvent(e), (this.sampler?.source === "pointerrawupdate" || this.useRaw) && e.pointerType === "mouse" && this.motion(e, 3)), { passive: true });
    // Fullscreen in / out or a resize while locked can re-centre the hidden cursor (OS-accelerated locks): a jump. So
    // can the window coming back to the front with the lock kept. The view's size sizes the re-centre rule.
    const rearm = () => this.pointerLocked && this.filter.rearm(performance.now());
    const view = () => this.filter.setView(innerWidth, innerHeight);
    view();
    addEventListener("resize", () => (view(), rearm()));
    document.addEventListener("fullscreenchange", () => (view(), rearm()));
    // Browsers can lose keyup while the window is inactive without immediately dropping pointer lock.
    // Discard held input on departure and return; subsequent key events can resume movement.
    addEventListener("blur", () => (this.down.clear(), this.releaseAll()));
    addEventListener("focus", () => { this.down.clear(); this.releaseAll(); rearm(); });
    document.addEventListener("visibilitychange", () => {
      this.down.clear();
      this.releaseAll();
      if (document.visibilityState === "visible") rearm();
    });
    document.addEventListener(
      "wheel",
      (e) => {
        // Scroll-to-jump, as in CS:S bhop binds. Held for one tick. Modifiers never filter it: Ctrl+wheel (a crouch-hop
        // with crouch on Ctrl) registers like any notch, and play-lock.ts cancels the browser zoom it would cause in a
        // separate non-passive listener. Shift+wheel arrives as a horizontal scroll in Chromium / Firefox on Windows,
        // Linux and macOS (deltaY 0, deltaX set), which used to drop the jump for players crouching on Shift; a
        // horizontal delta only counts with Shift held, so trackpad / tilt-wheel sideways scrolls stay ignored.
        noteInputEvent(e);
        if (!this.pointerLocked) return;
        const delta = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
        if (delta === 0) return;
        if (this.wheelSink) return this.wheelSink(delta < 0 ? 1 : -1);
        const dir = delta < 0 ? "MWheelUp" : "MWheelDown";
        const cmdCode = this.cmdCodes.has(dir) ? dir : this.cmdCodes.has("MouseWheel") ? "MouseWheel" : null;
        if (cmdCode) return this.wheelCommand(cmdCode, e);
        const bits = (this.codeBits.get(dir) ?? 0) | (this.codeBits.get("MouseWheel") ?? 0);
        this.pulse(bits, e);
        this.queue({type:"pulse", bits}, e.timeStamp);
        const code = this.codeAction.has(dir) ? dir : "MouseWheel";
        const a = this.codeAction.get(code);
        if (a) this.onAction?.(a, code);
      },
      { passive: true },
    );
    guardSideMouseButtons(document, () => this.pointerLocked);
    document.addEventListener("mousedown", (e) => {
      noteInputEvent(e);
      if (this.pointerLocked) this.press(mouseCode(e.button), false, e);
    });
    document.addEventListener("mouseup", (e) => (noteInputEvent(e), this.releaseCode(mouseCode(e.button), e)));
    document.addEventListener("keydown", (e) => {
      noteInputEvent(e);
      if (!isTextField(e.target)) this.down.add(e.code);
      // Typing into a text field (the chat, with the game still playing) never moves the player or fires binds.
      if (this.locked && !isTextField(e.target)) {
        if (MOD_CODES.has(e.code)) {
          this.mods.add(e.code);
          if (this.lookSink && e.code.startsWith("Alt")) e.preventDefault(); // (Alt alone focuses the browser's menu)
        }
        this.press(e.code, e.repeat, e);
      }
    });
    document.addEventListener("keyup", (e) => (noteInputEvent(e), this.down.delete(e.code), this.mods.delete(e.code), this.releaseCode(e.code, e)));
  }

  /**
   * Keys down on this page right now, locked or not (not typed into a text field). Pressed in a menu, or held through
   * Esc and the click back in, they never reached the game: the press came while unlocked, and key repeat brings back
   * only the last key pressed. Cleared with everything else when the window loses focus or the tab hides.
   */
  private readonly down = new Set<string>();

  /** The lock is back: keys held since before it go down now, as fresh presses (holds only: no actions fire). */
  private restoreDown(): void {
    const e = { timeStamp: performance.now(), preventDefault() {} } as unknown as Event;
    for (const c of this.down) {
      if (this.heldCodes.has(c) || this.untilKeyup.has(c)) continue;
      if (MOD_CODES.has(c)) this.mods.add(c);
      const a = this.codeAction.get(c);
      if (this.codeBits.has(c) || (a && ACTION_PRESS_BITS[a])) this.press(c, false, e);
    }
  }

  /** Which event carries motion during this lock (diagnostics). */
  get motionEvent(): "pointermove" | "mousemove" | "pointerrawupdate" | "none" {
    return this.motionSource === 1 ? "pointermove" : this.motionSource === 2 ? "mousemove" : this.motionSource === 3 ? "pointerrawupdate" : "none";
  }

  /** One motion event from `source` (1 pointermove, 2 mousemove, 3 pointerrawupdate): filtered, then turned into view angles. */
  private motion(e: MouseEvent, source: 1 | 2 | 3): void {
    if (!this.pointerLocked) return;
    if (this.sampler) { this.samplerMotionEvent(e, source); return; }
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (!(dx || dy)) return;
    if (source === 3) {
      // RAW_MAX_HZ: back to pointermove for the session; its next event overlaps what the raw updates counted.
      const sec = Math.floor(e.timeStamp / 1000);
      if (sec !== this.rawSecond) {
        this.rawSecond = sec;
        this.rawInSecond = 0;
      }
      if (++this.rawInSecond > RAW_MAX_HZ) {
        this.rawTripped = true;
        this.useRaw = false;
        this.motionSource = 1;
        this.skipNextMove = true;
        return;
      }
      this.lastRawT = e.timeStamp;
    } else if (source === 1 && this.motionSource === 3) {
      // Raw updates stalled while pointermove still moves: pointermove takes over (this event included).
      if (e.timeStamp - this.lastRawT < RAW_STALL_MS) return;
      this.useRaw = false;
      this.motionSource = 1;
    }
    if (source === 1 && this.skipNextMove) {
      this.skipNextMove = false;
      return;
    }
    if (this.motionSource !== source) {
      if (this.motionSource !== 0) return;
      this.motionSource = source;
    }
    const f = this.filter;
    const reports = source !== 2 ? reportsOf(e) : null;
    const timed = this.timedActive;
    f.push(dx, dy, e.timeStamp, source !== 2 && (f.enabled || this.collectReports || timed) ? reports : null);
    if (this.lookSink) {
      // Freecam: the camera turns, the view and the input stats don't (R2).
      const s = this.settings;
      const pk = (s.verticalSensitivityEnabled ? (s.verticalSensitivity ?? s.sensitivity) : s.sensitivity) * s.m_pitch;
      if (f.outX || f.outY) this.lookSink(f.outX * s.sensitivity * s.m_yaw, f.outY * pk);
      return;
    }
    this.eventsSince++;
    this.reportsSince += reports ? reports.length : 1;
    this.look(f.outX, f.outY);
    if (timed && (f.outX || f.outY)) this.timedMotion(e, reports);
  }

  /** Timed input: the event's accepted motion, per report at the report's own time where the browser gives them. */
  private timedMotion(e: MouseEvent, reports: ArrayLike<MotionSample> | null): void {
    const f = this.filter;
    const s = this.settings;
    const pk = (s.verticalSensitivityEnabled ? (s.verticalSensitivity ?? s.sensitivity) : s.sensitivity) * s.m_pitch;
    const now = performance.now();
    const ev = ++this.motionSerial;
    if (f.perReport && reports && f.repN === reports.length) {
      let last = -Infinity;
      for (let i = 0; i < f.repN; i++) {
        // Reports are in order; a backwards stamp keeps the order (sum unchanged either way).
        last = Math.max(last, this.ti.stamp(reports[i].timeStamp, now));
        if (f.repX[i] || f.repY[i]) this.ti.addMotion(last, f.repX[i], f.repY[i] * pk, ev);
      }
      return;
    }
    // Unfiltered (the filter off or nothing dropped from a single-report judgement): the reports as they came, if they
    // add up to what was accepted.
    if (reports && reports.length > 1 && f.outX === (e.movementX || 0) && f.outY === (e.movementY || 0)) {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < reports.length; i++) {
        sx += reports[i].movementX || 0;
        sy += reports[i].movementY || 0;
      }
      if (sx === f.outX && sy === f.outY) {
        let last = -Infinity;
        for (let i = 0; i < reports.length; i++) {
          const x = reports[i].movementX || 0;
          const y = reports[i].movementY || 0;
          last = Math.max(last, this.ti.stamp(reports[i].timeStamp, now));
          if (x || y) this.ti.addMotion(last, x, y * pk, ev);
        }
        return;
      }
    }
    this.ti.addMotion(this.ti.stamp(e.timeStamp, now), f.outX, f.outY * pk, ev);
  }

  private samplerMotionEvent(e: MouseEvent, source: 1 | 2 | 3): void {
    const sampler = this.sampler!;
    const arrivalTime = performance.now();
    const name = source === 1 ? "pointermove" : source === 2 ? "mousemove" : "pointerrawupdate";
    const delivery = ++this.samplerDelivery;
    let observedChildren: number | null = null;
    let capturedChildren: readonly Readonly<MotionSample>[] = Object.freeze([]);
    let entries: SamplerDelivery['entries'] = Object.freeze([]);
    const recordDelivery = (accepted: boolean, reason: string, reports: number, acceptedX = 0, acceptedY = 0) => {
      this.samplerMotion = Object.freeze({version:1, session:sampler.session, epoch:sampler.lastReset.epoch, observedChildren, entries, children:capturedChildren, childrenTruncated:observedChildren !== null && observedChildren > sampler.capacity, delivery, source:name, accepted, reason, reports, eventTime:e.timeStamp,
        arrivalTime, parentX:e.movementX, parentY:e.movementY, acceptedX, acceptedY});
      sampler.evidence({type:'delivery', delivery:this.samplerMotion});
      this.onSamplerDelivery?.(this.samplerMotion);
    };
    if (name !== sampler.source) {
      recordDelivery(false, "companion-source", 0);
      return;
    }
    this.motionSource = source;
    let children: ArrayLike<MotionSample> | null = null;
    try { children = source === 2 ? null : reportsOf(e); } catch { /* Parent remains authoritative. */ }
    observedChildren = children && Number.isSafeInteger(children.length) && children.length >= 0 ? children.length : null;
    capturedChildren = Object.freeze(Array.from({length:Math.min(observedChildren ?? 0, sampler.capacity)}, (_,i) => {
      const c = children![i];
      return Object.freeze({movementX:c?.movementX, movementY:c?.movementY, timeStamp:c?.timeStamp});
    }));
    const validated = validateMotion(e, children, sampler.capacity);
    if (!validated.reports.length) {
      recordDelivery(false, validated.reason, 0);
      return;
    }
    // Exactly one filter invocation per real selected callback, with the validated representation.
    this.filter.push(e.movementX, e.movementY, e.timeStamp, validated.quality === "children" ? validated.reports : null);
    this.eventsSince++;
    this.reportsSince += observedChildren || 1;
    const unchanged = this.filter.outX === e.movementX && this.filter.outY === e.movementY;
    // A filtered event keeps its reports' own times when the filter judged them one by one (dropped ones carry 0).
    const split = !unchanged && validated.quality === "children" && this.filter.perReport && this.filter.repN === validated.reports.length;
    const reports = unchanged ? validated.reports
      : split ? validated.reports.map((r, i) => ({movementX:this.filter.repX[i], movementY:this.filter.repY[i], timeStamp:r.timeStamp}))
      : [{movementX:this.filter.outX, movementY:this.filter.outY, timeStamp:e.timeStamp}];
    const quality = unchanged ? validated.quality : split ? "filtered-reports" : "filtered-aggregate";
    entries = Object.freeze(reports.map((r,report) => Object.freeze({movementX:r.movementX, movementY:r.movementY, timeStamp:r.timeStamp, report, k:this.settings.sensitivity*this.settings.m_yaw, pitchK:(this.settings.verticalSensitivityEnabled ? (this.settings.verticalSensitivity ?? this.settings.sensitivity) : this.settings.sensitivity)*this.settings.m_pitch})));
    recordDelivery(true, unchanged ? validated.reason : quality, reports.length, this.filter.outX, this.filter.outY);
    for (const r of entries) {
      this.queue({type:"motion", x:r.movementX, y:r.movementY, k:r.k,
        pitchK:r.pitchK, delivery, report:r.report, quality}, r.timeStamp, arrivalTime);
    }
    this.syncSamplerPreview();
  }

  /** Mouse counts -> view angles, CS:S style: degrees = counts * sensitivity * m_yaw / m_pitch. */
  look(dx: number, dy: number): void {
    if (this.sampler) throw new Error("Direct look is unsupported while sampler is enabled");
    this.previewLook(dx,dy);
  }

  private previewLook(dx: number, dy: number): void {
    if (!(dx || dy)) return;
    const s = this.settings;
    // A changed sensitivity keeps the view where it is: a new base at the current yaw, counted with the new k.
    const k = s.sensitivity * s.m_yaw;
    if (k !== this.yawK) {
      this.commitPending(); // pending motion was counted with the old k
      const at = this.yaw;
      this.yawBase = at;
      this.yawCount = 0;
      this.yawK = k;
      this.yawEpoch++;
      this.yawKind = YAW_SET_SENSITIVITY;
    }
    this.yawCount += dx;
    this.viewPitch += dy * (s.verticalSensitivityEnabled ? (s.verticalSensitivity ?? s.sensitivity) : s.sensitivity) * s.m_pitch;
    this.viewPitch = Math.max(-89, Math.min(89, this.viewPitch));
    if (!this.timedActive) this.cmdPitch = this.viewPitch;
  }

  private press(code: string, repeat: boolean, e: Event, actionCode = code): void {
    if (repeat && this.untilKeyup.has(code)) return;
    if (!repeat) this.untilKeyup.delete(code);
    if (this.ownsKey?.(code)) return void this.untilKeyup.add(code);
    const bound = this.cmdCodes.get(code);
    if (bound !== undefined) {
      // A command bind (console/bind-run.ts): its + commands hold, the rest run once, on the press only.
      e.preventDefault();
      if (repeat || this.cmdHeld.has(code)) return;
      // The real guard (aliases change after binding; toggles switch what a key does): a press that would start a move
      // and a turn is dropped whole, input as before it, and said once in the console.
      if (this.refuseMoveTurn(code, bound)) return;
      this.cmdHeld.set(code, bound);
      this.runChain(code, e, (ops) => runPress(bound, this.aliases, ops));
      return;
    }
    if (this.codeBits.has(code)) {
      // A key not held yet: a press, or a key repeat of one a release-all forgot while it stayed down (blur / focus).
      // Frame-sampled input re-adds it on that repeat too (heldCodes below), so timed input gives it back the same way.
      if (this.timedActive && !this.heldCodes.has(code)) this.timedPress(code, e);
      this.heldCodes.add(code);
      this.queue({type:"key", code, down:true, bits:this.codeBits.get(code)!}, e.timeStamp);
      e.preventDefault();
      return;
    }
    if (repeat) return;
    const a = this.codeAction.get(code);
    if (a) {
      e.preventDefault();
      if (this.timedActive && !this.heldCodes.has(code)) this.timedPress(code, e);
      this.heldCodes.add(code); // for actionHeld
      if (a === "attack" || a === "attack2") this.queue({type:"key", code, down:true, bits:a === "attack" ? IN_ATTACK : IN_ATTACK2}, e.timeStamp);
      else if (!repeat && (a === "turnLeft" || a === "turnRight" || a === "turnFast")) this.queue({type:"key", code, down:true, bits:a === "turnLeft" ? IN_LEFT : a === "turnRight" ? IN_RIGHT : IN_TURN_FAST}, e.timeStamp);
      this.onAction?.(a, actionCode);
    } else this.onKey?.(code);
  }

  /** True while any key bound to non-movement action `a` is held (viewmodel attack auto-repeat). */
  actionHeld(a: Action): boolean {
    if (!this.locked) return false;
    for (const c of this.heldCodes) if (this.codeAction.get(c) === a) return true;
    return false;
  }

  /** What a command bind's + / - / once commands do for physical key `code` (console/bind-run.ts). */
  private chainOps(code: string, e: Event): ChainOps {
    return {
      hold: (a) => this.holdVirtual(`${code}>${a}`, a, e, code),
      unhold: (a, own) => {
        for (const [vc, va] of [...this.virtual]) if (va === a && (!own || vc === `${code}>${a}`)) this.releaseVirtual(vc, e);
      },
      once: (c) => this.onCommand?.(c),
      error: (t) => this.onCommand?.(`echo "${t.replace(/"/g, "'")}"`),
    };
  }

  /**
   * Commands after a `wait` in a key's chain (console/bind-run.ts): the part after k waits runs right after the (k+1)th
   * command that took the key's press, so they land one command later each, as Source runs them a frame later. `t`:
   * the press's time on timed input (a command whose cutoff is before it didn't take the press and doesn't count), else
   * -Infinity (every command counts). Dropped by releaseAll.
   */
  private later: { t: number; step: number; code: string; run: (ops: ChainOps) => void }[] = [];

  /** Runs a chain for key `code` now, its `wait` parts after the following commands. */
  private runChain(code: string, e: Event, run: (ops: ChainOps) => void): void {
    const now = this.chainOps(code, e);
    const t = this.timedActive ? this.ti.stamp(e.timeStamp, performance.now()) : -Infinity;
    let step = -1;
    const at = (f: (o: ChainOps) => void) => (step < 0 ? f(now) : this.later.push({ t, step, code, run: f }));
    run({
      hold: (a, own) => at((o) => o.hold(a, own)),
      unhold: (a, own) => at((o) => o.unhold(a, own)),
      once: (c) => at((o) => o.once(c)),
      error: now.error,
      wait: () => void step++,
    });
  }

  /** After a command with cutoff `cut`: the chain parts waiting for it (runChain), stamped just after its boundary `at`. */
  private runLater(at: number, cut: number): void {
    const due: { code: string; run: (ops: ChainOps) => void }[] = [];
    this.later = this.later.filter((l) => {
      if (l.t > cut) return true;
      if (l.step-- > 0) return true;
      due.push(l);
      return false;
    });
    const e = { timeStamp: at + 0.001, preventDefault() {} } as unknown as Event;
    for (const { code, run } of due) run(this.chainOps(code, e));
  }

  /** Keys whose refused press was already said (code + text: said again only if what the key does changes). */
  private refused = new Set<string>();
  /** True (and said once) when this press of `code` would move and turn (console/bind-run.ts mixesMoveAndTurn). */
  private refuseMoveTurn(code: string, text: string): boolean {
    if (!mixesMoveAndTurn(text, this.aliases)) return false;
    const key = `${code}|${text}|${JSON.stringify(this.aliases)}`;
    if (!this.refused.has(key)) {
      this.refused.add(key);
      this.onCommand?.(`echo "${keyForCode(code)}: ${MOVE_TURN_REFUSAL} Nothing was pressed."`);
    }
    return true;
  }

  /** A command bind's `+x`: virtual key `vc` goes down as a key bound to `a` would (`code`: the physical key). */
  private holdVirtual(vc: string, a: Action, e: Event, code: string): void {
    if (this.virtual.has(vc)) return; // already held by this key (Source: the same key twice is a repeat)
    this.virtual.set(vc, a);
    const bit = ACTION_BITS[a];
    if (bit) this.codeBits.set(vc, bit);
    else this.codeAction.set(vc, a);
    this.press(vc, false, e, code);
  }

  /** Its `-x`: the virtual key comes up. */
  private releaseVirtual(vc: string, e: Event): void {
    if (!this.virtual.has(vc)) return;
    this.releaseCode(vc, e);
    this.virtual.delete(vc);
    this.codeBits.delete(vc);
    this.codeAction.delete(vc);
  }

  /**
   * A wheel notch on a command bind: Source presses and releases a wheel key in one go, and its button still counts
   * for one command ("impulse down"). Here a + command's button pulses for one tick like a wheel bind, a + action
   * fires once, and the release's - commands run (only what they do besides letting go matters).
   */
  private wheelCommand(code: string, e: Event): void {
    const text = this.cmdCodes.get(code)!;
    if (this.refuseMoveTurn(code, text)) return;
    const once = (c: string) => this.onCommand?.(c);
    const pulse: ChainOps = {
      hold: (a) => {
        const bit = ACTION_BITS[a];
        if (bit) {
          this.pulse(bit, e);
          this.queue({type:"pulse", bits:bit}, e.timeStamp);
        } else this.onAction?.(a, code);
      },
      unhold: () => {},
      once,
    };
    runPress(text, this.aliases, pulse);
    runRelease(text, this.aliases, pulse);
  }

  /** Hold jump (toggle) is on: commands hold IN_JUMP. */
  get jumpToggled(): boolean {
    return this.jumpLatched;
  }

  /**
   * Turns Hold jump (toggle) on or off. `quiet`: a release-all, whose sampler reset drops held keys anyway. Off does
   * nothing to a real jump key that is still down: that key keeps the jump held, as in Source.
   */
  setJumpToggle(on: boolean, quiet = false): void {
    if (on === this.jumpLatched) return;
    this.jumpLatched = on;
    if (!quiet) this.queue({type:"key", code:JUMP_TOGGLE_CODE, down:on, bits:IN_JUMP});
    this.onJumpToggle?.(on);
  }

  setBinds(binds: Partial<Record<BindAction, string[]>>, commands: { binds?: Record<string, string>; aliases?: Aliases } = {}): void {
    if (this.sampler) this.releaseAll();
    this.codeBits.clear();
    this.codeAction.clear();
    this.cmdCodes = new Map(Object.entries(commands.binds ?? {}));
    this.aliases = { ...(commands.aliases ?? {}) };
    const weapon: [BindAction, string[]][] = [];
    for (const [action, codes] of Object.entries(binds) as [BindAction, string[]][]) {
      if (!Array.isArray(codes)) continue;
      if (isWeaponAction(action)) {
        weapon.push([action, codes]);
        continue;
      }
      const bit = ACTION_BITS[action];
      for (const c of codes) {
        if (bit) this.codeBits.set(c, (this.codeBits.get(c) ?? 0) | bit);
        else this.codeAction.set(c, action);
      }
    }
    // Weapon keys: only on keys nothing else uses (Settings -> Keys already keeps every key on one action).
    for (const [action, codes] of weapon) for (const c of codes) if (!this.codeBits.has(c) && !this.codeAction.has(c)) this.codeAction.set(c, action);
    // A key with a command bind runs that, not an action (Settings keeps a key in one or the other).
    for (const c of this.cmdCodes.keys()) (this.codeBits.delete(c), this.codeAction.delete(c));
    // Holds a command bind made stay held under the new binds (as held keys do).
    for (const [vc, a] of this.virtual) {
      const bit = ACTION_BITS[a];
      if (bit) this.codeBits.set(vc, bit);
      else this.codeAction.set(vc, a);
    }
    // Held movement keys carry over under the new binds, as frame-sampled input reads them from heldCodes. Every
    // settings write runs this (main.ts prefs.watch): clearing the timed keys here killed a held W/A/S/D until it was
    // pressed again (v0.0.29-0.0.30, GothQueen's dropped keys).
    this.seedTimedKeys();
  }

  /** Requests weapon slot 1..3 (IN_SLOT_*) in the next command only. */
  requestSlot(slot: number): void {
    this.slot = slot & 3;
    this.queue({type:"slot", value:this.slot});
  }

  /** Drops the active gun (IN_DROP) in the next command only. */
  requestDrop(): void {
    this.weaponBits |= IN_DROP;
    this.queue({type:"pulse", bits:IN_DROP});
  }

  /** Reloads (IN_RELOAD) in the next command only. */
  requestReload(): void {
    this.weaponBits |= IN_RELOAD;
    this.queue({type:"pulse", bits:IN_RELOAD});
  }

  /**
   * A weapon command (physics v7, weapon-commands.ts) for weapon `id` in the next command only. A restart's re-give adds
   * the v10 restore flags (weapon-rules.ts GIVE_RESTORE / GIVE_MODE, KeptWeapons).
   */
  requestGive(id: number): void {
    this.give = id & (IN_WEAPON_COMMAND_MASK >>> IN_GIVE_SHIFT);
    this.queue({type:"give", value:this.give});
  }

  /** Releases every held key (e.g. when a chat field takes the keyboard mid-strafe). */
  /**
   * releaseAll, and the keys that were held stay released until the player lets go and presses them again: a key
   * repeat doesn't bring them back (freecam on / off, spectator free look). releaseAll alone lets a repeat restore a
   * key whose keyup was lost to a blur.
   */
  releaseAllUntilKeyup(): void {
    const held = [...this.heldCodes];
    this.releaseAll();
    for (const c of held) this.untilKeyup.add(c);
  }

  /** `code` is bound to a movement key (forward / back / left / right / jump / duck...): it flies a free camera. */
  isMovementCode(code: string): boolean {
    return this.codeBits.has(code);
  }

  releaseAll(): void {
    this.setJumpToggle(false, true);
    // Command binds: every hold goes (a keyup after this releases nothing more), as Source clears its buttons.
    this.cmdHeld.clear();
    this.later = [];
    for (const vc of this.virtual.keys()) (this.codeBits.delete(vc), this.codeAction.delete(vc));
    this.virtual.clear();
    this.resetSampler(performance.now(), "release-all");
    this.untilKeyup.clear();
    this.heldCodes.clear();
    this.mods.clear();
    this.commitPending(); // the view the player sees is the view the next command has
    this.ti.releaseKeys();
    this.ti.clearPulses();
    this.wRelease.reset();
    this.wheelBits = 0;
    this.slot = 0;
    this.weaponBits = 0;
    // (Not a weapon command: !usp typed in chat asks for it just before the chat closes and releases the keys.)
  }

  /** The canvas holds the pointer lock (`locked` is also true while the chat's cursor is free). */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** The chat opened: release the pointer so the cursor can scroll the chat, still playing (free-cursor.ts). */
  freeCursor(): void {
    if (!this.pointerLocked) return;
    setCursorFree(true);
    document.exitPointerLock();
  }

  /**
   * The chat closed: take the lock back (the Enter / click that closed it is user activation; after an Esc, Chromium
   * re-locks without one since the page released the lock itself). Refused: the game pauses (free-cursor.ts). On the
   * next task, so a command the chat line ran first can take the release over (!ssj, takeFreeCursor).
   */
  recapture(): void {
    if (!cursorFree() || cursorHeld()) return;
    setTimeout(async () => {
      if (!cursorFree() || cursorHeld()) return;
      setCursorFree(false);
      if (!(await this.lock())) endFreeCursorAsPause();
    });
  }

  /** True if `code` is bound to any action. */
  isBound(code: string): boolean {
    return this.codeBits.has(code) || this.codeAction.has(code) || this.cmdCodes.has(code);
  }

  /**
   * Null binds (null-binds.ts), as of the last sample(): opposite movement keys go to the one pressed last. heldCodes
   * keeps press order (a Set keeps insertion order; a release deletes the code, key repeat re-adds nothing).
   */
  private nullBinds = false;
  /** Release W on jump (w-release.ts): its per-command state, applied in sample() while the setting is active. */
  private readonly wRelease = new WRelease();

  /**
   * Timed input's command buttons: the timed keys as of the command's cutoff (in press order, for null binds), every
   * other bound key as held now (frame-sampled: jump, duck, use without timed presses), plus the wheel pulse (`pulse`,
   * this command's own, with timed presses; else the frame's). `acts`: the attack and turn-bind buttons the timed keys
   * hold (timed presses), which sample() adds by its own rules.
   */
  private timedHeld(pulse: number): { held: number; acts: number } {
    const pressed: number[] = [];
    for (const c of this.heldCodes) if (!this.timedBitsOf(c)) pressed.push(this.codeBits.get(c) ?? 0);
    let acts = 0;
    for (const c of this.ti.keys) {
      const b = this.pressBits.get(c) ?? this.codeBits.get(c) ?? 0;
      acts |= b & ACTION_PRESS_MASK;
      pressed.push(b & ~ACTION_PRESS_MASK);
    }
    pressed.push(this.timedPresses ? pulse : this.wheelBits);
    if (this.jumpLatched) pressed.push(IN_JUMP); // (no movement axis: null binds pass it through)
    if (this.nullBinds) return { held: resolveNullBinds(pressed), acts };
    let b = 0;
    for (const v of pressed) b |= v;
    return { held: b, acts };
  }

  /** Buttons currently held (for the keys overlay; includes a pending wheel pulse). */
  get held(): number {
    if (this.nullBinds) {
      const pressed: number[] = [];
      for (const c of this.heldCodes) pressed.push(this.codeBits.get(c) ?? 0);
      pressed.push(this.wheelBits); // a wheel pulse is this tick's press: the newest
      if (this.jumpLatched) pressed.push(IN_JUMP);
      return resolveNullBinds(pressed);
    }
    let b = this.wheelBits | (this.jumpLatched ? IN_JUMP : 0);
    for (const c of this.heldCodes) b |= this.codeBits.get(c) ?? 0;
    return b;
  }

  /**
   * The free camera's intent from the held binds (freecam.ts): forward / back / left / right fly along the view, jump
   * rises, duck sinks; Shift faster and Alt slower unless they are bound to one of those. Reads held keys only: nothing
   * here goes into a command.
   */
  freeIntent(): { f: number; r: number; u: number; fast: boolean; slow: boolean } {
    let b = 0;
    for (const c of this.heldCodes) b |= this.codeBits.get(c) ?? 0;
    const bit = (m: number) => (b & m ? 1 : 0);
    const mod = (...codes: string[]) => codes.some((c) => this.mods.has(c) && !this.codeBits.has(c));
    return {
      f: bit(IN_FORWARD) - bit(IN_BACK),
      r: bit(IN_MOVERIGHT) - bit(IN_MOVELEFT),
      u: bit(IN_JUMP) - bit(IN_DUCK),
      fast: mod("ShiftLeft", "ShiftRight"),
      slow: mod("AltLeft", "AltRight"),
    };
  }

  /**
   * Requests pointer lock; resolves true once the canvas holds it, false if the browser refused (no user activation
   * after the player left the lock with Esc, Chrome's ~1 s re-lock cooldown, window not focused). Never throws.
   * play-lock.ts decides what the player sees when it fails.
   */
  async lock(): Promise<boolean> {
    if (this.pointerLocked) return true;
    // Raw (unaccelerated) mouse input where supported, as Aimperion does it: only NotSupportedError means the browser
    // can't do raw (Chromium on Linux, older browsers), and only then a plain, OS-accelerated lock. Any other refusal
    // (SecurityError: a re-lock without user activation, a fullscreen change in flight, focus) is not a capability
    // statement: no lock, and the next click asks for raw again. Before 0.0.17 every refusal fell back to a plain lock,
    // silently: ~30% of the runs of Windows Chromium players who also had raw runs, the sensitivity changing from one
    // lock to the next wherever Windows' pointer speed isn't 6/11 or "Enhance pointer precision" is on. Browsers
    // without the promise can't say why they refused ("error" / "timeout"), so those still try plain.
    if (this.rawInput && !this.rawUnsupported) {
      const refused = await this.request({ unadjustedMovement: true });
      if (!refused) {
        this.lockMode = rawHonoured() ? "raw" : "os";
        this.notePath(true);
        return true;
      }
      this.rawError = refused;
      if (refused !== "NotSupportedError" && refused !== "error" && refused !== "timeout") {
        this.rawRefusals++;
        this.lockMode = "none";
        return false;
      }
      if (refused === "NotSupportedError") this.rawUnsupported = true;
    }
    const ok = !(await this.request());
    this.lockMode = ok ? "os" : "none";
    if (ok) this.notePath(this.rawInput);
    return ok;
  }

  /** A lock was taken (`asked`: with raw input requested): the path it gave, for Settings and the one-time line. */
  private notePath(asked: boolean): void {
    if (this.lockMode === "none") return;
    noteLockPath(this.lockMode, asked);
    if (asked && this.lockMode === "os") this.onOsAccel?.();
  }

  /** Once per rendered frame (rAF time): frame times for the input stats. */
  frame(now: number): void {
    this.framesSince++;
    this.sampler?.evidence({type:'frame', now, arrivalTime:performance.now()});
    this.filter.stats.frame(now, performance.now(), this.locked);
  }

  /**
   * One pointer lock request: null once the canvas holds the lock, else why not (the DOMException's name, "error" or
   * "timeout"). Settled by the promise where there is one (Chromium settles every request, a slow grant during a
   * fullscreen change included: timing it out let the plain fallback race the raw lock), else by pointerlockchange /
   * pointerlockerror (Firefox and Safari return undefined) or a timeout.
   */
  private request(opts?: PointerLockOptions): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (err: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener("pointerlockchange", onChange);
        document.removeEventListener("pointerlockerror", onError);
        resolve(err && document.pointerLockElement !== this.canvas ? err : null);
      };
      const onChange = () => document.pointerLockElement === this.canvas && finish(null);
      const onError = () => finish("error");
      let timer = 0;
      document.addEventListener("pointerlockchange", onChange);
      try {
        const p = (opts ? this.canvas.requestPointerLock(opts) : this.canvas.requestPointerLock()) as Promise<void> | undefined;
        // With a promise, only it says "refused" (a previous request's pointerlockerror can still be in flight).
        if (p && typeof p.then === "function") p.then(() => finish(null), (e) => finish(errName(e)));
        else {
          document.addEventListener("pointerlockerror", onError);
          timer = window.setTimeout(() => finish("timeout"), 1500);
        }
      } catch (e) {
        finish(errName(e));
      }
    });
  }

  /**
   * Builds the command for the next simulation tick. `wRelease`: Release W on jump is active, with the player's
   * pre-tick ground state (w-release.ts); absent: off.
   */
  sample(o: { turnBinds?: boolean; tickInterval?: number; nullBinds?: boolean; wRelease?: WReleaseContext; at?: number } = {}): UserCmd {
    if (this.sampler) throw new Error("Use pumpSampler(now) while the sampler is enabled");
    this.nullBinds = !!o.nullBinds;
    // Timed input: this tick's share of the motion and key edges (`at`: its boundary, main.ts frame()).
    const timed = this.timedActive;
    const presses = timed && this.timedPresses;
    let taken = { events: this.eventsSince, reports: this.reportsSince, pulse: 0 };
    if (timed) {
      taken = this.ti.take(o.at, (_x, p) => (this.cmdPitch = Math.max(-89, Math.min(89, this.cmdPitch + p))));
      taken.events += this.carryEvents;
      taken.reports += this.carryReports;
    }
    this.carryEvents = this.carryReports = 0;
    // Keep mouse counts intact: replay analysis can check the fixed turn separately from mouse movement. A spawn,
    // teleport, pusher, sensitivity or raw set in this tick retains its own reason (including unexplained raw sets).
    const { held, acts } = timed ? this.timedHeld(taken.pulse) : { held: this.held, acts: 0 };
    // Timed presses: the attack and turn binds as held at this command's cutoff; else as held now.
    const holds = (a: Action, bit: number) => (presses ? this.locked && (acts & bit) !== 0 : this.actionHeld(a));
    let turn = 0;
    this.lastTurn = 0;
    if (o.turnBinds && o.tickInterval && this.locked) {
      const left = holds("turnLeft", IN_LEFT), right = holds("turnRight", IN_RIGHT);
      if (left !== right) turn = left ? IN_LEFT : IN_RIGHT;
      if (turn) {
        // Fast turn only goes on a command that turns (a lone IN_TURN_FAST is never recorded).
        if (holds("turnFast", IN_TURN_FAST)) turn |= IN_TURN_FAST;
        this.lastTurn = turnDelta(turn, o.tickInterval, this.turnSpeed);
        this.yawBase = norm360(this.yawBase + this.lastTurn);
        this.yawKind = this.yawEpoch === this.sampledYawEpoch ? YAW_SET_TURN : this.yawKind | YAW_WITH_TURN;
        this.yawEpoch++;
      }
    }
    // The knife binds are actions (the viewmodel swings on them), not movement bits: add their buttons here.
    // A weapon slot request (requestSlot) goes into this one command only.
    let buttons = held | turn | (holds("attack", IN_ATTACK) ? IN_ATTACK : 0) | (holds("attack2", IN_ATTACK2) ? IN_ATTACK2 : 0) | (this.slot << IN_SLOT_SHIFT) | this.weaponBits | (this.give << IN_GIVE_SHIFT);
    // Release W on jump: only the forward bit changes, and forwardmove follows it below.
    if (o.wRelease) buttons = this.wRelease.apply(buttons, o.wRelease);
    else this.wRelease.reset();
    this.wheelBits = 0;
    this.slot = 0;
    this.weaponBits = 0;
    this.give = 0;
    const speed = 450; // cl_forwardspeed / cl_sidespeed (CS:S default); clamped by maxspeed in movement
    let forwardmove = 0;
    let sidemove = 0;
    if (buttons & IN_FORWARD) forwardmove += speed;
    if (buttons & IN_BACK) forwardmove -= speed;
    if (buttons & IN_MOVERIGHT) sidemove += speed;
    if (buttons & IN_MOVELEFT) sidemove -= speed;
    // Timed: the counts this command took (the camera also shows the pending ones), the events / reports they came in.
    const count = timed ? this.yawCount - this.ti.pendingX : this.yawCount;
    const look: LookSample = {
      base: this.yawBase, count, k: this.yawK, epoch: this.yawEpoch, kind: this.yawKind,
      frames: this.framesSince, events: taken.events, reports: taken.reports,
    };
    this.framesSince = this.eventsSince = this.reportsSince = 0;
    this.sampledYawEpoch = this.yawEpoch;
    const pitch = timed ? this.cmdPitch : this.pitch;
    // (a chain's `wait`: from the next command that took its press)
    if (this.later.length) this.runLater(o.at ?? performance.now(), timed && o.at !== undefined ? o.at - this.ti.holdbackMs : Infinity);
    return { pitch, yaw: countedYaw(this.yawBase, count, this.yawK), forwardmove, sidemove, buttons, look, ...(this.nullBinds ? { nullBinds: true } : {}), ...(timed ? { timed: true } : {}), ...(presses ? { timedPresses: true } : {}), ...(o.wRelease ? { wRelease: true } : {}) };
  }
}
