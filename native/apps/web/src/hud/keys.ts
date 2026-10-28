// Keys overlay ("showkeys"): W A S D, duck, jump and mouse-turn arrows, driven by the commands the
// simulation actually received (one feed() per tick), so live play, replays and the ghost all show
// exactly what was simulated. A press that starts and ends between two rendered frames (a scroll
// notch = one tick of +jump) still shows: every rising edge plays a short flash.

import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT } from "../input";
import { h } from "../ui/dom";
import type { KeysPrefs } from "./layout";

/** Virtual bits for the mouse-turn arrows (above the 16-bit button field). */
const TURN_L = 1 << 16;
const TURN_R = 1 << 17;
/** A turn arrow stays lit this many ticks after the last tick with yaw movement that way. */
const TURN_HOLD = 3;

const KEYS: [label: string, bit: number, cls: string, row: "wasd" | "actions" | "mouse"][] = [
  ["W", IN_FORWARD, "k-w", "wasd"],
  ["A", IN_MOVELEFT, "k-a", "wasd"],
  ["S", IN_BACK, "k-s", "wasd"],
  ["D", IN_MOVERIGHT, "k-d", "wasd"],
  ["DUCK", IN_DUCK, "k-duck", "actions"],
  ["JUMP", IN_JUMP, "k-jump", "actions"],
  ["◀", TURN_L, "k-ml", "mouse"],
  ["▶", TURN_R, "k-mr", "mouse"],
];

const FLASH: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
const FLASH_OPTS: KeyframeAnimationOptions = { duration: 110, easing: "ease-out" };

export class KeysOverlay {
  readonly el: HTMLElement;
  private keyEls: HTMLElement[] = [];
  private flashEls: HTMLElement[] = [];
  /** Bits currently rendered as pressed (DOM starts with none). */
  private shown = 0;
  /** Buttons of the most recent tick. */
  private latest = 0;
  private prevButtons = 0;
  /** Rising edges since the last render. */
  private edges = 0;
  private prevYaw = NaN;
  private tickNo = 0;
  private lastLeft = -1e9;
  private lastRight = -1e9;
  private dirty = true;

  constructor(caption?: string) {
    this.el = h("div.keys", { "aria-hidden": "true" });
    if (caption) this.el.append(h("span.keys-cap", null, caption));
    for (const [label, , cls] of KEYS) {
      const fl = h("i.fl", null, label);
      const k = h(`span.k.${cls}`, null, h("b", null, label), fl);
      this.keyEls.push(k);
      this.flashEls.push(fl);
      this.el.append(k);
    }
  }

  configure(k: KeysPrefs): void {
    const e = this.el;
    e.classList.remove("ks-classic", "ks-keycaps", "ks-minimal");
    e.classList.add(`ks-${k.style}`);
    e.classList.toggle("no-wasd", !k.rows.wasd);
    e.classList.toggle("no-actions", !k.rows.actions);
    e.classList.toggle("no-mouse", !k.rows.mouse);
    e.style.setProperty("--k-on", k.pressed);
    e.style.setProperty("--k-idle", k.idle);
    e.style.opacity = String(k.opacity);
  }

  /** One simulated tick: the command's buttons and view yaw (degrees). */
  feed(buttons: number, yaw: number): void {
    this.tickNo++;
    if (this.prevYaw === this.prevYaw) {
      let d = yaw - this.prevYaw;
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      // Yaw increases turning left (Source convention).
      if (d > 0) this.lastLeft = this.tickNo;
      else if (d < 0) this.lastRight = this.tickNo;
    }
    this.prevYaw = yaw;
    let b = buttons & 0xffff;
    if (this.tickNo - this.lastLeft < TURN_HOLD) b |= TURN_L;
    if (this.tickNo - this.lastRight < TURN_HOLD) b |= TURN_R;
    this.edges |= b & ~this.prevButtons;
    this.prevButtons = b;
    this.latest = b;
    this.dirty = true;
  }

  /** Forget history (after a reset / seek) without flashing. */
  reset(buttons = 0, yaw = NaN): void {
    this.prevYaw = yaw;
    this.prevButtons = this.latest = buttons & 0xffff;
    this.edges = 0;
    this.lastLeft = this.lastRight = -1e9;
    this.dirty = true;
  }

  /** Shows a fixed state (layout editor preview). */
  preview(bits: number): void {
    this.latest = bits;
    this.edges = 0;
    this.dirty = true;
  }

  /** Per rendered frame; touches the DOM only when something changed. */
  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const now = this.latest;
    if (now !== this.shown) {
      const changed = now ^ this.shown;
      for (let i = 0; i < KEYS.length; i++) if (changed & KEYS[i][1]) this.keyEls[i].classList.toggle("on", !!(now & KEYS[i][1]));
      this.shown = now;
    }
    const e = this.edges;
    if (e) {
      this.edges = 0;
      // Every press flashes, so a one-tick press (wheel jump, sub-frame tap) is visible even if it
      // started and ended between two frames. Under a held key the flash is invisible.
      for (let i = 0; i < KEYS.length; i++) if (e & KEYS[i][1]) this.flashEls[i].animate(FLASH, FLASH_OPTS);
    }
  }
}

export const PREVIEW_BITS = IN_FORWARD | IN_MOVERIGHT | IN_JUMP | TURN_R;
