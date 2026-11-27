// Meta progression: XP and account level, achievements (badges), cosmetic unlocks and the "next map" suggestion.
// DOM-free and deterministic: the API (apps/api/src/progress.ts) awards XP and unlocks achievements from verified
// runs with exactly this code, and the client renders the same catalogue (profile, card editor, home screen).
//
// Rules of thumb (see research/RANKS.md "Meta progression"):
//   - Everything comes from verified runs (the server re-simulated them), so nothing here can be farmed with a
//     modified client. "Time played" is active play time (users.playtime_seconds; Clocked In / Overtime); clock time is still kept; jumps are the verified jump counts.
//   - Anti-grind: repeat finishes of the same board on the same UTC day give less XP (full for the first 3, then
//     a quarter, then nothing after 10), PB XP is capped at 3 per board per day, first clears are once per board.
//   - Unlocks are cosmetic only (card backgrounds, frames, title tags, ghost and trail colours, bunny colourways, and
//     the first-person loadout: knife, finish, gloves). No physics changes, nothing for sale, nothing random.
//   - Staff own every earned cosmetic while they hold the role (rank-held ones: preview only, unless it's the owner;
//     the owner's own items stay the owner's: staffGrant); their achievements and XP still come only from playing.

import { clampTier, MAX_TIER, TIERS, tierLabel, tierNum, type Tier } from "./tiers";
import { earnsProgression, isStyleId, STYLE_DEFS } from "./styles";
import { rankColorOf } from "./ranking";

// ---------------------------------------------------------------------------------------------
// XP

export type XpKind = "finish" | "time" | "jumps" | "pb" | "first_clear" | "first_tier" | "gauntlet";

export interface XpRunInput {
  /** Raw map tier (null = unrated: counts as half a tier). */
  tier: number | null;
  track: number;
  /** Server-recomputed time in seconds, and verified jump count. */
  time: number;
  jumps: number;
  /** Verified finishes of this exact board (map version, zones, style, track) by this player earlier the same UTC day. */
  finishesToday: number;
  /** PB improvements on this board earlier the same UTC day. */
  pbsToday: number;
  /** This run is the player's first verified finish of this board. */
  firstClear: boolean;
  /** This run improved an existing PB on this board (not the first clear). */
  improvedPB: boolean;
  /** Main-track first clear and the player had no main-track clear of this tier before (any style). */
  firstOfTier: boolean;
}

export const XP_RULES = {
  finishPerTier: 10,
  secondsPerXp: 10,
  maxTimeXp: 60,
  jumpsPerXp: 25,
  maxJumpXp: 40,
  pbPerTier: 15,
  pbPerBoardPerDay: 3,
  firstClearPerTier: 50,
  firstTierPerTier: 100,
  bonusTrackFactor: 0.5,
  /** A gauntlet's first clear (apps/api/src/gauntlets.ts): this much per tier of each of its maps (an unrated map 0.5),
   * half a map's own first clear, on top of the runs' XP. The 3-map weekly ≈ 150, the 20-map classic ≈ 1,800. */
  gauntletPerTier: 25,
} as const;

/** XP for a gauntlet's first clear: XP_RULES.gauntletPerTier per (clamped) map tier, an unrated map counting half. */
export function gauntletXp(tiers: readonly (number | null)[]): number {
  return Math.floor(tiers.reduce<number>((t, x) => t + (clampTier(x) ?? 0.5), 0) * XP_RULES.gauntletPerTier);
}

/** Repeat-finish damping: the n-th finish (0-based) of the same board in a UTC day. */
export function repeatFactor(finishesToday: number): number {
  if (finishesToday < 3) return 1;
  if (finishesToday < 10) return 0.25;
  return 0;
}

/** XP for one verified run, split by kind (zero entries omitted). Integer amounts. */
export function runXp(r: XpRunInput): { kind: XpKind; amount: number }[] {
  const t = clampTier(r.tier);
  const tierUnits = t ?? 0.5;
  const trackF = r.track > 0 ? XP_RULES.bonusTrackFactor : 1;
  const rep = repeatFactor(r.finishesToday);
  const out: { kind: XpKind; amount: number }[] = [];
  const add = (kind: XpKind, v: number) => {
    const amount = Math.floor(v);
    if (amount > 0) out.push({ kind, amount });
  };
  add("finish", XP_RULES.finishPerTier * tierUnits * trackF * rep);
  add("time", Math.min(XP_RULES.maxTimeXp, Math.floor(Math.max(0, r.time) / XP_RULES.secondsPerXp)) * rep);
  add("jumps", Math.min(XP_RULES.maxJumpXp, Math.floor(Math.max(0, r.jumps) / XP_RULES.jumpsPerXp)) * rep);
  if (r.improvedPB && r.pbsToday < XP_RULES.pbPerBoardPerDay) add("pb", XP_RULES.pbPerTier * Math.max(1, tierUnits) * trackF);
  if (r.firstClear) add("first_clear", XP_RULES.firstClearPerTier * tierUnits * trackF);
  if (r.firstOfTier && t && r.track === 0) add("first_tier", XP_RULES.firstTierPerTier * t);
  return out;
}

/** A verified run as the XP rules see it. `board` = "<map version>:<zones>:<style>:<track>". */
export interface XpRun {
  id: string;
  board: string;
  /** The map's current tier (raw). */
  tier: number | null;
  track: number;
  ticks: number;
  time: number;
  jumps: number;
  /** Submission time (ms): defines "earlier" and the UTC day. */
  at: number;
}

const DAY_MS = 86_400_000;
const before = (a: XpRun, b: XpRun) => a.at < b.at || (a.at === b.at && a.id < b.id);
/** A run's score for PB comparisons: its time in whole milliseconds, as the boards rank (v0.0.29). */
const scoreMs = (r: XpRun) => Math.round(r.time * 1000);

/**
 * The XP context of `run` given the player's earlier verified runs (any order; anything not earlier is ignored). Only
 * runs on the same board and main-track runs matter, so callers may pass just those.
 */
export function xpContext(prior: XpRun[], run: XpRun): XpRunInput {
  const earlier = prior.filter((p) => p.id !== run.id && before(p, run)).sort((a, b) => (before(a, b) ? -1 : 1));
  const day = Math.floor(run.at / DAY_MS);
  const same = earlier.filter((p) => p.board === run.board);
  let best = Infinity;
  let pbsToday = 0;
  for (const p of same) {
    if (scoreMs(p) < best && best !== Infinity && Math.floor(p.at / DAY_MS) === day) pbsToday++;
    best = Math.min(best, scoreMs(p));
  }
  const t = clampTier(run.tier);
  return {
    tier: run.tier,
    track: run.track,
    time: run.time,
    jumps: run.jumps,
    finishesToday: same.filter((p) => Math.floor(p.at / DAY_MS) === day).length,
    pbsToday,
    firstClear: same.length === 0,
    improvedPB: same.length > 0 && scoreMs(run) < best,
    firstOfTier: run.track === 0 && t !== null && !earlier.some((p) => p.track === 0 && clampTier(p.tier) === t),
  };
}

/** XP ledger rows for a run (`ref` dedupes first clears / first-of-tier when accounts merge). */
export function xpEvents(prior: XpRun[], run: XpRun): { kind: XpKind; amount: number; ref: string | null }[] {
  const ctx = xpContext(prior, run);
  return runXp(ctx).map((e) => ({ ...e, ref: e.kind === "first_clear" ? run.board : e.kind === "first_tier" ? `t${clampTier(run.tier)}` : null }));
}

/** Total XP needed to reach `level` (level 1 = 0 XP). Each level costs 50 more than the last: 100, 150, 200, ... */
export function xpForLevel(level: number): number {
  const n = Math.max(0, Math.floor(level) - 1);
  return 100 * n + 25 * n * (n - 1);
}

export interface LevelInfo {
  level: number;
  xp: number;
  /** XP into the current level / needed for the next one. */
  into: number;
  need: number;
  /** 0..1 progress to the next level. */
  fraction: number;
}

export function levelInfo(xp: number): LevelInfo {
  xp = Math.max(0, Math.floor(xp));
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const base = xpForLevel(level);
  const need = xpForLevel(level + 1) - base;
  return { level, xp, into: xp - base, need, fraction: need ? (xp - base) / need : 0 };
}

// ---------------------------------------------------------------------------------------------
// Achievements

/** Snapshot of a player's verified progress; the server builds it with a few aggregate queries. */
export interface ProgressStats {
  giftsSent?: number;
  /** Distinct maps with a main-track finish (any style), by clamped tier; index 0 = unrated. */
  clearsByTier: number[];
  /** Ranked maps per tier (index 0 = unrated), for "clear every T1". */
  rankedByTier: number[];
  /** Currently ranked maps cleared in progression-eligible styles, for Sweep only. */
  rankedClearsByTier?: number[];
  /** Distinct maps with a main-track finish (any style). */
  maps: number;
  /** Personal bests held (boards with a verified run). */
  pbs: number;
  /** Boards where the player currently holds rank 1 / a top-10 place. */
  wrs: number;
  top10s: number;
  /** Distinct bonus boards finished. */
  bonuses: number;
  /** Distinct maps finished (main track) per style id. */
  styleMaps: Record<string, number>;
  /** Highest tier finished (main track) in a style other than Normal (0 = none). */
  altStyleMaxTier: number;
  runs: number;
  jumps: number;
  /** Seconds on the clock across verified finishes. */
  seconds: number;
  /** Active play time in seconds (users.playtime_seconds; the card's "12.4h played"). */
  playtime: number;
  level: number;
  /** Best main-track Normal time (seconds) per map, for time goals. */
  bestNormal: Record<string, number>;
  /**
   * Best main-track time (seconds) per map in any style that earns progression (earnsProgression: Normal and the other
   * classic styles; not Auto-strafe or the separate modes), for the time goals that take any of them (anyStyle).
   */
  bestClassic?: Record<string, number>;
  /** Best sync % on a main-track finish of tier >= 2. */
  bestSync: number;
  /** Maps with a main-track finish in a progression style (Home Turf and the map-set goals). Absent = none known. */
  clearedMaps?: readonly string[];
  /** Slowest main-track Normal finish (seconds) per map (Scenic Route). */
  worstNormal?: Record<string, number>;
  /** A main-track bhop_eazy finish after reaching level 25 (Back to Basics). */
  eazyAfterL25?: boolean;
  /** !races won by finishing first (not by forfeit or timeout), and how many different players were beaten. */
  raceWins?: number;
  raceOpponents?: number;
  /** A !race won by less than PHOTO_FINISH_S on server finish times, with both runs verified. */
  photoFinish?: boolean;
  /** Most HALLOWEEN_MAPS cleared inside one year's HALLOWEEN_WINDOW. */
  halloweenSeason?: number;
  /** Most WINTER_MAPS cleared inside one winter's WINTER_WINDOW (December 1 to January 7, one season). */
  winterSeason?: number;
  /** Gauntlets (apps/api/src/gauntlets.ts). Absent = none cleared. */
  gauntlets?: GauntletStats;
  /** The Daily Challenge (apps/api/src/daily.ts). Absent = never played one. */
  daily?: DailyStats;
  /**
   * Maps made by a linked mapper (apps/api/src/mappers.ts) where the player's best Normal main-track time is under the
   * mapper's own. Never the player's own maps.
   */
  beatMapper?: number;
}

/**
 * A player's Daily Challenge record. Taking part: days with a time on the day's board, days they beat their own earlier
 * time of that day, days they closed in the faster half of the board. Podium places, frozen at each close.
 */
export interface DailyStats {
  days: number;
  improved?: number;
  topHalf?: number;
  gold: number;
  silver: number;
  bronze: number;
}

/** A player's gauntlet record for the gauntlet achievements. */
export interface GauntletStats {
  /** Slugs of the gauntlets with a complete attempt (any kind). */
  cleared: string[];
  /** Published public permanent gauntlets, and how many of them are cleared. */
  permanent: number;
  permanentCleared: number;
  /** Best total (seconds) on the classic 20-map gauntlet (CLASSIC_GAUNTLET), null without a clear. */
  classicBest: number | null;
  /** Weekly results (frozen at close): top-3 places and wins. */
  podiums: number;
  wins: number;
}

/** The classic 20-map Bunny Hop Map Gauntlet and its Mini (slugs: tools/gauntlets/seed-permanent.ts). */
export const CLASSIC_GAUNTLET = "classic";
export const MINI_GAUNTLET = "classic-mini";
/** "Under Five Hours": the classic's ranked total (the sum of the runs) under this. */
export const CLASSIC_FAST_SECONDS = 5 * 3600;

export type AchievementGroup = "start" | "tier" | "sweep" | "maps" | "records" | "style" | "time" | "lifetime" | "level" | "social" | "gauntlet" | "event";
/** Ring colour of the badge token (hatchdle-style ladders): bronze, silver, gold, prism. */
export type Ring = 0 | 1 | 2 | 3;

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  group: AchievementGroup;
  /** Glyph id (ui/badges.ts draws them). */
  icon: string;
  ring: Ring;
  /** Title tag unlocked with this badge. */
  title?: string;
  /** Hidden until earned ("???"). */
  hidden?: boolean;
  /**
   * Awarded by the server for something that isn't a run stat (e.g. the room Durable Object for Play with the Owner):
   * never earned from ProgressStats, progress is always [0, 1] until it is recorded.
   */
  event?: boolean;
  /** The goal in a few words, for unlock hints where the name doesn't say it ("Link Discord"). */
  goal?: string;
  /**
   * Listed as a goal only while it can be earned; otherwise only players who have it see it (their own Loadout,
   * profile, card). "closed": never again (Early Hopper). "discord_server": while the API's Discord bot grants the
   * community server rewards (GET /config discordMembership). "support": the Supporter set, whose items are listed as
   * locked like any other while the achievement itself is never listed as a goal to chase.
   */
  availability?: "closed" | "discord_server" | "support";
  /** A hidden achievement's cryptic line on its "???" (no numbers, nothing that gives it away). */
  secretHint?: string;
  /** Progress towards it: [current, goal]. */
  progress: (s: ProgressStats) => [number, number];
}

const at = (n: number, goal: number): [number, number] => [Math.min(n, goal), goal];
const TIER_TITLE: Record<Tier, string | undefined> = { 1: undefined, 2: undefined, 3: "Climber", 4: "Daredevil", 5: "Untouchable", 6: "Ascended", 7: "Transcendent", 8: "Immortal", 9: "Celestial", 10: "Eternal" };
const RING_BY_TIER: Record<Tier, Ring> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3 };
/** "tier 3", "tier 10" (achievement copy). */
const tierWords = (t: Tier) => `tier ${tierNum(t)}`;

/** The Santa Hat's map (TIME_GOALS "Sleigh Ride"): the code-built Christmas remix of bhop_ambience. */
export const SANTA_MAP = "bhop_ambience_xmas";

/**
 * Time goals ("Sub-X on bhop_eazy"). Thresholds need tuning against real WRs (see research/RANKS.md open questions).
 * `anyStyle`: any style that earns progression counts (bestClassic), not only Normal.
 */
export const TIME_GOALS: { map: string; seconds: number; name: string; ring: Ring; title?: string; id?: string; anyStyle?: boolean }[] = [
  // Was under 30 s, which nobody could earn (the Normal WR was 31.77 s in 2026-10). Owner, 2026-10-21: under 60 s. The
  // id stays the old one (user_achievements rows carry it). That made Eazy Does It (time_bhop_eazy_60, under 60 s, no
  // items) the same goal, so it's retired: rows that carry it stay in D1 but no longer show or pay XP; whoever had it
  // qualifies for Eazy Money instead (granted on their next run or profile view).
  { map: "bhop_eazy", seconds: 60, name: "Eazy Money", ring: 2, title: "Eazy", id: "time_bhop_eazy_30" },
  // Our own maps (WRs 2026-10: Meadow 14.1 s, 35 players under 20 s; Aero 22.6 s, 10 under 40 s).
  { map: "bhop_lol_meadow", seconds: 16, name: "Meadowlark", ring: 1 },
  { map: "bhop_lol_aero", seconds: 35, name: "Fair Weather", ring: 2 },
  // The Santa Hat (v0.0.44, owner 11-27: "for clearing bhop_ambience_xmas under a decent time"). Picked from the live
  // board on 11-27: WR 19.297 s; 19 of the 45 Normal finishers (42%) were under 22 s, and no other style's best was.
  { map: SANTA_MAP, seconds: 22, name: "Sleigh Ride", ring: 1, anyStyle: true },
];

/** The time goal that unlocks the Santa Hat. */
export const SANTA_GOAL = `time_${SANTA_MAP}_22`;

/**
 * Home Turf: the maps made for bunnyhop.lol (tools/meadow, tools/aero, tools/backrooms, tools/plaza). Hermes is left out:
 * clearing it is the secret (WINGS below).
 */
export const HOME_TURF_MAPS = ["bhop_lol_meadow", "bhop_lol_aero", "bhop_lol_backrooms", "bhop_lol_plaza"] as const;

/** True Architect: a clear of bhop_lol_backrooms (tools/backrooms). */
export const TRUE_ARCHITECT = "true_architect";
export const BACKROOMS_MAP = "bhop_lol_backrooms";

/** The Halloween collection (maps/index.json "halloween"; a test keeps them in step). */
export const HALLOWEEN_MAPS = [
  "bhop_asylum",
  "bhop_bfur_halloween",
  "bhop_bram_halloween",
  "bhop_cobblestone",
  "bhop_dark_forest",
  "bhop_darkage",
  "bhop_forgotten",
  "bhop_forgotten2",
  "bhop_halloween_sm_css",
  "bhop_haunt",
  "bhop_nature",
  "bhop_serenity",
  "bhop_tehoputki",
  "bhop_terrarium",
] as const;

/** The October window, every year (UTC, inclusive): Trick or Treat counts clears inside it. "MM-DD". */
export const HALLOWEEN_WINDOW = { from: "10-15", to: "11-07" } as const;

/** Whether `ms` falls inside that year's Halloween window. */
export function inHalloweenWindow(ms: number): boolean {
  const d = new Date(ms);
  const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return md >= HALLOWEEN_WINDOW.from && md <= HALLOWEEN_WINDOW.to;
}

/**
 * The Winter collection (maps/index.json "winter"; a test keeps them in step): the live maps set in snow or ice, picked
 * by eye from their pictures plus their snow textures and snowfall volumes.
 */
export const WINTER_MAPS = [
  "bhop_abstract_winter",
  "bhop_ambience_xmas",
  "bhop_boxes_snowy",
  "bhop_christmas",
  "bhop_cks_winter",
  "bhop_cold",
  "bhop_frost_bite_v1",
  "bhop_icebase",
  "bhop_icetrap",
  "bhop_jago",
  "bhop_kaunisnimi",
  "bhop_monster_jam_xmas",
  "bhop_snowwhite",
  "bhop_snowy",
  "bhop_strafe_winter",
  "bhop_strafing_in_siberia",
  "bhop_stref_siberia",
  "bhop_winter",
] as const;

/**
 * The winter window, every year (UTC, inclusive): December 1 to January 7, across the new year. "MM-DD". One season is
 * a December and the January after it (winterSeasonOf).
 */
export const WINTER_WINDOW = { from: "12-01", to: "01-07" } as const;

/** The winter season `ms` falls in: the year of its December (January 1-7 2027 is the 2026 season), or null outside. */
export function winterSeasonOf(ms: number): number | null {
  const d = new Date(ms);
  const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  if (md >= WINTER_WINDOW.from) return d.getUTCFullYear();
  if (md <= WINTER_WINDOW.to) return d.getUTCFullYear() - 1;
  return null;
}

/**
 * How long after a seasonal window closes the server still reads the season's history (a run finished on the last day
 * can be verified late). Outside a window plus this, Trick or Treat and Snow Day can't advance, so their scans are
 * skipped (apps/api/src/progress.ts) and their stats read 0 unless held.
 */
export const SEASON_GRACE_MS = 3 * 86_400_000;
/** Whether Trick or Treat's history is read at `now` (inside the October window, or just after it). */
export const halloweenScanOpen = (now: number): boolean => inHalloweenWindow(now) || inHalloweenWindow(now - SEASON_GRACE_MS);
/** Whether Snow Day's history is read at `now` (inside the winter window, or just after it). */
export const winterScanOpen = (now: number): boolean => winterSeasonOf(now) !== null || winterSeasonOf(now - SEASON_GRACE_MS) !== null;

/** A race won by less than this (seconds between server finishes) is a photo finish. */
export const PHOTO_FINISH_S = 0.05;

/** How many of `maps` the stats have cleared (main track, progression styles). */
export function clearedOf(s: ProgressStats, maps: readonly string[]): number {
  const set = new Set(s.clearedMaps ?? []);
  return maps.filter((m) => set.has(m)).length;
}

/** The "Play with the Owner" achievement (room-awarded) and how long both players must share a server. */
export const PLAY_WITH_OWNER = "play_with_owner";
export const OWNER_OVERLAP_SECONDS = 30;

/**
 * Community rewards (event achievements awarded by the API outside runs: apps/api/src/community.ts). Permanent once
 * earned like every achievement: unlinking Discord or leaving the server later takes nothing away.
 *   DISCORD_LINK    a Discord account linked to the player (the Discord sign-in callback; backfilled by migration 0019)
 *   DISCORD_MEMBER  a member of the community Discord server, seen by the API's Discord bot (on link / sign-in, hourly)
 *   DISCORD_BOOSTER boosting that server at a check (the member object's premium_since). The set stays when the boost
 *                   ends; only the profile's Booster flair follows the current boost (apps/api/src/community.ts)
 *   EARLY_HOPPER    a verified run before v0.0.8 (granted once by migration 0019, never again)
 */
export const DISCORD_LINK = "discord_link";
export const DISCORD_MEMBER = "discord_member";
export const DISCORD_BOOSTER = "discord_booster";
export const EARLY_HOPPER = "early_hopper";
/**
 * Supporter (v0.0.14): an admin's grant for now; one-time payments of SUPPORTER_MIN_USD or more come later (Stripe,
 * granting automatically). Recorded with users.supporter_since (apps/api/src/supporters.ts), which is what the
 * badge, the name colour and the reserved room slot read; this event achievement is what unlocks the Geode set.
 * Permanent like every achievement: only an admin's revoke (a refund or chargeback) takes it away. Cosmetic only.
 */
