// Player points and overall rank. DOM-free: the API generates its recompute SQL from these constants
// (apps/api/src/points.ts) and the client uses the same functions to explain points and draw rank titles.
// Design notes and the research behind it: research/RANKS.md.
//
// Points per record (one verified PB on one board = map × track × style), for N players on the board and your place:
//
//   clear     = 3 × base(tier) × (0.4 + 0.6 × quality²)                   quality = wrTicks / yourTicks, 0..1
//   placement = 40 × √(base / 10) × ((N / place)^0.2 − 1) × (1 + 1 / place)
//   record    = (clear + placement) × trackFactor                         "raw" (style-blind) points
//   WR        = (clear + placement) at place 2 and WR pace × (1 + min(1, ln N / ln 30)), × trackFactor
//   alone     = clear at WR pace, × trackFactor
//   weighted  = raw × styleWeight(style)                                  what the overall rank sums
//
//   total = Σ weighted[i] × 0.985^i over the player's records sorted best first (bhoptimer's osu!-style weighting,
//   flatter than its 0.975)
//
// - base(tier) is triangular, 5 × t × (t + 1): T1 10, T2 30, T3 60, T4 100, T5 150, T6 210, T7 280, T8 360, T9 450,
//   T10 550 (each step 10 more than the one before; T8–T10 joined in v0.0.37, before that every map above 7 scored as
//   T7). Tiers above 10 clamp to T10; maps with no tier are unranked (0 points).
// - Clear pays for finishing the map at all, with time on top. Placement only pays for players you actually beat, so last
//   place on the most played map earns nothing for that map being popular.
// - A WR pays 2× second place from 30 players up, and less below that, because a WR on an unplayed map is cheap.
// - Past the top 10, N and place round down to steps (STEPS, 10 per decade, N capped at 10,000). A new finisher then
//   changes points only for the few players who cross a step, instead of rewriting every row and every total on the board
//   (research/RANKING-REVAMP.md: ~4× the D1 writes otherwise).
// - Bonus tracks give no points (BONUS_MAX_TIER 0, owner 11-12: "set bonus points to 0 and see if anyone complains";
//   their boards and WRs stay). The mechanism, should it come back: a quarter, scored at most at BONUS_MAX_TIER, because a
//   bonus has no tier of its own and is usually a
//   short track (8-20 s WRs at every map tier), so a T6-T8 map's bonus paid like a hard map for a few seconds' run
//   (bhop_minecraft_spiral's 0.8 s bonus 2 paid 158 points, more than a T3 map's WR). The same rule in every style.
// - Length (v0.0.40): a main-track record is multiplied by its map's length factor (maps.length_factor, set offline from
//   the SourceJump WR's jump count: lengthFactorFor below). Length counts more the harder the tier, because a long hard
//   map compounds (one slip anywhere costs the run): T1-T2 are never changed, a T7 twice as long as a typical T7 pays
//   ~11% more. Troll stamina maps opt out of the bonus by hand (owner 11-07: bhop_ragequit). Styles whose tier is capped
//   (Infinite) keep 1.
// - Overall points = the 0.985-weighted sum of weighted points over every record; style rankings = the same weighted
//   sum of raw points over that style's records. The weighting (from shavit-rankings) means the 46th-best record counts
//   half, so rank comes from a strong set of records rather than from finishing the most maps or re-running the same
//   map in every style. (Until 2026-10-28 it was bhoptimer's 0.975: the 28th counted half and the 100th 0.08×, so a
//   player past ~60 records got almost nothing for clearing more T1/T2 maps. research/RANKS.md "Weighting".)
// - Everything is a pure function of (tier, track, style, ticks, wrTicks, rank, players), recomputed for a whole board when
//   a run on it is verified, and for a whole map when its tier/version/pinned zones change.

import { clampTier, type Tier } from "./tiers";

export const TIER_BASE: Record<Tier, number> = { 1: 10, 2: 30, 3: 60, 4: 100, 5: 150, 6: 210, 7: 280, 8: 360, 9: 450, 10: 550 };
export const BONUS_TRACK_FACTOR = 0.25;
/**
 * The highest tier a bonus track is scored at (v0.0.40, owner's choice; research in the v0.0.40 ranks report): bonus
 * boards pay like a T1-T2 map at most, whatever the map's tier. 0 = bonuses give no points at all (their boards and WRs
 * stay, unranked). src/points.ts tierSql mirrors this.
 */
