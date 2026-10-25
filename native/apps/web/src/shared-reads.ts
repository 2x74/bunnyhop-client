// Reads more than one screen asks for, kept once for the page (research/READ-LATENCY.md, phase 1): every read costs a
// trip to the far-away database, so a second screen takes the first one's answer (or its request still in flight)
// instead of asking again. A failed read is never kept.
//   - the gauntlet hub (GET /gauntlets): the home screen's weekly line (5 minutes old is fine) and the Gauntlets screen
//     (a minute, and only if nothing was written since: your rank there follows your runs).
//   - map boards (GET /leaderboards/<map>/<style>): the map list's top 10 (ui/map-board.ts, aborted when the player
//     moves on) and the world-record reads (the WR ghost, the replay viewer's compare, the HUD's provisional WR, chat's
//     !wr), 30 s; a WR read takes a top-10 board that already answered. Your own verified run drops them (online.ts).
//   - the HUD's leaderboard place (board-place.ts): the top PLACE_ROWS rows of the board being run, read once when it's
//     on; the WR reads take it too (in flight or answered), so turning it on doesn't add a read.

import { api, type GauntletHub, type Leaderboard, type LeaderboardEntry } from "./api";

interface Entry<T> {
  at: number;
  /** api.writes() when it was asked. */
  writes: number;
  p: Promise<T>;
  /** Answered (a board still loading may yet be aborted). */
  ok: boolean;
}

function keep<T>(cache: Map<string, Entry<T>>, key: string, p: Promise<T>): Entry<T> {
  const e: Entry<T> = { at: performance.now(), writes: api.writes(), p, ok: false };
  cache.set(key, e);
  p.then(
    () => (e.ok = true),
    () => cache.get(key) === e && cache.delete(key),
  );
  return e;
}
const young = <T>(e: Entry<T> | undefined, maxAge: number): e is Entry<T> => !!e && performance.now() - e.at < maxAge;

// --- gauntlets

const hub = new Map<string, Entry<GauntletHub>>();
/** The gauntlet hub, read at most once per `maxAge`; `sinceWrites`: also not if anything was written after it was asked. */
export function gauntletHub(maxAge: number, o: { sinceWrites?: boolean } = {}): Promise<GauntletHub> {
  const e = hub.get("");
  if (young(e, maxAge) && (!o.sinceWrites || e.writes === api.writes())) return e.p;
  return keep(hub, "", api.gauntlets()).p;
}

// --- map boards

export const BOARD_MS = 30_000;
/** The map list's board size (ui/map-board.ts). */
export const TOP_ROWS = 10;
/** The HUD's leaderboard place reads this many rows (the API's most per page). */
export const PLACE_ROWS = 100;
const boards = new Map<string, Entry<Leaderboard>>();
const boardKey = (map: string, style: string, track: number, rows: number) => `${map}|${style}|${track}|${rows}`;

/**
 * The top `TOP_ROWS` rows of a board (ui/map-board.ts), cached for 30 s. `signal` is asked only when a request goes
 * out (the map list aborts the previous map's then).
 */
export function topBoard(map: string, style: string, track: number, signal?: () => AbortSignal): Promise<Leaderboard> {
  const key = boardKey(map, style, track, TOP_ROWS);
  const e = boards.get(key);
  if (young(e, BOARD_MS)) return e.p;
  return keep(boards, key, api.leaderboard(map, style, { limit: TOP_ROWS, track }, { signal: signal?.() })).p;
}

/**
 * The top `PLACE_ROWS` rows of a board and its total (the HUD's leaderboard place, board-place.ts), cached for 30 s.
 */
export function placeBoard(map: string, style: string, track: number): Promise<Leaderboard> {
  const key = boardKey(map, style, track, PLACE_ROWS);
  const e = boards.get(key);
  if (young(e, BOARD_MS)) return e.p;
  return keep(boards, key, api.leaderboard(map, style, { limit: PLACE_ROWS, track })).p;
}

/**
 * A board's world record (its first row; null: nobody has finished it), from a top-10 board that already answered, the
 * HUD's place board (never aborted, so also while it's in flight) or one shared one-row read, cached for 30 s.
 */
export function worldRecord(map: string, style: string, track = 0): Promise<LeaderboardEntry | null> {
  const top = boards.get(boardKey(map, style, track, TOP_ROWS));
  const place = boards.get(boardKey(map, style, track, PLACE_ROWS));
  const one = boards.get(boardKey(map, style, track, 1));
  const e = young(top, BOARD_MS) && top.ok ? top : young(place, BOARD_MS) ? place : young(one, BOARD_MS) ? one : keep(boards, boardKey(map, style, track, 1), api.leaderboard(map, style, { track, limit: 1 }));
  return e.p.then((lb) => lb.entries[0] ?? lb.wr ?? null);
}

/** After your own verified run: the boards (all, or `map`'s) are read again. */
export function forgetBoards(map?: string): void {
  for (const key of boards.keys()) if (map === undefined || key.startsWith(`${map}|`)) boards.delete(key);
}
