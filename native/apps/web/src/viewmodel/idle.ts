// Hand-level idle for the knife viewmodel (v0.0.38): the life goes into the hand, not the screen. While the knife is
// idle the wrist relaxes and firms up again (a degree or two of flex and deviation on slow, uneven periods), the grip
// eases a little (the index and pinky lift a few degrees off the handle and take it again), and after an action ends
// (a swing, the draw, an inspect) the wrist settles: a small, quickly damped give, as if the hand let the knife's weight
// back into the fist. Nothing moves the view, the arm or the knife's place in the frame; the hand turns about its wrist.
//
// Deterministic: fixed phases on the viewmodel's own clock (replays and exports repeat exactly; no randomness).
// Bob amount scales it (0 = still, like the rest of the bob), reduced motion scales it down like the other feel.
// Runs after the grip solve (knives/hold.ts) and before the finger safety clamp, so fingers only ever open from the
// solved grip (never into the handle).

import type { Arm } from "./inspects/kit";
import { springStep } from "./feel";

/** Fade in once idle (s), fade out when anything else starts (s). */
const FADE_IN = 0.6;
const FADE_OUT = 0.08;
/** The settle spring (rad/s, damping) and the kick (deg/s of wrist flex) when an action hands back to idle. */
const SETTLE_W = 15;
const SETTLE_Z = 0.42;
const SETTLE_KICK = 34;

export class HandIdle {
  private w = 0;
  private wasIdle = true;
  private sx = new Float64Array(1);
  private sv = new Float64Array(1);

  /** Back to rest (a replay seek, a knife change). */
  reset(): void {
    this.w = 0;
    this.wasIdle = true;
    this.sx[0] = this.sv[0] = 0;
  }

  /**
   * Advances by dt. `idle`: the knife is in its idle (no swing, draw or inspect showing); `amount`: Bob amount x
   * reduced motion (1 at the default).
   */
  update(dt: number, idle: boolean): void {
    if (dt <= 0) return;
    if (idle && !this.wasIdle) this.sv[0] -= SETTLE_KICK;
    this.wasIdle = idle;
    this.w = idle ? Math.min(1, this.w + dt / FADE_IN) : Math.max(0, this.w - dt / FADE_OUT);
    springStep(this.sx, this.sv, 0, 0, SETTLE_W, SETTLE_Z, dt);
  }

  /** Poses the hand over W at viewmodel time `t` (s), scaled by `amount`. */
  apply(W: Float32Array, arm: Arm, t: number, amount: number): void {
    const w = this.w * this.w * (3 - 2 * this.w) * amount;
    const settle = this.sx[0] * amount;
    if (w < 1e-3 && Math.abs(settle) < 1e-3) return;
    // Wrist: flex / deviation on incommensurate slow periods (7.3, 11.1, 5.2 s), about a degree and a half.
    const flex = w * (1.2 * Math.sin(t * 0.861 + 0.4) + 0.45 * Math.sin(t * 1.21 + 2.2)) + settle;
    const dev = w * 0.9 * Math.sin(t * 0.566 + 1.1);
    arm.wrist(W, flex, dev);
    // Grip: every ~6.7 s the index eases off the handle a few degrees and takes it again; the pinky on its own period.
    if (w > 1e-3) {
      const f = arm.frame(W);
      const ease = (p: number, ph: number) => Math.max(0, Math.sin(t * p + ph)) ** 3;
      const ix = 5 * w * ease(0.94, 0.3), px = 4 * w * ease(0.71, 2.6);
      if (ix > 0.05) arm.curl(W, "index", [-ix, -ix * 0.5, 0], 0, f);
      if (px > 0.05) arm.curl(W, "pinky", [-px, -px * 0.4, 0], 0, f);
    }
  }
}
