// How a cosmetic is unlocked, as one short line: the goal while it's locked (shortGoal, used by ui/unlocks.ts lockInfo)
// and how it was earned once it's owned (earnedHint: the Loadout's caption, the card editor). DOM-free.

import {
  achievement,
  DISCORD_BOOSTER,
  DISCORD_LINK,
  DISCORD_MEMBER,
  EARLY_HOPPER,
  isUnlocked,
  SUPPORTER,
  PLAY_WITH_OWNER,
  rankHint,
  roleHint,
  staffGrant,
  type AchievementDef,
  type CosmeticDef,
  type HeldRanks,
  type StaffRole,
  type Unlock,
} from "../progression";

import { styleLabel } from "../styles";

/** The goal in a few words ("Clear every ranked T3 map"), for one-line unlock hints; the full text is the desc. */
export function shortGoal(a: AchievementDef): string {
  if (a.goal) return a.goal;
  const [kind, arg] = [a.id.slice(0, a.id.indexOf("_")), a.id.slice(a.id.indexOf("_") + 1)];
  const n = Number(arg.replace(/k$/, "000").replace(/h$/, ""));
  switch (kind) {
    case "tier":
      return `Clear a T${arg} map`;
    case "sweep":
      return `Clear every ranked T${arg} map`;
    case "maps":
      return `Clear ${n} maps`;
    case "pbs":
      return `Hold ${n} PBs`;
    case "top10":
      return n === 1 ? "Get a top-10 place" : `Hold ${n} top-10s at once`;
    case "wr":
      return n === 1 ? "Set a world record" : `Hold ${n} WRs at once`;
    case "bonus":
      return n === 1 ? "Clear a bonus track" : `Clear ${n} bonus tracks`;
    case "level":
      return `Reach level ${n}`;
    case "jumps":
      return `${n.toLocaleString("en-US")} jumps in runs`;
    case "clock":
      return `${n}h on the clock`;
    case "scroll":
      return `Clear ${n} maps in EZ Scroll`;
    case "style":
      return arg === "all" ? "Clear a map in every style" : arg === "t4" ? "Clear a T4+ map off Normal" : `Clear a map in ${styleLabel(arg)}`;
    case "sync":
      return "90% sync on a T2+ map";
    default:
      return a.desc.replace(/^Finish /, "");
  }
}

/** Achievements whose earned line isn't their goal in the past tense. */
const EARNED: Record<string, string> = {
  first_finish: "Finished a run",
  [PLAY_WITH_OWNER]: "Played with Huddled",
  [DISCORD_LINK]: "Linked Discord",
  [DISCORD_MEMBER]: "Joined the Discord server",
  [DISCORD_BOOSTER]: "Boosted the Discord server",
  [EARLY_HOPPER]: "Played before v0.0.8",
  [SUPPORTER]: "Supported bunnyhop.lol",
};
const PAST: Record<string, string> = { Clear: "Cleared", Hold: "Held", Get: "Got", Reach: "Reached", Link: "Linked", Join: "Joined", Boost: "Boosted", Finish: "Finished", Win: "Won" };

/** The goal as done: "Cleared a T3 map", "Held 5 WRs at once", "Set a world record". */
export function pastGoal(a: AchievementDef): string {
  return EARNED[a.id] ?? shortGoal(a).replace(/^(\w+)/, (w) => PAST[w] ?? w);
}

/** What an earned line knows about the player (a profile's level, achievements with when / where, ranks, role). */
export interface EarnedFrom {
  level: number;
  achievements: readonly { id: string; unlockedAt?: string; map?: string }[];
  ranks?: HeldRanks;
  role?: StaffRole | null;
}

/** "Oct 5" (this year), "Oct 5, 2025" (another). */
export function earnedDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/**
 * How an owned cosmetic was earned, in one line: "Cleared a T3 map · Oct 5 on bhop_eazy", "Reached level 12", "Free",
 * "While holding overall #1", "Unlocked as staff". The date and map come from the achievement's record (the run that
 * earned it); level unlocks have neither. Early Hopper has no date (everyone's is the day v0.0.8 granted it).
 * `when` = false: the line alone (small picker items).
 */
export function earnedHint(c: CosmeticDef, p: EarnedFrom, o: { when?: boolean; now?: Date } = {}): string {
  const ids = p.achievements.map((a) => a.id);
  // The route actually met (an item's legacy routes count too), without the staff grant: what the player did.
  const met = [c.unlock, ...(c.legacy ?? [])].find((u) => isUnlocked({ ...c, unlock: u, legacy: undefined }, p.level, ids, p.ranks ?? {}, p.role ?? null, false));
  if (!met) return staffGrant(c, p.role) ? (p.role === "owner" ? "Unlocked as owner" : "Unlocked as staff") : "";
  return earnedText(met, p, o);
}

function earnedText(u: Unlock, p: EarnedFrom, o: { when?: boolean; now?: Date }): string {
  switch (u.kind) {
    case "free":
      return "Free";
    case "level":
      return `Reached level ${u.level}`;
    case "rank":
      return rankHint(u).replace(/^Hold /, "While holding ");
    case "role":
      return roleHint(u.role);
    case "achievement": {
      const a = achievement(u.id);
      if (!a) return "";
      const how = pastGoal(a);
      const rec = p.achievements.find((x) => x.id === u.id);
      if (o.when === false || !rec?.unlockedAt || u.id === EARLY_HOPPER) return how;
      const date = earnedDate(rec.unlockedAt, o.now);
      if (!date) return how;
      // (A time goal already names its map.)
      return `${how} · ${date}${rec.map && !how.includes(rec.map) ? ` on ${rec.map}` : ""}`;
    }
  }
}
