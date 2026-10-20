// Player points and overall rank. DOM-free: the API generates its recompute SQL from these constants
// (apps/api/src/points.ts) and the client uses the same functions to explain points and draw rank titles.
// Design notes and the research behind it: research/RANKS.md.
//
// Points per record (one verified PB on one board = map × track × style):
//
//   record = base(tier) × trackFactor × (1 + quality + placement(rank))      "raw" (style-blind) points
//   quality = wrTicks / yourTicks                                           0..1, 1 = you hold the WR
//   placement = WR 1.0, #2 0.75, #3 0.6, #4–#10 0.5 → 0.2, else 0           top-10 bonus
//   weighted = raw × styleWeight(style)                                     what the overall rank sums
//
//   total = Σ weighted[i] × 0.975^i over the player's records sorted best first (bhoptimer's osu!-style weighting)
//
// - base(tier) is triangular (T1 10, T2 30, T3 60, T4 100, T5 150, T6 210): one T6 clear is worth 21 T1 clears, so the
//   overall rank can't be farmed on easy maps. Tiers above 6 clamp to 6; maps with no tier are unranked (0 points).
// - Bonus tracks give a quarter of the main track's base (they're short, and bonus boards are Normal only).
// - The completion part (the "1 +") guarantees every verified finish counts; quality rewards closing the gap to the WR
//   on every board, not just the top 10; placement is the SurfTimer-style top-10 bonus.
// - Overall points = the 0.975-weighted sum of weighted points over every record; style rankings = the same weighted
//   sum of raw points over that style's records. The weighting (from shavit-rankings) means the 28th-best record counts
//   half, so rank comes from a strong set of records rather than from finishing the most maps or re-running the same
//   map in every style.
// - Everything is a pure function of (tier, track, style, ticks, wrTicks, rank), recomputed for a whole board when a
//   run on it is verified, and for a whole map when its tier/version/pinned zones change.

import { clampTier, type Tier } from "./tiers";

export const TIER_BASE: Record<Tier, number> = { 1: 10, 2: 30, 3: 60, 4: 100, 5: 150, 6: 210 };
export const BONUS_TRACK_FACTOR = 0.25;

/** Placement bonus by board rank (index 0 = rank 1). Ties share a rank, so tied WRs both get 1.0. */
export const PLACEMENT = [1.0, 0.75, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2] as const;

/**
 * Overall-rank weight per style. Normal counts most (bhoptimer instead gives the hard styles 1.2–1.5×; we don't, so the
 * headline rank stays a Normal rank and five styles of one map can't outweigh new maps). Legit Scroll is the classic
 * "harder Normal" and keeps most; the key-restricted styles count 0.6. Every style also has its own ranking
 * (unweighted raw points), so style specialists get a board of their own.
 */
export const STYLE_WEIGHT: Record<string, number> = { autohop: 1, legit: 0.8, scroll: 0.8, wonly: 0.6, sideways: 0.6, hsw: 0.6, autostrafe: 0, lowgrav: 0 };
// Auto-strafe (assisted: the game presses A/D from your mouse) is a separate scored mode: its own boards, WRs and
// style ranking (raw points, like every style), but weight 0, so it adds nothing to the overall rank (bhoptimer's
// convention for assisted/TAS styles: rankingmultiplier 0). Styles missing here (none today; stale ids) earn nothing.

/** True if records in this style earn (style-ranking) points: the style has its own ranking. */
export const isRankedStyle = (style: string): boolean => Object.hasOwn(STYLE_WEIGHT, style);

/** Each record counts 0.975× the one before it (sorted by points, best first). */
export const RECORD_WEIGHTING = 0.975;
/** Records past this many add nothing (0.975^500 ≈ 3e-6); bounds the SQL weight table. */
export const MAX_WEIGHTED_RECORDS = 500;

export function placementBonus(rank: number): number {
  return rank >= 1 && rank <= PLACEMENT.length ? PLACEMENT[rank - 1] : 0;
}

