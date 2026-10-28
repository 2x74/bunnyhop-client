// What a verified run earned, for the reward reel on the native finish card (hud_result.hpp). The host can't read the
// website's catalog, so the menu turns the submission's ids into finished lines, the way the website's own result card
// works them out (web ui/unlocks.ts runRewards).
import type { LevelView, Submission } from "../../web/src/api";
import {
  achievement,
  COSMETICS,
  levelInfo,
  RARITY,
  type AchievementDef,
  type CosmeticDef,
  type CosmeticSlot,
} from "../../web/src/progression";
import { knifeById } from "./knife-catalog";

export interface RunReward {
  title: string;
  detail: string;
}

/** The progression fields of a verified runService message (README "Native HUD host messages"). */
export interface RunProgression {
  xp?: number;
  level?: LevelView;
  achievements?: string[];
  rewards?: RunReward[];
}

/** The host keeps 12 reel lines and cuts titles at 95 bytes and details at 127. */
const MAX_REWARDS = 12;
const TITLE_BYTES = 95;
const DETAIL_BYTES = 127;

const SLOT_NAMES: Record<CosmeticSlot, string> = {
  background: "background",
  frame: "frame",
  title: "title",
  outfit: "colourway",
  ghost: "ghost",
  trail: "trail",
  knife: "knife",
  finish: "finish",
  glove: "gloves",
  hat: "hat",
  body: "player model",
};

const encoder = new TextEncoder();

/** Cut to `bytes` of UTF-8 on a character boundary, so the host's byte cut never splits a character. */
export function clipUtf8(text: string, bytes: number): string {
  if (encoder.encode(text).length <= bytes) return text;
  let kept = "";
  let used = 0;
  for (const character of text) {
    used += encoder.encode(character).length;
    if (used > bytes) break;
    kept += character;
  }
  return kept;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validLevel(value: unknown): value is LevelView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<LevelView>;
  return isCount(view.level) && view.level > 0 && isCount(view.xp);
}

function achievementIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** A knife the catalog hasn't built yet isn't listed anywhere, so it isn't announced either. */
function listed(item: CosmeticDef): boolean {
  return item.slot !== "knife" || !!knifeById(item.id);
}

function unlockedItems(achievements: AchievementDef[], levelBefore: number | null, levelNow: number | null) {
  const earned = new Set(achievements.map((entry) => entry.id));
  const byLevel = (item: CosmeticDef) =>
    item.unlock.kind === "level" &&
    levelBefore !== null &&
    levelNow !== null &&
    item.unlock.level > levelBefore &&
    item.unlock.level <= levelNow;
  const byAchievement = (item: CosmeticDef) => item.unlock.kind === "achievement" && earned.has(item.unlock.id);
  const items = COSMETICS.filter((item) => listed(item) && (byLevel(item) || byAchievement(item)));
  return items.sort((a, b) => (b.rarity ?? 0) - (a.rarity ?? 0));
}

function itemReward(item: CosmeticDef): RunReward {
  const slot = SLOT_NAMES[item.slot];
  const rarity = item.rarity ? RARITY[item.rarity].name : null;
  return { title: item.name, detail: rarity ? `${rarity} ${slot}` : `New ${slot}` };
}

/**
 * The reel lines for a verified submission: XP, a level-up, each achievement and each unlocked item (rarest first).
 * Ids this build's catalog doesn't know are left out rather than shown raw.
 */
export function runRewardLines(xp: number, level: LevelView | undefined, ids: string[]): RunReward[] {
  const achievements = ids.map(achievement).filter((entry): entry is AchievementDef => !!entry);
  const levelNow = level?.level ?? null;
  const levelBefore = level && xp > 0 ? levelInfo(level.xp - xp).level : levelNow;
  const lines: RunReward[] = [];
  if (xp > 0) lines.push({ title: `+${xp} XP`, detail: "Run verified" });
  if (levelBefore !== null && levelNow !== null && levelNow > levelBefore) {
    lines.push({ title: `Level ${levelNow}`, detail: "Level up" });
  }
  for (const entry of achievements) lines.push({ title: entry.name, detail: entry.desc });
  for (const item of unlockedItems(achievements, levelBefore, levelNow)) lines.push(itemReward(item));
  return lines.slice(0, MAX_REWARDS).map((line) => ({
    title: clipUtf8(line.title, TITLE_BYTES),
    detail: clipUtf8(line.detail, DETAIL_BYTES),
  }));
}

/**
 * The progression fields to forward with a verified result: the raw fields the host can fall back on, plus the
 * resolved `rewards`, which the host prefers. An empty `rewards` is still sent so the host doesn't draw "+0 XP".
 * Empty when the submission carries no progression (an older API, or a run that doesn't earn it).
 */
export function runProgression(result: Pick<Submission, "xp" | "level" | "achievements">): RunProgression {
  const xp = isCount(result.xp) ? result.xp : undefined;
  const level = validLevel(result.level) ? result.level : undefined;
  const achievements = Array.isArray(result.achievements) ? achievementIds(result.achievements) : undefined;
  if (xp === undefined && level === undefined && achievements === undefined) return {};
  return {
    ...(xp === undefined ? {} : { xp }),
    ...(level === undefined ? {} : { level }),
    ...(achievements === undefined ? {} : { achievements }),
    rewards: runRewardLines(xp ?? 0, level, achievements ?? []),
  };
}
