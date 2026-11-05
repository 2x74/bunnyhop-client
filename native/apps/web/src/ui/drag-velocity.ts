// Release velocity for drag-to-spin previews (ui/loadout-stage.ts, ui/bunny-preview.ts): from the pointer events' own
// timestamps over the last WINDOW_MS, not one assumed 60 Hz frame per event (a 1000 Hz mouse or a 120 Hz touchscreen
// flung several times harder before). A pointer held still before letting go flings nothing.

const WINDOW_MS = 90;
/** Held still this long before release: no fling. */
const STILL_MS = 70;

export class DragVelocity {
  private ts: number[] = [];
  private xs: number[] = [];
  private ys: number[] = [];

  start(t: number, x: number, y: number): void {
    this.ts = [t];
    this.xs = [x];
    this.ys = [y];
  }

  move(t: number, x: number, y: number): void {
    this.ts.push(t), this.xs.push(x), this.ys.push(y);
    while (this.ts.length > 2 && t - this.ts[0] > WINDOW_MS) this.ts.shift(), this.xs.shift(), this.ys.shift();
  }

  /** Velocity (CSS px/s) at release time `t`: over the recent window, 0 if the pointer was held still. */
  release(t: number): [number, number] {
    const n = this.ts.length;
    if (n < 2 || t - this.ts[n - 1] > STILL_MS) return [0, 0];
    const span = (this.ts[n - 1] - this.ts[0]) / 1000;
    if (span < 0.008) return [0, 0];
    return [(this.xs[n - 1] - this.xs[0]) / span, (this.ys[n - 1] - this.ys[0]) / span];
  }
}
