import type { Leaderboard, RunCard } from "../api";

export interface ExportRunIdentity { runId: string; map: string; style: string; track: number; ticks: number }
interface PublicRun {
  id: string; map: string; style: string; track: number; status: string;
  player: { id: string }; ticks: number | null;
}
export interface ExportLeaderboard {
  rank: number; total: number; points: number | null;
  rows: { rank: number; player: string; time: number; current: boolean }[];
}
/** Require the exact replay to remain a current PB; old runs have hypothetical ranks, not board places. */
export function exportLeaderboardSnapshot(identity: ExportRunIdentity, run: PublicRun, board: Leaderboard, cards: RunCard[]): ExportLeaderboard | null {
  if (run.id !== identity.runId || run.status !== "verified" || run.map !== identity.map || run.style !== identity.style || run.track !== identity.track || run.ticks !== identity.ticks) return null;
  if (board.map !== identity.map || board.style !== identity.style || (board.track ?? 0) !== identity.track) return null;
  const current = board.entries.find(row => row.runId === identity.runId && row.player.id === run.player.id && row.ticks === identity.ticks);
  if (!current || !Number.isInteger(current.rank) || current.rank < 1 || !Number.isInteger(board.total) || board.total < current.rank) return null;
  const card = cards.find(c => c.runId === identity.runId && c.pb && c.map === identity.map && c.style === identity.style && c.track === identity.track && c.ticks === identity.ticks);
  const points = card?.points != null && Number.isFinite(card.points) && card.points >= 0 ? card.points : null;
  return { rank: current.rank, total: board.total, points, rows: board.entries.slice(0, 3).map(row => ({ rank: row.rank, player: row.player.name, time: row.time, current: row.runId === identity.runId })) };
}
/** Public reads only. A shared deadline bounds the extra outro lookup, including failed/offline APIs. */
export async function fetchExportLeaderboard(base: string, identity: ExportRunIdentity, fetcher: typeof fetch = fetch): Promise<ExportLeaderboard | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let partial: ExportLeaderboard | null = null;
  const deadline = new Promise<ExportLeaderboard | null>(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(partial); }, 5000); });
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetcher(`${base}${path}`, { credentials: "include", cache: "no-cache", signal: controller.signal });
    if (!response.ok) throw new Error("Leaderboard unavailable");
    return response.json() as Promise<T>;
  };
  const lookup = async () => {
    const run = await read<PublicRun>(`/runs/${encodeURIComponent(identity.runId)}`);
    if (run.status !== "verified" || !run.player?.id) return null;
    const q = new URLSearchParams({ around: run.player.id, limit: "3", track: String(identity.track) });
    const board = await read<Leaderboard>(`/leaderboards/${encodeURIComponent(identity.map)}/${encodeURIComponent(identity.style)}?${q}`);
    partial = exportLeaderboardSnapshot(identity, run, board, []);
    if (!partial) return null;
    // Points are stored on a run card, not on the leaderboard or public run response.
    let cards: RunCard[] = [];
    if (board.entries.some(row => row.runId === identity.runId)) {
      try {
        // The public endpoint caps pages at 50. Search bounded pages for older PBs.
        for (let offset = 0; offset < 500; offset += 50) {
          const page = await read<{ runs: RunCard[]; total: number }>(`/players/${encodeURIComponent(run.player.id)}/runs?pb=1&limit=50&offset=${offset}`);
          cards.push(...page.runs);
          if (page.runs.some(card => card.runId === identity.runId) || page.runs.length < 50 || offset + 50 >= page.total) break;
        }
      } catch { /* rank can still be shown without points */ }
    }
    return exportLeaderboardSnapshot(identity, run, board, cards);
  };
  try { return await Promise.race([lookup().catch(() => null), deadline]); }
  finally { clearTimeout(timeout!); controller.abort(); }
}
