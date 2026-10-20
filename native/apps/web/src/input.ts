// Mouse/keyboard input mapped to Source-style user commands.
// Sensitivity matches CS:S: degrees = counts * sensitivity * m_yaw (0.022).
//
// Binds are KeyboardEvent.code strings plus mouse pseudo-codes: Mouse1..Mouse5 (buttons, Source's names: binds.ts mouseCode),
// MWheelUp / MWheelDown, and MouseWheel (either direction). Wheel binds pulse for one tick,
// like `bind mwheeldown +jump` in CS:S.

import type { Action } from "./ui/settings";
import { DEFAULT_BINDS, isWeaponAction, mouseCode, type BindAction } from "./binds";
import { cursorFree, endFreeCursorAsPause, setCursorFree } from "./free-cursor";
import { MouseFilter, type MotionSample } from "./mouse-filter";
import { IN_GIVE_SHIFT, IN_WEAPON_COMMAND_MASK } from "./weapon-rules";
import { countedYaw, norm360, YAW_SET_RAW, YAW_SET_SENSITIVITY, YAW_SET_SPAWN, type LookSample } from "./replay";
import { NativeMouse } from "./native-input";

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
/**
 * Above this many raw updates a second the uncapped loop goes back to pointermove for the session (Aimperion
 * RAW_MAX_HZ): an 8 kHz mouse dispatches 8,000 events a second on the main thread for frames that can't use them all.
 */
const RAW_MAX_HZ = 2000;
/** Raw updates silent this long while pointermove still carries motion: the raw stream stalled, pointermove takes over. */
const RAW_STALL_MS = 250;
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
  use: IN_USE,
};

export { DEFAULT_BINDS } from "./binds";

/** Key events aimed at a text input / textarea / contenteditable (not game input). */
export function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

