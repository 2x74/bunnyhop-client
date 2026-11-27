// Featured-run edges (v0.0.44): each of the card's three featured runs wears a thin metal rim that says what the run
// is, read from its live standing when the profile is read (apps/api src/profile.ts featured). No item, nothing stored:
// a lost record or a fall out of the top 10 changes the rim at the next read.
//
// Precedence when several apply: a held world record, then a Daily Challenge podium, then a current top 10.
// - The world record is the biggest claim a run can make, and it is live.
// - A Daily podium beats a top 10 because the tile already shows the place ("#4"), so a silver "Top 10" rim only repeats
//   it, while the day's medal is something the tile can't otherwise say. It is also frozen: it never downgrades.
// Drawn by web ui/card.ts featTile (profile.css .pc-feat-edge) and the OG player card (apps/api src/og/cards.ts).

import { DAILY_METALS, type DailyMetal } from "./creators";

export type FeatEdge =
  | { kind: "wr" }
  | { kind: "top10" }
  /** `day`: the Daily day the run placed on ("2026-11-24", the UTC date the day starts on). */
  | { kind: "daily"; metal: DailyMetal; day: string };

/** Places a top-10 edge covers (2..10; 1 is the world record). */
export const FEAT_EDGE_TOP = 10;

const PODIUM: readonly DailyMetal[] = ["gold", "silver", "bronze"];

/**
 * The edge for a run: `rank` its live board place while it is the player's PB on the current board (RunCard.rank, null
 * otherwise), `podium` the frozen Daily place it took (daily_results), if any.
 */
export function featEdgeOf(rank: number | null, podium: { place: number; day: string } | null): FeatEdge | null {
  if (rank === 1) return { kind: "wr" };
  const metal = podium ? PODIUM[podium.place - 1] : undefined;
  if (metal && podium) return { kind: "daily", metal, day: podium.day };
  if (rank !== null && rank > 1 && rank <= FEAT_EDGE_TOP) return { kind: "top10" };
  return null;
}

/** The rim's metal: gold for a world record, silver for a top 10, the day's medal for a Daily podium. */
export const featEdgeMetal = (e: FeatEdge): DailyMetal => (e.kind === "wr" ? "gold" : e.kind === "top10" ? "silver" : e.metal);

/** The rim's three stops (light, mid, dark), the Daily marks' medal colours. */
export const featEdgeColors = (e: FeatEdge): { light: string; mid: string; dark: string } => DAILY_METALS[featEdgeMetal(e)];

/** Hover text: "World record", "Top 10", "Daily gold, Nov 24". */
export function featEdgeLabel(e: FeatEdge): string {
  if (e.kind === "wr") return "World record";
  if (e.kind === "top10") return "Top 10";
  const day = new Date(`${e.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Daily ${e.metal}, ${day}`;
}

/** Whether a value read from the API is an edge this client draws (older or newer APIs may send other shapes). */
export function isFeatEdge(v: unknown): v is FeatEdge {
  if (!v || typeof v !== "object") return false;
  const e = v as { kind?: unknown; metal?: unknown; day?: unknown };
  if (e.kind === "wr" || e.kind === "top10") return true;
  return e.kind === "daily" && PODIUM.includes(e.metal as DailyMetal) && typeof e.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.day);
}