export const SUPPORTER = "supporter";
export const SUPPORTER_MIN_USD = 5;

/** Distinct main-track clears (progression styles) of maps at tier `t` or higher. */
const clearsFrom = (s: ProgressStats, t: Tier) => TIERS.filter((x) => x >= t).reduce((n, x) => n + (s.clearsByTier[x] ?? 0), 0);

const fmtGoal = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`);

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "country_flag", name: "Flying the Flag", desc: "Set a country flag on your profile", goal: "Set a profile flag", group: "social", icon: "flag", ring: 0, event: true, progress: () => [0, 1] },
  { id: "first_finish", name: "First Hop", desc: "Finish a run on any map", group: "start", icon: "flag", ring: 0, title: "Hopper", progress: (s) => at(s.runs, 1) },
  ...TIERS.map(
    (t): AchievementDef => ({
      id: `tier_${t}`,
      name: `First ${tierLabel(t)}`,
      desc: `Finish the main track of a ${tierWords(t)} map`,
      group: "tier",
      icon: `t${t}`,
      ring: RING_BY_TIER[t],
      title: TIER_TITLE[t],
      progress: (s) => at(s.clearsByTier[t] ? 1 : 0, 1),
    }),
  ),
  ...TIERS.map(
    (t): AchievementDef => ({
      id: `sweep_${t}`,
      name: `${tierLabel(t)} Sweep`,
      desc: `Finish every ranked ${tierWords(t)} map`,
      group: "sweep",
      icon: `t${t}`,
      ring: Math.min(3, RING_BY_TIER[t] + 1) as Ring,
      title: t >= 4 ? `${tierLabel(t)} Sweeper` : undefined,
      progress: (s) => (s.rankedByTier[t] ? at((s.rankedClearsByTier ?? s.clearsByTier)[t], s.rankedByTier[t]) : [0, 1]),
    }),
  ),
  { id: "maps_10", name: "Explorer", desc: "Finish 10 different maps", group: "maps", icon: "map", ring: 0, progress: (s) => at(s.maps, 10) },
  { id: "maps_25", name: "Globetrotter", desc: "Finish 25 different maps", group: "maps", icon: "map", ring: 1, title: "Globetrotter", progress: (s) => at(s.maps, 25) },
  { id: "maps_100", name: "Centurion", desc: "Finish 100 different maps", group: "maps", icon: "map", ring: 3, title: "Centurion", progress: (s) => at(s.maps, 100) },
  { id: "pbs_10", name: "Personal Best", desc: "Hold 10 personal bests", group: "records", icon: "pb", ring: 0, progress: (s) => at(s.pbs, 10) },
  { id: "pbs_50", name: "Best of the Best", desc: "Hold 50 personal bests", group: "records", icon: "pb", ring: 2, progress: (s) => at(s.pbs, 50) },
  { id: "top10_1", name: "Top 10", desc: "Hold a top-10 place on any board", group: "records", icon: "podium", ring: 1, progress: (s) => at(s.top10s, 1) },
  { id: "top10_10", name: "Regular Contender", desc: "Hold 10 top-10 places at once", group: "records", icon: "podium", ring: 2, title: "Contender", progress: (s) => at(s.top10s, 10) },
  { id: "wr_1", name: "World Record", desc: "Hold a world record", group: "records", icon: "crown", ring: 2, title: "Record Holder", progress: (s) => at(s.wrs, 1) },
  { id: "wr_5", name: "Record Collector", desc: "Hold 5 world records at once", group: "records", icon: "crown", ring: 3, title: "Record Collector", progress: (s) => at(s.wrs, 5) },
  { id: "bonus_1", name: "Bonus Round", desc: "Finish a bonus track", group: "maps", icon: "bonus", ring: 0, progress: (s) => at(s.bonuses, 1) },
  { id: "bonus_10", name: "Bonus Hunter", desc: "Finish 10 bonus tracks", group: "maps", icon: "bonus", ring: 1, title: "Bonus Hunter", progress: (s) => at(s.bonuses, 10) },
  { id: "style_legit", name: "Scroll Wheel", desc: "Finish a map in EZ Scroll", group: "style", icon: "scroll", ring: 1, progress: (s) => at(s.styleMaps.legit ?? 0, 1) },
  { id: "style_scroll", name: "True Scroll", desc: "Finish a map in Legit Scroll", group: "style", icon: "scroll", ring: 1, progress: (s) => at(s.styleMaps.scroll ?? 0, 1) },
  { id: "style_wonly", name: "W Only", desc: "Finish a map in W-Only", group: "style", icon: "w", ring: 1, progress: (s) => at(s.styleMaps.wonly ?? 0, 1) },
  { id: "style_sideways", name: "Sideways", desc: "Finish a map in Sideways", group: "style", icon: "sw", ring: 1, progress: (s) => at(s.styleMaps.sideways ?? 0, 1) },
  { id: "style_hsw", name: "Half and Half", desc: "Finish a map in Half-Sideways", group: "style", icon: "hsw", ring: 1, progress: (s) => at(s.styleMaps.hsw ?? 0, 1) },
  { id: "style_adonly", name: "One Side", desc: "Finish a map in A/D-Only", group: "style", icon: "ad", ring: 1, progress: (s) => at(s.styleMaps.adonly ?? 0, 1) },
  { id: "style_backwards", name: "Rear View", desc: "Finish a map in Backwards", group: "style", icon: "bw", ring: 1, progress: (s) => at(s.styleMaps.backwards ?? 0, 1) },
  {
    id: "style_all",
    name: "Stylist",
    desc: "Finish a map in every unassisted style",
    goal: "Clear a map in every unassisted style",
    group: "style",
    icon: "styles",
    ring: 2,
    title: "Stylist",
    progress: (s) => {
      const styles = STYLE_DEFS.filter((d) => earnsProgression(d.id));
      return at(styles.filter((d) => (s.styleMaps[d.id] ?? 0) > 0).length, styles.length);
    },
  },
  { id: "style_t4", name: "Off the Beaten Path", desc: "Finish a T4+ map in a style other than Normal", group: "style", icon: "styles", ring: 3, title: "Stylish", progress: (s) => at(s.altStyleMaxTier >= 4 ? 1 : 0, 1) },
  { id: "scroll_10", name: "Wheel Warrior", desc: "Finish 10 maps in EZ Scroll", group: "style", icon: "scroll", ring: 2, title: "Scroller", progress: (s) => at(s.styleMaps.legit ?? 0, 10) },
  { id: "legitscroll_10", name: "Legit Scroller", desc: "Finish 10 different maps in Legit Scroll", goal: "Clear 10 maps in Legit Scroll", group: "style", icon: "scroll", ring: 2, title: "Legit Scroller", progress: (s) => at(s.styleMaps.scroll ?? 0, 10) },
  // Batch 1 (2026-10-21, research/PROGRESSION-BATCH1.md): the ladders that went flat. Thresholds from the live
  // distributions (maps: 85 players at 25, 43 at 50, 15 at 100, 7 at 150, max 237).
  { id: "maps_50", name: "Wayfarer", desc: "Finish 50 different maps", group: "maps", icon: "map", ring: 2, title: "Wayfarer", progress: (s) => at(s.maps, 50) },
  { id: "maps_150", name: "Cartographer", desc: "Finish 150 different maps", group: "maps", icon: "map", ring: 3, title: "Cartographer", progress: (s) => at(s.maps, 150) },
  { id: "maps_250", name: "Atlas", desc: "Finish 250 different maps", group: "maps", icon: "map", ring: 3, title: "Atlas", progress: (s) => at(s.maps, 250) },
  {
    id: "home_turf",
    name: "Home Turf",
    desc: "Finish bhop_lol_meadow, bhop_lol_aero, bhop_lol_backrooms and bhop_lol_plaza",
    goal: "Clear Meadow, Aero, Backrooms and Plaza",
    group: "maps",
    icon: "map",
    ring: 1,
    progress: (s) => at(clearedOf(s, HOME_TURF_MAPS), HOME_TURF_MAPS.length),
  },
  // Luna's idea (11-04): the eleven levels of our own Backrooms map, main track, any style that counts as a clear.
  {
    id: TRUE_ARCHITECT,
    name: "True Architect",
    desc: `Finish ${BACKROOMS_MAP}`,
    goal: "Clear Backrooms",
    group: "maps",
    icon: "architect",
    ring: 1,
    progress: (s) => at(clearedOf(s, [BACKROOMS_MAP]), 1),
  },
  { id: "bonus_25", name: "Bonus Collector", desc: "Finish 25 bonus tracks", group: "maps", icon: "bonus", ring: 2, title: "Bonus Collector", progress: (s) => at(s.bonuses, 25) },
  { id: "t2_clears_25", name: "Second Gear", desc: "Finish 25 different tier 2 maps", goal: "Clear 25 T2 maps", group: "tier", icon: "t2", ring: 1, progress: (s) => at(s.clearsByTier[2] ?? 0, 25) },
  { id: "t3_clears_10", name: "Rock Face", desc: "Finish 10 different tier 3 maps", goal: "Clear 10 T3 maps", group: "tier", icon: "t3", ring: 2, progress: (s) => at(s.clearsByTier[3] ?? 0, 10) },
  { id: "t4_clears_5", name: "Hard Five", desc: "Finish 5 different tier 4 maps", goal: "Clear 5 T4 maps", group: "tier", icon: "t4", ring: 3, progress: (s) => at(s.clearsByTier[4] ?? 0, 5) },
  // v0.0.37 (tiers to T10): the long goals above the first clears. Counted on the map's current tier, like every tier goal.
  { id: "t8_clears_5", name: "Deep End", desc: "Finish 5 different maps of tier 8 or higher", goal: "Clear 5 T8+ maps", group: "tier", icon: "t8", ring: 3, progress: (s) => at(clearsFrom(s, 8), 5) },
  { id: "t9_clears_3", name: "Sleepless", desc: "Finish 3 different maps of tier 9 or higher", goal: "Clear 3 T9+ maps", group: "tier", icon: "t9", ring: 3, progress: (s) => at(clearsFrom(s, 9), 3) },
  { id: "top10_25", name: "Fixture", desc: "Hold 25 top-10 places at once", group: "records", icon: "podium", ring: 3, title: "Fixture", progress: (s) => at(s.top10s, 25) },
  { id: "wr_10", name: "Ten Crowns", desc: "Hold 10 world records at once", group: "records", icon: "crown", ring: 3, progress: (s) => at(s.wrs, 10) },
  { id: "sideways_10", name: "Crab Walk", desc: "Finish 10 different maps in Sideways", goal: "Clear 10 maps in Sideways", group: "style", icon: "sw", ring: 2, progress: (s) => at(s.styleMaps.sideways ?? 0, 10) },
  { id: "wonly_10", name: "One Key", desc: "Finish 10 different maps in W-Only", goal: "Clear 10 maps in W-Only", group: "style", icon: "w", ring: 2, progress: (s) => at(s.styleMaps.wonly ?? 0, 10) },
  { id: "hsw_10", name: "Halfway", desc: "Finish 10 different maps in Half-Sideways", goal: "Clear 10 maps in Half-Sideways", group: "style", icon: "hsw", ring: 2, progress: (s) => at(s.styleMaps.hsw ?? 0, 10) },
  { id: "adonly_10", name: "Lopsided", desc: "Finish 10 different maps in A/D-Only", goal: "Clear 10 maps in A/D-Only", group: "style", icon: "ad", ring: 2, progress: (s) => at(s.styleMaps.adonly ?? 0, 10) },
  { id: "backwards_10", name: "Moonwalker", desc: "Finish 10 different maps in Backwards", goal: "Clear 10 maps in Backwards", group: "style", icon: "bw", ring: 2, progress: (s) => at(s.styleMaps.backwards ?? 0, 10) },
  // Batch 1, part 2: !race, the October window and three hidden ones (research/PROGRESSION-BATCH1.md). The gauntlet
  // achievements are GAUNTLET_ACHIEVEMENTS below (gauntlets-weekly); batch 1's gauntlet items unlock with those.
  { id: "race_1", name: "Head to Head", desc: "Win a !race", goal: "Win a !race", group: "social", icon: "race", ring: 0, progress: (s) => at(s.raceWins ?? 0, 1) },
  {
    id: "race_10",
    name: "Duelist",
    desc: "Win 10 !races, against at least 5 different players",
    goal: "Win 10 !races against 5 players",
    group: "social",
    icon: "race",
    ring: 2,
    title: "Duelist",
    // Both halves count: 10 wins and 5 opponents (whichever is further behind shows).
    progress: (s) => {
      const w = Math.min(s.raceWins ?? 0, 10) / 10, o = Math.min(s.raceOpponents ?? 0, 5) / 5;
      return w <= o ? at(s.raceWins ?? 0, 10) : [Math.min(s.raceOpponents ?? 0, 5) * 2, 10];
    },
  },
  {
    id: "halloween_5",
    name: "Trick or Treat",
    desc: "Finish 5 maps from the Halloween collection between October 15 and November 7 (any year)",
    goal: "5 Halloween maps, Oct 15 to Nov 7",
    group: "event",
    icon: "pumpkin",
    ring: 1,
    progress: (s) => at(s.halloweenSeason ?? 0, 5),
  },
  {
    id: "halloween_10",
    name: "Lantern Night",
    desc: "Finish 10 maps from the Halloween collection",
    goal: "Clear 10 Halloween maps",
    group: "event",
    icon: "pumpkin",
    ring: 2,
    progress: (s) => at(clearedOf(s, HALLOWEEN_MAPS), 10),
  },
  {
    id: "winter_5",
    name: "Snow Day",
    desc: "Finish 5 maps from the Winter collection between December 1 and January 7 (one winter)",
    goal: "5 Winter maps, Dec 1 to Jan 7",
    group: "event",
    icon: "snowflake",
    ring: 1,
    progress: (s) => at(s.winterSeason ?? 0, 5),
  },
  {
    id: "winter_10",
    name: "Deep Winter",
    desc: "Finish 10 maps from the Winter collection",
    goal: "Clear 10 Winter maps",
    group: "event",
    icon: "snowflake",
    ring: 2,
    progress: (s) => at(clearedOf(s, WINTER_MAPS), 10),
  },
  {
    id: "scenic_route",
    name: "Scenic Route",
    desc: "Finish bhop_eazy taking more than five minutes",
    group: "time",
    icon: "clock",
    ring: 0,
    hidden: true,
    secretHint: "Take your time.",
    progress: (s) => at((s.worstNormal?.bhop_eazy ?? 0) > 300 ? 1 : 0, 1),
  },
  {
    id: "photo_finish",
    name: "Photo Finish",
    desc: `Win a !race by less than ${PHOTO_FINISH_S} seconds`,
    group: "social",
    icon: "race",
    ring: 2,
    hidden: true,
    secretHint: "Closer than close.",
    progress: (s) => at(s.photoFinish ? 1 : 0, 1),
  },
  {
    id: "back_to_basics",
    name: "Back to Basics",
    desc: "Finish bhop_eazy at level 25 or higher",
    group: "start",
    icon: "sprout",
    ring: 0,
    hidden: true,
    secretHint: "Where it all started.",
    progress: (s) => at(s.eazyAfterL25 ? 1 : 0, 1),
  },
  ...TIME_GOALS.map(
    (g): AchievementDef => ({
      id: g.id ?? `time_${g.map}_${g.seconds}`,
      name: g.name,
      desc: `Finish ${g.map} under ${fmtGoal(g.seconds)} (${g.anyStyle ? "any style that earns XP" : "Normal"})`,
      goal: g.anyStyle ? `${g.map} under ${fmtGoal(g.seconds)}` : undefined,
      group: "time",
      icon: "clock",
      ring: g.ring,
      title: g.title,
      progress: (s) => {
        const best = (g.anyStyle ? s.bestClassic : s.bestNormal)?.[g.map];
        return at(best !== undefined && best < g.seconds ? 1 : 0, 1);
      },
    }),
  ),
  { id: "sync_90", name: "In Sync", desc: "Finish a T2+ map with 90% sync or better", group: "time", icon: "sync", ring: 1, progress: (s) => at(s.bestSync >= 90 ? 1 : 0, 1) },
  { id: "jumps_1k", name: "Bunny", desc: "1,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 0, progress: (s) => at(s.jumps, 1_000) },
  { id: "jumps_10k", name: "Jackrabbit", desc: "10,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 1, progress: (s) => at(s.jumps, 10_000) },
  { id: "jumps_100k", name: "Hare Raiser", desc: "100,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 3, title: "Hare Raiser", progress: (s) => at(s.jumps, 100_000) },
  { id: "clock_1h", name: "Clocked In", desc: "Play for one hour", group: "lifetime", icon: "clock", ring: 0, progress: (s) => at(Math.floor(s.playtime), 3600) },
  { id: "clock_10h", name: "Overtime", desc: "Play for ten hours", group: "lifetime", icon: "clock", ring: 2, title: "Workhorse", progress: (s) => at(Math.floor(s.playtime), 36_000) },
  { id: "jumps_25k", name: "Spring Loaded", desc: "25,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 2, progress: (s) => at(s.jumps, 25_000) },
  { id: "clock_25h", name: "Night Shift", desc: "Play for 25 hours", group: "lifetime", icon: "clock", ring: 2, progress: (s) => at(Math.floor(s.playtime), 90_000) },
  { id: "clock_50h", name: "Lifer", desc: "Play for 50 hours", group: "lifetime", icon: "clock", ring: 3, title: "Lifer", progress: (s) => at(Math.floor(s.playtime), 180_000) },
  { id: "level_10", name: "Level 10", desc: "Reach level 10", group: "level", icon: "level", ring: 0, progress: (s) => at(s.level, 10) },
  { id: "level_25", name: "Level 25", desc: "Reach level 25", group: "level", icon: "level", ring: 2, title: "Veteran", progress: (s) => at(s.level, 25) },
  { id: "level_35", name: "Level 35", desc: "Reach level 35", group: "level", icon: "level", ring: 2, progress: (s) => at(s.level, 35) },
  { id: "level_40", name: "Level 40", desc: "Reach level 40", group: "level", icon: "level", ring: 3, progress: (s) => at(s.level, 40) },
  { id: "level_50", name: "Level 50", desc: "Reach level 50", group: "level", icon: "level", ring: 3, title: "Legend of the Hop", progress: (s) => at(s.level, 50) },
  // Garry's Mod's "Play with Garry": awarded by the room (apps/api/src/rooms/room.ts) after OWNER_OVERLAP_SECONDS on the
  // same multiplayer server as the site owner (the API's OWNER_ID). Not a run stat, so progress stays [0, 1].
  {
    id: PLAY_WITH_OWNER,
    name: "Play with the Owner",
    desc: `Be on a multiplayer server at the same time as Huddled, who made bunnyhop.lol, for ${OWNER_OVERLAP_SECONDS} seconds`,
    group: "social",
    icon: "together",
    ring: 2,
    title: "Hopped with Huddled",
    event: true,
    progress: () => [0, 1],
  },
  // Community rewards (DISCORD_LINK above): event achievements, so progress stays [0, 1] until the API records them.
  {
    id: DISCORD_LINK,
    name: "Linked Up",
    desc: "Link a Discord account to your bunnyhop.lol account",
    goal: "Link Discord",
    group: "social",
    icon: "link",
    ring: 0,
    event: true,
    progress: () => [0, 1],
  },
  {
    id: DISCORD_MEMBER,
    name: "In the Burrow",
    desc: "Join the bunnyhop.lol Discord server. It stays yours if you leave",
    goal: "Join the Discord server",
    group: "social",
    icon: "burrow",
    ring: 1,
    event: true,
    availability: "discord_server",
    progress: () => [0, 1],
  },
  {
    id: DISCORD_BOOSTER,
    name: "Burrow Booster",
    desc: "Boost the bunnyhop.lol Discord server. The Afterglow set stays yours after the boost ends",
    goal: "Boost the Discord server",
    group: "social",
    icon: "spark",
    ring: 3,
    event: true,
    availability: "discord_server",
    progress: () => [0, 1],
  },
  {
    id: EARLY_HOPPER,
    name: "Early Hopper",
    desc: "Finished a run in the early alpha, before v0.0.8",
    goal: "Played before v0.0.8",
    group: "social",
    icon: "sprout",
    ring: 2,
    title: "Early Hopper",
    event: true,
    availability: "closed",
    progress: () => [0, 1],
  },
  {
    id: SUPPORTER,
    name: "Supporter",
    desc: "Supported bunnyhop.lol with a donation. Every Supporter item is yours to keep",
    goal: "Supporter item",
    group: "social",
    icon: "heart",
    ring: 3,
    title: "Supporter",
    event: true,
    availability: "support",
    progress: () => [0, 1],
  },
];

// ---------------------------------------------------------------------------------------------
// The secret (v0.0.14): a hidden achievement that unlocks the Tek colourway (player/bunny/tek.ts: the Teknium homage,
// winged sneakers and all). "???" everywhere until earned. Awarded by the API from a verified run
// (apps/api/src/wings.ts, called by the verifier with facts it re-simulated), never from anything a client sends; the
// owner can also grant or revoke it from the admin panel. To change the criterion, change wingsEarned (and its test).

/** The hidden achievement's id (user_achievements rows carry it: never rename). */
export const WINGS = "wings";
/** The map whose main track earns it (owner, 2026-10-09: the Hermes map, made in code, shipped in v0.0.14). */
export const WINGS_MAP = "bhop_lol_hermes";
/**
 * Optional cryptic line shown with "???" on the locked item (null = none, just "???"). No numbers, nothing that gives
 * the criterion away (owner).
 */
export const WINGS_HINT: string | null = "Earn your wings.";

/** What the verifier knows about a run (all recomputed by the re-simulation, never the client's claims). */
export interface WingsRun {
  style: string;
  track: number;
  /** Recomputed run time, seconds. */
  time: number;
  /** The run's map (the verifier's own row, not the client's claim). */
  map: string;
}

/**
 * THE criterion: whether this verified run earns the wings: a clear of WINGS_MAP's main track, any classic style.
 * Assisted styles (Auto-strafe computes the strafes) never count. The verifier also skips shadowed players and runs whose input analysis isn't clean (apps/api/src/wings.ts).
 */
export function wingsEarned(r: WingsRun): boolean {
  return earnsProgression(r.style) && r.map === WINGS_MAP && r.track === 0;
}

ACHIEVEMENTS.push({
  id: WINGS,
  name: "Winged Feet",
  desc: `Clear ${WINGS_MAP}`,
  goal: `Clear ${WINGS_MAP}`,
  group: "records",
  icon: "wing",
  ring: 3,
  hidden: true,
  event: true,
  progress: () => [0, 1],
});

/** A hidden achievement that isn't earned yet shows as "???" (name, goal, unlock text, its items). */
export const isSecret = (a: AchievementDef | null | undefined): boolean => !!a?.hidden;

/** A hidden achievement's cryptic line: its own secretHint, WINGS_HINT for the wings, else none. */
export const secretHintOf = (a?: AchievementDef | null): string | null => a?.secretHint ?? (!a || a.id === WINGS ? WINGS_HINT : null);

/** What a locked secret item says about how to get it: "???", plus its cryptic line when there is one. */
export const secretLockText = (a?: AchievementDef | null): string => {
  const hint = secretHintOf(a);
  return hint ? `??? · ${hint}` : "???";
};

for (const [i, goal] of [1,5,25,100].entries()) ACHIEVEMENTS.push({ id:`gift_${goal}`, name:["Bronze Gifter","Silver Gifter","Gold Gifter","Prism Gifter"][i], desc:`Deliver ${goal} Supporter gift${goal === 1 ? "" : "s"}`, group:"social", icon:"gift", ring:i as Ring, progress:s => [s.giftsSent ?? 0, goal] });

// Gauntlets (research/GAUNTLETS.md "Marks"): from GauntletStats (apps/api/src/progress.ts progressStats). Every
// gauntlet counts toward the first two, weeklies and events too; "Every Gauntlet" is the permanent ones published now.
const gs = (s: ProgressStats): GauntletStats => s.gauntlets ?? { cleared: [], permanent: 0, permanentCleared: 0, classicBest: null, podiums: 0, wins: 0 };
export const GAUNTLET_ACHIEVEMENTS: AchievementDef[] = [
  { id: "gauntlet_1", name: "Run the Gauntlet", desc: "Clear a gauntlet: every map in one attempt", goal: "Clear a gauntlet", group: "gauntlet", icon: "g_route", ring: 0, progress: (s) => at(gs(s).cleared.length, 1) },
  { id: "gauntlet_5", name: "Gauntlet Regular", desc: "Clear 5 different gauntlets", goal: "Clear 5 gauntlets", group: "gauntlet", icon: "g_stack", ring: 1, progress: (s) => at(gs(s).cleared.length, 5) },
  { id: "gauntlet_mini", name: "Mini Gauntlet", desc: "Clear Gauntlet Mini", group: "gauntlet", icon: "g_mini", ring: 2, progress: (s) => at(gs(s).cleared.includes(MINI_GAUNTLET) ? 1 : 0, 1) },
  {
    id: "gauntlet_every",
    name: "Every Gauntlet",
    desc: "Clear every permanent gauntlet",
    group: "gauntlet",
    icon: "g_every",
    ring: 3,
    title: "Gauntleteer",
    progress: (s) => (gs(s).permanent ? at(gs(s).permanentCleared, gs(s).permanent) : [0, 1]),
  },
  { id: "weekly_podium", name: "Weekly Podium", desc: "Finish a weekly gauntlet in the top 3", goal: "Top 3 on a weekly gauntlet", group: "gauntlet", icon: "g_podium", ring: 1, progress: (s) => at(gs(s).podiums, 1) },
  { id: "weekly_win", name: "Weekly Winner", desc: "Win a weekly gauntlet", group: "gauntlet", icon: "g_weekly", ring: 2, title: "Weekly Winner", progress: (s) => at(gs(s).wins, 1) },
  {
    id: "gauntlet_classic",
    name: "The Gauntlet",
    desc: "Clear the 20-map Bunny Hop Map Gauntlet",
    group: "gauntlet",
    icon: "g20",
    ring: 3,
    title: "Gauntlet Champion",
    progress: (s) => at(gs(s).cleared.includes(CLASSIC_GAUNTLET) ? 1 : 0, 1),
  },
  {
    id: "gauntlet_classic_fast",
    name: "Under Five Hours",
    desc: "Clear the Bunny Hop Map Gauntlet with a total under 5:00:00",
    group: "gauntlet",
    icon: "g_hourglass",
    ring: 3,
    progress: (s) => at(gs(s).classicBest !== null && gs(s).classicBest! < CLASSIC_FAST_SECONDS ? 1 : 0, 1),
  },
];
ACHIEVEMENTS.push(...GAUNTLET_ACHIEVEMENTS);

// The Daily Challenge (apps/api/src/daily.ts): from DailyStats. Two families.
//   Taking part (DAILY_LADDER): days finished in total, at any pace and any place on the board. Never days in a row: a
//   missed day takes nothing away. Each step unlocks something from the day-cycle set below (colourways, gun camos),
//   the first with the first finish. Two more for effort rather than rank: beating your own time of the day, and
//   closing a day in the faster half of its board.
//   The podium: top 3, a win, ten wins. Their rewards are the counted medals (creators.ts dailyMarkId).
const ds = (s: ProgressStats): DailyStats => s.daily ?? { days: 0, gold: 0, silver: 0, bronze: 0 };
/** Days finished at each step of the taking-part ladder. */
export const DAILY_LADDER = [1, 5, 15, 30, 60, 100] as const;
const DAILY_STEP_NAMES = ["Daily", "Five Days", "Fifteen Days", "Thirty Days", "Sixty Days", "A Hundred Days"];
const DAILY_STEP_RINGS: Ring[] = [0, 0, 1, 1, 2, 3];
export const dailyStepId = (days: number) => `daily_${days}`;
export const DAILY_ACHIEVEMENTS: AchievementDef[] = [
  ...DAILY_LADDER.map(
    (n, i): AchievementDef => ({
      id: dailyStepId(n),
      name: DAILY_STEP_NAMES[i],
      desc: n === 1 ? "Finish a Daily Challenge" : `Finish the Daily Challenge on ${n} days`,
      goal: n === 1 ? "Finish a Daily Challenge" : `Finish ${n} Daily Challenges`,
      group: "gauntlet",
      icon: n === 1 ? "d_sun" : `d_${n}`,
      ring: DAILY_STEP_RINGS[i],
      ...(n === 100 ? { title: "Sun Chaser" } : {}),
      progress: (s) => at(ds(s).days, n),
    }),
  ),
  { id: "daily_better", name: "Second Wind", desc: "Beat your own time on the same Daily Challenge", goal: "Beat your own daily time the same day", group: "gauntlet", icon: "d_better", ring: 0, progress: (s) => at(ds(s).improved ?? 0, 1) },
  { id: "daily_top_half", name: "Upper Half", desc: "Finish a Daily Challenge in the faster half of the day's board", goal: "Top half of a Daily Challenge", group: "gauntlet", icon: "d_half", ring: 1, progress: (s) => at(ds(s).topHalf ?? 0, 1) },
  { id: "daily_podium", name: "Daily Podium", desc: "Finish a Daily Challenge in the top 3", goal: "Top 3 on a Daily Challenge", group: "gauntlet", icon: "d_podium", ring: 1, progress: (s) => at(ds(s).gold + ds(s).silver + ds(s).bronze, 1) },
  { id: "daily_win", name: "Day Winner", desc: "Win a Daily Challenge", group: "gauntlet", icon: "d_win", ring: 2, title: "Day Winner", progress: (s) => at(ds(s).gold, 1) },
  { id: "daily_win_10", name: "Ten Golds", desc: "Win 10 Daily Challenges", group: "gauntlet", icon: "d_10", ring: 3, progress: (s) => at(ds(s).gold, 10) },
];
ACHIEVEMENTS.push(...DAILY_ACHIEVEMENTS);

/**
 * Mapper recognition (2026-10-28, Maharero's idea): a verified Normal time under the mapper's own on a map they made.
 * "Mapper" means a player staff linked to the map's author name (migrations/0076, apps/api/src/mappers.ts), and the
 * mapper needs a time of their own to beat. Earned like any time goal (progress.ts progressStats), permanent once held.
 */
export const BEAT_MAPPER = "beat_mapper";
ACHIEVEMENTS.push({
  id: BEAT_MAPPER,
  name: "Beat the Mapper",
  desc: "Beat a mapper's own time on a map they made",
  goal: "Beat a mapper's time on their own map",
  group: "records",
  icon: "mapper",
  ring: 1,
  progress: (s) => at(s.beatMapper ?? 0, 1),
});

const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
export const achievement = (id: string) => ACH_BY_ID.get(id) ?? null;

/**
 * Achievement XP (2026-10-21, research/PROGRESSION-BATCH1.md): an achievement pays XP once, by its ring. Recorded per
 * (player, achievement) in achievement_xp (apps/api/src/achievement-xp.ts), so it never pays twice; a player's XP is
 * their run XP (xp_events) plus this. Owner call: players get it for the achievements they already hold too (the
 * one-off backfill, which keeps level-ups from it quiet on Discord).
 */
export const ACHIEVEMENT_XP: Readonly<Record<Ring, number>> = { 0: 100, 1: 250, 2: 500, 3: 1000 };

/**
 * Achievements that pay no XP: paid or Discord-boost ones (XP is never for sale) and the level ones (XP for levels
 * would feed itself).
 */
const NO_XP = (a: AchievementDef) => a.availability === "support" || a.id === DISCORD_BOOSTER || a.id.startsWith("gift_") || a.group === "level";

/** The XP an achievement pays once (0 for unknown ids and the NO_XP ones). */
export function achievementXp(a: AchievementDef | string | null | undefined): number {
  const d = typeof a === "string" ? achievement(a) : a;
  if (!d || NO_XP(d)) return 0;
  return ACHIEVEMENT_XP[d.ring];
}

/** Ids of every achievement the stats satisfy. */
export function earnedAchievements(s: ProgressStats): string[] {
  return ACHIEVEMENTS.filter((a) => {
    const [n, goal] = a.progress(s);
    return goal > 0 && n >= goal;
  }).map((a) => a.id);
}

// ---------------------------------------------------------------------------------------------
// Cosmetics (all unlocked by playing; card editor + ghost settings)

export type CosmeticSlot = "background" | "frame" | "title" | "ghost" | "trail" | "shape" | "outfit" | "knife" | "finish" | "glove" | "hilt" | "hat" | "body" | "camo" | "back" | "hop" | "charm";

/**
 * The first-person loadout slots (apps/web/src/loadout.ts): what you hold, what its blade is painted with, its hilt (one
 * skin for whichever knife is held, v0.0.38), your gloves.
 */
export const LOADOUT_SLOTS = ["knife", "finish", "hilt", "glove"] as const satisfies readonly CosmeticSlot[];

export type Unlock =
  | { kind: "free" }
  | { kind: "level"; level: number }
  | { kind: "achievement"; id: string }
  /**
   * Held, not earned: yours while you HOLD this place on the rank board ("all" = overall rank <= max; "style" = rank
   * <= max in any style's ranking), and gone again when you lose it. Checked server-side from player_points on save
   * and on every read (a lost rank reads back as the default), like every other unlock.
   */
  | { kind: "rank"; max: number; scope: "all" | "style" }
  /**
   * Role-held: yours while you hold the role (RoleNeed, holdsRole). Checked server-side on save and on every read like
   * rank-held items, so a removed admin or a revoked Contributor badge reads back as the default. Staff items are never
   * listed or previewed for players who don't hold the role (staffItem); Contributor items are listed for everyone,
   * locked and marked Contributor.
   */
  | { kind: "role"; role: RoleNeed };

/**
 * A player's staff role as the server sees it (null = none): "owner" (OWNER_ID), "admin" (a room admin) or "moderator"
 * (migrations/0018). The room roster, chat lines, profiles and /me/cosmetics carry it; clients never decide it. What each
 * role may do: moderation/staff.ts.
 */
export type StaffRole = "owner" | "admin" | "moderator";

/**
 * Who a role-held item belongs to (v0.0.38 role model). The staff roles are a ladder, each holding the items of the roles
 * under it; Contributor is a badge beside the ladder (creators.ts special "contributor", granted by staff, no
 * permissions), so admins and moderators don't get it from their role. The owner holds everything.
 *   "owner"        the owner (OWNER_ID)
 *   "admin"        admins and the owner
 *   "staff"        the same as "admin" (the name the Staff title has always used)
 *   "moderator"    moderators, admins and the owner
 *   "contributor"  players with the Contributor badge, and the owner
 * Role-held items are their own looks (ROLE_SETS), never earned items: staffGrant still gives admins the earned
 * catalogue and moderators nothing, so modding is never a shortcut to anything earned by playing.
 */
export type RoleNeed = "owner" | "staff" | "admin" | "moderator" | "contributor";
export const ROLE_NEEDS: readonly RoleNeed[] = ["owner", "staff", "admin", "moderator", "contributor"];

/** What role-held items check: the staff role, and whether the player has the Contributor badge. */
export interface RoleHolder {
  role: StaffRole | null;
  contributor?: boolean;
}
/** A bare staff role (older callers: no Contributor badge) or a full RoleHolder. */
export type Holder = StaffRole | RoleHolder | null | undefined;
export const holderOf = (h: Holder): RoleHolder => (h && typeof h === "object" ? { role: h.role ?? null, contributor: !!h.contributor } : { role: h ?? null, contributor: false });
/** The Contributor badge among a player's special badges (users.special_badges; creators.ts SPECIAL_BADGES). */
export const hasContributorBadge = (special: readonly string[] | null | undefined): boolean => !!special?.includes("contributor");

/** Whether `who` holds a role-held unlock (see RoleNeed). */
export function holdsRole(need: RoleNeed, who: Holder): boolean {
  const { role, contributor } = holderOf(who);
  switch (need) {
    case "owner":
      return role === "owner";
    case "staff":
    case "admin":
      return role === "owner" || role === "admin";
    case "moderator":
      return role === "owner" || role === "admin" || role === "moderator";
    case "contributor":
      return role === "owner" || !!contributor;
  }
}

/**
 * A staff item (v0.0.38, owner 11-06): held through a staff role (moderator, admin / "staff", owner). Nobody who doesn't
 * hold that role may browse or preview it: it's left out of every selector, Loadout section, tab count, unlock list and
 * preview, and the API answers for it like for an id that doesn't exist (cosmeticsProblem "unknown item"). Someone
 * wearing one still shows it to everyone (rooms, replays, their card). Contributor items aren't staff items: they stay
 * listed for everyone as a locked goal, marked Contributor.
 */
export const staffItem = (c: Pick<CosmeticDef, "unlock">): boolean => c.unlock.kind === "role" && c.unlock.role !== "contributor";

/** Whether `who` may see `c` listed or previewed anywhere (selectors, counts, unlock lists, API lists): see staffItem. */
export function listedFor(c: Pick<CosmeticDef, "unlock">, who: Holder): boolean {
  return c.unlock.kind !== "role" || c.unlock.role === "contributor" || holdsRole(c.unlock.role, who);
}

/** "Owner only", "Staff only", "Moderators only", "Contributors only". */
export const roleHint = (need: RoleNeed): string =>
  need === "owner" ? "Owner only" : need === "staff" ? "Staff only" : need === "admin" ? "Admins only" : need === "moderator" ? "Moderators only" : "Contributors only";

/** Display name of a role ("Owner", "Admin", "Mod"): chat tags, the scoreboard and the player card. */
export const roleName = (role: StaffRole): string => (role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Mod");

/** Hover text of a role tag. */
export const roleTitle = (role: StaffRole): string => (role === "owner" ? "Made bunnyhop.lol" : role === "admin" ? "bunnyhop.lol admin" : "bunnyhop.lol moderator");

/** A role from untrusted JSON (API replies, the room roster), or null. */
export const staffRoleOf = (v: unknown): StaffRole | null => (v === "owner" || v === "admin" || v === "moderator" ? v : null);

/** A player's current ranks by scope ("all" or a style id), only where they have points (ranks.ts / points.ts). */
export type HeldRanks = Readonly<Record<string, number>>;

/** HeldRanks from rank views ({ scope, rank }; rank null = no points). */
export function heldRanks(ranks: readonly { scope: string; rank: number | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ranks) if (r.rank) out[r.scope] = r.rank;
  return out;
}

/** The crown a player wears while holding overall #1 / #2 / #3 (null otherwise). Shown automatically on the bunny. */
export function crownOf(held: HeldRanks | null | undefined): 1 | 2 | 3 | null {
  const r = held?.all;
  return r === 1 || r === 2 || r === 3 ? r : null;
}

/**
 * Rarity tiers (research/COSMETICS-PLAN.md §2): one colour ramp for the card editor, the Loadout and celebrations.
 * Only the loadout items carry one; it's how hard the unlock is, not a drop rate (nothing here is random).
 */
export type Rarity = 1 | 2 | 3 | 4 | 5;
export const RARITY: Record<Rarity, { name: string; color: string }> = {
  1: { name: "Garden", color: "#9cbf8a" },
  2: { name: "Market", color: "#4fa8ff" },
  3: { name: "Prize", color: "#b67cff" },
  4: { name: "Heirloom", color: "#ff6fb5" },
  5: { name: "Golden", color: "#ffd45e" },
};

export interface CosmeticDef {
  id: string;
  slot: CosmeticSlot;
  name: string;
  unlock: Unlock;
  /** Ghost / trail colour, or the swatch for card backgrounds and frames. */
  color?: string;
  /** Loadout items (knife / finish / hilt / glove). */
  rarity?: Rarity;
  /**
   * A second colour, for the two-tone items: the Geode trail fades from `color` at the head to this at the tail, and
   * the Geode ghost glows in it (player/trail.ts, player/materials.ts uGhostRim). Absent = `color` alone.
   */
  color2?: string;
  /**
   * Also unlocked by any of these (checked like `unlock`; the hint only names `unlock`). Used when a lineup changes so
   * nobody loses an item they had earned: v0.0.6 folded thirteen finishes into eight, and each new finish keeps the
   * v0.0.5 routes of the ones it replaced (FINISH_ALIASES).
   */
  legacy?: readonly Unlock[];
  /** A supporter item's set (SUPPORTER_SETS): the Loadout groups them by it, the Support page switches between them. */
  set?: SupporterSetId;
  /** A role-held item's set (ROLE_SETS): the Loadout groups them by it. */
  roleSet?: RoleSetId;
}

const free: Unlock = { kind: "free" };
const lvl = (level: number): Unlock => ({ kind: "level", level });
const ach = (id: string): Unlock => ({ kind: "achievement", id });
const held = (max: number, scope: "all" | "style" = "all"): Unlock => ({ kind: "rank", max, scope });
const role = (r: RoleNeed): Unlock => ({ kind: "role", role: r });

export const COSMETICS: CosmeticDef[] = [
  // Card backgrounds (ui/card.css: .pc-bg-<id>)
  { id: "bg-night", slot: "background", name: "Night", unlock: free, color: "#151a26" },
  { id: "bg-dusk", slot: "background", name: "Dusk", unlock: lvl(3), color: "#3a2546" },
  { id: "bg-grid", slot: "background", name: "Blueprint", unlock: lvl(6), color: "#14304a" },
  { id: "bg-meadow", slot: "background", name: "Meadow", unlock: ach("sweep_1"), color: "#1f4a33" },
  { id: "bg-arcade", slot: "background", name: "Arcade", unlock: lvl(12), color: "#2b1450" },
  { id: "bg-ember", slot: "background", name: "Ember", unlock: ach("tier_5"), color: "#4a1a14" },
  { id: "bg-void", slot: "background", name: "Void", unlock: ach("tier_6"), color: "#1a0f2e" },
  { id: "bg-aurora", slot: "background", name: "Aurora", unlock: lvl(20), color: "#0f3a3a" },
  { id: "bg-gold", slot: "background", name: "Gilded", unlock: ach("wr_1"), color: "#4a3a12" },
  { id: "bg-prism", slot: "background", name: "Prism", unlock: ach("style_all"), color: "#3a2a5a" },
  // Supporter (SUPPORTER): the Geode set's card. Dark stone, an aqua crystal glow in one corner, amethyst in the other.
  { id: "bg-geode", slot: "background", name: "Geode", unlock: ach(SUPPORTER), color: "#15161f", rarity: 4 },
  // High Roller: casino felt with a gold lamp glow and a faint card-suit print.
  { id: "bg-highroller", slot: "background", name: "High Roller", unlock: ach(SUPPORTER), color: "#0f4a30", rarity: 4 },
  // Borealis: a night sky with green and violet curtains of light.
  { id: "bg-borealis", slot: "background", name: "Borealis", unlock: ach(SUPPORTER), color: "#0b1530", rarity: 4 },
  // Frames (.pc-frame-<id>)
  { id: "frame-plain", slot: "frame", name: "Plain", unlock: free, color: "#2a3040" },
  { id: "frame-steel", slot: "frame", name: "Steel", unlock: lvl(5), color: "#9aa4b5" },
  { id: "frame-mint", slot: "frame", name: "Mint", unlock: ach("sweep_1"), color: "#5ee08a" },
  { id: "frame-tiers", slot: "frame", name: "Tier Ramp", unlock: ach("tier_4"), color: "#ff9a3c" },
  { id: "frame-ember", slot: "frame", name: "Ember", unlock: ach("tier_5"), color: "#ff5468" },
  { id: "frame-violet", slot: "frame", name: "Ascended", unlock: ach("tier_6"), color: "#c477ff" },
  { id: "frame-gold", slot: "frame", name: "Gold", unlock: ach("wr_1"), color: "#ffd45e" },
  { id: "frame-holo", slot: "frame", name: "Holo", unlock: lvl(30), color: "#79d2ff" },
  // Held while you hold the place (rank-held: revoked when you lose it).
  { id: "frame-podium", slot: "frame", name: "Podium", unlock: held(3), color: "#e8b931", rarity: 5 },
  { id: "frame-reigning", slot: "frame", name: "Reigning", unlock: held(1), color: "#fff2b0", rarity: 5 },
  // Role-held (the owner's own; revoked with the role, hidden from everyone who can't hold it).
  { id: "frame-founder", slot: "frame", name: "Founder", unlock: role("owner"), color: "#ff7a1a", rarity: 5 },
  // Supporter (SUPPORTER): cut crystal facets all the way round, aqua to amethyst.
  { id: "frame-geode", slot: "frame", name: "Geode", unlock: ach(SUPPORTER), color: "#5ff2df", rarity: 4 },
  // High Roller: a reeded gold coin edge. Borealis: green, teal and violet light round the card.
  { id: "frame-highroller", slot: "frame", name: "High Roller", unlock: ach(SUPPORTER), color: "#e0b13a", rarity: 4 },
  { id: "frame-borealis", slot: "frame", name: "Borealis", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4 },
  // Ghost colours (your PB ghost, and how others see your ghost when they race it)
  { id: "ghost-gold", slot: "ghost", name: "Gold", unlock: free, color: "#ffc23d" },
  { id: "ghost-mint", slot: "ghost", name: "Mint", unlock: lvl(2), color: "#5ee08a" },
  { id: "ghost-cyan", slot: "ghost", name: "Cyan", unlock: lvl(4), color: "#3fd0c9" },
  { id: "ghost-rose", slot: "ghost", name: "Rose", unlock: lvl(8), color: "#ff7aa8" },
  { id: "ghost-ember", slot: "ghost", name: "Ember", unlock: ach("tier_4"), color: "#ff6a3c" },
  { id: "ghost-violet", slot: "ghost", name: "Violet", unlock: ach("tier_6"), color: "#c477ff" },
  { id: "ghost-white", slot: "ghost", name: "Pearl", unlock: lvl(15), color: "#f2f5ff" },
  { id: "ghost-lime", slot: "ghost", name: "Lime", unlock: ach("style_all"), color: "#c6ff4d" },
  { id: "ghost-reigning", slot: "ghost", name: "Reigning", unlock: held(1), color: "#fff2b0", rarity: 5 },
  { id: "ghost-founder", slot: "ghost", name: "Founder", unlock: role("owner"), color: "#3ff0ff", rarity: 5 },
  // Supporter (SUPPORTER): crystal aqua with an amethyst glow at the edges.
  { id: "ghost-geode", slot: "ghost", name: "Geode", unlock: ach(SUPPORTER), color: "#5ff2df", color2: "#8f72ff", rarity: 4 },
  // High Roller: felt green with a gold glow. Borealis: aurora green with a violet glow.
  { id: "ghost-highroller", slot: "ghost", name: "High Roller", unlock: ach(SUPPORTER), color: "#2fbf73", color2: "#ffcf4a", rarity: 4 },
  { id: "ghost-borealis", slot: "ghost", name: "Borealis", unlock: ach(SUPPORTER), color: "#4dffb0", color2: "#a77cff", rarity: 4 },
  // Trail colours
  { id: "trail-gold", slot: "trail", name: "Gold", unlock: free, color: "#ffc23d" },
  { id: "trail-sky", slot: "trail", name: "Sky", unlock: lvl(3), color: "#66b3ff" },
  { id: "trail-mint", slot: "trail", name: "Mint", unlock: ach("tier_2"), color: "#5ee08a" },
  { id: "trail-rose", slot: "trail", name: "Rose", unlock: lvl(10), color: "#ff7aa8" },
  { id: "trail-ember", slot: "trail", name: "Ember", unlock: ach("tier_5"), color: "#ff5468" },
  { id: "trail-violet", slot: "trail", name: "Violet", unlock: ach("jumps_10k"), color: "#c477ff" },
  { id: "trail-white", slot: "trail", name: "Pearl", unlock: ach("wr_1"), color: "#f2f5ff" },
  { id: "trail-podium", slot: "trail", name: "Podium", unlock: held(3), color: "#e8b931", rarity: 5 },
  { id: "trail-reigning", slot: "trail", name: "Reigning", unlock: held(1), color: "#fff2b0", rarity: 5 },
  { id: "trail-founder", slot: "trail", name: "Founder", unlock: role("owner"), color: "#ff7a1a", rarity: 5 },
  // Community (DISCORD_BOOSTER): the Afterglow set's trail.
  { id: "trail-afterglow", slot: "trail", name: "Afterglow", unlock: ach(DISCORD_BOOSTER), color: "#f47fff" },
  // Supporter (SUPPORTER): crystal aqua at the head fading into amethyst.
  { id: "trail-geode", slot: "trail", name: "Geode", unlock: ach(SUPPORTER), color: "#5ff2df", color2: "#8f72ff", rarity: 4 },
  // High Roller: gold at the head into felt green. Borealis: aurora green into violet.
  { id: "trail-highroller", slot: "trail", name: "High Roller", unlock: ach(SUPPORTER), color: "#ffcf4a", color2: "#1f9a5c", rarity: 4 },
  { id: "trail-borealis", slot: "trail", name: "Borealis", unlock: ach(SUPPORTER), color: "#3ff0a0", color2: "#9a6bff", rarity: 4 },
  // Bunny colourways (the player model's outfit; palettes in player/bunny/palettes.ts)
  { id: "body-a", slot: "body", name: "Model A", unlock: free },
  { id: "body-b", slot: "body", name: "Model B", unlock: free },
  { id: "outfit-cream", slot: "outfit", name: "Cream", unlock: free, color: "#ece5d8" },
  { id: "outfit-midnight", slot: "outfit", name: "Midnight", unlock: free, color: "#262b38" },
  { id: "outfit-neon", slot: "outfit", name: "Neon", unlock: free, color: "#7dff4a" },
  { id: "outfit-carrot", slot: "outfit", name: "Carrot", unlock: lvl(3), color: "#ff8a2a" },
  { id: "outfit-mint", slot: "outfit", name: "Mint", unlock: ach("tier_2"), color: "#c9f2dc" },
  { id: "outfit-sakura", slot: "outfit", name: "Sakura", unlock: lvl(8), color: "#ffd3e2" },
  { id: "outfit-arctic", slot: "outfit", name: "Arctic", unlock: lvl(15), color: "#f3f7fb" },
  { id: "outfit-ember", slot: "outfit", name: "Ember", unlock: ach("tier_5"), color: "#ff5a36" },
  { id: "outfit-void", slot: "outfit", name: "Void", unlock: ach("tier_6"), color: "#c477ff" },
  { id: "outfit-gold", slot: "outfit", name: "Gilded", unlock: ach("wr_1"), color: "#ffd45e" },
  // Community (DISCORD_MEMBER): for being in the bunnyhop.lol Discord server. Blurple hoodie, an "online" green accent.
  { id: "outfit-blurple", slot: "outfit", name: "Blurple", unlock: ach(DISCORD_MEMBER), color: "#5865f2" },
  // Community (DISCORD_BOOSTER): for boosting that server. Deep violet with a glowing pink trim, gloves and accents.
  { id: "outfit-afterglow", slot: "outfit", name: "Afterglow", unlock: ach(DISCORD_BOOSTER), color: "#f47fff" },
  // Supporter (SUPPORTER): deep teal hoodie, amethyst trim, stone pants, a glowing crystal-aqua accent.
  { id: "outfit-geode", slot: "outfit", name: "Geode", unlock: ach(SUPPORTER), color: "#1d6b74", rarity: 4 },
  // High Roller: casino-felt hoodie, gold trim and glow, black pants. Borealis: night-sky navy, aurora green and violet.
  { id: "outfit-highroller", slot: "outfit", name: "High Roller", unlock: ach(SUPPORTER), color: "#0f5a3a", rarity: 4 },
  { id: "outfit-borealis", slot: "outfit", name: "Borealis", unlock: ach(SUPPORTER), color: "#101a33", rarity: 4 },
  { id: "glove-plush", slot: "glove", name: "Plush Paws", unlock: ach(SUPPORTER), color: "#e8d7b9", rarity: 4 },
  { id: "glove-bune", slot: "glove", name: "Bun-E Hands", unlock: ach(SUPPORTER), color: "#f2e8d8", rarity: 4 },
  { id: "outfit-plush", slot: "outfit", name: "Plush Bunny", unlock: ach(SUPPORTER), color: "#e8d7b9", rarity: 4 },
  { id: "outfit-bune", slot: "outfit", name: "Bun-E", unlock: ach(SUPPORTER), color: "#f2e8d8", rarity: 4 },
  // Rank-held colourways (overall #1 / top 2 / top 3); the crown itself comes automatically with the place (crownOf).
  { id: "outfit-bronzehare", slot: "outfit", name: "Bronze Hare", unlock: held(3), color: "#c98a52", rarity: 5 },
  { id: "outfit-silverhare", slot: "outfit", name: "Silver Hare", unlock: held(2), color: "#dfe5ee", rarity: 5 },
  { id: "outfit-reigning", slot: "outfit", name: "Reigning", unlock: held(1), color: "#ffd45e", rarity: 5 },
  // The owner's colourway (role-held).
  { id: "outfit-founder", slot: "outfit", name: "Founder", unlock: role("owner"), color: "#2a1660", rarity: 5 },
  // Knives (first person + third person). Built in code by the viewmodel knife registry (viewmodel/knives/); the client
  // only lists the ones that registry can draw, so a knife whose model hasn't shipped stays hidden. EVERY KNIFE IS FREE
  // (owner call, v0.0.5; the Supporter knives below are the exception): you just pick the one you like in the
  // Loadout screen; finishes, gloves and rank-held items are what you unlock. The rarity is the knife's tier of flair
  // (its colour in the UI), not how hard it is to get.
  { id: "knife-carrot", slot: "knife", name: "Carrot Blade", unlock: free, color: "#ff7a1a", rarity: 1 },
  { id: "knife-bayonet", slot: "knife", name: "Carrot Bayonet", unlock: free, color: "#ff8a2a", rarity: 2 },
  { id: "knife-parsnip", slot: "knife", name: "Parsnip Stiletto", unlock: free, color: "#efe2b8", rarity: 2 },
  { id: "knife-karrotbit", slot: "knife", name: "Karrotbit", unlock: free, color: "#ff7a1a", rarity: 3 },
  { id: "knife-radish", slot: "knife", name: "Radish Kukri", unlock: free, color: "#ff5c8a", rarity: 3 },
  { id: "knife-cleaver", slot: "knife", name: "Clover Cleaver", unlock: free, color: "#5ee08a", rarity: 3 },
  { id: "knife-bunnyfly", slot: "knife", name: "Bunnyfly", unlock: free, color: "#ff9a3c", rarity: 4 },
  { id: "knife-daikon", slot: "knife", name: "Daikon-tana", unlock: free, color: "#f3f1ea", rarity: 4 },
  { id: "knife-candycane", slot: "knife", name: "Candy Cane Shiv", unlock: free, color: "#e8333f", rarity: 5 },
  { id: "knife-golden", slot: "knife", name: "Golden Carrot", unlock: free, color: "#ffd45e", rarity: 5 },
  // v0.0.30: a talon with a three-petal spinner on its bolster (viewmodel/knives/whirligig.ts; kill's ask).
  { id: "knife-whirligig", slot: "knife", name: "Whirligig", unlock: free, color: "#f2a93b", rarity: 4 },
  // Supporter (SUPPORTER): the only knives that aren't free, standalone (no set). The two bayonets
  // (viewmodel/knives/thornback.ts, thistle.ts): a big clip point grown from a rose stem, thorns along its spine; a
  // slim spinner with a thistle-head pommel. v0.0.38 (owner 11-06): the Leek Saber (leek.ts, a long curved white-to-green saber; Heirloom like
  // every Supporter item) and Twin Sprouts (sprouts.ts, two golden tines from a seed).
  { id: "knife-thornback", slot: "knife", name: "Thornback", unlock: ach(SUPPORTER), color: "#b52a3c", rarity: 4 },
  { id: "knife-thistle", slot: "knife", name: "Thistle", unlock: ach(SUPPORTER), color: "#b46ad8", rarity: 4 },
  { id: "knife-leek", slot: "knife", name: "Leek Saber", unlock: ach(SUPPORTER), color: "#8fdc6a", rarity: 4 },
  { id: "knife-sprouts", slot: "knife", name: "Twin Sprouts", unlock: ach(SUPPORTER), color: "#ffb04a", rarity: 4 },
  // Finishes: paint for any knife's blade (viewmodel/finishes/). Owner call (v0.0.6): each finish is ONE fixed design,
  // the same for everyone (no per-player patterns, no wear), and the lineup is our own garden-themed set rather than a
  // copy of anyone's skin list. The v0.0.5 ids still read (FINISH_ALIASES below), and `legacy` keeps every v0.0.5 route,
  // so nobody lost a finish they had earned. Unlock ladder: level 20, Jackrabbit, a T4+ map in another style, first
  // T4 / T5 / T6, a world record, level 50; Founder's Gold is the owner's.
  { id: "fin-garden", slot: "finish", name: "Garden Fresh", unlock: free, color: "#ff7a1a", rarity: 1 },
  // Warm sky gradient guard -> tip with soft cloud streaks.
  { id: "fin-sunset", slot: "finish", name: "Sunset", unlock: lvl(20), color: "#f86a7c", rarity: 3 },
  // Kiln-fired glaze: charcoal, ember red, orange and gold, with a fine crackle.
  { id: "fin-ember", slot: "finish", name: "Ember Glaze", unlock: ach("jumps_10k"), color: "#e0582a", rarity: 3 },
  // Lily-petal orange with dark freckles.
  { id: "fin-tigerlily", slot: "finish", name: "Tiger Lily", unlock: ach("style_t4"), color: "#f5862a", rarity: 3 },
  // Deep space: violet and magenta gas clouds and a field of twinkling stars.
  { id: "fin-nebula", slot: "finish", name: "Nebula", unlock: ach("tier_4"), color: "#6a3ad0", rarity: 3, legacy: [ach("maps_25"), lvl(30), ach("wr_5")] },
  // A dawn-blue blade under a silver web strung with glinting dew.
  { id: "fin-dewweb", slot: "finish", name: "Dewdrop Web", unlock: ach("tier_5"), color: "#3a5a9a", rarity: 4, legacy: [ach("sweep_5")] },
  // Frosted glass: ice blue with white frost ferns and sparkle.
  { id: "fin-frost", slot: "finish", name: "Frost", unlock: ach("tier_6"), color: "#9fd8ff", rarity: 4, legacy: [ach("top10_1")] },
  // A sliced beetroot: glossy crimson and pink rings.
  { id: "fin-heartbeet", slot: "finish", name: "Heartbeet", unlock: ach("wr_1"), color: "#c0144a", rarity: 5 },
  // Emerald meadow scattered with little four-leaf clovers, a few of them gold.
  { id: "fin-fourleaf", slot: "finish", name: "Four-Leaf", unlock: ach("level_50"), color: "#1aa851", rarity: 5 },
  // The owner's finish (role-held): molten gold with a shimmer that sweeps the blade.
  { id: "fin-founder", slot: "finish", name: "Founder's Gold", unlock: role("owner"), color: "#ffc23d", rarity: 5 },
  // Supporter (SUPPORTER): the Geode finishes, all three animated (viewmodel/finishes/shader.ts).
  // A split geode: stone shell, agate band and crystal facets that a shine sweeps across.
  { id: "fin-geode", slot: "finish", name: "Geode", unlock: ach(SUPPORTER), color: "#5ff2df", rarity: 4 },
  // Veins of light crawling over a near-black blade, a pulsing edge.
  { id: "fin-rift", slot: "finish", name: "Rift", unlock: ach(SUPPORTER), color: "#6a2cff", rarity: 4 },
  // Halftone neon dots with colour bands scrolling through them, and a glitch now and then.
  { id: "fin-spectrum", slot: "finish", name: "Spectrum", unlock: ach(SUPPORTER), color: "#2a8cff", rarity: 4 },
  // High Roller: torn gold leaf on black lacquer, a sheen crossing it and glints. Borealis: curtains of aurora light
  // rippling along a night-blue blade over faint stars. Both animated.
  { id: "fin-goldleaf", slot: "finish", name: "Gold Leaf", unlock: ach(SUPPORTER), color: "#e0b13a", rarity: 4 },
  { id: "fin-aurora", slot: "finish", name: "Aurora", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4 },
  // Supporter metals (asked for in ┃supporters, 2026-10-28), standalone like the bayonets: polished metal and nothing
  // else, no pattern. Three deep tinted steels (coloured chrome, not gemstones), a white pearl metal whose sheen turns
  // with the angle, a chrome washed in a rainbow that turns with the angle and drifts slowly, and plain chrome.
  { id: "fin-emerald-steel", slot: "finish", name: "Emerald Steel", unlock: ach(SUPPORTER), color: "#12a058", rarity: 4 },
  { id: "fin-ruby-steel", slot: "finish", name: "Ruby Steel", unlock: ach(SUPPORTER), color: "#c8183a", rarity: 4 },
  { id: "fin-sapphire-steel", slot: "finish", name: "Sapphire Steel", unlock: ach(SUPPORTER), color: "#2456d8", rarity: 4 },
  { id: "fin-pearl", slot: "finish", name: "Pearl", unlock: ach(SUPPORTER), color: "#efe6ee", rarity: 4 },
  { id: "fin-chromatic", slot: "finish", name: "Chromatic", unlock: ach(SUPPORTER), color: "#b07cff", rarity: 4 },
  { id: "fin-chrome", slot: "finish", name: "Chrome", unlock: ach(SUPPORTER), color: "#d4d9e0", rarity: 4 },
  // Gloves: a style (its own shape and materials on the hands, loadout.ts GLOVE_STYLE / viewmodel/gloves/) in a
  // colourway. Knit follows your bunny colourway. Ids are `glove-<style>-<colourway>` and never change.
  { id: "glove-knit", slot: "glove", name: "Knit", unlock: free, color: "#2a2e38", rarity: 1 },
  { id: "glove-garden-classic", slot: "glove", name: "Garden · Classic", unlock: ach("first_finish"), color: "#2e7d4a", rarity: 1 },
  { id: "glove-wraps-ducttape", slot: "glove", name: "Hand Wraps · Duct Tape", unlock: ach("bonus_1"), color: "#a3a9b1", rarity: 1 },
  { id: "glove-sport-carrot", slot: "glove", name: "Sport · Carrot", unlock: lvl(5), color: "#ff8a2a", rarity: 2 },
  { id: "glove-garden-tulip", slot: "glove", name: "Garden · Tulip", unlock: ach("maps_10"), color: "#e0457b", rarity: 2 },
  { id: "glove-wraps-spruce", slot: "glove", name: "Hand Wraps · Spruce", unlock: ach("clock_1h"), color: "#3f7a5a", rarity: 2 },
  { id: "glove-sport-vice", slot: "glove", name: "Sport · Vice", unlock: lvl(12), color: "#ff6fae", rarity: 2 },
  { id: "glove-driver-tan", slot: "glove", name: "Driver · Tan", unlock: lvl(15), color: "#c08a55", rarity: 2 },
  { id: "glove-garden-moss", slot: "glove", name: "Garden · Moss", unlock: ach("maps_25"), color: "#4d6b2a", rarity: 2 },
  { id: "glove-paws-cocoa", slot: "glove", name: "Paw Pads · Cocoa", unlock: ach("jumps_10k"), color: "#7a5236", rarity: 2 },
  { id: "glove-driver-cocoa", slot: "glove", name: "Driver · Cocoa", unlock: ach("pbs_10"), color: "#4a3326", rarity: 2 },
  { id: "glove-sport-pandora", slot: "glove", name: "Sport · Pandora", unlock: lvl(20), color: "#5b2a86", rarity: 3 },
  { id: "glove-sport-superconductor", slot: "glove", name: "Sport · Superconductor", unlock: ach("tier_4"), color: "#2a62e8", rarity: 3 },
  { id: "glove-driver-racing", slot: "glove", name: "Driver · Racing Green", unlock: ach("tier_3"), color: "#2f5a3a", rarity: 3 },
  { id: "glove-wraps-ember", slot: "glove", name: "Hand Wraps · Ember", unlock: ach("bonus_10"), color: "#d8433a", rarity: 3 },
  { id: "glove-moto-boom", slot: "glove", name: "Moto · Boom", unlock: ach("sync_90"), color: "#ff7a3c", rarity: 3 },
  { id: "glove-moto-spearmint", slot: "glove", name: "Moto · Spearmint", unlock: ach("top10_10"), color: "#2fd39a", rarity: 3 },
  { id: "glove-paws-snow", slot: "glove", name: "Paw Pads · Snow", unlock: lvl(30), color: "#f7f4ef", rarity: 3 },
  { id: "glove-moto-eclipse", slot: "glove", name: "Moto · Eclipse", unlock: ach("clock_10h"), color: "#ffb43c", rarity: 4 },
  { id: "glove-specialist-forest", slot: "glove", name: "Specialist · Forest", unlock: ach("tier_5"), color: "#3d5a3a", rarity: 4 },
  { id: "glove-specialist-crimson", slot: "glove", name: "Specialist · Crimson", unlock: ach("sweep_5"), color: "#b02a3a", rarity: 4 },
  { id: "glove-specialist-arctic", slot: "glove", name: "Specialist · Arctic", unlock: ach("tier_6"), color: "#49b6ff", rarity: 4 },
  { id: "glove-paws-sakura", slot: "glove", name: "Paw Pads · Sakura", unlock: ach("jumps_100k"), color: "#ff7aa8", rarity: 4 },
  // Community (DISCORD_LINK): for linking Discord. Blurple sport gloves, a near-black back panel, a green stripe.
  { id: "glove-sport-blurple", slot: "glove", name: "Sport · Blurple", unlock: ach(DISCORD_LINK), color: "#5865f2", rarity: 2 },
  // Community (DISCORD_BOOSTER): for boosting the server. Moto gloves in deep violet with glossy pink armour plates.
  { id: "glove-moto-afterglow", slot: "glove", name: "Moto · Afterglow", unlock: ach(DISCORD_BOOSTER), color: "#f47fff", rarity: 4 },
  // Supporter (SUPPORTER): Specialist gloves in deep teal with a stone grip, amethyst knuckles and aqua detail.
  { id: "glove-specialist-geode", slot: "glove", name: "Specialist · Geode", unlock: ach(SUPPORTER), color: "#1d6b74", rarity: 4 },
  // High Roller: black driving gloves, felt-green tips, gold snaps. Borealis: navy sport gloves, green and violet panels.
  { id: "glove-driver-highroller", slot: "glove", name: "Driver · High Roller", unlock: ach(SUPPORTER), color: "#17181c", rarity: 4 },
  { id: "glove-sport-borealis", slot: "glove", name: "Sport · Borealis", unlock: ach(SUPPORTER), color: "#14203d", rarity: 4 },
  // v0.0.38 glove styles (loadout.ts GLOVE_STYLE: Dress, Aviator, Flip Mitts), earned by playing. They fill goals that
  // had no glove: an early one (1,000 jumps), level 25, 50 PBs, the Aero time goal, and the first T7 to T10 clears (each
  // tier's own colours, beside its colourway, trail and frame).
  { id: "glove-mitts-oatmeal", slot: "glove", name: "Flip Mitts · Oatmeal", unlock: ach("jumps_1k"), color: "#d9c9a8", rarity: 1 },
  { id: "glove-dress-ivory", slot: "glove", name: "Dress · Ivory", unlock: lvl(25), color: "#f3eee3", rarity: 3 },
  { id: "glove-aviator-bomber", slot: "glove", name: "Aviator · Bomber", unlock: ach("time_bhop_lol_aero_35"), color: "#6e4528", rarity: 3 },
  { id: "glove-dress-noir", slot: "glove", name: "Dress · Noir", unlock: ach("pbs_50"), color: "#16161a", rarity: 4 },
  { id: "glove-dress-lapis", slot: "glove", name: "Dress · Lapis", unlock: ach("tier_7"), color: "#26307a", rarity: 4 },
  { id: "glove-aviator-flare", slot: "glove", name: "Aviator · Flare", unlock: ach("tier_8"), color: "#e0479f", rarity: 4 },
  { id: "glove-aviator-riptide", slot: "glove", name: "Aviator · Riptide", unlock: ach("tier_9"), color: "#4fb8ff", rarity: 5 },
  { id: "glove-mitts-whiteout", slot: "glove", name: "Flip Mitts · Whiteout", unlock: ach("tier_10"), color: "#f4f6fb", rarity: 5 },
  // Supporter (v0.0.38): a second glove for High Roller (black dress gloves with gold points and a felt-green cuff) and
  // Borealis (a navy flying gauntlet, violet knuckles, an aurora-green strap), and the new Tidepool set's mitts.
  { id: "glove-dress-dealer", slot: "glove", name: "Dress · Dealer", unlock: ach(SUPPORTER), color: "#e0b13a", rarity: 4 },
  { id: "glove-aviator-polar", slot: "glove", name: "Aviator · Polar Night", unlock: ach(SUPPORTER), color: "#9a6bff", rarity: 4 },
  { id: "glove-mitts-tidepool", slot: "glove", name: "Flip Mitts · Tidepool", unlock: ach(SUPPORTER), color: "#5fc8b8", rarity: 4 },
  // Batch 1 (2026-10-21, research/PROGRESSION-BATCH1.md): earned by playing, themed on our own maps. Each goal gives a
  // small matched set. Colourways in player/bunny/palettes.ts, gloves in loadout.ts GLOVE_STYLE.
  // Home Turf: Meadow's clover green with buttercup accents, and canvas gloves dipped in buttercup yellow.
  { id: "outfit-meadow", slot: "outfit", name: "Meadow", unlock: ach("home_turf"), color: "#4f9a3a" },
  { id: "glove-garden-buttercup", slot: "glove", name: "Garden · Buttercup", unlock: ach("home_turf"), color: "#ffc93a", rarity: 2 },
  // Wayfarer (50 maps): the Backrooms' mono-yellow wallpaper and carpet, saddle leather, a dandelion trail.
  { id: "outfit-fluorescent", slot: "outfit", name: "Fluorescent", unlock: ach("maps_50"), color: "#d8c35a" },
  { id: "glove-driver-saddle", slot: "glove", name: "Driver · Saddle", unlock: ach("maps_50"), color: "#8a4f2a", rarity: 3 },
  { id: "trail-dandelion", slot: "trail", name: "Dandelion", unlock: ach("maps_50"), color: "#ffd23a", color2: "#fff3c8" },
  // Centurion (100 maps; a title only until now): olive with brass trim.
  { id: "outfit-laurel", slot: "outfit", name: "Laurel", unlock: ach("maps_100"), color: "#34452c" },
  // Cartographer (150 maps): Palmera Plaza's teal, pink and violet.
  { id: "outfit-palmera", slot: "outfit", name: "Palmera", unlock: ach("maps_150"), color: "#2bb6b0" },
  // Second Gear (25 T2 clears): Aero's glossy sky blue and white, a grass-green accent.
  { id: "outfit-skyglass", slot: "outfit", name: "Skyglass", unlock: ach("t2_clears_25"), color: "#48b4f0" },
  // Rock Face (10 T3 clears): hare-brown paw pads.
  { id: "glove-paws-hare", slot: "glove", name: "Paw Pads · Hare", unlock: ach("t3_clears_10"), color: "#a07850", rarity: 3 },
  // Spring Loaded (25,000 jumps): chalk-white hand wraps.
  { id: "glove-wraps-chalk", slot: "glove", name: "Hand Wraps · Chalk", unlock: ach("jumps_25k"), color: "#f2efe8", rarity: 3 },
  // Night Shift (25 h): black tactical gloves with sodium-amber stitching, and a street-lamp amber ghost.
  { id: "glove-specialist-nightshift", slot: "glove", name: "Specialist · Night Shift", unlock: ach("clock_25h"), color: "#1b1d22", rarity: 4 },
  { id: "ghost-sodium", slot: "ghost", name: "Sodium", unlock: ach("clock_25h"), color: "#ffa63a", color2: "#ffd27a" },
  // Finishes (viewmodel/finishes/shader.ts FINISH 15-21): one fixed design each, like the rest.
  // Contour: a slate topographic map, cream contour lines, every fifth in carrot orange.
  { id: "fin-contour", slot: "finish", name: "Contour", unlock: ach("maps_100"), color: "#2c3e57", rarity: 4 },
  // Meteor: black iron crossed by three falling streaks, white-hot heads cooling to red.
  { id: "fin-meteor", slot: "finish", name: "Meteor", unlock: ach("t4_clears_5"), color: "#ff6a2a", rarity: 4 },
  // Hourglass: sand-gold dunes in soft ripples that creep toward the tip, a fine grain.
  { id: "fin-hourglass", slot: "finish", name: "Hourglass", unlock: ach("clock_50h"), color: "#e0bf80", rarity: 5 },
  // Wildflower: pale meadow green with small five-petal flowers.
  { id: "fin-wildflower", slot: "finish", name: "Wildflower", unlock: ach("sweep_2"), color: "#c6e3a8", rarity: 5 },
  // Tally: bone white with scratched tally marks, now and then a group in orange.
  { id: "fin-tally", slot: "finish", name: "Tally", unlock: ach("maps_250"), color: "#efe9dc", rarity: 5 },
  // Gauntlets: the old orange-and-grey developer texture.
  // Run the Gauntlet (any gauntlet), Gauntlet Regular (5 different), Weekly Podium: GAUNTLET_ACHIEVEMENTS.
  { id: "outfit-devgrid", slot: "outfit", name: "Dev Grid", unlock: ach("gauntlet_1"), color: "#8f9296" },
  { id: "glove-moto-devgrid", slot: "glove", name: "Moto · Dev Grid", unlock: ach("gauntlet_1"), color: "#e8862a", rarity: 2 },
  { id: "fin-devgrid", slot: "finish", name: "Dev Grid", unlock: ach("gauntlet_5"), color: "#f08a24", rarity: 4 },
  { id: "trail-checker", slot: "trail", name: "Checker", unlock: ach("weekly_podium"), color: "#f08a24", color2: "#8f9296" },
  // !race: white moto gloves with red plates.
  { id: "glove-moto-racer", slot: "glove", name: "Moto · Racer", unlock: ach("race_10"), color: "#d8262f", rarity: 3 },
  // October: a pumpkin colourway and gloves (Trick or Treat, inside the window), a candle-lit blade (any time).
  { id: "outfit-pumpkin", slot: "outfit", name: "Pumpkin Patch", unlock: ach("halloween_5"), color: "#e0701c" },
  { id: "glove-garden-pumpkin", slot: "glove", name: "Garden · Pumpkin", unlock: ach("halloween_5"), color: "#e0701c", rarity: 3 },
  { id: "fin-lantern", slot: "finish", name: "Lantern", unlock: ach("halloween_10"), color: "#ff8a1f", rarity: 4 },
  // Winter (v0.0.44): a snow colourway (Snow Day, inside the window), a pack-ice blade (Deep Winter, any time) and the
  // Santa Hat for a quick bhop_ambience_xmas (Sleigh Ride, any time). Ids are stable forever.
  { id: "outfit-snowdrift", slot: "outfit", name: "Snowdrift", unlock: ach("winter_5"), color: "#e9eef0" },
  { id: "fin-pack-ice", slot: "finish", name: "Pack Ice", unlock: ach("winter_10"), color: "#9cc9ea", rarity: 4 },
  { id: "hat-santa", slot: "hat", name: "Santa Hat", unlock: ach(SANTA_GOAL), color: "#d0342c" },
  // Level 35 / 40: the card between Holo (30) and Four-Leaf (50).
  { id: "frame-brass", slot: "frame", name: "Brass", unlock: lvl(35), color: "#c9a24a" },
  { id: "bg-nightgarden", slot: "background", name: "Night Garden", unlock: lvl(40), color: "#102418" },
  // v0.0.37: the top tiers (T7 Insane indigo, T8 Brutal pink, T9 Nightmare azure, T10 Impossible white: tiers.ts TIER_COLORS), a set each,
  // earned with the first clear and kept if the map is re-tiered later (achievements are permanent). The hat for T10
  // is player/bunny/hats.ts wreath; the card pieces are ui/profile.css .pc-frame-* / .pc-bg-* and og/cards.ts.
  // Lapis (First T7, added in the second pass so T7 has a set too): deep lapis blue with the tier's indigo trim and a
  // fleck of gold, and an indigo trail that settles into gold.
  { id: "outfit-lapis", slot: "outfit", name: "Lapis", unlock: ach("tier_7"), color: "#26307a" },
  { id: "trail-lapis", slot: "trail", name: "Lapis", unlock: ach("tier_7"), color: "#7c83ff", color2: "#d9b45a" },
  // Flare (First T8): a hot pink hoodie on black, and a pink trail that burns out orange.
  { id: "outfit-flare", slot: "outfit", name: "Flare", unlock: ach("tier_8"), color: "#e0479f" },
  { id: "trail-flare", slot: "trail", name: "Flare", unlock: ach("tier_8"), color: "#ff6ec7", color2: "#ff9a3c" },
  // Riptide (First T9): deep-water navy with azure trim, an azure ghost glowing deep blue, an azure frame.
  { id: "outfit-riptide", slot: "outfit", name: "Riptide", unlock: ach("tier_9"), color: "#0e2a4a" },
  { id: "ghost-riptide", slot: "ghost", name: "Riptide", unlock: ach("tier_9"), color: "#4fb8ff", color2: "#1a4fd8" },
  { id: "frame-riptide", slot: "frame", name: "Riptide", unlock: ach("tier_9"), color: "#4fb8ff" },
  // Whiteout (First T10): all white with a cold glow, a white trail into pale ice, a platinum frame, the Silver Wreath.
  { id: "outfit-whiteout", slot: "outfit", name: "Whiteout", unlock: ach("tier_10"), color: "#f4f6fb" },
  { id: "trail-whiteout", slot: "trail", name: "Whiteout", unlock: ach("tier_10"), color: "#ffffff", color2: "#b8c8ff" },
  { id: "frame-whiteout", slot: "frame", name: "Whiteout", unlock: ach("tier_10"), color: "#f2f4ff" },
  // The long goals: Deep End (5 T8+ maps) and Sleepless (3 T9+ maps) each give the card background of their tier.
  { id: "bg-flare", slot: "background", name: "Flare", unlock: ach("t8_clears_5"), color: "#2a0d1f" },
  { id: "bg-riptide", slot: "background", name: "Riptide", unlock: ach("t9_clears_3"), color: "#0a1f3a" },
];

// Hilt skins (v0.0.38, the owner's ask: one hilt slot for every knife, skins in colourways and materials, so knife ×
// finish × hilt × gloves make the combos). Render data: loadout.ts HILT_SKIN; which parts of each knife are its hilt:
// viewmodel/knives/types.ts HiltMap. Earned ones fill goals that gave nothing (First T1, level 10, every style's first
// clear and 10 clears, T3 / T4 / T6 / T7 sweeps, Top 10, Bonus Collector, Meadowlark, Every Gauntlet, Record
// Collector); the supporter and role sets each get their own. Ids are stable forever.
COSMETICS.push(
  { id: "hilt-original", slot: "hilt", name: "Original", unlock: free, color: "#2f7d34", rarity: 1 },
  { id: "hilt-bone-white", slot: "hilt", name: "Bone White", unlock: ach("tier_1"), color: "#f1eadb", rarity: 1 },
  { id: "hilt-black", slot: "hilt", name: "Black", unlock: lvl(10), color: "#1c1d21", rarity: 2 },
  // Every style's first clear: a material each.
  { id: "hilt-cork", slot: "hilt", name: "Cork", unlock: ach("style_legit"), color: "#c79a64", rarity: 2 },
  { id: "hilt-oak", slot: "hilt", name: "Oak", unlock: ach("style_scroll"), color: "#c99a62", rarity: 2 },
  { id: "hilt-twine", slot: "hilt", name: "Garden Twine", unlock: ach("style_wonly"), color: "#c8ad7a", rarity: 2 },
  { id: "hilt-olive-rubber", slot: "hilt", name: "Olive Rubber", unlock: ach("style_sideways"), color: "#4f5a34", rarity: 2 },
  { id: "hilt-tan-leather", slot: "hilt", name: "Tan Leather", unlock: ach("style_hsw"), color: "#b27a45", rarity: 2 },
  { id: "hilt-slate-cord", slot: "hilt", name: "Slate Cord", unlock: ach("style_adonly"), color: "#5b6470", rarity: 2 },
  { id: "hilt-driftwood", slot: "hilt", name: "Driftwood", unlock: ach("style_backwards"), color: "#9a8a74", rarity: 2 },
  // Ten clears in a style: the step up.
  { id: "hilt-walnut", slot: "hilt", name: "Walnut", unlock: ach("scroll_10"), color: "#6b4428", rarity: 3 },
  { id: "hilt-antler", slot: "hilt", name: "Antler", unlock: ach("legitscroll_10"), color: "#cdbb9a", rarity: 3 },
  { id: "hilt-orange-cord", slot: "hilt", name: "Orange Cord", unlock: ach("wonly_10"), color: "#ff7a1a", rarity: 3 },
  { id: "hilt-bamboo", slot: "hilt", name: "Bamboo", unlock: ach("sideways_10"), color: "#c7c27a", rarity: 3 },
  { id: "hilt-black-leather", slot: "hilt", name: "Black Leather", unlock: ach("hsw_10"), color: "#1f1c1c", rarity: 3 },
  { id: "hilt-oxblood", slot: "hilt", name: "Oxblood Leather", unlock: ach("adonly_10"), color: "#6e1f1c", rarity: 3 },
  { id: "hilt-ebony", slot: "hilt", name: "Ebony", unlock: ach("backwards_10"), color: "#2b211c", rarity: 3 },
  // Maps, boards and sweeps.
  { id: "hilt-clover", slot: "hilt", name: "Clover", unlock: ach("time_bhop_lol_meadow_16"), color: "#2f8f4a", rarity: 3 },
  { id: "hilt-navy-cord", slot: "hilt", name: "Navy Cord", unlock: ach("top10_1"), color: "#22305e", rarity: 3 },
  { id: "hilt-copper", slot: "hilt", name: "Copper", unlock: ach("bonus_25"), color: "#d9825a", rarity: 3 },
  { id: "hilt-brass", slot: "hilt", name: "Brass", unlock: ach("sweep_3"), color: "#e0b25a", rarity: 3 },
  { id: "hilt-carved-bone", slot: "hilt", name: "Carved Bone", unlock: ach("sweep_4"), color: "#ece2c9", rarity: 4 },
  { id: "hilt-gunmetal", slot: "hilt", name: "Gunmetal", unlock: ach("gauntlet_every"), color: "#5a616b", rarity: 4 },
  { id: "hilt-rosewood", slot: "hilt", name: "Rosewood", unlock: ach("sweep_6"), color: "#7a2e22", rarity: 4 },
  { id: "hilt-gilded", slot: "hilt", name: "Gilded", unlock: ach("wr_5"), color: "#ffc94a", rarity: 5 },
  { id: "hilt-marble", slot: "hilt", name: "Marble", unlock: ach("sweep_7"), color: "#f2f0ea", rarity: 5 },
  // Supporter (SUPPORTER), one per set: banded geode stone with aqua and amethyst fittings; felt-green cord and gold;
  // a navy leather wrap edged in aurora green with violet fittings; frosted sea glass, pearl and coral.
  { id: "hilt-geode", slot: "hilt", name: "Geode", unlock: ach(SUPPORTER), color: "#1d6b74", rarity: 4 },
  { id: "hilt-highroller", slot: "hilt", name: "High Roller", unlock: ach(SUPPORTER), color: "#0f5a3a", rarity: 4 },
  { id: "hilt-borealis", slot: "hilt", name: "Borealis", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4 },
  { id: "hilt-tidepool", slot: "hilt", name: "Sea Glass", unlock: ach(SUPPORTER), color: "#5fc8b8", rarity: 4 },
  // Living hilts (v0.0.43, Supporter, standalone): pieces that move and glow in first person (viewmodel/hilts/live).
  { id: "hilt-watcher", slot: "hilt", name: "Watcher", unlock: ach(SUPPORTER), color: "#8fb23a", rarity: 4 },
  { id: "hilt-frostrune", slot: "hilt", name: "Frostrune", unlock: ach(SUPPORTER), color: "#5cb8ff", rarity: 4 },
  { id: "hilt-clockwork", slot: "hilt", name: "Escapement", unlock: ach(SUPPORTER), color: "#d9a54a", rarity: 4 },
  { id: "hilt-ember", slot: "hilt", name: "Forge", unlock: ach(SUPPORTER), color: "#ff6a1a", rarity: 4 },
  { id: "hilt-deep", slot: "hilt", name: "Deepwater", unlock: ach(SUPPORTER), color: "#58ffc8", rarity: 4 },
  { id: "hilt-storm", slot: "hilt", name: "Stormfork", unlock: ach(SUPPORTER), color: "#8a6cff", rarity: 4 },
  { id: "hilt-bloom", slot: "hilt", name: "Bloom", unlock: ach(SUPPORTER), color: "#ff7a6a", rarity: 4 },
  // Role sets (ROLE_SETS): storm-navy rubber with a hi-vis lime groove and reflective silver; teal-stained wood and
  // brass; oxblood lacquer and polished silver; violet leather edged in carrot orange, gold fittings.
  { id: "hilt-lookout", slot: "hilt", name: "Lookout", unlock: role("moderator"), color: "#c8f53a", rarity: 5 },
  { id: "hilt-workbench", slot: "hilt", name: "Workbench", unlock: role("contributor"), color: "#2f6e6a", rarity: 5 },
  { id: "hilt-keyholder", slot: "hilt", name: "Keyholder", unlock: role("admin"), color: "#5a1420", rarity: 5 },
  { id: "hilt-founder", slot: "hilt", name: "Founder", unlock: role("owner"), color: "#ffc23d", rarity: 5 },
);

// Titles: every achievement title, plus a few level titles. id = "title-<slug>".
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
for (const a of ACHIEVEMENTS) if (a.title) COSMETICS.push({ id: `title-${slug(a.title)}`, slot: "title", name: a.title, unlock: ach(a.id) });
for (const [level, name] of [
  [1, "Newcomer"],
  [5, "Regular"],
  [15, "Seasoned"],
] as const)
  COSMETICS.push({ id: `title-${slug(name)}`, slot: "title", name, unlock: level === 1 ? free : lvl(level) });
// Rank-held titles.
COSMETICS.push({ id: "title-reigning-champion", slot: "title", name: "Reigning Champion", unlock: held(1), rarity: 5 });
COSMETICS.push({ id: "title-style-champion", slot: "title", name: "Style Champion", unlock: held(1, "style"), rarity: 5 });
// Role-held titles (the staff tag in chat comes with the role itself; these are for the card).
COSMETICS.push({ id: "title-owner", slot: "title", name: "Owner", unlock: role("owner"), rarity: 5 });
COSMETICS.push({ id: "title-staff", slot: "title", name: "Staff", unlock: role("staff"), rarity: 5 });
// Hats (the owner's, role-held like the Founder items, and the Supporter's three): worn on the bunny's head wherever the rank crown shows (rooms,
// replays, ghosts, the menu bunny; player/bunny/hats.ts) and on the player card. null = none (the default). A hat
// replaces the rank crown while it's on: the owner holding #1-#3 shows the crown by default, the hat when one is picked.
COSMETICS.push(
  { id: "hat-founder-crown", slot: "hat", name: "Founder Crown", unlock: role("owner"), color: "#7a3cff", rarity: 5 },
  { id: "hat-tophat", slot: "hat", name: "Tiny Top Hat", unlock: role("owner"), color: "#2a2340", rarity: 5 },
  { id: "hat-beanie", slot: "hat", name: "Carrot Beanie", unlock: role("owner"), color: "#ff7a1a", rarity: 5 },
  // Supporter (SUPPORTER): the Geode hats, all three theirs to pick from (player/bunny/hats.ts, player/hat-fx.ts).
  // Four gems (silver, amethyst, emerald, sapphire) circling the head, each spinning, one catching a shine now and then.
  { id: "hat-gem-orbit", slot: "hat", name: "Gem Orbit", unlock: ach(SUPPORTER), color: "#9b5cf5", rarity: 4 },
  // A faceted crystal ring floating above the ears, a light running round it.
  { id: "hat-halo", slot: "hat", name: "Halo", unlock: ach(SUPPORTER), color: "#8f72ff", rarity: 4 },
  { id: "hat-propeller", slot: "hat", name: "Propeller Cap", unlock: ach(SUPPORTER), color: "#ffd052", rarity: 4 },
  { id: "hat-capybara", slot: "hat", name: "Capybara", unlock: ach(SUPPORTER), color: "#b88955", rarity: 4 },
  { id: "hat-maxwell", slot: "hat", name: "Maxwell", unlock: ach(SUPPORTER), color: "#2b2c38", rarity: 4 },
  // Wigs worn with the hood up (player/bunny/wigs.ts): a fringe under the rim, and two buns or a swaying ponytail.
  { id: "hat-space-buns", slot: "hat", name: "Space Buns", unlock: ach(SUPPORTER), color: "#f29bbf", rarity: 4 },
  { id: "hat-ponytail", slot: "hat", name: "Ponytail", unlock: ach(SUPPORTER), color: "#f29bbf", rarity: 4 },
  // A red lacquer oni mask over the lower face, under the visor (player/bunny/oni-mask.ts).
  { id: "hat-oni-mask", slot: "hat", name: "Half Oni Mask", unlock: ach(SUPPORTER), color: "#c8202c", rarity: 4 },
  // v0.0.42. A plain ivory festival fox mask, worn pushed up on the side of the head or over the face (CosmeticChoice.maskOn;
  // player/bunny/kitsune-mask.ts), and two more wigs (player/bunny/hair-styles.ts): chunky swept spikes, and longer
  // hair with a curtain fringe. Both take the hair colour, the highlight colour and the length.
  { id: "hat-kitsune-mask", slot: "hat", name: "Kitsune Mask", unlock: ach(SUPPORTER), color: "#f3ece0", rarity: 4 },
  { id: "hat-spiky", slot: "hat", name: "Spiky Hair", unlock: ach(SUPPORTER), color: "#f29bbf", rarity: 4 },
  { id: "hat-long", slot: "hat", name: "Long Hair", unlock: ach(SUPPORTER), color: "#f29bbf", rarity: 4 },
  // A band of dark amethyst glass round the hood, a light sweeping the aqua line across its forehead plate.
  { id: "hat-circlet", slot: "hat", name: "Circlet", unlock: ach(SUPPORTER), color: "#342a78", rarity: 4 },
  // High Roller: a dealer's green eyeshade on a black band with gold piping; four gold coins flipping round the head.
  { id: "hat-dealer-visor", slot: "hat", name: "Dealer's Visor", unlock: ach(SUPPORTER), color: "#1e9a5a", rarity: 4 },
  { id: "hat-lucky-coins", slot: "hat", name: "Lucky Coins", unlock: ach(SUPPORTER), color: "#ffcf4a", rarity: 4 },
  // Borealis: a ribbon of aurora light floating above the ears, its colours flowing round it.
  { id: "hat-aurora", slot: "hat", name: "Aurora", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4 },
  // First T10 (v0.0.37): a wreath of small silver leaves round the hood, the two branches meeting over the brow.
  { id: "hat-wreath", slot: "hat", name: "Silver Wreath", unlock: ach("tier_10"), color: "#dfe5f2" },
);
// The secret (WINGS above): the Tek look, a whole outfit rather than a colourway (player/bunny/tek.ts). Staff own it
// like every earned item (staffGrant), so the owner always has it.
COSMETICS.push({ id: "outfit-tek", slot: "outfit", name: "Tek", unlock: ach(WINGS), color: "#1f4a33", rarity: 5 });

/** Items behind a hidden achievement: listed as a "???" silhouette until owned, never named. */
export function secretCosmetic(c: CosmeticDef | null | undefined): boolean {
  return c?.unlock.kind === "achievement" && isSecret(achievement(c.unlock.id));
}

// The Supporter sets' own titles (the Supporter title itself comes with the achievement, in every set).
COSMETICS.push(
  { id: "title-high-roller", slot: "title", name: "High Roller", unlock: ach(SUPPORTER), rarity: 4 },
  { id: "title-stargazer", slot: "title", name: "Stargazer", unlock: ach(SUPPORTER), rarity: 4 },
);

// The Tidepool set (v0.0.38, Supporter): sea glass, coral and pearl. A rock-pool green hoodie with coral trim, pearl
// shoes; a sea-glass ghost glowing coral; a trail of foam into sea glass; the card a pool lit from above; a starfish
// on the hood.
COSMETICS.push(
  { id: "outfit-tidepool", slot: "outfit", name: "Tidepool", unlock: ach(SUPPORTER), color: "#2f8f86", rarity: 4 },
  { id: "ghost-tidepool", slot: "ghost", name: "Tidepool", unlock: ach(SUPPORTER), color: "#7fe0cf", color2: "#ff8a78", rarity: 4 },
  { id: "trail-tidepool", slot: "trail", name: "Tidepool", unlock: ach(SUPPORTER), color: "#f3ece2", color2: "#5fc8b8", rarity: 4 },
  { id: "bg-tidepool", slot: "background", name: "Tidepool", unlock: ach(SUPPORTER), color: "#0f3b3a", rarity: 4 },
  { id: "frame-tidepool", slot: "frame", name: "Tidepool", unlock: ach(SUPPORTER), color: "#5fc8b8", rarity: 4 },
  { id: "hat-starfish", slot: "hat", name: "Starfish", unlock: ach(SUPPORTER), color: "#ff7f6e", rarity: 4 },
  { id: "title-beachcomber", slot: "title", name: "Beachcomber", unlock: ach(SUPPORTER), rarity: 4 },
);

// Back items (v0.0.42): worn on the bunny's back over the hoodie, with any hat (player/bunny/backs.ts builds them,
// player/back-fx.ts moves them). null = none (the default). Most are Supporter items, standalone like the bayonets; the
// wings are the secret's (WINGS: whoever holds it); two are earned by playing. Ids are stable forever.
COSMETICS.push(
  // A small pair of feathered wings, the primaries dipped in gold: they fold back with speed and beat on a hop.
  { id: "back-wings", slot: "back", name: "Wings", unlock: ach(WINGS), color: "#eef0e8", rarity: 5 },
  // A thick brass toy key between the shoulder blades, turning in clicks: slowly at rest, faster with speed.
  { id: "back-windup-key", slot: "back", name: "Wind-up Key", unlock: ach(SUPPORTER), color: "#d9a642", rarity: 4 },
  // A cape in the colourway's accent, lined in ivory, that streams back with speed and swings out of strafes. Its owner
  // sets its length (hip to ankle) and may pick its two colours (CAPE_LENGTH, CosmeticChoice.capeColor / capeLining).
  { id: "back-cape", slot: "back", name: "Cape", unlock: ach(SUPPORTER), color: "#c8202c", rarity: 4 },
  // A stuffed canvas rucksack with a big carrot sticking out of it (Globetrotter: 25 maps cleared).
  { id: "back-carrot-pack", slot: "back", name: "Carrot Pack", unlock: ach("maps_25"), color: "#c9a36b", rarity: 3 },
  // A bunny balloon in the accent colour, tied on at the shoulder: it lags behind and bobs.
  { id: "back-balloon", slot: "back", name: "Balloon", unlock: ach(SUPPORTER), color: "#ff6fb5", rarity: 4 },
  // Two squat pods in the accent colour, a flame under each that flares for a moment on each hop.
  { id: "back-jetpack", slot: "back", name: "Jet Pack", unlock: ach(SUPPORTER), color: "#c9ced6", rarity: 4 },
  // A short sword across the back in the Half Oni Mask's red lacquer and gold.
  { id: "back-blade", slot: "back", name: "Sheathed Blade", unlock: ach(SUPPORTER), color: "#c81e2a", rarity: 4 },
  // A paper pinwheel on a stick over the left shoulder, spinning with speed.
  { id: "back-pinwheel", slot: "back", name: "Pinwheel", unlock: lvl(18), color: "#ffd052", rarity: 2 },
  // A haori: an open-fronted jacket with wide hanging sleeves, worn over the hoodie. Its owner wears it open or tied,
  // picks one of five patterns and may pick its two colours (ROBE_PATTERN_COUNT, CosmeticChoice.robe*).
  { id: "back-robe", slot: "back", name: "Robe", unlock: ach(SUPPORTER), color: "#2b303b", rarity: 4 },
  // The Daily Challenge's medal, worn round the neck (player/bunny/backs.ts medal): earned with the first podium place.
  // Its owner picks which of the metals they hold it shows (CosmeticChoice.medalMetal); its face grows richer with the
  // count of that medal, in the six steps of the name badge (MEDAL_STEPS).
  { id: "back-medal", slot: "back", name: "Daily Medal", unlock: ach("daily_podium"), color: "#ffcf3d", rarity: 4 },
);

// ---------------------------------------------------------------------------------------------
// Role sets (v0.0.38): a whole look per role, held while the role is (RoleNeed / holdsRole), like the Founder items.
// Lookout (moderators): storm navy with hi-vis lime and reflective silver, someone on watch. Workbench (Contributor
// badge): ink canvas with the badge's teal and brass, the workshop. Keyholder (admins): oxblood and polished silver.
// Founder (the owner): the Founder items it always had, plus a glove and a card background.
COSMETICS.push(
  { id: "glove-specialist-lookout", slot: "glove", name: "Specialist · Lookout", unlock: role("moderator"), color: "#c8f53a", rarity: 5 },
  { id: "outfit-lookout", slot: "outfit", name: "Lookout", unlock: role("moderator"), color: "#1b2740", rarity: 5 },
  { id: "ghost-lookout", slot: "ghost", name: "Lookout", unlock: role("moderator"), color: "#c8f53a", color2: "#d8dee8", rarity: 5 },
  { id: "trail-lookout", slot: "trail", name: "Lookout", unlock: role("moderator"), color: "#c8f53a", color2: "#d8dee8", rarity: 5 },
  { id: "bg-lookout", slot: "background", name: "Lookout", unlock: role("moderator"), color: "#111a2c", rarity: 5 },
  { id: "frame-lookout", slot: "frame", name: "Lookout", unlock: role("moderator"), color: "#c8f53a", rarity: 5 },
  { id: "title-moderator", slot: "title", name: "Moderator", unlock: role("moderator"), rarity: 5 },

  { id: "glove-garden-workbench", slot: "glove", name: "Garden · Workbench", unlock: role("contributor"), color: "#3fd4c6", rarity: 5 },
  { id: "outfit-workbench", slot: "outfit", name: "Workbench", unlock: role("contributor"), color: "#2b3448", rarity: 5 },
  { id: "ghost-workbench", slot: "ghost", name: "Workbench", unlock: role("contributor"), color: "#3fd4c6", color2: "#c9a24a", rarity: 5 },
  { id: "trail-workbench", slot: "trail", name: "Workbench", unlock: role("contributor"), color: "#3fd4c6", color2: "#c9a24a", rarity: 5 },
  { id: "bg-workbench", slot: "background", name: "Workbench", unlock: role("contributor"), color: "#18202f", rarity: 5 },
  { id: "frame-workbench", slot: "frame", name: "Workbench", unlock: role("contributor"), color: "#3fd4c6", rarity: 5 },
  { id: "title-contributor", slot: "title", name: "Contributor", unlock: role("contributor"), rarity: 5 },

  { id: "glove-dress-keyholder", slot: "glove", name: "Dress · Keyholder", unlock: role("admin"), color: "#5a1420", rarity: 5 },
  { id: "outfit-keyholder", slot: "outfit", name: "Keyholder", unlock: role("admin"), color: "#5a1420", rarity: 5 },
  { id: "ghost-keyholder", slot: "ghost", name: "Keyholder", unlock: role("admin"), color: "#e8edf3", color2: "#c0283c", rarity: 5 },
  { id: "trail-keyholder", slot: "trail", name: "Keyholder", unlock: role("admin"), color: "#e8edf3", color2: "#8a1c2c", rarity: 5 },
  { id: "bg-keyholder", slot: "background", name: "Keyholder", unlock: role("admin"), color: "#2a0a10", rarity: 5 },
  { id: "frame-keyholder", slot: "frame", name: "Keyholder", unlock: role("admin"), color: "#cfd6e0", rarity: 5 },

  { id: "glove-aviator-founder", slot: "glove", name: "Aviator · Founder", unlock: role("owner"), color: "#ff7a1a", rarity: 5 },
  { id: "bg-founder", slot: "background", name: "Founder", unlock: role("owner"), color: "#1a0f3a", rarity: 5 },
);

// Contributor items, round two (v0.0.38, owner 11-06: "a cool contributor cosmetic or few"). Shown to everyone as a
// locked goal (staffItem), so they are the role's showpiece. Workbench gains the two slots it lacked: Ruler, a teal
// anodised blade with a brass ruler along it, and Pencil, a carpenter's pencil tucked behind the left ear.
// Draftsman, the second Contributor set: blueprint blue with white linework, a technical drawing to wear. Its finish,
// Linework, draws the blade's own outline, a grid and a dimension line in white on blueprint blue.
COSMETICS.push(
  { id: "fin-ruler", slot: "finish", name: "Ruler", unlock: role("contributor"), color: "#2fb8ab", rarity: 5 },
  { id: "hat-pencil", slot: "hat", name: "Pencil", unlock: role("contributor"), color: "#ffc23d", rarity: 5 },

  { id: "fin-linework", slot: "finish", name: "Linework", unlock: role("contributor"), color: "#1d4f91", rarity: 5 },
  { id: "glove-dress-draftsman", slot: "glove", name: "Dress · Draftsman", unlock: role("contributor"), color: "#1d4f91", rarity: 5 },
  { id: "hilt-draftsman", slot: "hilt", name: "Draftsman", unlock: role("contributor"), color: "#1d4f91", rarity: 5 },
  { id: "camo-draftsman", slot: "camo", name: "Draftsman", unlock: role("contributor"), color: "#1d4f91", rarity: 5, roleSet: "draftsman" },
  { id: "outfit-draftsman", slot: "outfit", name: "Draftsman", unlock: role("contributor"), color: "#1d4f91", rarity: 5 },
  { id: "ghost-draftsman", slot: "ghost", name: "Draftsman", unlock: role("contributor"), color: "#bfe0ff", color2: "#ffffff", rarity: 5 },
  { id: "trail-draftsman", slot: "trail", name: "Draftsman", unlock: role("contributor"), color: "#ffffff", color2: "#3f86e0", rarity: 5 },
  { id: "bg-draftsman", slot: "background", name: "Draftsman", unlock: role("contributor"), color: "#1d4f91", rarity: 5 },
  { id: "frame-draftsman", slot: "frame", name: "Draftsman", unlock: role("contributor"), color: "#bfe0ff", rarity: 5 },
);

export type RoleSetId = "lookout" | "workbench" | "draftsman" | "keyholder" | "founder";
/**
 * The role sets: a theme per role, for the Loadout's grouping. `role`: who holds it (holdsRole: higher staff roles hold
 * the sets under them, the owner all of them). `look`: the whole set worn at once (null = the set has none in that slot).
 */
export const ROLE_SETS: readonly { id: RoleSetId; name: string; role: RoleNeed; items: readonly string[]; look: { finish: string | null; glove: string; hilt: string; outfit: string; hat: string | null; ghost: string; trail: string; background: string; frame: string; title: string } }[] = [
  {
    id: "founder",
    name: "Founder",
    role: "owner",
    items: ["glove-aviator-founder", "hilt-founder", "outfit-founder", "fin-founder", "hat-founder-crown", "hat-tophat", "hat-beanie", "ghost-founder", "trail-founder", "bg-founder", "frame-founder", "title-owner"],
    look: { finish: "fin-founder", glove: "glove-aviator-founder", hilt: "hilt-founder", outfit: "outfit-founder", hat: "hat-founder-crown", ghost: "ghost-founder", trail: "trail-founder", background: "bg-founder", frame: "frame-founder", title: "title-owner" },
  },
  {
    id: "keyholder",
    name: "Keyholder",
    role: "admin",
    items: ["glove-dress-keyholder", "hilt-keyholder", "outfit-keyholder", "ghost-keyholder", "trail-keyholder", "bg-keyholder", "frame-keyholder", "title-staff"],
    look: { finish: null, glove: "glove-dress-keyholder", hilt: "hilt-keyholder", outfit: "outfit-keyholder", hat: null, ghost: "ghost-keyholder", trail: "trail-keyholder", background: "bg-keyholder", frame: "frame-keyholder", title: "title-staff" },
  },
  {
    id: "lookout",
    name: "Lookout",
    role: "moderator",
    items: ["glove-specialist-lookout", "hilt-lookout", "outfit-lookout", "ghost-lookout", "trail-lookout", "bg-lookout", "frame-lookout", "title-moderator"],
    look: { finish: null, glove: "glove-specialist-lookout", hilt: "hilt-lookout", outfit: "outfit-lookout", hat: null, ghost: "ghost-lookout", trail: "trail-lookout", background: "bg-lookout", frame: "frame-lookout", title: "title-moderator" },
  },
  {
    id: "workbench",
    name: "Workbench",
    role: "contributor",
    items: ["fin-ruler", "glove-garden-workbench", "hilt-workbench", "outfit-workbench", "hat-pencil", "ghost-workbench", "trail-workbench", "bg-workbench", "frame-workbench", "title-contributor"],
    look: { finish: "fin-ruler", glove: "glove-garden-workbench", hilt: "hilt-workbench", outfit: "outfit-workbench", hat: "hat-pencil", ghost: "ghost-workbench", trail: "trail-workbench", background: "bg-workbench", frame: "frame-workbench", title: "title-contributor" },
  },
  {
    id: "draftsman",
    name: "Draftsman",
    role: "contributor",
    items: ["fin-linework", "glove-dress-draftsman", "hilt-draftsman", "camo-draftsman", "outfit-draftsman", "ghost-draftsman", "trail-draftsman", "bg-draftsman", "frame-draftsman"],
    look: { finish: "fin-linework", glove: "glove-dress-draftsman", hilt: "hilt-draftsman", outfit: "outfit-draftsman", hat: null, ghost: "ghost-draftsman", trail: "trail-draftsman", background: "bg-draftsman", frame: "frame-draftsman", title: "title-contributor" },
  },
];
for (const set of ROLE_SETS) for (const id of set.items) {
  const c = COSMETICS.find((x) => x.id === id);
  if (c) c.roleSet = set.id;
}

/**
 * The Supporter sets (every supporter owns all of them): a theme each, for the Loadout's grouping and the Support
 * page's switcher. `look`: what the Support page first puts on the preview for the set.
 */
export type SupporterSetId = "geode" | "highroller" | "borealis" | "tidepool";
export const SUPPORTER_SETS: readonly { id: SupporterSetId; name: string; items: readonly string[]; look: { finish: string; glove: string; hilt: string; outfit: string; hat: string; ghost: string; trail: string } }[] = [
  {
    id: "geode",
    name: "Geode",
    items: ["bg-geode", "frame-geode", "ghost-geode", "trail-geode", "outfit-geode", "fin-geode", "fin-rift", "fin-spectrum", "glove-specialist-geode", "hilt-geode", "hat-gem-orbit", "hat-halo", "hat-circlet"],
    look: { finish: "fin-geode", glove: "glove-specialist-geode", hilt: "hilt-geode", outfit: "outfit-geode", hat: "hat-gem-orbit", ghost: "ghost-geode", trail: "trail-geode" },
  },
  {
    id: "highroller",
    name: "High Roller",
    items: ["bg-highroller", "frame-highroller", "ghost-highroller", "trail-highroller", "outfit-highroller", "fin-goldleaf", "glove-driver-highroller", "glove-dress-dealer", "hilt-highroller", "hat-dealer-visor", "hat-lucky-coins", "title-high-roller"],
    look: { finish: "fin-goldleaf", glove: "glove-driver-highroller", hilt: "hilt-highroller", outfit: "outfit-highroller", hat: "hat-lucky-coins", ghost: "ghost-highroller", trail: "trail-highroller" },
  },
  {
    id: "borealis",
    name: "Borealis",
    items: ["bg-borealis", "frame-borealis", "ghost-borealis", "trail-borealis", "outfit-borealis", "fin-aurora", "glove-sport-borealis", "glove-aviator-polar", "hilt-borealis", "hat-aurora", "title-stargazer"],
    look: { finish: "fin-aurora", glove: "glove-sport-borealis", hilt: "hilt-borealis", outfit: "outfit-borealis", hat: "hat-aurora", ghost: "ghost-borealis", trail: "trail-borealis" },
  },
  {
    id: "tidepool",
    name: "Tidepool",
    items: ["bg-tidepool", "frame-tidepool", "ghost-tidepool", "trail-tidepool", "outfit-tidepool", "fin-pearl", "glove-mitts-tidepool", "hilt-tidepool", "hat-starfish", "title-beachcomber"],
    look: { finish: "fin-pearl", glove: "glove-mitts-tidepool", hilt: "hilt-tidepool", outfit: "outfit-tidepool", hat: "hat-starfish", ghost: "ghost-tidepool", trail: "trail-tidepool" },
  },
];
for (const set of SUPPORTER_SETS) for (const id of set.items) {
  const c = COSMETICS.find((x) => x.id === id);
  if (c) c.set = set.id;
}

// ---------------------------------------------------------------------------------------------
// The Daily Challenge's day-cycle set (v0.0.43): earned by taking part, whatever the place (DAILY_LADDER above). Three
// colourways, a knife finish and two gun camos that follow the sun through a day, one at each step: Daybreak with the
// first finish, First Light at 5, Sunray (the knife) at 15, Noon at 30, Dusk at 60, Midnight Sun at 100. (The podium's
// rewards are the counted medals, a step above these.) Colourways in player/bunny/palettes.ts, camos in camo.ts, the
// finish in viewmodel/finishes/shader.ts (FINISH 30). Ids are stable forever.
COSMETICS.push(
  { id: "outfit-daybreak", slot: "outfit", name: "Daybreak", unlock: ach("daily_1"), color: "#ffa86e" },
  { id: "camo-first-light", slot: "camo", name: "First Light", unlock: ach("daily_5"), color: "#ff8a4a", rarity: 2 },
  { id: "fin-sunray", slot: "finish", name: "Sunray", unlock: ach("daily_15"), color: "#ffcc42", rarity: 3 },
  { id: "outfit-noon", slot: "outfit", name: "Noon", unlock: ach("daily_30"), color: "#ffd84a" },
  { id: "outfit-dusk", slot: "outfit", name: "Dusk", unlock: ach("daily_60"), color: "#6a3f9e" },
  { id: "camo-midnight-sun", slot: "camo", name: "Midnight Sun", unlock: ach("daily_100"), color: "#ffc23d", rarity: 4 },
);

// ---------------------------------------------------------------------------------------------
// Gun camos (v0.0.38; camo.ts has the designs, viewmodel/guns/camo.ts draws them): one camo on every gun you're handed.
// No camo is the default (null). Earned ones fill achievements and levels that had no loadout item yet (the style
// clears, the record and sweep goals, the Backrooms, a few early levels); Supporter ones join their set; role ones
// complete the role sets. Ids are stable forever.
COSMETICS.push(
  // Solids and two-tones.
  { id: "camo-field", slot: "camo", name: "Field", unlock: ach("tier_1"), color: "#6b6f4a", rarity: 1 },
  { id: "camo-graphite", slot: "camo", name: "Graphite", unlock: lvl(7), color: "#7b818b", rarity: 1 },
  { id: "camo-split", slot: "camo", name: "Split", unlock: ach("style_hsw"), color: "#eae2cf", rarity: 2 },
  // Game-native, early.
  { id: "camo-carrot-patch", slot: "camo", name: "Carrot Patch", unlock: lvl(9), color: "#ff7a1a", rarity: 2 },
  { id: "camo-picnic", slot: "camo", name: "Picnic", unlock: lvl(11), color: "#f08a8a", rarity: 2 },
  { id: "camo-paws", slot: "camo", name: "Paw Prints", unlock: lvl(14), color: "#7a5236", rarity: 2 },
  // One per unassisted style's first clear. v0.0.41: the army patterns became garden ones (Woodland: fallen leaves).
  { id: "camo-woodland", slot: "camo", name: "Woodland", unlock: ach("style_legit"), color: "#5f7a45", rarity: 2 },
  { id: "camo-desert", slot: "camo", name: "Flagstone", unlock: ach("style_scroll"), color: "#d8c49a", rarity: 2 },
  { id: "camo-urban", slot: "camo", name: "Urban", unlock: ach("style_wonly"), color: "#8c9096", rarity: 2 },
  { id: "camo-reeds", slot: "camo", name: "Reeds", unlock: ach("style_sideways"), color: "#8a9a5b", rarity: 2 },
  // Longer goals.
  { id: "camo-splat", slot: "camo", name: "Paint Splat", unlock: ach("race_1"), color: "#2fb7a8", rarity: 3 },
  { id: "camo-sprinkles", slot: "camo", name: "Sprinkles", unlock: ach("bonus_25"), color: "#ff6fae", rarity: 3 },
  { id: "camo-carbon", slot: "camo", name: "Carbon", unlock: ach("top10_1"), color: "#3a3e46", rarity: 3 },
  { id: "camo-finish-line", slot: "camo", name: "Finish Line", unlock: ach("photo_finish"), color: "#f4f4f6", rarity: 3 },
  { id: "camo-meadow", slot: "camo", name: "Meadow", unlock: ach("scenic_route"), color: "#5f9a4a", rarity: 3 },
  { id: "camo-snow", slot: "camo", name: "Snowfield", unlock: ach("scroll_10"), color: "#dfe7f1", rarity: 3 },
  { id: "camo-night", slot: "camo", name: "Fireflies", unlock: ach("legitscroll_10"), color: "#2a3346", rarity: 3 },
  { id: "camo-crab", slot: "camo", name: "Crab Shell", unlock: ach("sideways_10"), color: "#f08a4b", rarity: 3 },
  { id: "camo-backrooms", slot: "camo", name: "Backrooms", unlock: ach(TRUE_ARCHITECT), color: "#d9c46a", rarity: 3 },
  { id: "camo-devgrid", slot: "camo", name: "Dev Grid", unlock: ach("gauntlet_classic"), color: "#e8862a", rarity: 4 },
  { id: "camo-gilded", slot: "camo", name: "Gold Vein", unlock: ach("wr_5"), color: "#e0b13a", rarity: 4 },
  { id: "camo-gold-weave", slot: "camo", name: "Gold Weave", unlock: ach("wr_10"), color: "#b8902e", rarity: 5 },
  // The high tiers' sweeps, in their tier's colours (the Lapis, Flare, Riptide and Whiteout sets).
  { id: "camo-lapis", slot: "camo", name: "Lapis", unlock: ach("sweep_7"), color: "#26307a", rarity: 5 },
  { id: "camo-flare", slot: "camo", name: "Flare", unlock: ach("sweep_8"), color: "#e0479f", rarity: 5 },
  { id: "camo-riptide", slot: "camo", name: "Riptide", unlock: ach("sweep_9"), color: "#4fb8ff", rarity: 5 },
  { id: "camo-whiteout", slot: "camo", name: "Whiteout", unlock: ach("sweep_10"), color: "#dfe5f2", rarity: 5 },
  // Supporter, one per set.
  { id: "camo-geode", slot: "camo", name: "Geode", unlock: ach(SUPPORTER), color: "#7a5ce8", rarity: 4, set: "geode" },
  { id: "camo-highroller", slot: "camo", name: "High Roller", unlock: ach(SUPPORTER), color: "#0f5a3a", rarity: 4, set: "highroller" },
  { id: "camo-borealis", slot: "camo", name: "Borealis", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4, set: "borealis" },
  { id: "camo-tidepool", slot: "camo", name: "Tidepool", unlock: ach(SUPPORTER), color: "#5fc8b8", rarity: 4, set: "tidepool" },
  // Role sets.
  { id: "camo-lookout", slot: "camo", name: "Lookout", unlock: role("moderator"), color: "#c8f53a", rarity: 5, roleSet: "lookout" },
  { id: "camo-workbench", slot: "camo", name: "Workbench", unlock: role("contributor"), color: "#3fd4c6", rarity: 5, roleSet: "workbench" },
  { id: "camo-keyholder", slot: "camo", name: "Keyholder", unlock: role("admin"), color: "#5a1420", rarity: 5, roleSet: "keyholder" },
  { id: "camo-founder", slot: "camo", name: "Founder", unlock: role("owner"), color: "#241450", rarity: 5, roleSet: "founder" },
);
// The camos join their sets' item lists (kept here, beside the camos, rather than in the lists above).
for (const c of COSMETICS) if (c.slot === "camo") {
  const st = c.set ? SUPPORTER_SETS.find((x) => x.id === c.set) : c.roleSet ? ROLE_SETS.find((x) => x.id === c.roleSet) : null;
  if (st && !st.items.includes(c.id)) (st.items as string[]).push(c.id);
}

// ---------------------------------------------------------------------------------------------
// Trail shapes (v0.0.41; player/trail.ts draws them): what the trail behind your ghost is made of, picked apart from
// its colour, so any shape goes with any trail colour. The ribbon is the default and free; the rest fill two levels and
// four achievements that gave no loadout item. Ids are "shape-<player/trail.ts TrailShape>" and stable forever.
COSMETICS.push(
  { id: "shape-ribbon", slot: "shape", name: "Ribbon", unlock: free },
  // Two thin rails.
  { id: "shape-twin", slot: "shape", name: "Twin", unlock: lvl(6) },
  // The ribbon cut into dashes that stay where they were laid.
  { id: "shape-dashes", slot: "shape", name: "Dashes", unlock: lvl(13) },
  // Eazy Money (bhop_eazy under a minute): a wide head that narrows at once into a long hairline.
  { id: "shape-comet", slot: "shape", name: "Comet", unlock: ach("time_bhop_eazy_30") },
  // Mini Gauntlet: seeds scattered off the path.
  { id: "shape-seeds", slot: "shape", name: "Seeds", unlock: ach("gauntlet_mini") },
  // Beat the Mapper: petals shed to either side, tumbling down.
  { id: "shape-petals", slot: "shape", name: "Petals", unlock: ach(BEAT_MAPPER) },
  // Fixture (25 top-10 places at once): a stem strung with four-leaf clovers.
  { id: "shape-clover", slot: "shape", name: "Clover", unlock: ach("top10_25") },
);

// Hop effects (v0.0.42; player/hop-fx.ts has the recipes, player/hop-layer.ts draws them): a small burst at the feet on
// every hop, seen on you in third person, on other players, ghosts and replays (Settings: Hop effects). None is the
// default (null). Dust is free; the rest fill levels and the jump achievements; one per Supporter set. The tinted ones
// (Ring, Sparks, Embers, Petals, Boost, Static) cool to the colours of the trail you wear. Ids are stable forever.
COSMETICS.push(
  { id: "hop-dust", slot: "hop", name: "Dust", unlock: free, color: "#e4d6ba", rarity: 1 },
  { id: "hop-ring", slot: "hop", name: "Ring", unlock: lvl(4), color: "#ffc23d", rarity: 1 },
  { id: "hop-sparks", slot: "hop", name: "Sparks", unlock: lvl(9), color: "#ffb347", rarity: 2 },
  { id: "hop-frost", slot: "hop", name: "Frost", unlock: lvl(16), color: "#d8f1ff", rarity: 2 },
  { id: "hop-embers", slot: "hop", name: "Embers", unlock: lvl(22), color: "#ff8a4a", rarity: 2 },
  // Bunny (1,000 jumps in finished runs).
  { id: "hop-petals", slot: "hop", name: "Petals", unlock: ach("jumps_1k"), color: "#ffb3cf", rarity: 2 },
  // Jackrabbit (10,000 jumps).
  { id: "hop-carrot", slot: "hop", name: "Carrot Bits", unlock: ach("jumps_10k"), color: "#ff8a2a", rarity: 3 },
  // Spring Loaded (25,000 jumps).
  { id: "hop-boost", slot: "hop", name: "Boost", unlock: ach("jumps_25k"), color: "#9fe870", rarity: 3 },
  // In Sync (a T2+ map at 90% sync).
  { id: "hop-static", slot: "hop", name: "Static", unlock: ach("sync_90"), color: "#9fd2ff", rarity: 3 },
  { id: "hop-crystals", slot: "hop", name: "Crystals", unlock: ach(SUPPORTER), color: "#5ff2df", color2: "#8f72ff", rarity: 4, set: "geode" },
  { id: "hop-gold", slot: "hop", name: "Gold Rush", unlock: ach(SUPPORTER), color: "#ffcf4a", color2: "#1f9a5c", rarity: 4, set: "highroller" },
  { id: "hop-aurora", slot: "hop", name: "Aurora", unlock: ach(SUPPORTER), color: "#3ff0a0", color2: "#9a6bff", rarity: 4, set: "borealis" },
  { id: "hop-splash", slot: "hop", name: "Splash", unlock: ach(SUPPORTER), color: "#f3ece2", color2: "#5fc8b8", rarity: 4, set: "tidepool" },
);
// Charms (v0.0.43; viewmodel/charms/ builds and swings them): a small thing hanging on a short cord from the knife's
// guard (or its pommel), swinging with your movement, in first person. null = none (the default). One fixed look each,
// no rarity. A third are earned by playing, the rest are Supporter items, standalone like the back items. Its owner sets
// the cord's length, the size, how lively it swings and where it hangs (CHARM_LENGTH / CHARM_SIZE / CHARM_SWING,
// CosmeticChoice.charm*). Ids are stable forever.
COSMETICS.push(
  // The game's carrot in small, leaves and all (First Hop: finish a map).
  { id: "charm-carrot", slot: "charm", name: "Carrot", unlock: ach("first_finish"), color: "#ff7a1a" },
  // The bunny's hooded head: cream hood and ears, the dark face, the amber visor with its two lit eyes.
  { id: "charm-bun", slot: "charm", name: "Bun", unlock: lvl(5), color: "#ece5d8" },
  // A round snail with an orange swirl shell (Jackrabbit: 10,000 jumps).
  { id: "charm-snail", slot: "charm", name: "Snail", unlock: ach("jumps_10k"), color: "#f08a3a" },
  // A puffed gold star that turns slowly on its cord.
  { id: "charm-star", slot: "charm", name: "Star", unlock: lvl(25), color: "#ffc93a" },
  // A sleepy crescent moon (Night Shift: 25 hours played).
  { id: "charm-moon", slot: "charm", name: "Moon", unlock: ach("clock_25h"), color: "#f5e6a0" },
  // A puffed cherry-red heart that beats now and then.
  { id: "charm-heart", slot: "charm", name: "Heart", unlock: ach(SUPPORTER), color: "#e0283c" },
  // A round grey-and-white cat sitting as a loaf, its tail wrapped round, the tip flicking.
  { id: "charm-loaf", slot: "charm", name: "Loaf", unlock: ach(SUPPORTER), color: "#8a8f99" },
  // A brass bell whose clapper swings inside it.
  { id: "charm-bell", slot: "charm", name: "Bell", unlock: ach(SUPPORTER), color: "#e2ae48" },
  // A small red paper lantern with a warm light inside.
  { id: "charm-lantern", slot: "charm", name: "Lantern", unlock: ach(SUPPORTER), color: "#d8332e" },
  // A yellow bath duck.
  { id: "charm-duck", slot: "charm", name: "Duck", unlock: ach(SUPPORTER), color: "#ffd23a" },
  // A round green frog that blinks.
  { id: "charm-frog", slot: "charm", name: "Frog", unlock: ach(SUPPORTER), color: "#5cbf4a" },
  // A red toadstool with white spots.
  { id: "charm-toadstool", slot: "charm", name: "Toadstool", unlock: ach(SUPPORTER), color: "#d8322c" },
  // Bun-E's head: the cream box, antenna ears, the dark visor with two amber eyes.
  { id: "charm-bune", slot: "charm", name: "Bun-E", unlock: ach(SUPPORTER), color: "#f2e8d8" },
  // A four-leaf clover in green enamel in a thin gold rim.
  { id: "charm-clover", slot: "charm", name: "Clover", unlock: ach(SUPPORTER), color: "#3f9a4a" },
);
for (const c of COSMETICS) if (c.slot === "hop" && c.set) {
  const st = SUPPORTER_SETS.find((x) => x.id === c.set);
  if (st && !st.items.includes(c.id)) (st.items as string[]).push(c.id);
}

/**
 * Retired cosmetic ids -> what replaced them (read everywhere through cosmetic(): saved choices, room rosters, replay
 * trailers, the local loadout cache), so an old save keeps an equivalent and is written back under the new id. The
 * replacement's unlock (plus `legacy`) is met by everyone who met the old one. v0.0.6 finish lineup:
 */
export const FINISH_ALIASES: Readonly<Record<string, string>> = {
  "fin-fade": "fin-sunset",
  "fin-case": "fin-ember",
  "fin-tiger": "fin-tigerlily",
  "fin-web": "fin-dewweb",
  "fin-doppelhop-p1": "fin-nebula",
  "fin-doppelhop-p2": "fin-nebula",
  "fin-doppelhop-p4": "fin-nebula",
  "fin-doppelhop-blackpearl": "fin-nebula",
  "fin-doppelhop-p3": "fin-frost",
  "fin-doppelhop-sapphire": "fin-frost",
  "fin-doppelhop-ruby": "fin-heartbeet",
  "fin-gamma-emerald": "fin-fourleaf",
};

const COS_BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
/** A catalogue item by id; retired ids (FINISH_ALIASES) resolve to their replacement. */
export const cosmetic = (id: string | null | undefined) => (id ? (COS_BY_ID.get(id) ?? COS_BY_ID.get(FINISH_ALIASES[id] ?? "") ?? null) : null);

export const DEFAULT_COSMETICS: Record<CosmeticSlot, string | null> = {
  background: "bg-night",
  frame: "frame-plain",
  /** null = show the rank title. */
  title: null,
  ghost: "ghost-gold",
  trail: "trail-gold",
  /** The trail's shape (v0.0.41): the ribbon it has always been. */
  shape: "shape-ribbon",
  outfit: "outfit-cream",
  body: "body-a",
  knife: "knife-carrot",
  finish: "fin-garden",
  glove: "glove-knit",
  /** Each knife's own hilt (loadout.ts HILT_SKIN: no skin). */
  hilt: "hilt-original",
  /** null = no hat (the owner's hats and the Supporter's three). */
  hat: null,
  /** null = no gun camo (v0.0.38; camo.ts): the guns as they've always looked. */
  camo: null,
  /** null = nothing on the bunny's back (v0.0.42; player/bunny/backs.ts). */
  back: null,
  /** null = no hop effect (v0.0.42; player/hop-fx.ts). */
  hop: null,
  /** null = no charm on the knife (v0.0.43; viewmodel/charms/). */
  charm: null,
};

/**
 * Staff unlocks (owner call, v0.0.6). While a player holds a staff role every cosmetic earned by playing (level /
 * achievement) is theirs, plus the staff role's own items. Rank-held items (Reigning / Podium / Hare colourways,
 * frames, trails, ghost, the Champion titles) stay with whoever holds the place: admins can see and preview them but
 * not equip them unless they hold the rank too. The owner gets everything, rank-held included. The owner's own items
 * stay the owner's (they say "this is the owner"). Like every role-held unlock it's checked server-side with the role
 * on save and on every read, so a removed admin reads back as what they really earned. Cosmetics only: achievements,
 * XP and showcased badges (earned achievements) are untouched; the crown still needs the real place.
 */
export function staffGrant(c: CosmeticDef, who: Holder): boolean {
  const staff = holderOf(who).role;
  if (c.unlock.kind === "role" || !holdsRole("staff", staff)) return false;
  // The Supporter set says "this player donated": admins get it only by supporting (the owner gets everything).
  if (supporterItem(c) && staff !== "owner") return false;
  return c.unlock.kind !== "rank" || staff === "owner";
}

/** The first set's look (SUPPORTER_SETS[0].look): what the Support page first shows. */
export const SUPPORTER_LOOK = SUPPORTER_SETS[0].look;

/** An item of the Supporter set (the Geode items and the Supporter title). */
export const supporterItem = (c: CosmeticDef): boolean => c.unlock.kind === "achievement" && c.unlock.id === SUPPORTER;

/**
 * Whether the player owns `c`. `grant` = false leaves out the staff grant (staffGrant): what the player owns on their
 * own (the client's "new unlock" tracking, so role-granted items never count as new).
 */
export function isUnlocked(
  c: CosmeticDef,
  level: number,
  achievements: ReadonlySet<string> | readonly string[],
  ranks: HeldRanks = {},
  staff: Holder = null,
  grant = true,
): boolean {
  if (grant && staffGrant(c, staff)) return true;
  const has = (id: string) => (Array.isArray(achievements) ? achievements.includes(id) : (achievements as ReadonlySet<string>).has(id));
  const meets = (u: Unlock): boolean => {
    switch (u.kind) {
      case "free":
        return true;
      case "level":
        return level >= u.level;
      case "achievement":
        return has(u.id);
      case "rank":
        if (u.scope === "all") return (ranks.all ?? Infinity) <= u.max;
        // Any style's ranking, Auto-strafe's too (since 0.0.15; it still adds nothing to the overall rank or the crown).
        return Object.entries(ranks).some(([scope, r]) => isStyleId(scope) && Number.isInteger(r) && r >= 1 && r <= u.max);
      case "role":
        return holdsRole(u.role, staff);
    }
  };
  return meets(c.unlock) || !!c.legacy?.some(meets);
}

export function unlockHint(c: CosmeticDef): string {
  switch (c.unlock.kind) {
    case "free":
      return "Free";
    case "level":
      return `Level ${c.unlock.level}`;
    case "achievement": {
      const a = achievement(c.unlock.id);
      if (isSecret(a)) return "???";
      return a?.goal ?? a?.name ?? c.unlock.id;
    }
    case "rank":
      return rankHint(c.unlock);
    case "role":
      return roleHint(c.unlock.role);
  }
}

/** "Hold overall #1", "Hold overall top 3", "Hold #1 in a style". */
export function rankHint(u: { max: number; scope: "all" | "style" }): string {
  if (u.scope === "style") return u.max === 1 ? "Hold #1 in a style" : `Hold top ${u.max} in a style`;
  return u.max === 1 ? "Hold overall #1" : `Hold overall top ${u.max}`;
}

/**
 * Card + ghost cosmetics a player has chosen (ids), as stored and served by the API; plus `hairColor` ("#rrggbb"), the
 * colour of a wig hat (loadout.ts WIGS), and `hairLength` (a percent, HAIR_LENGTH), the ponytail's length, both kept
 * only for players who own a wig (absent = the default). The same for the Cape (CAPE_ITEM): `capeLength` (a percent,
 * CAPE_LENGTH), `capeColor` and `capeLining` ("#rrggbb" on the cape's colour grid, capeHexOf; absent = the colourway's
 * accent outside and ivory inside), kept only for players who own it.
 */
export type CosmeticChoice = Record<CosmeticSlot, string | null> & {
  hairColor?: string | null;
  hairLength?: number | null;
  /** A wig's highlight colour ("#rrggbb" on the highlight grid, highlightHexOf; absent = none), for wig owners. */
  hairHighlight?: string | null;
  /** The Kitsune Mask over the face (true) instead of pushed up on the side of the head (absent), for its owners. */
  maskOn?: boolean | null;
  capeLength?: number | null;
  capeColor?: string | null;
  capeLining?: string | null;
  /**
   * The Robe's (ROBE_ITEM): `robePattern` (1 .. ROBE_PATTERN_COUNT - 1; absent = plain), `robeTied` (true = tied; absent
   * = open), `robeColor` and `robePrint` ("#rrggbb" on the cape's colour grid; absent = the colourway's own), kept only
   * for players who own it.
   */
  robePattern?: number | null;
  robeTied?: boolean | null;
  robeColor?: string | null;
  robePrint?: string | null;
  /** The Daily Medal's (MEDAL_ITEM) metal: one the player holds (absent = their best), kept only for its owners. */
  medalMetal?: MedalMetal | null;
  /**
   * The charm's options (CHARM_LENGTH, CHARM_SIZE, CHARM_SWING: whole numbers on their steps; absent = the default) and
   * `charmPommel` (true = it hangs from the pommel; absent = the guard), kept for players who own a charm.
   */
  charmLength?: number | null;
  charmSize?: number | null;
  charmSwing?: number | null;
  charmPommel?: boolean | null;
  knifePool?: KnifePool | null;
  /** The overall Number One's title colour ("#rrggbb", ranking.ts shownRankColor). Set only while #1, kept after. */
  rankColor?: string | null;
};

/**
 * Knife pool (v0.0.30, syl's ask): owned knives, each with its own finish, that the game swaps between on a map change
 * (or on every restart too), in order or at random. Saved with the cosmetics (CosmeticChoice.knifePool); the run's
 * replay trailer and the room roster carry the knife actually held (loadout.ts heldPick), never the pool. Active with
 * two or more items; fewer is a pool still being built (the equipped knife is held).
 */
export interface KnifePool {
  items: { knife: string; finish: string }[];
  /** "map": a new knife each map; "restart": each restart too. */
  swap: "map" | "restart";
  /** "order": the next one in the list; "random": any other one. */
  order: "order" | "random";
}
export const KNIFE_POOL_MAX = 8;
export const KNIFE_POOL_SWAPS = ["map", "restart"] as const;
export const KNIFE_POOL_ORDERS = ["order", "random"] as const;

/**
 * A saved / sent knife pool, checked item by item: strict (on save) returns the first problem as a string, lenient (on
 * read) drops unknown, locked and repeated items and keeps the rest (null when nothing is left). `owns` says whether an
 * item is unlocked.
 */
export function knifePoolOf(v: unknown, owns: (c: CosmeticDef) => boolean, strict: true): KnifePool | string | null;
export function knifePoolOf(v: unknown, owns: (c: CosmeticDef) => boolean, strict?: false): KnifePool | null;
export function knifePoolOf(v: unknown, owns: (c: CosmeticDef) => boolean, strict = false): KnifePool | string | null {
  if (v === null || v === undefined) return null;
  const fail = (why: string) => (strict ? why : null);
  if (typeof v !== "object" || Array.isArray(v)) return fail("expected { items, swap, order }");
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.items)) return fail("expected an items list");
  if (strict && r.items.length > KNIFE_POOL_MAX) return fail(`at most ${KNIFE_POOL_MAX} knives`);
  const swap = KNIFE_POOL_SWAPS.find((x) => x === r.swap);
  const order = KNIFE_POOL_ORDERS.find((x) => x === r.order);
  if (strict && (r.swap !== undefined && !swap)) return fail("swap: expected map or restart");
  if (strict && (r.order !== undefined && !order)) return fail("order: expected order or random");
  const items: KnifePool["items"] = [];
  const seen = new Set<string>();
  for (const it of r.items) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const k = typeof o.knife === "string" ? cosmetic(o.knife) : null;
    const f = typeof o.finish === "string" ? cosmetic(o.finish) : null;
    if (!k || k.slot !== "knife" || !f || f.slot !== "finish") {
      if (strict) return fail("unknown knife or finish");
      continue;
    }
    if (!owns(k) || !owns(f)) {
      if (strict) return fail(`locked (${unlockHint(!owns(k) ? k : f)})`);
      continue;
    }
    const key = `${k.id}|${f.id}`;
    if (seen.has(key)) {
      if (strict) return fail("the same knife and finish twice");
      continue;
    }
    seen.add(key);
    items.push({ knife: k.id, finish: f.id });
    if (items.length === KNIFE_POOL_MAX) break;
  }
  if (!items.length && !strict) return null;
  return { items, swap: swap ?? "map", order: order ?? "order" };
}

/** Hats that are hair (player/bunny/wigs.ts): the player picks their colour (CosmeticChoice.hairColor). */
export const HAIR_HATS: readonly string[] = ["hat-space-buns", "hat-ponytail", "hat-spiky", "hat-long"];
/**
 * Hats whose length the player sets (CosmeticChoice.hairLength): the Ponytail's tail, Spiky Hair's spikes, Long Hair's
 * fringe and back (each style maps the percent onto its own range: player/hair-fx.ts lengthFactor).
 */
export const LENGTH_HATS: readonly string[] = ["hat-ponytail", "hat-spiky", "hat-long"];
/** The hat with two ways to wear it (CosmeticChoice.maskOn). */
export const MASK_HAT = "hat-kitsune-mask";
/**
 * The ponytail's length, a whole percent of the built length (player/bunny/wigs.ts; the shader stretches it, hat-fx.ts):
 * from a short tuft to the small of the back (v0.0.30: up from 200, the middle of the back; tyzi: "Much longer"). 100 =
 * as built. Older builds read a length past their own top as the built length.
 */
export const HAIR_LENGTH = { min: 40, max: 300, default: 100 } as const;
const hairHexOf = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
/**
 * A highlight colour on its grid: 16 steps a channel ("#ffaa33": the colours CSS writes as #fa3), 4,096 colours, so it
 * rides in two characters of the replay trailer (loadout.ts). Any "#rrggbb" snaps to the nearest; else null.
 */
export function highlightHexOf(v: unknown): string | null {
  const hex = hairHexOf(v);
  if (!hex) return null;
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) / 17).toString(16).repeat(2)).join("")}`;
}
/** A saved / carried hair length (a whole percent in range), else null. */
export const hairLengthOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= HAIR_LENGTH.min && v <= HAIR_LENGTH.max ? v : null;
/** The back item whose length and colours its owner sets (player/bunny/backs.ts cape). */
export const CAPE_ITEM = "back-cape";
/**
 * The cape's length, a whole percent of the short cape's (hip length, as built at 100): up to 260, a hem at the ankles.
 * Steps of 5 (the slider's; each length is its own geometry).
 */
