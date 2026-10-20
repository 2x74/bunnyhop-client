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

import { clampTier, MAX_TIER, type Tier } from "./tiers";
import { earnsProgression, isStyleId, STYLE_DEFS } from "./styles";

// ---------------------------------------------------------------------------------------------
// XP

export type XpKind = "finish" | "time" | "jumps" | "pb" | "first_clear" | "first_tier";

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
} as const;

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
    if (p.ticks < best && best !== Infinity && Math.floor(p.at / DAY_MS) === day) pbsToday++;
    best = Math.min(best, p.ticks);
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
    improvedPB: same.length > 0 && run.ticks < best,
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
  /** Best sync % on a main-track finish of tier >= 2. */
  bestSync: number;
}

export type AchievementGroup = "start" | "tier" | "sweep" | "maps" | "records" | "style" | "time" | "lifetime" | "level" | "social";
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
  /** Progress towards it: [current, goal]. */
  progress: (s: ProgressStats) => [number, number];
}

const at = (n: number, goal: number): [number, number] => [Math.min(n, goal), goal];
const TIER_TITLE: Record<Tier, string | undefined> = { 1: undefined, 2: undefined, 3: "Climber", 4: "Daredevil", 5: "Untouchable", 6: "Ascended" };
const RING_BY_TIER: Record<Tier, Ring> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 3 };

/** Time goals ("Sub-X on bhop_eazy"). Thresholds need tuning against real WRs (see research/RANKS.md open questions). */
export const TIME_GOALS: { map: string; seconds: number; name: string; ring: Ring; title?: string }[] = [
  { map: "bhop_eazy", seconds: 60, name: "Eazy Does It", ring: 0 },
  { map: "bhop_eazy", seconds: 30, name: "Eazy Money", ring: 2, title: "Eazy" },
];

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

