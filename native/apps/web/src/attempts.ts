// Attempt counter per board (map / track / style) for the run session: how many times the timer started on the board
// before this run, how many restarts / resets, how many practice exits on the map, and how long the player has been
// at it. It travels in the run-session heartbeats (run-clock.ts), which the server signs, so staff can read "a WR on
// attempt 1 of the session" or "on attempt 40 after 25 minutes" next to a record. Context only, never a verdict; the
// server stores it with the run's analysis (apps/api src/verify.ts), no extra writes.
//
// Kept in sessionStorage, so a reload in the same tab keeps counting (a new tab, or IDLE_MS without a start, begins
// again). Counting never touches the timer, the sim or the replay.

/** What a beat carries: [attempt, resets, practice exits, seconds since the board's first start in the session]. */
export type AttemptClaim = [attempt: number, resets: number, practice: number, secs: number];

interface Board {
  /** Timer starts (ranked attempts), restarts / resets, first start and last activity (ms). */
  starts: number;
  resets: number;
  first: number;
  last: number;
}

interface State {
  boards: Record<string, Board>;
  /** Practice-mode exits per map. */
  practice: Record<string, number>;
}

const KEY = "bunnyhop:attempts";
/** A board idle this long starts counting again. */
export const IDLE_MS = 2 * 3_600_000;
/** Boards kept (oldest activity dropped first). */
const MAX_BOARDS = 64;

/** sessionStorage's part we use (structural, so tests and the server's typecheck need no DOM). */
interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStore(): Store | null {
  try {
    return (globalThis as { sessionStorage?: Store }).sessionStorage ?? null;
  } catch {
    return null; // storage blocked: count in memory only
  }
}

export class AttemptCounter {
  private s: State = { boards: {}, practice: {} };

  constructor(
    private readonly store: Store | null = sessionStore(),
    private readonly now: () => number = Date.now,
  ) {
    try {
      const v = JSON.parse(store?.getItem(KEY) ?? "null") as State | null;
      if (v && typeof v.boards === "object" && typeof v.practice === "object") this.s = v;
    } catch {
      /* corrupt: start over */
    }
  }

  private board(map: string, track: number, style: string): Board {
    const k = `${map}|${track}|${style}`;
    const t = this.now();
    let b = this.s.boards[k];
    if (!b || t - b.last > IDLE_MS) {
      b = this.s.boards[k] = { starts: 0, resets: 0, first: 0, last: t };
      const keys = Object.keys(this.s.boards);
      if (keys.length > MAX_BOARDS) {
        keys.sort((a, c) => this.s.boards[a].last - this.s.boards[c].last);
        for (const old of keys.slice(0, keys.length - MAX_BOARDS)) delete this.s.boards[old];
      }
    }
    b.last = t;
    return b;
  }

  private save(): void {
    try {
      this.store?.setItem(KEY, JSON.stringify(this.s));
    } catch {
      /* full / blocked */
    }
  }

  /** A ranked timer start on the board: this attempt's claim. */
  start(map: string, track: number, style: string): AttemptClaim {
    const b = this.board(map, track, style);
    b.starts++;
    if (!b.first) b.first = b.last;
    this.save();
    return [b.starts, b.resets, this.s.practice[map] ?? 0, Math.round((b.last - b.first) / 1000)];
  }

  /** A restart or reset on the board (restart key, respawn, track or style change). */
  reset(map: string, track: number, style: string): void {
    this.board(map, track, style).resets++;
    this.save();
  }

  /** A practice attempt on the map (practice mode, a checkpoint teleport, noclip) gave way to a clean one. */
  practiceExit(map: string): void {
    this.s.practice[map] = (this.s.practice[map] ?? 0) + 1;
    this.save();
  }
}