export const CAPE_LENGTH = { min: 100, max: 260, default: 100, step: 5 } as const;
/** A saved / carried cape length (a percent in range, on the slider's steps), else null. */
export const capeLengthOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= CAPE_LENGTH.min && v <= CAPE_LENGTH.max && v % CAPE_LENGTH.step === 0 ? v : null;
/**
 * A cape colour: "#rrggbb" snapped to the grid the replay trailer carries (6 bits a channel, loadout.ts packCape: at
 * most 2 / 255 from the colour picked), else null. Everything saved and shown goes through this, so what you pick is
 * what a replay shows.
 */
export function capeHexOf(v: unknown): string | null {
  const n = typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v) ? parseInt(v.replace("#", ""), 16) : null;
  if (n === null) return null;
  const q = (c: number) => Math.round((Math.round((c / 255) * 63) * 255) / 63);
  return `#${((q(n >> 16) << 16) | (q((n >> 8) & 255) << 8) | q(n & 255)).toString(16).padStart(6, "0")}`;
}
const ownsCape = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) => {
  const c = cosmetic(CAPE_ITEM);
  return !!c && isUnlocked(c, level, achievements, ranks, staff);
};
/**
 * The Daily Medal (player/bunny/backs.ts medal): a medal on a ribbon round the neck, in a metal its wearer holds, its
 * face in the look of how many of that medal they have (the name badge's six steps). What is drawn is one number, the
 * medal code: metal * MEDAL_STEPS.length + step, 0 .. MEDAL_CODES - 1 (gold first). The count itself is never carried:
 * the code is worked out wherever a loadout is made from a saved choice (loadout.ts loadoutFor), from the player's medal
 * counts, so a pick the player doesn't hold reads as their best medal.
 */