const fmtGoal = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`);

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "country_flag", name: "Flying the Flag", desc: "Set a country flag on your profile", goal: "Set a profile flag", group: "social", icon: "flag", ring: 0, event: true, progress: () => [0, 1] },
  { id: "first_finish", name: "First Hop", desc: "Finish a run on any map", group: "start", icon: "flag", ring: 0, title: "Hopper", progress: (s) => at(s.runs, 1) },
  ...([1, 2, 3, 4, 5, 6] as Tier[]).map(
    (t): AchievementDef => ({
      id: `tier_${t}`,
      name: `First T${t}`,
      desc: `Finish the main track of a tier ${t} map`,
      group: "tier",
      icon: `t${t}`,
      ring: RING_BY_TIER[t],
      title: TIER_TITLE[t],
      progress: (s) => at(s.clearsByTier[t] ? 1 : 0, 1),
    }),
  ),
  ...([1, 2, 3, 4, 5, 6] as Tier[]).map(
    (t): AchievementDef => ({
      id: `sweep_${t}`,
      name: `T${t} Sweep`,
      desc: `Finish every ranked tier ${t} map`,
      group: "sweep",
      icon: `t${t}`,
      ring: Math.min(3, RING_BY_TIER[t] + 1) as Ring,
      title: t >= 4 ? `T${t} Sweeper` : undefined,
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
  ...TIME_GOALS.map(
    (g): AchievementDef => ({
      id: `time_${g.map}_${g.seconds}`,
      name: g.name,
      desc: `Finish ${g.map} under ${fmtGoal(g.seconds)} (Normal)`,
      group: "time",
      icon: "clock",
      ring: g.ring,
      title: g.title,
      progress: (s) => at(s.bestNormal[g.map] !== undefined && s.bestNormal[g.map] < g.seconds ? 1 : 0, 1),
    }),
  ),
  { id: "sync_90", name: "In Sync", desc: "Finish a T2+ map with 90% sync or better", group: "time", icon: "sync", ring: 1, progress: (s) => at(s.bestSync >= 90 ? 1 : 0, 1) },
  { id: "jumps_1k", name: "Bunny", desc: "1,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 0, progress: (s) => at(s.jumps, 1_000) },
  { id: "jumps_10k", name: "Jackrabbit", desc: "10,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 1, progress: (s) => at(s.jumps, 10_000) },
  { id: "jumps_100k", name: "Hare Raiser", desc: "100,000 jumps in finished runs", group: "lifetime", icon: "jump", ring: 3, title: "Hare Raiser", progress: (s) => at(s.jumps, 100_000) },
  { id: "clock_1h", name: "Clocked In", desc: "Play for one hour", group: "lifetime", icon: "clock", ring: 0, progress: (s) => at(Math.floor(s.playtime), 3600) },
  { id: "clock_10h", name: "Overtime", desc: "Play for ten hours", group: "lifetime", icon: "clock", ring: 2, title: "Workhorse", progress: (s) => at(Math.floor(s.playtime), 36_000) },
  { id: "level_10", name: "Level 10", desc: "Reach level 10", group: "level", icon: "level", ring: 0, progress: (s) => at(s.level, 10) },
  { id: "level_25", name: "Level 25", desc: "Reach level 25", group: "level", icon: "level", ring: 2, title: "Veteran", progress: (s) => at(s.level, 25) },
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
    desc: "Supported bunnyhop.lol with a donation. Every supporter set is yours to keep",
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

/** What a locked secret item says about how to get it: "???", plus WINGS_HINT when there is one. */
export const secretLockText = (): string => (WINGS_HINT ? `??? · ${WINGS_HINT}` : "???");

for (const [i, goal] of [1,5,25,100].entries()) ACHIEVEMENTS.push({ id:`gift_${goal}`, name:["Bronze Gifter","Silver Gifter","Gold Gifter","Prism Gifter"][i], desc:`Deliver ${goal} Supporter gift${goal === 1 ? "" : "s"}`, group:"social", icon:"gift", ring:i as Ring, progress:s => [s.giftsSent ?? 0, goal] });

const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
export const achievement = (id: string) => ACH_BY_ID.get(id) ?? null;

/** Ids of every achievement the stats satisfy. */
export function earnedAchievements(s: ProgressStats): string[] {
  return ACHIEVEMENTS.filter((a) => {
    const [n, goal] = a.progress(s);
    return goal > 0 && n >= goal;
  }).map((a) => a.id);
}

// ---------------------------------------------------------------------------------------------
// Cosmetics (all unlocked by playing; card editor + ghost settings)

export type CosmeticSlot = "background" | "frame" | "title" | "ghost" | "trail" | "outfit" | "knife" | "finish" | "glove" | "hat" | "body";

/** The first-person loadout slots (apps/web/src/loadout.ts): what you hold, what it's painted with, your gloves. */
export const LOADOUT_SLOTS = ["knife", "finish", "glove"] as const satisfies readonly CosmeticSlot[];

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
   * Role-held: yours while you hold the role ("owner" = the API's OWNER_ID account; "staff" = room admins, D1
   * room_admins or ROOM_ADMINS, and the owner). Checked server-side on save and on every read like rank-held items, so
   * a removed admin reads back as the default. Never shown as a locked goal to players who can't hold it.
   */
  | { kind: "role"; role: "owner" | "staff" };

/**
 * A player's staff role as the server sees it (null = none): "owner" (OWNER_ID), "admin" (a room admin) or "moderator"
 * (migrations/0018). The room roster, chat lines, profiles and /me/cosmetics carry it; clients never decide it. What each
 * role may do: moderation/staff.ts.
 */
export type StaffRole = "owner" | "admin" | "moderator";

/**
 * Whether `role` satisfies a role-held unlock (the owner is staff too). Moderators hold neither: they get the Mod tag but
 * no cosmetic perks (no staffGrant, no Staff title), so modding is never a shortcut to unlocks.
 */
export function holdsRole(need: "owner" | "staff", role: StaffRole | null | undefined): boolean {
  return need === "owner" ? role === "owner" : role === "owner" || role === "admin";
}

/** "Owner only", "Staff only". */
export const roleHint = (need: "owner" | "staff"): string => (need === "owner" ? "Owner only" : "Staff only");

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
  /** Loadout items (knife / finish / glove). */
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
}

const free: Unlock = { kind: "free" };
const lvl = (level: number): Unlock => ({ kind: "level", level });
const ach = (id: string): Unlock => ({ kind: "achievement", id });
const held = (max: number, scope: "all" | "style" = "all"): Unlock => ({ kind: "rank", max, scope });
const role = (r: "owner" | "staff"): Unlock => ({ kind: "role", role: r });

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
  // (owner call, v0.0.5; the Supporter set's two bayonets are the exception): you just pick the one you like in the
  // Loadout screen; finishes, gloves and rank-held items are what you unlock. The rarity is the knife's tier of flair
  // (its colour in the UI), not how hard it is to get.
  { id: "knife-carrot", slot: "knife", name: "Carrot Blade", unlock: free, color: "#ff7a1a", rarity: 1 },
  { id: "knife-bayonet", slot: "knife", name: "Carrot Bayonet", unlock: free, color: "#ff8a2a", rarity: 2 },
  { id: "knife-parsnip", slot: "knife", name: "Parsnip Stiletto", unlock: free, color: "#efe2b8", rarity: 2 },
  { id: "knife-karrotbit", slot: "knife", name: "Karrotbit", unlock: free, color: "#ff7a1a", rarity: 3 },
  { id: "knife-radish", slot: "knife", name: "Radish Kukri", unlock: free, color: "#ff5c8a", rarity: 3 },
  { id: "knife-leek", slot: "knife", name: "Leek Saber", unlock: free, color: "#8fdc6a", rarity: 3 },
  { id: "knife-cleaver", slot: "knife", name: "Clover Cleaver", unlock: free, color: "#5ee08a", rarity: 3 },
  { id: "knife-bunnyfly", slot: "knife", name: "Bunnyfly", unlock: free, color: "#ff9a3c", rarity: 4 },
  { id: "knife-daikon", slot: "knife", name: "Daikon-tana", unlock: free, color: "#f3f1ea", rarity: 4 },
  { id: "knife-sprouts", slot: "knife", name: "Twin Sprouts", unlock: free, color: "#ffb04a", rarity: 4 },
  { id: "knife-candycane", slot: "knife", name: "Candy Cane Shiv", unlock: free, color: "#e8333f", rarity: 5 },
  { id: "knife-golden", slot: "knife", name: "Golden Carrot", unlock: free, color: "#ffd45e", rarity: 5 },
  // Supporter (SUPPORTER): the two bayonets, the only knives that aren't free (viewmodel/knives/thornback.ts, thistle.ts).
  // A big sawback clip point with a muzzle ring; a slim spinner with a thistle-head pommel.
  { id: "knife-thornback", slot: "knife", name: "Thornback", unlock: ach(SUPPORTER), color: "#2b6870", rarity: 4 },
  { id: "knife-thistle", slot: "knife", name: "Thistle", unlock: ach(SUPPORTER), color: "#b46ad8", rarity: 4 },
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
];

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
  // A band of dark amethyst glass round the hood, a light sweeping the aqua line across its forehead plate.
  { id: "hat-circlet", slot: "hat", name: "Circlet", unlock: ach(SUPPORTER), color: "#342a78", rarity: 4 },
  // High Roller: a dealer's green eyeshade on a black band with gold piping; four gold coins flipping round the head.
  { id: "hat-dealer-visor", slot: "hat", name: "Dealer's Visor", unlock: ach(SUPPORTER), color: "#1e9a5a", rarity: 4 },
  { id: "hat-lucky-coins", slot: "hat", name: "Lucky Coins", unlock: ach(SUPPORTER), color: "#ffcf4a", rarity: 4 },
  // Borealis: a ribbon of aurora light floating above the ears, its colours flowing round it.
  { id: "hat-aurora", slot: "hat", name: "Aurora", unlock: ach(SUPPORTER), color: "#3ff0a0", rarity: 4 },
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

/**
 * The Supporter sets (every supporter owns all of them): a theme each, for the Loadout's grouping and the Support
 * page's switcher. `look`: what the Support page first puts on the preview for the set.
 */
export type SupporterSetId = "geode" | "highroller" | "borealis";
export const SUPPORTER_SETS: readonly { id: SupporterSetId; name: string; items: readonly string[]; look: { finish: string; glove: string; outfit: string; hat: string; ghost: string; trail: string } }[] = [
  {
    id: "geode",
    name: "Geode",
    items: ["bg-geode", "frame-geode", "ghost-geode", "trail-geode", "outfit-geode", "fin-geode", "fin-rift", "fin-spectrum", "glove-specialist-geode", "hat-gem-orbit", "hat-halo", "hat-circlet"],
    look: { finish: "fin-geode", glove: "glove-specialist-geode", outfit: "outfit-geode", hat: "hat-gem-orbit", ghost: "ghost-geode", trail: "trail-geode" },
  },
  {
    id: "highroller",
    name: "High Roller",
    items: ["bg-highroller", "frame-highroller", "ghost-highroller", "trail-highroller", "outfit-highroller", "fin-goldleaf", "glove-driver-highroller", "hat-dealer-visor", "hat-lucky-coins", "title-high-roller"],
    look: { finish: "fin-goldleaf", glove: "glove-driver-highroller", outfit: "outfit-highroller", hat: "hat-lucky-coins", ghost: "ghost-highroller", trail: "trail-highroller" },
  },
  {
    id: "borealis",
    name: "Borealis",
    items: ["bg-borealis", "frame-borealis", "ghost-borealis", "trail-borealis", "outfit-borealis", "fin-aurora", "glove-sport-borealis", "hat-aurora", "title-stargazer"],
    look: { finish: "fin-aurora", glove: "glove-sport-borealis", outfit: "outfit-borealis", hat: "hat-aurora", ghost: "ghost-borealis", trail: "trail-borealis" },
  },
];
for (const set of SUPPORTER_SETS) for (const id of set.items) {
  const c = COSMETICS.find((x) => x.id === id);
  if (c) c.set = set.id;
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
  outfit: "outfit-cream",
  body: "body-a",
  knife: "knife-carrot",
  finish: "fin-garden",
  glove: "glove-knit",
  /** null = no hat (the owner's hats and the Supporter's three). */
  hat: null,
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
export function staffGrant(c: CosmeticDef, staff: StaffRole | null | undefined): boolean {
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
  staff: StaffRole | null = null,
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

/** Card + ghost cosmetics a player has chosen (ids), as stored and served by the API. */
export type CosmeticChoice = Record<CosmeticSlot, string | null>;

/**
 * Validates a choice. strict (on save): returns the first bad slot. lenient (on read): falls back to defaults for
 * anything unknown or no longer unlocked (hatchdle's cardProblem / cleanCard split).
 */
export function cleanCosmetics(raw: unknown, level: number, achievements: readonly string[], ranks: HeldRanks = {}, staff: StaffRole | null = null): CosmeticChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_COSMETICS };
  for (const slot of Object.keys(DEFAULT_COSMETICS) as CosmeticSlot[]) {
    const c = cosmetic(typeof r[slot] === "string" ? (r[slot] as string) : null);
    if (c && c.slot === slot && isUnlocked(c, level, achievements, ranks, staff)) out[slot] = c.id;
  }
  return out;
}

export function cosmeticsProblem(raw: unknown, level: number, achievements: readonly string[], ranks: HeldRanks = {}, staff: StaffRole | null = null): { slot: string; reason: string } | null {
  if (!raw || typeof raw !== "object") return { slot: "*", reason: "expected an object" };
  for (const [slot, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(slot in DEFAULT_COSMETICS)) return { slot, reason: "unknown slot" };
    if (v === null && (slot === "title" || slot === "hat")) continue;
    const c = typeof v === "string" ? cosmetic(v) : null;
    if (!c || c.slot !== slot) return { slot, reason: "unknown item" };
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
      out.push({ map: m.name, tier: t, reason: done === 0 ? (t === 1 ? "Start here" : `Your first T${t}`) : `${done}/${Math.min(GRADUATE_CLEARS, pool.length)} T${t} clears to move up` });
    }
  }
  if (out.length < n) {
    // Graduated everywhere it matters: suggest the easiest maps left anywhere.
    const left = maps
      .filter((m) => clampTier(m.tier) && !cleared.has(m.name) && !out.some((o) => o.map === m.name))
      .sort((a, b) => clampTier(a.tier)! - clampTier(b.tier)! || (b.players ?? 0) - (a.players ?? 0) || a.name.localeCompare(b.name));
    for (const m of left.slice(0, n - out.length)) out.push({ map: m.name, tier: clampTier(m.tier)!, reason: `Uncleared T${clampTier(m.tier)}` });
  }
  return out;
}
