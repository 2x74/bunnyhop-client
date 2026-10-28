// Hold to restart (Settings → Keys, off by default): with it on, the restart keys (R / B / M, whatever they're bound
// to) fire after a short hold instead of on press, so a stray press can't throw a run away. DOM-free state machine;
// restart-guard.ts wires it to the input and the HUD ring. It only delays *when* the existing restart action fires:
// nothing here reaches the sim or the replay (restart keys are non-movement binds and never part of a command).

/** How long a restart key must be held when "Hold to restart" is on. */
export const HOLD_MS = 500;

export type HoldResult<A> = { action: A; result: "fire" | "tap" } | null;

export class RestartHold<A extends string = string> {
  private cur: { action: A; start: number } | null = null;

  constructor(readonly holdMs = HOLD_MS) {}

  /** The action being held, if any. */
  get active(): A | null {
    return this.cur?.action ?? null;
  }

  /** A press of `action` at `now` (ms) starts its hold. Already holding that action (a second bound key): no-op. */
  begin(action: A, now: number): void {
    if (this.cur?.action === action) return;
    this.cur = { action, start: now };
  }

  /** 0..1 of the current hold (0 when idle). */
  progress(now: number): number {
    if (!this.cur) return 0;
    return Math.min(1, Math.max(0, (now - this.cur.start) / this.holdMs));
  }

  /**
   * Per frame while holding: `held` = a key bound to the action is still down. "fire" once the hold completes (the
   * caller runs the action, once), "tap" when it was released early (cancelled), else null (still holding / idle).
   */
  update(now: number, held: boolean): HoldResult<A> {
    const c = this.cur;
    if (!c) return null;
    if (now - c.start >= this.holdMs) {
      this.cur = null;
      return { action: c.action, result: "fire" };
    }
    if (!held) {
      this.cur = null;
      return { action: c.action, result: "tap" };
    }
    return null;
  }

  /** Drops the hold without a result (pointer lock / focus lost, pause, chat, replay viewer). */
  cancel(): void {
    this.cur = null;
  }
}
