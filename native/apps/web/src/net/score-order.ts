// The room scoreboard's order (net/mp.ts): fastest PB first; equal PBs by who set theirs first, as every leaderboard
// orders ties (time, then achieved_at: apps/api src/boards.ts); then by name. No PB last. DOM-free (tests import it).

export interface ScoreKey {
  /** PB in the style the player is in, seconds, or null. */
  pb: number | null;
  /** When that PB was set (ms); null or absent: unknown (an older server, or no PB). */
  pbAt?: number | null;
  name: string;
}

/** Array.sort comparator. Times are compared in whole milliseconds, like the boards. */
export function scoreOrder(a: ScoreKey, b: ScoreKey): number {
  const ms = (t: number | null) => (t === null ? Infinity : Math.round(t * 1000));
  return ms(a.pb) - ms(b.pb) || (a.pb !== null ? (a.pbAt ?? Infinity) - (b.pbAt ?? Infinity) : 0) || a.name.localeCompare(b.name);
}
