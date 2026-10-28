// The Main menu bind (Settings → Keys → Run, unbound by default): leaves for the main menu straight from the game.
// During a timed run it has to be held, like hold-to-restart: the same ring fills around the crosshair and letting go
// early says "Hold <key> to leave" (hud/restart-ring.ts). Before the start, after a finish or while spectating it
// leaves at once. A bind that can't be held (the mouse wheel) falls back to pressing it twice within CONFIRM_MS.
// DOM-free; main.ts wires it to the input, the ring and the menu. The pause menu's button and its Backspace key never ask.

import { RestartHold } from "./restart-hold";

/** How long the key is held to leave mid-run. */
export const LEAVE_HOLD_MS = 600;
/** How long the "press again" window stays open (wheel binds). */
export const CONFIRM_MS = 2000;

export class LeaveConfirm {
  private armedAt = -Infinity;

  constructor(readonly windowMs = CONFIRM_MS) {}

  /** A press at `now` (ms): "leave" now, or "ask" (the caller says to press again; the next press in time leaves). */
  press(now: number, runInProgress: boolean): "leave" | "ask" {
    if (!runInProgress || now - this.armedAt <= this.windowMs) {
      this.armedAt = -Infinity;
      return "leave";
    }
    this.armedAt = now;
    return "ask";
  }
}

/** What the hold draws on: the crosshair ring (hud/restart-ring.ts). */
export interface HoldRing {
  show(progress: number): void;
  flash(text: string): void;
  hide(): void;
}

export class LeaveHold {
  private hold = new RestartHold<"mainMenu">(LEAVE_HOLD_MS);
  private confirm = new LeaveConfirm();

  constructor(
    private o: {
      /** A key bound to Main menu is down (and the pointer is locked). */
      held: () => boolean;
      ring: HoldRing;
      leave: () => void;
      /** Label of the Main menu key ("Q"). */
      key: () => string;
      /** For a bind that can't be held: say "press again". */
      ask: (text: string) => void;
    },
  ) {}

  /** The Main menu key at `now`: leaves at once outside a run, else starts the hold. */
  press(now: number, runInProgress: boolean): void {
    if (!runInProgress) return this.o.leave();
    if (!this.o.held()) {
      // A wheel bind: no key stays down to hold.
      if (this.confirm.press(now, true) === "leave") this.o.leave();
      else this.o.ask(`${this.o.key()} again to leave`);
      return;
    }
    this.hold.begin("mainMenu", now);
    this.o.ring.show(this.hold.progress(now));
  }

  /** Every frame. `suspended`: the pointer isn't locked, a text field has focus or the replay viewer is open. */
  frame(now: number, suspended: boolean): void {
    if (!this.hold.active) return;
    if (suspended) {
      this.hold.cancel();
      this.o.ring.hide();
      return;
    }
    const r = this.hold.update(now, this.o.held());
    if (r?.result === "fire") {
      this.o.ring.hide();
      this.o.leave();
    } else if (r?.result === "tap") this.o.ring.flash(`Hold ${this.o.key()} to leave`);
    else this.o.ring.show(this.hold.progress(now));
  }
}
