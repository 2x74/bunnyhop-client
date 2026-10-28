// Hold to restart (Settings → Keys, off by default; restart-hold.ts has the state machine). main.ts routes the restart
// keys through RestartGuard.press(). Only *when* the existing restart fires changes: the restart itself (and what the
// replay records) is untouched. Chat commands (!r / !b) stay instant.

import type { Input } from "./input";
import { isTextField } from "./input";
import { RestartRing } from "./hud/restart-ring";
import { RestartHold } from "./restart-hold";
import { keyLabel, prefs, type Action } from "./ui/settings";

export type GuardedAction = "restart" | "restartBonus" | "restartMain";
const GUARDED: readonly Action[] = ["restart", "restartBonus", "restartMain"];
const VERB: Record<GuardedAction, string> = { restart: "restart", restartBonus: "switch track", restartMain: "go to the main track" };

/** Label of the first holdable key bound to `a` ("R"). */
function bindLabel(a: Action): string {
  const codes = prefs.get().binds[a] ?? [];
  const code = codes.find((c) => !c.startsWith("MWheel") && c !== "MouseWheel") ?? codes[0];
  return code ? keyLabel(code) : "the key";
}

export class RestartGuard {
  private hold = new RestartHold<GuardedAction>();
  /** The ring around the crosshair (also leave-confirm.ts's hold to leave). */
  readonly ring: RestartRing;

  constructor(private o: { input: Input; fire: (a: GuardedAction) => void }) {
    this.ring = new RestartRing(document.getElementById("hud")!);
  }

  /** input.onAction for the restart keys: true if a hold started (it fires later), false to run it now as before. */
  press(a: Action): boolean {
    if (!prefs.get().holdRestart || !GUARDED.includes(a)) return false;
    // A press that can't be held (a wheel bind: no key stays down) acts right away.
    if (!this.o.input.actionHeld(a)) return false;
    const now = performance.now();
    this.hold.begin(a as GuardedAction, now);
    this.ring.show(this.hold.progress(now));
    return true;
  }

  /** Every frame. `suspended`: the replay viewer is open (the run is paused). */
  frame(now: number, suspended: boolean): void {
    const a = this.hold.active;
    if (!a) return;
    const input = this.o.input;
    // Pause menu / focus loss (pointer lock released), chat or another text field, the replay viewer: cancel.
    if (suspended || !input.locked || isTextField(document.activeElement)) {
      this.hold.cancel();
      this.ring.hide();
      return;
    }
    const r = this.hold.update(now, input.actionHeld(a));
    if (r?.result === "fire") {
      this.ring.hide();
      this.o.fire(r.action);
    } else if (r?.result === "tap") this.ring.flash(`Hold ${bindLabel(r.action)} to ${VERB[r.action]}`);
    else this.ring.show(this.hold.progress(now));
  }
}