export class Input {
  settings: InputSettings = { sensitivity: 2, m_yaw: 0.022, m_pitch: 0.022 };
  /** Request raw (unaccelerated) mouse input when locking. */
  rawInput = true;
  pitch = 0;
  /**
   * The view yaw is counted (v8 replays, replay.ts countedYaw): an exact base plus the whole mouse counts since it,
   * yaw = norm360(base - count * k) with k = sensitivity * m_yaw. Anything that sets the view (spawn, teleport, a
   * rotating pusher, a sensitivity change) starts a new base (setYaw); plain assignment to `yaw` does too, as a raw set.
   */
  private yawBase = 0;
  private yawCount = 0;
  private yawK = 0.044;
  private yawEpoch = 0;
  private yawKind = YAW_SET_SPAWN;
  /** v8 input stats since the last command: rAF frames, motion events, mouse reports. */
  private framesSince = 0;
  private eventsSince = 0;
  private reportsSince = 0;
  get yaw(): number {
    return countedYaw(this.yawBase, this.yawCount, this.yawK);
  }
  set yaw(v: number) {
    this.setYaw(v, YAW_SET_RAW);
  }
  /** Sets the view yaw (a new counted base): `kind` says what set it (replay.ts YAW_SET_*). */
  setYaw(v: number, kind: number): void {
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
  private readonly nativeMouse = new NativeMouse(typeof window === "undefined" ? undefined : window.bunnyhopNativeInput);
  private browserLockMode: "raw" | "os" = "os";
  /** The native backend name when available; empty in ordinary browsers. */
  get nativeBackend(): string { return this.nativeMouse.backend; }

  constructor(private canvas: HTMLCanvasElement) {
    this.setBinds(DEFAULT_BINDS);
    document.addEventListener("pointerlockchange", () => {
      this.locked = this.pointerLocked || cursorFree();
      if (this.pointerLocked) {
        this.motionSource = 0;
        this.useRaw = this.rawUpdates && HAS_RAW_UPDATE && !this.rawTripped;
        this.skipNextMove = false;
        this.filter.rearm(performance.now());
      } else {
        this.nativeMouse.stop();
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
    document.addEventListener("pointermove", (e) => e.pointerType === "mouse" && this.motion(e, 1), { passive: true });
    document.addEventListener("mousemove", (e) => this.motion(e, 2), { passive: true });
    if (HAS_RAW_UPDATE) document.addEventListener("pointerrawupdate" as "pointermove", (e) => this.useRaw && e.pointerType === "mouse" && this.motion(e, 3), { passive: true });
    // Fullscreen in / out or a resize while locked can re-centre the hidden cursor (OS-accelerated locks): a jump. So
    // can the window coming back to the front with the lock kept. The view's size sizes the re-centre rule.
    const rearm = () => this.pointerLocked && this.filter.rearm(performance.now());
    const view = () => this.filter.setView(innerWidth, innerHeight);
    view();
    addEventListener("resize", () => (view(), rearm()));
    document.addEventListener("fullscreenchange", () => (view(), rearm()));
    // Browsers can lose keyup while the window is inactive without immediately dropping pointer lock.
    // Discard held input on departure and return; subsequent key events can resume movement.
    addEventListener("blur", () => { this.nativeMouse.stop(); this.releaseAll(); });
    addEventListener("focus", () => {
      this.releaseAll(); rearm();
      if (this.pointerLocked && this.rawInput) void this.startNativeMouse();
    });
    document.addEventListener("visibilitychange", () => {
      this.releaseAll();
      if (document.visibilityState !== "visible") this.nativeMouse.stop();
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
        if (!this.pointerLocked) return;
        const delta = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
        if (delta === 0) return;
        const dir = delta < 0 ? "MWheelUp" : "MWheelDown";
        const bits = (this.codeBits.get(dir) ?? 0) | (this.codeBits.get("MouseWheel") ?? 0);
        this.wheelBits |= bits;
        const code = this.codeAction.has(dir) ? dir : "MouseWheel";
        const a = this.codeAction.get(code);
        if (a) this.onAction?.(a, code);
      },
      { passive: true },
    );
    document.addEventListener("mousedown", (e) => {
      if (this.pointerLocked) this.press(mouseCode(e.button), false, e);
    });
    document.addEventListener("mouseup", (e) => this.heldCodes.delete(mouseCode(e.button)));
    document.addEventListener("keydown", (e) => {
      // Typing into a text field (the chat, with the game still playing) never moves the player or fires binds.
      if (this.locked && !isTextField(e.target)) this.press(e.code, e.repeat, e);
    });
    document.addEventListener("keyup", (e) => this.heldCodes.delete(e.code));
  }

  /** Which event carries motion during this lock (diagnostics). */
  get motionEvent(): "pointermove" | "mousemove" | "pointerrawupdate" | "native" | "none" {
    if (this.nativeMouse.active) return "native";
    return this.motionSource === 1 ? "pointermove" : this.motionSource === 2 ? "mousemove" : this.motionSource === 3 ? "pointerrawupdate" : "none";
  }

  /** One motion event from `source` (1 pointermove, 2 mousemove, 3 pointerrawupdate): filtered, then turned into view angles. */
  private motion(e: MouseEvent, source: 1 | 2 | 3): void {
    if (!this.pointerLocked || this.nativeMouse.active || this.nativeMouse.pending) return;
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
    f.push(dx, dy, e.timeStamp, source !== 2 && (f.enabled || this.collectReports) ? reports : null);
    this.eventsSince++;
    this.reportsSince += reports ? reports.length : 1;
    this.look(f.outX, f.outY);
  }

  /** Mouse counts -> view angles, CS:S style: degrees = counts * sensitivity * m_yaw / m_pitch. */
  look(dx: number, dy: number): void {
    if (!(dx || dy)) return;
    const s = this.settings;
    // A changed sensitivity keeps the view where it is: a new base at the current yaw, counted with the new k.
    const k = s.sensitivity * s.m_yaw;
    if (k !== this.yawK) {
      const at = this.yaw;
      this.yawBase = at;
      this.yawCount = 0;
      this.yawK = k;
      this.yawEpoch++;
      this.yawKind = YAW_SET_SENSITIVITY;
    }
    this.yawCount += dx;
    this.pitch += dy * (s.verticalSensitivityEnabled ? (s.verticalSensitivity ?? s.sensitivity) : s.sensitivity) * s.m_pitch;
    this.pitch = Math.max(-89, Math.min(89, this.pitch));
  }

  private press(code: string, repeat: boolean, e: Event): void {
    if (this.codeBits.has(code)) {
      this.heldCodes.add(code);
      e.preventDefault();
      return;
    }
    if (repeat) return;
    const a = this.codeAction.get(code);
    if (a) {
      e.preventDefault();
      this.heldCodes.add(code); // for actionHeld (no button bits: never part of a command)
      this.onAction?.(a, code);
    } else this.onKey?.(code);
  }

  /** True while any key bound to non-movement action `a` is held (viewmodel attack auto-repeat). */
  actionHeld(a: Action): boolean {
    if (!this.locked) return false;
    for (const c of this.heldCodes) if (this.codeAction.get(c) === a) return true;
    return false;
  }

  setBinds(binds: Partial<Record<BindAction, string[]>>): void {
    this.codeBits.clear();
    this.codeAction.clear();
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
  }

  /** Requests weapon slot 1..3 (IN_SLOT_*) in the next command only. */
  requestSlot(slot: number): void {
    this.slot = slot & 3;
  }

  /** Drops the active gun (IN_DROP) in the next command only. */
  requestDrop(): void {
    this.weaponBits |= IN_DROP;
  }

  /** Reloads (IN_RELOAD) in the next command only. */
  requestReload(): void {
    this.weaponBits |= IN_RELOAD;
  }

  /**
   * A weapon command (physics v7, weapon-commands.ts) for weapon `id` in the next command only. A restart's re-give adds
   * the v10 restore flags (weapon-rules.ts GIVE_RESTORE / GIVE_MODE, KeptWeapons).
   */
  requestGive(id: number): void {
    this.give = id & (IN_WEAPON_COMMAND_MASK >>> IN_GIVE_SHIFT);
  }

  /** Releases every held key (e.g. when a chat field takes the keyboard mid-strafe). */
  releaseAll(): void {
    this.heldCodes.clear();
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
    if (!cursorFree()) return;
    setTimeout(async () => {
      if (!cursorFree()) return;
      setCursorFree(false);
      if (!(await this.lock())) endFreeCursorAsPause();
    });
  }

  /** True if `code` is bound to any action. */
  isBound(code: string): boolean {
    return this.codeBits.has(code) || this.codeAction.has(code);
  }

  /** Buttons currently held (for the keys overlay; includes a pending wheel pulse). */
  get held(): number {
    let b = this.wheelBits;
    for (const c of this.heldCodes) b |= this.codeBits.get(c) ?? 0;
    return b;
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
        this.browserLockMode = this.lockMode = rawHonoured() ? "raw" : "os";
        await this.startNativeMouse();
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
    this.browserLockMode = "os";
    if (ok && this.rawInput) await this.startNativeMouse();
    return ok;
  }

  private async startNativeMouse(): Promise<void> {
    const active = await this.nativeMouse.start();
    if (!this.pointerLocked) return;
    if (active) {
      this.lockMode = "raw";
      this.useRaw = false;
      this.motionSource = 0;
      this.filter.rearm(performance.now());
    }
  }

  /** Once per rendered frame (rAF time): frame times for the input stats. */
  frame(now: number): void {
    if (this.pointerLocked && this.nativeMouse.active) {
      const samples = this.nativeMouse.drain(performance.now());
      const reports: MotionSample[] = [];
      let dx = 0, dy = 0;
      for (const sample of samples) {
        if (![sample.dx, sample.dy, sample.time].every(Number.isFinite)) continue;
        if (!(sample.dx || sample.dy)) continue;
        dx += sample.dx;
        dy += sample.dy;
        reports.push({ movementX: sample.dx, movementY: sample.dy, timeStamp: sample.time - performance.timeOrigin });
      }
      if (reports.length) {
        this.filter.push(dx, dy, reports[reports.length - 1].timeStamp, reports);
        this.eventsSince++;
        this.reportsSince += reports.length;
        this.look(this.filter.outX, this.filter.outY);
      }
      if (!this.nativeMouse.active) {
        this.lockMode = this.browserLockMode;
        this.rawError = this.nativeMouse.error;
        this.motionSource = 1;
        this.skipNextMove = true;
      }
    }
    this.framesSince++;
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

  /** Builds the command for the next simulation tick. */
  sample(): UserCmd {
    // The knife binds are actions (the viewmodel swings on them), not movement bits: add their buttons here.
    // A weapon slot request (requestSlot) goes into this one command only.
    const buttons = this.held | (this.actionHeld("attack") ? IN_ATTACK : 0) | (this.actionHeld("attack2") ? IN_ATTACK2 : 0) | (this.slot << IN_SLOT_SHIFT) | this.weaponBits | (this.give << IN_GIVE_SHIFT);
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
    const look: LookSample = {
      base: this.yawBase, count: this.yawCount, k: this.yawK, epoch: this.yawEpoch, kind: this.yawKind,
      frames: this.framesSince, events: this.eventsSince, reports: this.reportsSince,
    };
    this.framesSince = this.eventsSince = this.reportsSince = 0;
    return { pitch: this.pitch, yaw: this.yaw, forwardmove, sidemove, buttons, look };
  }
}