export interface RecordInput {
  tier: number | null;
  track: number;
  style: string;
  ticks: number;
  wrTicks: number;
  rank: number;
}

/** Raw (style-blind) points of one record; 0 on unrated maps and for unknown styles. */
export function recordPointsRaw(r: RecordInput): number {
  const t = clampTier(r.tier);
  if (!t || r.ticks <= 0 || !isRankedStyle(r.style)) return 0;
  const base = TIER_BASE[t] * (r.track > 0 ? BONUS_TRACK_FACTOR : 1);
  return base * (1 + r.wrTicks / r.ticks + placementBonus(r.rank));
}

/** Points the record adds to the overall rank (before the per-player 0.975 weighting). */
export function recordPoints(r: RecordInput): number {
  return recordPointsRaw(r) * (STYLE_WEIGHT[r.style] ?? 0);
}

/** A player's total from their record points: sorted best first, i-th counts RECORD_WEIGHTING^i. */
export function weightedTotal(points: number[]): number {
  const sorted = [...points].sort((a, b) => b - a).slice(0, MAX_WEIGHTED_RECORDS);
  let total = 0;
  let w = 1;
  for (const p of sorted) {
    total += p * w;
    w *= RECORD_WEIGHTING;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Rank titles (SurfTimer-style skill groups: the top few by position, then percentiles, each with a points floor so a
// handful of players on a new server don't all come out as "Legend").

export interface RankGroup {
  id: string;
  name: string;
  color: string;
  /** Qualifies by board position (rank ≤ maxRank) ... */
  maxRank?: number;
  /** ... or by percentile (rank / ranked players ≤ top). */
  top?: number;
  /** ... and always needs at least this many overall points. */
  minPoints: number;
}

export const RANK_GROUPS: RankGroup[] = [
  { id: "legend", name: "Legend", color: "#ffd45e", maxRank: 3, minPoints: 2000 },
  { id: "grandmaster", name: "Grandmaster", color: "#ff5468", top: 0.01, minPoints: 1500 },
  { id: "master", name: "Master", color: "#c477ff", top: 0.05, minPoints: 1000 },
  { id: "elite", name: "Elite", color: "#4fa8ff", top: 0.1, minPoints: 600 },
  { id: "expert", name: "Expert", color: "#3fd0c9", top: 0.2, minPoints: 300 },
  { id: "skilled", name: "Skilled", color: "#5ee08a", top: 0.35, minPoints: 120 },
  { id: "hopper", name: "Hopper", color: "#d6dceb", top: 0.6, minPoints: 40 },
  { id: "rookie", name: "Rookie", color: "#9aa3b5", top: 1, minPoints: 0.0001 },
];
export const UNRANKED: RankGroup = { id: "unranked", name: "Unranked", color: "#6f7889", minPoints: 0 };

/** Rank title for a player at `rank` (1-based) of `ranked` players with `points`. */
export function rankGroup(points: number, rank: number | null, ranked: number): RankGroup {
  if (!rank || points <= 0 || ranked <= 0) return UNRANKED;
  const pct = rank / ranked;
  for (const g of RANK_GROUPS) {
    if (points < g.minPoints) continue;
    if ((g.maxRank !== undefined && rank <= g.maxRank) || (g.top !== undefined && pct <= g.top)) return g;
  }
  return UNRANKED;
}

export const rankGroupById = (id: string) => RANK_GROUPS.find((g) => g.id === id) ?? UNRANKED;

/** "top 4%" style wording used next to a rank title (Aimperion: one wording everywhere). */
export function topPercent(rank: number, ranked: number): string {
  if (!rank || !ranked) return "";
  const p = (rank / ranked) * 100;
  return `top ${p < 1 ? p.toFixed(1).replace(/\.0$/, "") : Math.max(1, Math.ceil(p))}%`;
}

export function fmtPoints(p: number): string {
  return Math.round(p).toLocaleString("en-US");
}
