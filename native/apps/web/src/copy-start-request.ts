// Copy start's plumbing (copy-start.ts has the rules): finding the run (a leaderboard row, a rank, a player), downloading
// its replay and handing it to the session (session.ts copyStartPoint). The leaderboard rows ask through a tiny bus, like
// their Race (player/race.ts), so the UI never imports the session: main.ts registers the loaded map's handler, and a
// board shows "Copy start" only for that map (the pause menu's always; the map browser's when it's the map you're on).

import { api, type LeaderboardEntry } from "./api";
import { parseCopyStart } from "./copy-start";
import { decodeReplay, type Replay } from "./replay";
import type { StyleId } from "./styles";

export interface CopyStartHandler {
  /** The loaded map: boards of other maps don't offer it. */
  map: string;
  /** Copies the start of leaderboard run `runId` (`who`, the player's name, is in the answer). */
  copy(runId: string, who: string, reply?: (text: string) => void): void;
}

let handler: CopyStartHandler | null = null;

/** main.ts, once a map is loaded (null: none). */
export function setCopyStartHandler(h: CopyStartHandler | null): void {
  handler = h;
}

/** Whether a board of `map` can offer Copy start (the game has that map loaded). */
export const canCopyStart = (map: string): boolean => handler?.map === map;

/** A board row's Copy start. */
export function requestCopyStart(map: string, runId: string, who: string): void {
  if (handler?.map === map) handler.copy(runId, who);
}

/** Downloads a run's replay and copies its start (`apply`: session.copyStartPoint). Answers through `say`. */
export async function copyRunStart(runId: string, who: string, apply: (r: Replay, who: string) => void, say: (text: string) => void): Promise<void> {
  let replay: Replay;
  try {
    replay = await decodeReplay(await api.replay(runId));
  } catch {
    return say("Couldn't download that run's replay.");
  }
  apply(replay, who);
}

/**
 * !copystart's run on the board of `map` / `style` / `track`: nothing or #1 the world record, "#3" a rank, else a
 * player's name (exact, else the only one it's the start of; the board's search is a substring). An entry, or why not.
 */
export async function boardRunFor(map: string, style: StyleId, track: number, arg: string): Promise<{ entry: LeaderboardEntry; who: string } | { error: string }> {
  if (!api.available()) return { error: "Leaderboards are offline." };
  const t = parseCopyStart(arg);
  try {
    if (t.kind !== "name") {
      const rank = t.kind === "wr" ? 1 : t.rank;
      const lb = await api.leaderboard(map, style, { offset: rank - 1, limit: 1, track });
      const e = lb.entries.find((x) => x.rank === rank) ?? lb.entries[0];
      if (!e) return { error: rank === 1 ? "No record on this board yet." : `No #${rank} on this board.` };
      return { entry: e, who: e.player.name };
    }
    const q = t.name.toLowerCase();
    const lb = await api.leaderboard(map, style, { q: t.name, limit: 8, track });
    const exact = lb.entries.filter((e) => e.player.name.toLowerCase() === q);
    const starts = lb.entries.filter((e) => e.player.name.toLowerCase().startsWith(q));
    const pick = exact.length === 1 ? exact[0] : !exact.length && starts.length === 1 ? starts[0] : !exact.length && !starts.length && lb.entries.length === 1 ? lb.entries[0] : null;
    if (pick) return { entry: pick, who: pick.player.name };
    if (!lb.entries.length) return { error: `No time by "${t.name}" on this board.` };
    return { error: `More than one player matches "${t.name}": ${lb.entries.slice(0, 4).map((e) => e.player.name).join(", ")}.` };
  } catch {
    return { error: "Couldn't load the leaderboard." };
  }
}

/** A player's run on the board of `map` / `track`, in the first of `styles` they have one in (rooms: their PB). */
export async function playerRunOn(map: string, track: number, playerId: string, styles: readonly StyleId[]): Promise<LeaderboardEntry | null> {
  for (const style of [...new Set(styles)]) {
    const lb = await api.leaderboard(map, style, { around: playerId, limit: 5, track });
    const e = lb.entries.find((x) => x.player.id === playerId);
    if (e) return e;
  }
  return null;
}
