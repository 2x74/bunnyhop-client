// Small timing rules shared by the notification layer (DOM-free; apps/api/test/notify.test.ts).

/** How long a toast stays: 2.2 s plus ~55 ms per character past 12 (reading speed), at most 8 s. */
export function readingMs(text: string): number {
  return Math.min(8000, 2200 + Math.max(0, text.length - 12) * 55);
}

/** Value of a count-up at `t` (0..1): ease-out quart, so most of the distance goes by early and it eases onto the target. */
export function countUpValue(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  const k = 1 - Math.pow(1 - Math.max(0, t), 4);
  const v = from + (to - from) * k;
  return Math.round(v);
}

/**
 * Count-up ticks (count_tick): at most one per `gap` ms across every count running, so a fast count (or two numbers
 * counting at once on the end card) never machine-guns. Each tick in a run plays a step higher (+6%, like tixy's
 * printer), up to `maxSteps`; the run starts over after `reset` ms of quiet. `next(t)` is the playback rate for a tick
 * at `t` (ms), or null to skip it.
 */
export class TickPacer {
  private last = -Infinity;
  private n = 0;
  constructor(
    private gap = 70,
    private step = 1.06,
    private maxSteps = 10,
    private reset = 320,
  ) {}

  next(t: number): number | null {
    const since = t - this.last;
    if (since < this.gap) return null;
    this.n = since > this.reset ? 0 : Math.min(this.n + 1, this.maxSteps);
    this.last = t;
    return Math.pow(this.step, this.n);
  }
}