export const MEDAL_ITEM = "back-medal";
export const MEDAL_METALS = ["gold", "silver", "bronze"] as const;
export type MedalMetal = (typeof MEDAL_METALS)[number];
/** The counts a medal's face changes at (creators.ts DAILY_STEPS, the name badge's: the test keeps them the same). */
export const MEDAL_STEPS = [1, 5, 10, 25, 50, 100] as const;
export const MEDAL_CODES = MEDAL_METALS.length * MEDAL_STEPS.length;
/** What a loadout without a code draws (a writer that didn't know them): bronze at its first step, never more than was earned. */
export const MEDAL_DEFAULT = MEDAL_METALS.indexOf("bronze") * MEDAL_STEPS.length;
/** How many of each medal a player holds (apps/api daily_medals; creators.ts medalCountsOf reads them off the marks). */
export type MedalCounts = Readonly<Record<MedalMetal, number>>;
export const medalMetalOf = (v: unknown): MedalMetal | null => (MEDAL_METALS as readonly unknown[]).includes(v) ? (v as MedalMetal) : null;
/** A carried medal code (a whole number 0 .. MEDAL_CODES - 1), else null. */
export const medalCodeOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < MEDAL_CODES ? v : null);
/** The metals a player holds, best first. */
export const heldMetals = (m: MedalCounts | null | undefined): MedalMetal[] => MEDAL_METALS.filter((k) => (m?.[k] ?? 0) > 0);
/**
 * The medal a player wears: the metal they picked if they hold it, else their best, in the step of its count. A player
 * who holds none (staff trying it on) gets the pick, or bronze, at the first step.
 */
