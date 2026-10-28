// Frame-time benchmark for the desktop client (F10 → Benchmark; client-bridge.ts). The shell asks for a capture; the
// game measures only while you play (pointer locked, not a replay), so menus and pauses don't count, and sends back
// percentiles of the frame-to-frame interval and of the time spent inside frame(). Read only: it never changes how
// frames are drawn or paced, and nothing reaches the run or its replay.

import type { ClientBenchmarkResult } from "./client-bridge";

/** Enough for 30 s at 1000+ FPS; past it the capture just ends early. */
const MAX_FRAMES = 120_000;

export interface FrameBenchmarkOptions {
  /** Shown when a capture starts and ends. */
  say: (text: string) => void;
  done: (result: ClientBenchmarkResult) => void;
  /** The map and graphics settings at the end of the capture. */
  describe: () => { map: string; graphics: ClientBenchmarkResult["graphics"] };
}

const percentile = (sorted: Float64Array, q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const ms = (n: number): number => Math.round(n * 1000) / 1000;

export class FrameBenchmark {
  private intervals = new Float64Array(MAX_FRAMES);
  private works = new Float64Array(MAX_FRAMES);
  private count = 0;
  private played = 0;
  private target = 0;
  private last = -1;

  constructor(private o: FrameBenchmarkOptions) {}

  get active(): boolean {
    return this.target > 0;
  }

  start(seconds: number): void {
    this.target = Math.max(5, Math.min(120, Math.round(Number.isFinite(seconds) ? seconds : 30))) * 1000;
    this.count = 0;
    this.played = 0;
    this.last = -1;
    this.o.say(`Measuring frame times for ${this.target / 1000} seconds of play.`);
  }

  /** After each frame: its start time, the time spent in it, and whether you were playing. */
  frame(now: number, work: number, playing: boolean): void {
    if (!this.target) return;
    if (!playing) {
      this.last = -1; // a pause is not a long frame
      return;
    }
    if (this.last >= 0) {
      const interval = now - this.last;
      this.intervals[this.count] = interval;
      this.works[this.count] = work;
      this.count++;
      this.played += interval;
    }
    this.last = now;
    if (this.played >= this.target || this.count >= MAX_FRAMES) this.finish();
  }

  private finish(): void {
    const n = this.count;
    const seconds = this.played / 1000;
    this.target = 0;
    const intervals = this.intervals.slice(0, n).sort();
    const works = this.works.slice(0, n).sort();
    const median = percentile(intervals, 0.5);
    let hitches = 0;
    for (let i = 0; i < n; i++) if (this.intervals[i] > median * 2) hitches++;
    const { map, graphics } = this.o.describe();
    this.o.done({
      map,
      seconds: Math.round(seconds * 10) / 10,
      frames: n,
      interval: { avg: ms(n ? this.played / n : 0), p50: ms(median), p99: ms(percentile(intervals, 0.99)), max: ms(intervals[n - 1] ?? 0) },
      work: { p50: ms(percentile(works, 0.5)), p99: ms(percentile(works, 0.99)), max: ms(works[n - 1] ?? 0) },
      hitches,
      graphics,
    });
    this.o.say("Frame times are in F10.");
  }
}
