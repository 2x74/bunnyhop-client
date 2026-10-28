// Per-jump strafe sync and take-off gains for the sync bar and the speed graph's jump marks, computed on the HUD side
// from the per-tick command + post-tick state. Display only: the run's official jumps/strafes/sync come from
// timer.ts. (The Jump stats element, !ssj, is ssj/.)

/** Ground ticks after which a jump chain counts as broken. */
const CHAIN_GROUND_TICKS = 10;

export class JumpTracker {
  /** Fired on every take-off: chain number, speed and gain vs the previous take-off (0 for the first). */
  onJump: ((n: number, speed: number, gain: number) => void) | null = null;

  private air = false;
  private chain = 0;
  private groundTicks = 0;
  private lastJumpSpeed = 0;
  private good = 0;
  private total = 0;
  private prevYaw = NaN;
  /** Sync of the last finished jump (shown while grounded). */
  private lastSync = 0;

  reset(): void {
    this.air = false;
    this.chain = this.groundTicks = this.good = this.total = 0;
    this.lastJumpSpeed = this.lastSync = 0;
    this.prevYaw = NaN;
  }

  /** Live sync % for the current jump (or the last one while on the ground). */
  get sync(): number {
    return this.air && this.total ? (100 * this.good) / this.total : this.lastSync;
  }

  feed(side: number, yaw: number, speed: number, grounded: boolean, jumped: boolean): void {
    if (this.air && !grounded && this.prevYaw === this.prevYaw) {
      let d = yaw - this.prevYaw;
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      if (d !== 0) {
        this.total++;
        if ((d > 0 && side < 0) || (d < 0 && side > 0)) this.good++;
      }
    }
    this.prevYaw = yaw;
    if (jumped) {
      // Autohop lands and re-jumps on the same tick: close the previous jump first.
      if (this.air) this.land();
      const chained = this.chain > 0 && this.groundTicks < CHAIN_GROUND_TICKS;
      this.chain = chained ? this.chain + 1 : 1;
      this.onJump?.(this.chain, speed, chained ? speed - this.lastJumpSpeed : 0);
      this.lastJumpSpeed = speed;
      this.air = true;
      this.good = this.total = this.groundTicks = 0;
    } else if (grounded) {
      if (this.air) {
        this.land();
        this.air = false;
      }
      if (++this.groundTicks >= CHAIN_GROUND_TICKS) this.chain = 0;
    }
  }

  private land(): void {
    this.lastSync = this.total ? (100 * this.good) / this.total : 0;
  }
}
