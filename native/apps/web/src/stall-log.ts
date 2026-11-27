// Stall log (v0.0.44, after the v0.0.42 1–5 s stalls on Windows): every pointer-locked frame over STALL_MS is kept with
// when it happened and what had just happened before it, so a player's stall says what it was. The frame counters in
// mouse-filter.ts InputStats only say that one happened.
//
//   noteStall("ghost-show")        cheap hooks where something new may first be drawn or built (a Map write)
//   stalls.frame(now, dur, locked)  every frame (input.ts); a frame over STALL_MS records an entry
//   stalls.longTask(start, ms)      long tasks (input-debug.ts): a stall with no long task was the GPU's, not the page's
//   stalls.summary()                {n, recent} for the run diagnostics (selfcheck.ts) and feedback game info
//
// An entry: `t` seconds since the map was Ready, `ms` the frame, `lt` the longest long task inside it (Chromium only),
// `p` shader programs made since the frame before (WebGLRenderer.info.programs), `tags` the hooks noted from
// STALL_LOOKBACK_MS before the frame began to its end. DOM-free (apps/api imports STALL_TAGS to sanitise).

/** A frame longer than this (ms) is a stall. */
export const STALL_MS = 250;
/** Entries kept (the newest). */
export const STALL_KEEP = 8;
/** A hook counts for a stall when noted this long (ms) before the frame began, or during it. */
export const STALL_LOOKBACK_MS = 1500;

/** What a stall can be tagged with (apps/api src/diagnostics.ts keeps only these). */
export const STALL_TAGS = [
  // The scene's hop-effect layer made or first drawn (player/hop-layer.ts).
  "hop-layer",
  // A ghost loaded (its programs compile and draw off screen), and a ghost first shown (ghost.ts).
  "ghost-load",
  "ghost-show",
  // A player joined the room (their bunny starts building), and their bunny first drawn (net/players.ts).
  "player-join",
  "player-show",
  // An unlock card's 3D item started (notify/item3d.ts).
  "unlock-card",
  // A run finished (session.ts: upload, self-check, PB ghost).
  "run-finish",
  // The next map's download started (net/mp.ts, gauntlets).
  "prefetch",
  // A map vote opened in a room (net/mp.ts).
  "vote",
] as const;
export type StallTag = (typeof STALL_TAGS)[number];

export interface Stall {
  /** Seconds since Ready (one decimal). */
  t: number;
  /** The frame (ms). */
  ms: number;
  /** Longest long task inside the frame (ms), once the browser reported one. */
  lt?: number;
  /** Shader programs made since the previous frame. */
  p?: number;
  tags: StallTag[];
}

export interface StallSummary {
  /** Stalls since the page loaded. */
  n: number;
  /** The newest STALL_KEEP, oldest first. */
  recent: Stall[];
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class StallLog {
  /** performance.now() at Ready: `t`'s origin (0: the page's start). */
  origin = 0;
  /** WebGLRenderer.info.programs.length (main.ts sets it; null: not counted). */
  programs: (() => number) | null = null;
  n = 0;
  private readonly recent: Stall[] = [];
  /** Each recent entry's frame end (performance clock), for long tasks reported after it. */
  private readonly ends: number[] = [];
  private readonly noted = new Map<StallTag, number>();
  private lastPrograms = -1;
  /** The last few long tasks [start, ms]: one can be reported before the frame it slowed. */
  private readonly tasks: [number, number][] = [];

  note(tag: StallTag, at = now()): void {
    this.noted.set(tag, at);
  }

  /** Every rendered frame: `at` its time, `dur` since the previous one (ms); only a `playing` (pointer-locked) frame counts. */
  frame(at: number, dur: number, playing: boolean): void {
    let made = 0;
    if (this.programs) {
      const count = this.programs();
      if (this.lastPrograms >= 0) made = count - this.lastPrograms;
      this.lastPrograms = count;
    }
    if (!playing || !(dur > STALL_MS)) return;
    const from = at - dur - STALL_LOOKBACK_MS;
    const tags = STALL_TAGS.filter((tag) => (this.noted.get(tag) ?? -Infinity) >= from);
    const s: Stall = { t: Math.round((at - this.origin) / 100) / 10, ms: Math.round(dur), tags };
    if (made > 0) s.p = made;
    for (const [start, ms] of this.tasks) if (start < at && start + ms > at - dur) s.lt = Math.max(s.lt ?? 0, Math.round(ms));
    this.n++;
    this.recent.push(s);
    this.ends.push(at);
    if (this.recent.length > STALL_KEEP) {
      this.recent.shift();
      this.ends.shift();
    }
  }

  /** A long task (PerformanceObserver; reported after its frame): kept on the stall whose frame it overlaps. */
  longTask(start: number, ms: number): void {
    this.tasks.push([start, ms]);
    if (this.tasks.length > 4) this.tasks.shift();
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const end = this.ends[i], s = this.recent[i];
      if (start < end && start + ms > end - s.ms) {
        s.lt = Math.max(s.lt ?? 0, Math.round(ms));
        return;
      }
    }
  }

  /** Null before the first stall. */
  summary(): StallSummary | null {
    return this.n ? { n: this.n, recent: this.recent.map((s) => ({ ...s, tags: [...s.tags] })) } : null;
  }
}

/** The page's stall log (input.ts feeds it frames). */
export const stalls = new StallLog();

/** Something that may make the next frames slow just happened (see STALL_TAGS). */
export function noteStall(tag: StallTag): void {
  stalls.note(tag);
}

/** A summary as one line for staff (admin Runs): the count, then the newest entries first. */
export function stallText(s: StallSummary): string {
  const entries = [...s.recent].reverse().map((e) => {
    const parts = [`${e.ms} ms at ${e.t} s`];
    if (e.tags.length) parts.push(`after ${e.tags.join(", ")}`);
    if (e.lt !== undefined) parts.push(`long task ${e.lt} ms`);
    if (e.p) parts.push(`${e.p} new shader${e.p === 1 ? "" : "s"}`);
    return parts.join(", ");
  });
  return [`${s.n} over ${STALL_MS} ms`, ...entries].join(" · ");
}
