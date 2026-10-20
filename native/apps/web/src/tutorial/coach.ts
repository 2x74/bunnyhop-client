// The tutorial's coach: watches the strafe meter tick by tick and names the one thing going wrong, if anything
// ("let go of W", "mouse and key the same way", ...). A nudge needs its condition to hold for a moment (no flicker on
// a single bad tick) and stays up for a moment after it clears, so it can be read. DOM-free, from sim state only.

import type { LessonId } from "./data";
import { EVENT_TELEPORTED, type StrafeMeter, type TickInfo } from "./goals";

export type Nudge = "forward" | "opposite" | "mouse-left" | "mouse-right" | "key-left" | "key-right" | "slower" | "keep-holding" | "scroll-on-land" | "edge";

/** Ticks a condition must hold before its nudge shows, and ticks a nudge stays up after. */
const HOLD: Partial<Record<Nudge, number>> = { forward: 20, opposite: 25, "mouse-left": 45, "mouse-right": 45, "key-left": 45, "key-right": 45, slower: 60 };
const LINGER = 160;
/** Event nudges (a broken hop chain, a fall) stay this long. */
const EVENT_TICKS = 260;
const TURNING = 25; // degrees per second of smoothed mouse turn that counts as turning

export class Coach {
  nudge: Nudge | null = null;
  /** Ticks standing about (on the ground, slow): the lesson's instruction comes back. */
  idleTicks = 0;
  /** The condition seen this tick (the first that holds, in order of importance) and for how many ticks in a row. */
  private candidate: Nudge | null = null;
  private count = 0;
  private left = 0;

  constructor(private legit = false) {}

  reset(): void {
    this.nudge = null;
    this.candidate = null;
    this.count = this.left = this.idleTicks = 0;
  }

  /** Shows `n` for `ticks` (replaces a lingering one). */
  private show(n: Nudge, ticks = LINGER): void {
    this.nudge = n;
    this.left = ticks;
  }

  /** `breaksBefore`: the meter's broken-chain count before this tick; `done`: the lesson's goal is met. */
  update(lesson: LessonId, t: TickInfo, m: StrafeMeter, breaksBefore: number, done: boolean): void {
    this.idleTicks = m.grounded && m.speed < 40 ? this.idleTicks + 1 : 0;
    if (this.left > 0 && --this.left === 0) this.nudge = null;
    if (t.events & EVENT_TELEPORTED) {
      // A fall on the final course: one tip about take-off. Anywhere else a teleport is a restart.
      if (lesson === "final" && t.pre.position[2] < -8) this.show("edge", EVENT_TICKS);
      else this.reset();
      return;
    }
    if (lesson === "jump") {
      if (!done && m.breaks > breaksBefore && m.jumps > 1) this.show(this.legit ? "scroll-on-land" : "keep-holding", EVENT_TICKS);
      return;
    }
    const c = this.condition(lesson, m, done);
    this.count = c && c === this.candidate ? this.count + 1 : c ? 1 : 0;
    this.candidate = c;
    if (c && this.count >= (HOLD[c] ?? 1)) this.show(c);
  }

  private condition(lesson: LessonId, m: StrafeMeter, done: boolean): Nudge | null {
    if (!m.airborne) return null;
    // On the final course, W-only hops are fine for the gaps: only W with a strafe key costs speed.
    if (m.forwardInAir && (lesson !== "final" || m.key !== 0)) return "forward";
    if (done || lesson === "final") return null;
    const turning = Math.abs(m.turnRate) > TURNING ? Math.sign(m.turnRate) : 0; // + = left
    if (m.key !== 0 && turning !== 0 && Math.sign(-m.key) !== turning) return "opposite";
    if (m.key !== 0 && Math.abs(m.turnRate) < 8) return m.key < 0 ? "mouse-left" : "mouse-right";
    if (m.key === 0 && turning !== 0) return turning > 0 ? "key-left" : "key-right";
    if (m.key !== 0 && m.band > 1.4 && m.gain < 0) return "slower";
    return null;
  }
}
