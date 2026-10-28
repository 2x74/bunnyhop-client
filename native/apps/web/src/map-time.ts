// Attempts and time played per map, on this device (localStorage): the map list's panel ("214 attempts, 1h 32m
// played") and the result card. Any style and track. A submitted run's diagnostics carry the two numbers as they were
// at its finish, for its stats card on the boards (session.ts runPlay); nothing else is uploaded.
//   - an attempt is a timer start: leaving a start zone with the timer running (session.ts). A restart or a respawn
//     in the start zone isn't one; the run you start after it is. Practice mode's starts don't count.
//   - time is playtime.ts's count (on the map with the game running: not paused, in a menu or tabbed out, and not
//     away from the keys for 30 s), credited to the map being played. Rooms count; replays and spectating don't.
// Counts gather in memory and are written a few seconds after the last one (and when the page goes away), adding to
// what's stored, so two tabs never overwrite each other's counts. DOM-free.

/** [attempts, seconds]. */
type Entry = [number, number];

export interface MapTimes {
  attempts: number;
  seconds: number;
}

const KEY = "bunnyhop:map-time";
/** Wait after a count before it's written. */
export const WRITE_MS = 5000;

/** localStorage's part we use (structural, so tests need no DOM). */
interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localStore(): Store | null {
  try {
    return (globalThis as { localStorage?: Store }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** A stored entry, anything broken in it as 0. */
function stored(e: unknown): Entry {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return Array.isArray(e) ? [n(e[0]), n(e[1])] : [0, 0];
}

export class MapTime {
  /** Counted, not written yet. */
  private pending = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: Store | null = localStore()) {}

  private read(): Record<string, Entry> {
    try {
      const v = JSON.parse(this.store?.getItem(KEY) ?? "null") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  private add(map: string, attempts: number, seconds: number): void {
    const e = this.pending.get(map) ?? [0, 0];
    e[0] += attempts;
    e[1] += seconds;
    this.pending.set(map, e);
    this.timer ??= setTimeout(() => this.flush(), WRITE_MS);
  }

  /** A timer start on `map`. */
  attempt(map: string): void {
    this.add(map, 1, 0);
  }

  /** Seconds played on `map`. */
  played(map: string, seconds: number): void {
    if (seconds > 0 && Number.isFinite(seconds)) this.add(map, 0, seconds);
  }

  get(map: string): MapTimes {
    const [a, s] = stored(this.read()[map]);
    const p = this.pending.get(map);
    return { attempts: a + (p?.[0] ?? 0), seconds: s + (p?.[1] ?? 0) };
  }

  /** Writes what was counted, on top of what's stored now. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    const all = this.read();
    for (const [map, [a, s]] of this.pending) {
      const was = stored(all[map]);
      all[map] = [was[0] + a, Math.round((was[1] + s) * 10) / 10];
    }
    this.pending.clear();
    try {
      this.store?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* full / blocked: counted again from what's stored */
    }
  }
}

/** The game's counter (session.ts counts attempts, main.ts time). */
export const mapTime = new MapTime();
if (typeof addEventListener === "function") addEventListener("pagehide", () => mapTime.flush());

/** "12 attempts", "1 attempt". */
export function attemptsText(n: number): string {
  return `${n} attempt${n === 1 ? "" : "s"}`;
}

/** Time played, to the minute: "1h 32m", "12m", "under a minute". */
export function playedText(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}
