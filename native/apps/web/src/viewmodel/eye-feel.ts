// In-eye camera presentation options (Settings -> Viewmodel -> Movement feel), both off by default: competitive in-eye
// stays exactly the simulation's eye. Render only: neither touches the view angles, the simulation's eye, aim or input;
// the replay viewer's cameras are not affected (live play only).
//
//   Hard landing settle   after a genuinely hard fall (from ~650 u/s down, full by ~1200) the rendered camera drops a
//                         little and comes straight back: at most HARD_SETTLE_MAX units, peaking ~60 ms after touchdown,
//                         gone in ~0.35 s (critically damped: no bounce). Bhop landings (~300 u/s) never trigger it.
//   Speed FOV             a tiny FOV ease (SPEED_FOV_ADD degrees) once you're properly fast, with hysteresis (on above
//                         SPEED_FOV_ON u/s, off below SPEED_FOV_OFF) and a slow ease, so it never pumps hop to hop.
// prefers-reduced-motion: the settle is scaled down like the rest of the feel; the FOV ease is off.

import { hardLanding, motionScale, springStep } from "./feel";

export { hardLanding };

export const HARD_SETTLE_MAX = 1.8;
export const SPEED_FOV_ADD = 3;
export const SPEED_FOV_ON = 750;
export const SPEED_FOV_OFF = 550;
/** The settle spring (rad/s; critically damped). */
const SETTLE_W = 16;

export class EyeFeel {
  /** Camera height offset this frame (Source units, <= 0). */
  z = 0;
  /** Horizontal FOV to add this frame (degrees, >= 0). */
  fov = 0;
  private x = new Float64Array(1);
  private v = new Float64Array(1);
  private fast = false;

  reset(): void {
    this.x[0] = this.v[0] = 0;
    this.z = this.fov = 0;
    this.fast = false;
  }

  /**
   * Advances by dt: `landed` the vertical speed of a landing this frame (< 0) or 0, `speed` the horizontal speed;
   * `settle` / `speedFov` the settings (off: that part eases out / stays 0).
   */
  update(dt: number, landed: number, speed: number, settle: boolean, speedFov: boolean): void {
    if (dt <= 0) return;
    const m = motionScale();
    springStep(this.x, this.v, 0, 0, SETTLE_W, 1, dt);
    if (settle && landed < 0) {
      // A critically damped kick peaks at v / (w e): sized so the drop peaks at HARD_SETTLE_MAX x hardness.
      const h = hardLanding(landed) * m;
      if (h > 0) this.v[0] -= HARD_SETTLE_MAX * h * SETTLE_W * Math.E;
    }
    this.z = settle ? Math.max(-HARD_SETTLE_MAX, Math.min(0, this.x[0])) : 0;
    if (!settle) this.x[0] = this.v[0] = 0;
    // Speed FOV: on / off with hysteresis, then a slow ease (time constant ~0.7 s).
    if (speed > SPEED_FOV_ON) this.fast = true;
    else if (speed < SPEED_FOV_OFF) this.fast = false;
    const want = speedFov && this.fast && m >= 1 ? SPEED_FOV_ADD : 0;
    this.fov += (want - this.fov) * (1 - Math.exp(-dt / 0.7));
    if (Math.abs(this.fov - want) < 0.01) this.fov = want;
  }
}
