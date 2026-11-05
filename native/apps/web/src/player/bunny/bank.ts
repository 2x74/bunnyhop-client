// The bunny's bank into turns (player/bunny/model.ts): the view's yaw rate and the strafe key lean the whole body toward
// the turn about its hips, up to BANK_MAX at speed in the air, about a third of that running on the ground, none
// standing. Only over the CS:S animations (`on`): the procedural fallback (procedural.ts) already leans through its pose,
// so a second whole-body bank there would stack past BANK_MAX. `on` is eased like the rest, so content arriving
// mid-strafe brings the bank in smoothly. Exponential smoothing throughout; prefers-reduced-motion scales it like the
// rest of the game's motion (viewmodel/feel.ts motionScale). No allocation.

import { motionScale } from "../../viewmodel/feel";

/** Most the bunny banks into a turn (deg). */
export const BANK_MAX = 8;

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class BodyBank {
  /** The bank now (deg, + = leaning to the body's right). */
  bank = 0;
  private rate = 0;
  private air = 0;
  private yaw = NaN;
  /** `on`, eased (so the bank starts with no jump in its speed either). */
  private onW = 0;

  /** `on`: the CS:S animations are posing the body (no bank over the procedural fallback). */
  update(dt: number, yaw: number, grounded: boolean, speed: number, sidemove: number, on: boolean, snap: boolean): number {
    if (snap || dt <= 0 || Number.isNaN(this.yaw)) {
      this.yaw = yaw;
      if (snap) (this.rate = 0), (this.bank = 0), (this.air = grounded ? 0 : 1), (this.onW = on ? 1 : 0);
      return this.bank;
    }
    let r = wrap180(yaw - this.yaw) / dt;
    this.yaw = yaw;
    if (Math.abs(r) > 3000) r = 0; // a teleport / respawn turn
    this.rate += (r - this.rate) * (1 - Math.exp(-10 * dt));
    // Airborne weight: rises fast off the ground, falls slowly on it (a bhop touches the ground for one tick).
    this.air += ((grounded ? 0 : 1) - this.air) * (1 - Math.exp(-(grounded ? 4 : 12) * dt));
    const side = clamp(sidemove / 450, -1, 1);
    this.onW += ((on ? 1 : 0) - this.onW) * (1 - Math.exp(-4 * dt));
    const target = this.onW * clamp(-this.rate * 0.018 + side * 2.5, -BANK_MAX, BANK_MAX) * clamp(speed / 300, 0, 1) * (0.35 + 0.65 * this.air) * motionScale();
    this.bank += (target - this.bank) * (1 - Math.exp(-6 * dt));
    return this.bank;
  }
}