export function medalCode(pick: unknown, m: MedalCounts | null | undefined): number {
  const held = heldMetals(m), want = medalMetalOf(pick);
  const metal = held.length ? (want && held.includes(want) ? want : held[0]) : (want ?? "bronze");
  const n = m?.[metal] ?? 0;
  const step = MEDAL_STEPS.reduce((s, at, i) => (n >= at ? i : s), 0);
  return MEDAL_METALS.indexOf(metal) * MEDAL_STEPS.length + step;
}
export const medalOf = (code: number): { metal: MedalMetal; step: number } => ({ metal: MEDAL_METALS[Math.floor(code / MEDAL_STEPS.length)] ?? "bronze", step: code % MEDAL_STEPS.length });
const ownsMedal = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) => {
  const c = cosmetic(MEDAL_ITEM);
  return !!c && isUnlocked(c, level, achievements, ranks, staff);
};

/** The back item worn open or tied, in a pattern and two colours its owner picks (player/bunny/robe.ts). */
export const ROBE_ITEM = "back-robe";
/** How many patterns the Robe has, Plain (0) included (player/robe-fx.ts ROBE_PATTERNS names them). */
export const ROBE_PATTERN_COUNT = 5;
/** A saved / carried robe pattern other than Plain (1 .. ROBE_PATTERN_COUNT - 1), else null. */
export const robePatternOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v < ROBE_PATTERN_COUNT ? v : null);
const ownsRobe = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) => {
  const c = cosmetic(ROBE_ITEM);
  return !!c && isUnlocked(c, level, achievements, ranks, staff);
};
/**
 * The charm's options (v0.0.43; viewmodel/charms/): the cord's length and the charm's size as percents of the built
 * ones, and how lively it swings (0 = barely, 100 = a lot; the default is calm). Steps of 10, so the three ride in 11
 * bits of the replay's loadout continuation (loadout.ts packLoadoutExt).
 */