export const BONUS_MAX_TIER: number = 0;

export const CLEAR_WEIGHT = 3;
export const CLEAR_FLOOR = 0.4;
export const CLEAR_TIME = 0.6;
export const PLACEMENT_WEIGHT = 40;
export const PLAYERS_POWER = 0.2;
/** A WR pays 2× second place from this many players up. */
export const WR_FULL_PLAYERS = 30;
/** Places that are always exact, not rounded to a step. */
export const TOP_PLACES = 10;
export const MAX_COUNTED_PLAYERS = 10_000;

// Short decimals on purpose: the SQL carries these as literals, and they must parse to the same doubles as here.
const fixed = (x: number) => Number(x.toFixed(9));

/** One step for player counts and places: from `from` up to the next step, x^PLAYERS_POWER etc. take these values. */
export interface PointsStep {
  from: number;
  power: number;
  inverse: number;
  wrRamp: number;
}

/** 1..10 exact, then 10 steps per decade up to MAX_COUNTED_PLAYERS. */
export const STEPS: readonly PointsStep[] = (() => {
  const from = Array.from({ length: TOP_PLACES }, (_, i) => i + 1);
  for (let k = 11; 10 ** (k / 10) <= MAX_COUNTED_PLAYERS + 0.5; k++) from.push(Math.ceil(10 ** (k / 10) - 1e-9));
  return from.map((x) => ({
    from: x,
    power: fixed(x ** PLAYERS_POWER),
    inverse: fixed(1 / x),
    wrRamp: fixed(Math.min(1, Math.log(x) / Math.log(WR_FULL_PLAYERS))),
  }));
})();

export function pointsStep(x: number): PointsStep {
  let step = STEPS[0];
  for (const s of STEPS) {
    if (x < s.from) break;
    step = s;
  }
  return step;
}

/** placement's weight per tier: PLACEMENT_WEIGHT × √(base / 10). */
export const TIER_PLACEMENT: Record<Tier, number> = Object.fromEntries(
  Object.entries(TIER_BASE).map(([t, b]) => [t, fixed(PLACEMENT_WEIGHT * Math.sqrt(b / 10))]),
) as Record<Tier, number>;

/**
 * Overall-rank weight per style. Normal counts most (bhoptimer instead gives the hard styles 1.2–1.5×; we don't, so the
 * headline rank stays a Normal rank and five styles of one map can't outweigh new maps). Legit Scroll is the classic
 * "harder Normal" and keeps most; the key-restricted styles count 0.6. Every style also has its own ranking
 * (unweighted raw points), so style specialists get a board of their own.
 */
export const STYLE_WEIGHT: Record<string, number> = { autohop: 1, legit: 0.8, scroll: 0.8, wonly: 0.6, sideways: 0.6, hsw: 0.6, autostrafe: 0, lowgrav: 0, segmented: 0, infinite: 0.2, backwards: 0.6, adonly: 0.6 };
// Auto-strafe (assisted: the game presses A/D from your mouse) is a separate scored mode: its own boards, WRs and
// style ranking (raw points, like every style), but weight 0, so it adds nothing to the overall rank (bhoptimer's
// convention for assisted/TAS styles: rankingmultiplier 0). Styles missing here (none today; stale ids) earn nothing.
// Segmented likewise: bhoptimer's default shavit-styles.cfg gives it "rankingmultiplier" "0.0" (records and replays, no
// points) because its checkpoint loads let a run be assembled from retried pieces (research/SEGMENTED.md).
// Low Gravity changes the movement itself, so its times don't compare with the other styles: own boards and style
// ranking, weight 0. Infinite (air jumps, no prespeed cap; v0.0.36) too, but the owner gave it a small multiplier, 0.2
// (11-04): its records count a little towards the overall rank. It still earns no XP or clear achievements
// (styles.ts separate): air jumps make hard maps easy.
// Backwards (v0.0.36) is a key-restricted style like W-Only: plain movement, keys limited by the view, so 0.6.
// A/D-Only (v0.0.37) too: plain movement, one side key, so 0.6 (bhoptimer's rankingmultiplier puts it at 1.5 against
// W-Only's 1.33 and Sideways' 1.30; ours keep every key-restricted style level).

