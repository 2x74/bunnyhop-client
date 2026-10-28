// The player's own place on the board being run, for the native HUD's place line ("#4 | top 3%"). It comes from the
// same cached board read the website's HUD place uses (shared-reads.ts placeBoard), so it costs one read per map,
// style and track. A reply for an older attempt or another board never reaches the host.
import type { Leaderboard } from "../../web/src/api";
import { topPercent } from "../../web/src/board-place";

export interface BoardContext {
  map: string;
  style: string;
  track: number;
  generation: number;
}

/** README "Native HUD host messages": `place: 0` clears the line. */
export interface HudLeaderboardMessage extends BoardContext {
  type: "hudLeaderboard";
  place: number;
  topPercent?: number;
}

export type BoardRead = (map: string, style: string, track: number) => Promise<Leaderboard>;

/** The signed-in player's place on `board` and the share of the board at or ahead of it; place 0 when unranked. */
export function boardPlace(board: Leaderboard): { place: number; topPercent?: number } {
  const rank = board.me?.rank;
  if (!Number.isSafeInteger(rank) || !rank || rank < 1) return { place: 0 };
  if (!Number.isSafeInteger(board.total)) return { place: rank };
  const percent = topPercent({ place: rank, of: Math.max(board.total, rank), atLeast: false });
  return percent === null ? { place: rank } : { place: rank, topPercent: percent };
}

export class NativeHudLeaderboard {
  private key = "";
  private context: BoardContext | null = null;
  private revision = 0;

  constructor(
    private readonly read: BoardRead,
    private readonly send: (message: HudLeaderboardMessage) => void,
  ) {}

  /** The board and attempt on screen (null: no map). Each new attempt gets the place again: the host fences by it. */
  update(context: BoardContext | null): void {
    const key = context ? JSON.stringify(context) : "";
    if (key === this.key) return;
    this.key = key;
    this.context = context;
    this.fetch();
  }

  /** Read the board again for the attempt on screen: after a verified run of your own, or an account change. */
  refresh(): void {
    this.fetch();
  }

  private fetch(): void {
    const revision = ++this.revision;
    const context = this.context;
    if (!context) return;
    this.read(context.map, context.style, context.track)
      .then((board) => {
        if (revision !== this.revision) return;
        this.send({ type: "hudLeaderboard", ...context, ...boardPlace(board) });
      })
      .catch(() => {});
  }
}