export const CHARM_LENGTH = { min: 50, max: 200, default: 100, step: 10 } as const;
export const CHARM_SIZE = { min: 80, max: 140, default: 100, step: 10 } as const;
export const CHARM_SWING = { min: 0, max: 100, default: 30, step: 10 } as const;
type Range = { min: number; max: number; step: number };
const onSteps = (r: Range, v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max && (v - r.min) % r.step === 0 ? v : null);
/** A saved / carried charm option (on its slider's steps, in range), else null. */
export const charmLengthOf = (v: unknown) => onSteps(CHARM_LENGTH, v);
export const charmSizeOf = (v: unknown) => onSteps(CHARM_SIZE, v);
export const charmSwingOf = (v: unknown) => onSteps(CHARM_SWING, v);
const CHARM_OPTIONS = { charmLength: [CHARM_LENGTH, charmLengthOf], charmSize: [CHARM_SIZE, charmSizeOf], charmSwing: [CHARM_SWING, charmSwingOf] } as const;
const ownsCharm = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) =>
  COSMETICS.some((c) => c.slot === "charm" && isUnlocked(c, level, achievements, ranks, staff));
const ownsHair = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) =>
  HAIR_HATS.some((id) => {
    const c = cosmetic(id);
    return !!c && isUnlocked(c, level, achievements, ranks, staff);
  });