/** True if records in this style earn (style-ranking) points: the style has its own ranking. */
export const isRankedStyle = (style: string): boolean => Object.hasOwn(STYLE_WEIGHT, style);

/** Each record counts 0.985× the one before it (sorted by points, best first). */
export const RECORD_WEIGHTING = 0.985;
/** Records past this many add nothing (0.985^800 ≈ 6e-6); bounds the SQL weight table. */
export const MAX_WEIGHTED_RECORDS = 800;

export interface RecordInput {
  tier: number | null;
  track: number;
  style: string;
  ticks: number;
  wrTicks: number;
  rank: number;
  /** Players on the board. */
  players: number;
  /** The map's length factor (maps.length_factor); main track only, absent = 1. */
  lengthFactor?: number;
}

/**
 * The highest tier a style's boards are scored at (owner 11-04): Infinite's air jumps flatten a hard map, so a T7
 * cleared in Infinite pays like a T3. Its first clears of empty T6/T7 boards had made a Grandmaster out of Infinite
 * alone. src/points.ts tierSql mirrors this. T8–T10 (v0.0.37) are capped the same way.
 */
export const STYLE_MAX_TIER: Readonly<Record<string, Tier>> = { infinite: 3 };

/**
 * The tier a record is scored at: the map's (clamped to 1..10), capped for the styles in STYLE_MAX_TIER and for bonus
 * tracks at BONUS_MAX_TIER; null = no points (no tier, or bonuses unranked).
 */
export function scoredTier(tier: number | null, style: string, track = 0): Tier | null {
  const t = clampTier(tier);
  if (!t) return null;
  const caps = [Object.hasOwn(STYLE_MAX_TIER, style) ? STYLE_MAX_TIER[style] : 10, track > 0 ? BONUS_MAX_TIER : 10];
  const cap = Math.min(...caps);
  return cap < 1 ? null : (Math.min(t, cap) as Tier);
}

/**
 * Typical jumps in a SourceJump WR per tier (the median over maps with 5+ SourceJump runs, fetched 2026-11-07,
 * tools/ranking/sourcejump.json), made non-decreasing: past T4 tier measures difficulty more than length.
 */
export const LENGTH_REF_JUMPS: Record<Tier, number> = { 1: 25, 2: 39, 3: 72, 4: 197, 5: 270, 6: 351, 7: 386, 8: 386, 9: 386, 10: 386 };
/** Tier steps per doubling of length over the tier's typical WR: none at T1-T2, then 0.05 a tier up to 0.25 (T7+). */
export const lengthStep = (t: Tier): number => Math.min(0.25, 0.05 * Math.max(0, t - 2));
/** A map can gain up to two steps (4× the typical length) and lose one (half of it or shorter). */
export const LENGTH_UP_STEPS = 2;
export const LENGTH_DOWN_STEPS = 1;

/**
 * A map's length factor from its tier and the jumps in its SourceJump WR (null: unknown → 1): the points of tier
 * t + adj over tier t, adj = lengthStep(t) × log2(jumps / typical), clamped. `bonus: false` (troll stamina maps) keeps
 * the cut for short maps but no gain. Rounded to 4 decimals: the value is stored in maps.length_factor.
 */
export function lengthFactorFor(tier: number | null, jumps: number | null, bonus = true): number {
  const t = clampTier(tier);
  if (!t || !jumps || jumps <= 0) return 1;
  const step = lengthStep(t);
  if (!step) return 1;
  let adj = step * Math.log2(jumps / LENGTH_REF_JUMPS[t]);
  adj = Math.max(-step * LENGTH_DOWN_STEPS, Math.min(step * LENGTH_UP_STEPS, adj));
  if (!bonus) adj = Math.min(0, adj);
  const base = (x: number) => 5 * x * (x + 1); // TIER_BASE's curve between whole tiers
  return Math.round((base(t + adj) / base(t)) * 1e4) / 1e4;
}

