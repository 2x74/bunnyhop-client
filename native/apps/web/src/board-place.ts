// The leaderboard place a time would take (Settings → HUD → Leaderboard place): shown beside the split during a run.
// Worked out on the client from one board read per map / style / track (shared-reads.ts placeBoard: the top
// PLACE_ROWS rows and the board's total), never asked of the server per tick. DOM-free (test/board-place.test.ts).
//
// Your own entry is left out: a faster run replaces it, so the place is counted among the other players. Ties go
// behind the times already on the board (the server orders by ticks, then by when the run was set). A time slower
// than every row read has a lower bound only ("#100+") when the board has more players than were read.

import type { Leaderboard } from "./api";

export interface PlaceBoard {
  /** Other players' times (seconds), fastest first. */
  times: number[];
  /** Other ranked players on the whole board. */
  others: number;
}

/** The other players' times from a board read (the top rows; `me`, the signed-in player's entry, is left out). */
export function placeBoardFrom(lb: Leaderboard): PlaceBoard {
  const me = lb.me?.player.id ?? null;
  const times = lb.entries.filter((e) => e.player.id !== me).map((e) => e.time).sort((a, b) => a - b);
  // `total` counts you if you're ranked (in the rows read or not).
  const others = Math.max(times.length, lb.total - (lb.me ? 1 : 0));
  return { times, others };
}

export interface Place {
  /** 1 = first. With `atLeast`, the best it could be. */
  place: number;
  /** Players on the board with you in it. */
  of: number;
  /** Slower than every row read on a board with more players: somewhere from `place` down. */
  atLeast: boolean;
}

/** Where `time` (seconds) would place. */
export function placeFor(b: PlaceBoard, time: number): Place {
  const t = b.times;
  // Rows at or under the time (ties stay ahead): binary search for the first slower one.
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return { place: lo + 1, of: b.others + 1, atLeast: lo === t.length && b.others > t.length };
}

/** "Top 3%": the share of the board at or ahead of the place, rounded up (never "top 0%"). Null for #1 or a lower bound. */
export function topPercent(p: Place): number | null {
  if (p.atLeast || p.place <= 1) return null;
  return Math.min(100, Math.max(1, Math.ceil((p.place / p.of) * 100)));
}

/** The HUD text: "#4", "#4 · top 3%" (`top`), "#100+". */
export function formatPlace(p: Place, top: boolean): string {
  if (p.atLeast) return `#${p.place}+`;
  const pct = top ? topPercent(p) : null;
  return pct === null ? `#${p.place}` : `#${p.place} · top ${pct}%`;
}