const ownsMask = (level: number, achievements: readonly string[], ranks: HeldRanks, staff: Holder) => {
  const c = cosmetic(MASK_HAT);
  return !!c && isUnlocked(c, level, achievements, ranks, staff);
};

/**
 * Validates a choice. strict (on save): returns the first bad slot. lenient (on read): falls back to defaults for
 * anything unknown or no longer unlocked (hatchdle's cardProblem / cleanCard split).
 */
export function cleanCosmetics(raw: unknown, level: number, achievements: readonly string[], ranks: HeldRanks = {}, staff: Holder = null): CosmeticChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: CosmeticChoice = { ...DEFAULT_COSMETICS };
  for (const slot of Object.keys(DEFAULT_COSMETICS) as CosmeticSlot[]) {
    const c = cosmetic(typeof r[slot] === "string" ? (r[slot] as string) : null);
    if (c && c.slot === slot && isUnlocked(c, level, achievements, ranks, staff)) out[slot] = c.id;
  }
  const hair = hairHexOf(r.hairColor);
  if (hair && ownsHair(level, achievements, ranks, staff)) out.hairColor = hair;
  const length = hairLengthOf(r.hairLength);
  if (length !== null && length !== HAIR_LENGTH.default && ownsHair(level, achievements, ranks, staff)) out.hairLength = length;
  const highlight = highlightHexOf(r.hairHighlight);
  if (highlight && ownsHair(level, achievements, ranks, staff)) out.hairHighlight = highlight;
  if (r.maskOn === true && ownsMask(level, achievements, ranks, staff)) out.maskOn = true;
  if (ownsCape(level, achievements, ranks, staff)) {
    const capeLength = capeLengthOf(r.capeLength), capeColor = capeHexOf(r.capeColor), capeLining = capeHexOf(r.capeLining);
    if (capeLength !== null && capeLength !== CAPE_LENGTH.default) out.capeLength = capeLength;
    if (capeColor) out.capeColor = capeColor;
    if (capeLining) out.capeLining = capeLining;
  }
  if (ownsRobe(level, achievements, ranks, staff)) {
    const robePattern = robePatternOf(r.robePattern), robeColor = capeHexOf(r.robeColor), robePrint = capeHexOf(r.robePrint);
    if (robePattern !== null) out.robePattern = robePattern;
    if (r.robeTied === true) out.robeTied = true;
    if (robeColor) out.robeColor = robeColor;
    if (robePrint) out.robePrint = robePrint;
  }
  const metal = medalMetalOf(r.medalMetal);
  if (metal && ownsMedal(level, achievements, ranks, staff)) out.medalMetal = metal;
  if (ownsCharm(level, achievements, ranks, staff)) {
    for (const [k, [range, of]] of Object.entries(CHARM_OPTIONS)) {
      const v = of(r[k]);
      if (v !== null && v !== range.default) out[k as keyof typeof CHARM_OPTIONS] = v;
    }
    if (r.charmPommel === true) out.charmPommel = true;
  }
  const pool = knifePoolOf(r.knifePool, (c) => isUnlocked(c, level, achievements, ranks, staff));
  if (pool) out.knifePool = pool;
  // Kept while not #1 (it only shows on the Number One title), so it's back when the place is.
  const rankColor = rankColorOf(r.rankColor);
  if (rankColor) out.rankColor = rankColor;
  return out;
}