/** Raw (style-blind) points of one record; 0 on unrated maps and for unknown styles. src/points.ts RAW_SQL mirrors this, operation for operation. */
export function recordPointsRaw(r: RecordInput): number {
  const t = scoredTier(r.tier, r.style, r.track);
  if (!t || r.ticks <= 0 || !isRankedStyle(r.style)) return 0;
  const track = r.track > 0 ? BONUS_TRACK_FACTOR : 1;
  const len = r.track === 0 && t === clampTier(r.tier) ? (r.lengthFactor ?? 1) : 1;
  const clear = CLEAR_WEIGHT * TIER_BASE[t];
  const n = pointsStep(r.players);
  if (r.rank === 1) {
    if (r.players <= 1) return clear * track * len;
    const second = pointsStep(2);
    return (clear + TIER_PLACEMENT[t] * Math.max(0, n.power / second.power - 1) * (1 + second.inverse)) * (1 + n.wrRamp) * track * len;
  }
  const q = r.wrTicks / r.ticks;
  const place = pointsStep(r.rank);
  return (clear * (CLEAR_FLOOR + CLEAR_TIME * (q * q)) + TIER_PLACEMENT[t] * Math.max(0, n.power / place.power - 1) * (1 + place.inverse)) * track * len;
}

/** Points the record adds to the overall rank (before the per-player RECORD_WEIGHTING). */
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

/** The title of a board's #1 (v0.0.36, Throw's ask; owner: "a separate title for them"). Its holder may pick its colour. */
export const NUMBER_ONE = "number-one";

export const RANK_GROUPS: RankGroup[] = [
  { id: NUMBER_ONE, name: "Number One", color: "#ffffff", maxRank: 1, minPoints: 3500 },
  { id: "legend", name: "Legend", color: "#ffd45e", maxRank: 3, minPoints: 3500 },
  { id: "grandmaster", name: "Grandmaster", color: "#ff5468", top: 0.01, minPoints: 2500 },
  { id: "master", name: "Master", color: "#c477ff", top: 0.05, minPoints: 1750 },
  { id: "elite", name: "Elite", color: "#4fa8ff", top: 0.1, minPoints: 1000 },
  { id: "expert", name: "Expert", color: "#3fd0c9", top: 0.2, minPoints: 500 },
  { id: "skilled", name: "Skilled", color: "#5ee08a", top: 0.35, minPoints: 200 },
  { id: "hopper", name: "Hopper", color: "#d6dceb", top: 0.6, minPoints: 70 },
  { id: "rookie", name: "Rookie", color: "#9aa3b5", top: 1, minPoints: 0.0001 },
];
export const UNRANKED: RankGroup = { id: "unranked", name: "Unranked", color: "#6f7889", minPoints: 0 };

/** Rank title for a player at `rank` (1-based) of `ranked` players with `points`, on board `scope` ("all" = overall). */
export function rankGroup(points: number, rank: number | null, ranked: number, scope = "all"): RankGroup {
  if (!rank || points <= 0 || ranked <= 0) return UNRANKED;
  const pct = rank / ranked;
  for (const g of RANK_GROUPS) {
    // Number One is the overall #1's alone: a style board's #1 reads Legend.
    if (g.id === NUMBER_ONE && scope !== "all") continue;
    if (points < g.minPoints) continue;
    if ((g.maxRank !== undefined && rank <= g.maxRank) || (g.top !== undefined && pct <= g.top)) return g;
  }
  return UNRANKED;
}

export const rankGroupById = (id: string) => RANK_GROUPS.find((g) => g.id === id) ?? UNRANKED;

/** A colour the Number One picked (CosmeticChoice.rankColor): "#rrggbb", or null. */
export const rankColorOf = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/**
 * A rank title's colour as shown: the Number One's own pick (from their cosmetics' rankColor) on the overall board,
 * else the group's. Other titles and style boards always keep the group's colour.
 */
export function shownRankColor(scope: string, group: { id: string; color: string }, rankColor: unknown): string {
  return scope === "all" && group.id === NUMBER_ONE ? (rankColorOf(rankColor) ?? group.color) : group.color;
}

/** "top 4%" style wording used next to a rank title (Aimperion: one wording everywhere). */
export function topPercent(rank: number, ranked: number): string {
  if (!rank || !ranked) return "";
  // At least 0.1: rank 1 of thousands rounded down to "top 0%".
  const p = Math.max(0.1, (rank / ranked) * 100);
  return `top ${p < 1 ? p.toFixed(1).replace(/\.0$/, "") : Math.max(1, Math.ceil(p))}%`;
}

export function fmtPoints(p: number): string {
  return Math.round(p).toLocaleString("en-US");
}