export function cosmeticsProblem(raw: unknown, level: number, achievements: readonly string[], ranks: HeldRanks = {}, staff: Holder = null): { slot: string; reason: string } | null {
  if (!raw || typeof raw !== "object") return { slot: "*", reason: "expected an object" };
  for (const [slot, v] of Object.entries(raw as Record<string, unknown>)) {
    if (slot === "hairColor") {
      if (v === null) continue;
      if (!hairHexOf(v)) return { slot, reason: "expected a colour like #5a3426" };
      if (!ownsHair(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(HAIR_HATS[0])!)})` };
      continue;
    }
    if (slot === "hairLength") {
      if (v === null) continue;
      if (hairLengthOf(v) === null) return { slot, reason: `expected a whole number from ${HAIR_LENGTH.min} to ${HAIR_LENGTH.max}` };
      if (!ownsHair(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(HAIR_HATS[0])!)})` };
      continue;
    }
    if (slot === "hairHighlight") {
      if (v === null) continue;
      if (!highlightHexOf(v)) return { slot, reason: "expected a colour like #ffaa33" };
      if (!ownsHair(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(HAIR_HATS[0])!)})` };
      continue;
    }
    if (slot === "maskOn") {
      if (v === null || v === false) continue;
      if (v !== true) return { slot, reason: "expected true or false" };
      if (!ownsMask(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(MASK_HAT)!)})` };
      continue;
    }
    if (slot === "capeLength" || slot === "capeColor" || slot === "capeLining") {
      if (v === null) continue;
      if (slot === "capeLength" && capeLengthOf(v) === null) return { slot, reason: `expected a multiple of ${CAPE_LENGTH.step} from ${CAPE_LENGTH.min} to ${CAPE_LENGTH.max}` };
      if (slot !== "capeLength" && (typeof v !== "string" || !capeHexOf(v))) return { slot, reason: "expected a colour like #c8202c" };
      if (!ownsCape(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(CAPE_ITEM)!)})` };
      continue;
    }
    if (slot === "robePattern" || slot === "robeTied" || slot === "robeColor" || slot === "robePrint") {
      if (v === null) continue;
      // (Plain and open are the defaults: 0 and false say so and are saved as nothing.)
      if (slot === "robePattern" && v !== 0 && robePatternOf(v) === null) return { slot, reason: `expected a whole number from 0 to ${ROBE_PATTERN_COUNT - 1}` };
      if (slot === "robeTied" && typeof v !== "boolean") return { slot, reason: "expected true or false" };
      if ((slot === "robeColor" || slot === "robePrint") && (typeof v !== "string" || !capeHexOf(v))) return { slot, reason: "expected a colour like #2b303b" };
      if (!ownsRobe(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(ROBE_ITEM)!)})` };
      continue;
    }
    if (slot === "medalMetal") {
      if (v === null) continue;
      // (Whether the player holds that metal is checked where the loadout is made: a pick they don't hold shows their best.)
      if (!medalMetalOf(v)) return { slot, reason: `expected one of ${MEDAL_METALS.join(", ")}` };
      if (!ownsMedal(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(cosmetic(MEDAL_ITEM)!)})` };
      continue;
    }
    if (slot in CHARM_OPTIONS || slot === "charmPommel") {
      if (v === null) continue;
      if (slot === "charmPommel" && typeof v !== "boolean") return { slot, reason: "expected true or false" };
      if (slot !== "charmPommel") {
        const [range, of] = CHARM_OPTIONS[slot as keyof typeof CHARM_OPTIONS];
        if (of(v) === null) return { slot, reason: `expected a multiple of ${range.step} from ${range.min} to ${range.max}` };
      }
      if (!ownsCharm(level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(COSMETICS.find((c) => c.slot === "charm")!)})` };
      continue;
    }
    if (slot === "rankColor") {
      if (v === null) continue;
      if (!rankColorOf(v)) return { slot, reason: "expected a colour like #ffd45e" };
      if (ranks.all !== 1) return { slot, reason: "locked (hold overall #1)" };
      continue;
    }
    if (slot === "knifePool") {
      const pool = knifePoolOf(v, (c) => isUnlocked(c, level, achievements, ranks, staff), true);
      if (typeof pool === "string") return { slot, reason: pool };
      continue;
    }
    if (!(slot in DEFAULT_COSMETICS)) return { slot, reason: "unknown slot" };
    if (v === null && (slot === "title" || slot === "hat" || slot === "camo" || slot === "back" || slot === "hop" || slot === "charm")) continue;
    const c = typeof v === "string" ? cosmetic(v) : null;
    // A staff item its sender doesn't hold reads exactly like an id that doesn't exist (staffItem).
    if (!c || c.slot !== slot || !listedFor(c, staff)) return { slot, reason: "unknown item" };
    if (!isUnlocked(c, level, achievements, ranks, staff)) return { slot, reason: `locked (${unlockHint(c)})` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Next map suggestion (newcomers walk T1 → T2 → ...)

export interface SuggestMap {
  name: string;
  tier: number | null;
  /** Players on its main Normal board (popularity tiebreak; 0 when unknown). */
  players?: number;
}

export interface Suggestion {
  map: string;
  tier: number;
  reason: string;
}

/** How many clears of a tier "graduate" you to the next one (or all of them, when the tier has fewer maps). */
export const GRADUATE_CLEARS = 3;

/**
 * Picks up to `n` uncleared maps at the player's working tier: the lowest tier they haven't graduated from (fewer
 * than GRADUATE_CLEARS clears there, or every map of it if it has fewer). Ties: most played first, then name.
 * Unrated maps are never suggested.
 */
export function suggestNextMaps(maps: SuggestMap[], cleared: ReadonlySet<string>, n = 3): Suggestion[] {
  const byTier = new Map<number, SuggestMap[]>();
  for (const m of maps) {
    const t = clampTier(m.tier);
    if (!t) continue;
    byTier.set(t, [...(byTier.get(t) ?? []), m]);
  }
  const out: Suggestion[] = [];
  for (let t = 1; t <= MAX_TIER && out.length < n; t++) {
    const pool = byTier.get(t) ?? [];
    if (!pool.length) continue;
    const done = pool.filter((m) => cleared.has(m.name)).length;
    const graduated = done >= Math.min(GRADUATE_CLEARS, pool.length);
    const open = pool.filter((m) => !cleared.has(m.name)).sort((a, b) => (b.players ?? 0) - (a.players ?? 0) || a.name.localeCompare(b.name));
    // Working tier: fill from it; once graduated, still offer leftovers but only after the next tier's picks.
    if (graduated) continue;
    for (const m of open) {
      if (out.length >= n) break;
      out.push({ map: m.name, tier: t, reason: done === 0 ? (t === 1 ? "Start here" : `Your first ${tierLabel(t)}`) : `${done}/${Math.min(GRADUATE_CLEARS, pool.length)} ${tierLabel(t)} clears to move up` });
    }
  }
  if (out.length < n) {
    // Graduated everywhere it matters: suggest the easiest maps left anywhere.
    const left = maps
      .filter((m) => clampTier(m.tier) && !cleared.has(m.name) && !out.some((o) => o.map === m.name))
      .sort((a, b) => clampTier(a.tier)! - clampTier(b.tier)! || (b.players ?? 0) - (a.players ?? 0) || a.name.localeCompare(b.name));
    for (const m of left.slice(0, n - out.length)) out.push({ map: m.name, tier: clampTier(m.tier)!, reason: `Uncleared ${tierLabel(m.tier)}` });
  }
  return out;
}
