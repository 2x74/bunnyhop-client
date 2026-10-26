// Unlocks: what a player owns, how far they are from the rest, what's new since they last looked, and the small
// celebration when something unlocks. Shared by the profile (Edit card, Loadout), the home / pause entry points
// and the HUD's end-of-run card. DOM-light: the celebrations themselves are notifications (notify/).
//
// "New" (the dots) is tracked per account in localStorage (bunnyhop:unlocks-seen:<id>): ids of achievements and
// cosmetics the player has already looked at. The first time an account is seen everything it owns counts as seen,
// except what the HUD announced since (bunnyhop:unlocks-fresh), so a fresh unlock always gets its dot. Celebration
// cards are a separate, stricter matter: once per account on any device ("Celebrated once" below, notices.ts).

import "./profile.css";
import { api, type LevelView, type Profile } from "../api";
import { claimNotices, NOTICE_STAFF_ALL } from "../notices";
import {
  achievement,
  ACHIEVEMENTS,
  COSMETICS,
  DISCORD_BOOSTER,
  DISCORD_LINK,
  DISCORD_MEMBER,
  EARLY_HOPPER,
  SUPPORTER,
  heldRanks,
  holdsRole,
  isSecret,
  isUnlocked,
  levelInfo,
  PLAY_WITH_OWNER,
  rankHint,
  roleHint,
  type AchievementDef,
  type CosmeticDef,
  type CosmeticSlot,
  type HeldRanks,
  type Rarity,
  secretHintOf,
  secretLockText,
  WINGS,
} from "../progression";
import { badgeToken } from "./badges";
import { fmtHours } from "./card";
import { h } from "./dom";
import { isLoadoutSlot, listedCosmetic, loadoutSwatch, rarityOf } from "./loadout-ui";
import { isLoadoutCategory } from "./cosmetic-slots";
import { me } from "./account-state";
import { navigate } from "./nav";
import { celebrate as notifyCelebrate, moment as notifyMoment, PRIORITY, runGoing, type Mood } from "../notify";
import { liveEmblem } from "../notify/item3d";
import { earnedHint, shortGoal } from "./unlock-text";

export { shortGoal };

// ---------------------------------------------------------------------------------------------
// Ownership + progress

export const SLOT_NAMES: Record<CosmeticSlot, string> = {
  background: "Background",
  frame: "Frame",
  title: "Title",
  outfit: "Colourway",
  ghost: "Ghost",
  trail: "Trail",
  knife: "Knife",
  finish: "Finish",
  glove: "Gloves",
  hat: "Hat",
  body: "Player model",
};

/**
 * Cosmetic ids the profile's owner has unlocked (same rule as the server's /me/cosmetics, so staff own everything but
 * the owner's items: progression.ts staffGrant), among the ones this client lists (a knife the registry hasn't built
 * yet stays hidden, and shows up as new once it ships). `grant` = false: without the staff grant (new-unlock tracking).
 */
export function ownedCosmetics(p: Pick<Profile, "level" | "achievements"> & Partial<Pick<Profile, "rank" | "styles" | "role">>, grant = true): Set<string> {
  const earned = p.achievements.map((a) => a.id);
  const ranks = profileRanks(p);
  return new Set(COSMETICS.filter((c) => listedCosmetic(c) && isUnlocked(c, p.level.level, earned, ranks, p.role ?? null, grant)).map((c) => c.id));
}

/** The places a profile currently holds (overall + per style), for rank-held cosmetics and the crown. */
export function profileRanks(p: Partial<Pick<Profile, "rank" | "styles">>): HeldRanks {
  return heldRanks([...(p.rank ? [p.rank] : []), ...(p.styles ?? [])]);
}

/**
 * Everything that can be "new": earned achievement ids + unlocked cosmetic ids. Items staff own only through the role
 * never count (no "120 new unlocks" for a new admin; staffNote says it once instead); the ones they earn still do.
 */
export function ownedIds(p: Pick<Profile, "level" | "achievements"> & Partial<Pick<Profile, "rank" | "styles" | "role">>): string[] {
  return [...p.achievements.map((a) => a.id), ...ownedCosmetics(p, false)];
}

/** The old per-device record of the staff note (before notices.ts): still honoured, and reported as a notice. */
const STAFF_NOTED = (uid: string) => `bunnyhop:staff-all-noted:${uid}`;
const staffNoted = new Set<string>();

/** Once per account: "Staff · Everything unlocked", the first time a staff player's own profile loads anywhere. */
function staffNote(p: Profile): void {
  const uid = p.player.id;
  if (!holdsRole("staff", p.role) || staffNoted.has(uid)) return;
  staffNoted.add(uid);
  let before = false;
  try {
    before = !!localStorage.getItem(STAFF_NOTED(uid));
    localStorage.setItem(STAFF_NOTED(uid), "1");
  } catch {
    /* private mode: the notice set (server) still says once */
  }
  if (before) return void recordNotices(uid, [NOTICE_STAFF_ALL]);
  if (!claimFor(p, [NOTICE_STAFF_ALL]).length) return;
  const detail = p.role === "owner" ? "Every finish, glove, colourway and card item is yours." : "Everything's unlocked. Top-rank items are preview only.";
  celebrate({ kicker: p.role === "owner" ? "Owner" : "Staff", title: "Everything unlocked", detail, ms: 7000 });
}

const fmtN = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

/** [current, goal] towards an achievement, formatted ("2/5", "1.2h/10h"); null when there's nothing to count. */
export function progressText(a: AchievementDef, prog: [number, number] | null | undefined): string | null {
  if (!prog || prog[1] <= 1) return null;
  if (a.id.startsWith("clock_")) return `${fmtHours(prog[0])}/${fmtHours(prog[1])}`;
  return `${fmtN(prog[0])}/${fmtN(prog[1])}`;
}

export interface LockInfo {
  /** One line: "Finish every ranked tier 3 map · 2/8", "Reach level 30 · 23/30". */
  hint: string;
  /** The goal alone, for tiles: "Reach level 30", "Join the Discord server". */
  goal: string;
  /** 0..1, or null when unknown (visitors) or binary. */
  fraction: number | null;
}

/**
 * How to unlock a cosmetic, with the owner's progress when known (`progress` is null for visitors). `role` = the
 * profile's staff role: staff see rank-held items they don't hold as preview-only (progression.ts staffGrant).
 */
export function lockInfo(c: CosmeticDef, level: LevelView, progress: Profile["progress"], ranks?: HeldRanks, role?: Profile["role"]): LockInfo {
  switch (c.unlock.kind) {
    case "free":
      return { hint: "Free", goal: "Free", fraction: null };
    case "level": {
      const goal = c.unlock.level;
      const g = `Reach level ${goal}`;
      return progress ? { hint: `${g} · ${level.level}/${goal}`, goal: g, fraction: Math.min(1, level.level / goal) } : { hint: g, goal: g, fraction: null };
    }
    case "achievement": {
      const a = achievement(c.unlock.id);
      if (!a) return { hint: c.unlock.id, goal: c.unlock.id, fraction: null };
      // The secret (progression.ts WINGS): nothing but "???" (and the optional cryptic line) until it's earned.
      if (isSecret(a)) return { hint: secretLockText(a), goal: secretHintOf(a) ?? "???", fraction: null };
      const prog = progress?.[a.id] ?? null;
      const t = progressText(a, prog);
      // Supporter items: the Support page unlocks them (the caption links there).
      if (a.availability === "support") return { hint: shortGoal(a), goal: "Supporter item", fraction: null };
      return { hint: `${shortGoal(a)}${t ? ` · ${t}` : ""}`, goal: shortGoal(a), fraction: prog && prog[1] > 1 ? Math.min(1, prog[0] / prog[1]) : null };
    }
    case "rank": {
      if (holdsRole("staff", role)) return { hint: "Preview: held by the top players", goal: "Preview only", fraction: null };
      // "Hold overall #1 · you're #14" (owner); held-only items say so.
      const u = c.unlock;
      const mine = ranks ? (u.scope === "all" ? ranks.all : Math.min(Infinity, ...Object.entries(ranks).filter(([k]) => k !== "all").map(([, r]) => r))) : undefined;
      const where = progress && ranks ? (mine && Number.isFinite(mine) ? ` · you're #${mine}` : " · no rank yet") : "";
      return { hint: `${rankHint(u)}${where}`, goal: rankHint(u), fraction: null };
    }
    case "role":
      // Only ever listed for players who hold it (shownCosmetic), so this is the rare "role removed" case.
      return { hint: roleHint(c.unlock.role), goal: roleHint(c.unlock.role), fraction: null };
  }
}


/**
 * How an owned cosmetic was earned on this profile ("Cleared a T3 map · Oct 5 on bhop_eazy"); `when` = false: without
 * the date and map (picker items). Locked items say lockInfo's hint instead.
 */
export function earnedLine(c: CosmeticDef, p: Pick<Profile, "level" | "achievements"> & Partial<Pick<Profile, "rank" | "styles" | "role">>, when = true): string {
  return earnedHint(c, { level: p.level.level, achievements: p.achievements, ranks: profileRanks(p), role: p.role ?? null }, { when });
}

/** The three badges the card shows automatically when none are picked (server: profileView). */
export function autoBadges(p: Pick<Profile, "achievements">): string[] {
  return [...p.achievements]
    .filter((a) => achievement(a.id))
    .sort((a, b) => achievement(b.id)!.ring - achievement(a.id)!.ring || Date.parse(b.unlockedAt) - Date.parse(a.unlockedAt))
    .slice(0, 3)
    .map((a) => a.id);
}

// ---------------------------------------------------------------------------------------------
// "New since last seen"

export { unseen, markSeen } from "./unlock-seen";
import { readSet, writeSet, FRESH } from "./unlock-seen";

/** Remember ids unlocked by a run (before any profile has been opened this session), so they still show as new. */
function noteFresh(ids: readonly string[]): void {
  if (!ids.length) return;
  const fresh = readSet(FRESH) ?? new Set<string>();
  for (const id of ids) fresh.add(id);
  writeSet(FRESH, fresh);
}

// ---------------------------------------------------------------------------------------------
// Celebrated once (notices.ts): the unlocks an account has been shown a card for, on any device. This device keeps a
// copy (bunnyhop:notices:<id>) merged with the server's (your profile's `notices`), and what it couldn't send yet
// (bunnyhop:notices-unsent:<id>). A celebration that isn't from a run (community rewards, the staff note) only shows
// ids in neither, then records them; a run's own cards (HUD, rooms) record theirs.
// So a new device, cleared storage, a fresh tab or a sign-in blip never repeats one, and the first time an account is
// seen its baseline is what it owns (notices.ts claimNotices), never an empty or guest state.

const NOTICES = (uid: string) => `bunnyhop:notices:${uid}`;
const NOTICES_UNSENT = (uid: string) => `bunnyhop:notices-unsent:${uid}`;
/** Ids sent to the server from this page, per account (not resent when a cached profile's copy predates them). */
const sentNotices = new Map<string, Set<string>>();

/** Records ids as told for this account: here at once, on the server shortly (kept and resent if that fails). */
export function recordNotices(uid: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const local = readSet(NOTICES(uid)) ?? new Set<string>();
  const unsent = readSet(NOTICES_UNSENT(uid)) ?? new Set<string>();
  for (const id of ids) {
    local.add(id);
    unsent.add(id);
  }
  writeSet(NOTICES(uid), local);
  writeSet(NOTICES_UNSENT(uid), unsent);
  void sendNotices(uid);
}

let sending: Promise<void> | null = null;
/** POST /me/notices with what's unsent (for this account only: the server refuses another account's). Never throws. */
function sendNotices(uid: string): Promise<void> {
  if (!api.available()) return Promise.resolve();
  if (sending) return sending.then(() => sendNotices(uid));
  sending = (async () => {
    try {
      const ids = [...(readSet(NOTICES_UNSENT(uid)) ?? [])];
      if (!ids.length) return;
      await api.addNotices(uid, ids);
      const left = readSet(NOTICES_UNSENT(uid)) ?? new Set<string>();
      const sent = sentNotices.get(uid) ?? new Set<string>();
      for (const id of ids) {
        left.delete(id);
        sent.add(id);
      }
      sentNotices.set(uid, sent);
      writeSet(NOTICES_UNSENT(uid), left);
    } catch {
      /* offline, signed out or another account's: kept for the next time */
    } finally {
      sending = null;
    }
  })();
  return sending;
}

/**
 * Of `candidates`, the ones this account has never been shown (to celebrate now), recorded as shown. The account's
 * first claim anywhere also records everything it owns as its baseline (notices.ts). Own profiles only.
 */
export function claimFor(p: Profile, candidates: Iterable<string>): string[] {
  if (!p.mine) return [];
  const uid = p.player.id;
  const known = readSet(NOTICES(uid)) ?? new Set<string>();
  const server = p.notices ? new Set(p.notices) : null;
  for (const id of server ?? []) known.add(id);
  const { announce, record } = claimNotices(known, ownedIds(p), candidates);
  // The server's copy lacks something this device knows (told before the server kept them, or a send that failed):
  // send it along, so the next device knows it too.
  const sent = sentNotices.get(uid);
  if (server) for (const id of known) if (!server.has(id) && !sent?.has(id) && !record.includes(id)) record.push(id);
  writeSet(NOTICES(uid), known);
  recordNotices(uid, record);
  return announce;
}

/** A run's celebration cards (HUD, rooms) were shown: record them for the signed-in account. */
function recordShown(ids: readonly string[]): void {
  if (!ids.length || !api.available()) return;
  void me().then((u) => u && recordNotices(u.id, ids));
}

/**
 * The signed-in player's own profile loaded from the home or pause menu: the once-per-account cards for unlocks no run
 * announces (community rewards, the staff note). The menu entries themselves don't advertise new unlocks (the
 * profile's "new" dots mark them until you look).
 */
export function profileNotices(p: Profile | null): void {
  if (!p || !p.mine) return;
  // Community first: an account's first claim takes its baseline, and what's being announced stays out of it.
  communityNote(p);
  secretNote(p);
  staffNote(p);
}

// ---------------------------------------------------------------------------------------------
// Community rewards (progression.ts DISCORD_LINK, DISCORD_MEMBER, DISCORD_BOOSTER, EARLY_HOPPER): earned outside runs
// (the Discord sign-in and the API's Discord bot, migration 0019), so no end-of-run card announces them. The first profile load
// after one (home / pause menu, profileNotices) celebrates it like any unlock, once per account and device. Older ones
// (than COMMUNITY_RECENT_MS: another device already showed it, or it came long ago) just get their "new" dot.

const COMMUNITY_IDS = [SUPPORTER, DISCORD_BOOSTER, DISCORD_MEMBER, DISCORD_LINK, EARLY_HOPPER];
const COMMUNITY_CELEBRATED = (uid: string) => `bunnyhop:community-celebrated:${uid}`;
const COMMUNITY_RECENT_MS = 14 * 86_400_000;
const COMMUNITY_WHY: Record<string, string> = {
  [DISCORD_LINK]: "For linking Discord",
  [DISCORD_MEMBER]: "For joining the bunnyhop.lol Discord",
  [DISCORD_BOOSTER]: "For boosting the bunnyhop.lol Discord",
  [EARLY_HOPPER]: "For playing in the early alpha",
  [SUPPORTER]: "For supporting bunnyhop.lol",
};
const COMMUNITY_KICKER: Partial<Record<CosmeticSlot, string>> = { glove: "New gloves", outfit: "New colourway", trail: "New trail", title: "New title", hat: "New hat" };
/** Which of an achievement's items leads its card (the rest are named in the detail). */
const SLOT_ORDER: CosmeticSlot[] = ["hat", "glove", "finish", "knife", "outfit", "trail", "ghost", "frame", "background", "title"];

function communityNote(p: Profile): void {
  const uid = p.player.id;
  // (COMMUNITY_CELEBRATED is the older per-device record; the notice set is what makes it once per account.)
  const done = readSet(COMMUNITY_CELEBRATED(uid)) ?? new Set<string>();
  const now = Date.now();
  const recent = p.achievements.filter((a) => COMMUNITY_IDS.includes(a.id) && !done.has(a.id) && now - Date.parse(a.unlockedAt) < COMMUNITY_RECENT_MS).map((a) => a.id);
  // Always claimed (even with nothing recent): an account's first claim takes its baseline (notices.ts).
  const fresh = claimFor(p, recent);
  if (!fresh.length) return;
  for (const id of fresh) done.add(id);
  writeSet(COMMUNITY_CELEBRATED(uid), done);
  celebrateCommunity(fresh.sort((a, b) => COMMUNITY_IDS.indexOf(a) - COMMUNITY_IDS.indexOf(b)));
}

/** The unlock cards for community achievements: each one's lead item as the model (3D preview), with Equip. */
export function celebrateCommunity(ids: readonly string[]): void {
  for (const id of ids) {
    const a = achievement(id);
    if (!a) continue;
    const items = COSMETICS.filter((c) => listedCosmetic(c) && c.unlock.kind === "achievement" && c.unlock.id === id).sort((x, y) => SLOT_ORDER.indexOf(x.slot) - SLOT_ORDER.indexOf(y.slot));
    const top = items[0];
    const why = COMMUNITY_WHY[id] ?? a.name;
    if (!top) {
      celebrate({ kicker: "Achievement", title: a.name, detail: a.desc, tokens: [a], key: `ach-${id}` });
      continue;
    }
    const rest = items.length > 1 ? `Also ${cosmeticList(items.slice(1))}` : undefined;
    const equip = { label: "Equip", run: () => openCustomise(top.slot) };
    // Supporter thanks takes the stage; the rest are moments, by the lead item's rarity (rarityLadder).
    if (id === SUPPORTER) {
      celebrate({ stage: true, title: "Thank you", detail: top.name, hint: [why, rest].filter(Boolean).join(". "), item: top, color: top.rarity ? undefined : top.color, action: equip, mood: "proud", confetti: 80, key: `unlock-${top.id}` });
      continue;
    }
    const big = id === DISCORD_BOOSTER || id === EARLY_HOPPER;
    celebrate({
      ...rarityLadder(top.rarity),
      kicker: COMMUNITY_KICKER[top.slot] ?? "New unlock",
      title: top.name,
      detail: why,
      hint: rest,
      item: top,
      color: top.rarity ? undefined : top.color,
      action: equip,
      ...(big ? { mood: "proud" as Mood } : {}),
      key: `unlock-${top.id}`,
    });
  }
}

/**
 * Where an unlocked item is picked (celebration "Equip" buttons): the Loadout for anything you wear in the game, else
 * your profile with the card in edit mode on that part.
 */
export function openCustomise(slot: string): void {
  if (isLoadoutCategory(slot)) return openLoadout(slot);
  void me().then((u) => u && navigate({ screen: "profile", id: u.id, tab: "card", slot }));
}

/** The Loadout (your profile's Loadout tab, menu.ts), optionally on a category. */
export function openLoadout(slot?: string): void {
  navigate({ screen: "loadout", slot });
}

/** A small "new" dot (aria-hidden; pair it with text for screen readers). */
export const newDot = (label = "new") => h("span.pf-new-dot", { role: "img", "aria-label": label });

// ---------------------------------------------------------------------------------------------
// Rewards from a verified run (HUD end-of-run card)

export interface RunRewards {
  achievements: AchievementDef[];
  cosmetics: CosmeticDef[];
  /** [before, after] when the run levelled up. */
  levelUp: [number, number] | null;
}

export function runRewards(s: { xp?: number; level?: LevelView; achievements?: string[] }): RunRewards {
  const achievements = (s.achievements ?? []).map(achievement).filter((a): a is AchievementDef => !!a);
  const now = s.level?.level ?? null;
  const before = s.level && s.xp ? levelInfo(s.level.xp - s.xp).level : now;
  const got = new Set(achievements.map((a) => a.id));
  const cosmetics = COSMETICS.filter(
    (c) =>
      listedCosmetic(c) &&
      (c.unlock.kind === "level" ? before !== null && now !== null && c.unlock.level > before && c.unlock.level <= now : c.unlock.kind === "achievement" && got.has(c.unlock.id)),
  );
  noteFresh([...achievements.map((a) => a.id), ...cosmetics.map((c) => c.id)]);
  return { achievements, cosmetics, levelUp: before !== null && now !== null && now > before ? [before, now] : null };
}

/** "Ember frame, Ember trail +2 more" */
export function cosmeticList(cs: CosmeticDef[], max = 3): string {
  const names = cs.map((c) => (c.slot === "title" ? `“${c.name}” title` : `${c.name} ${SLOT_NAMES[c.slot].toLowerCase()}`));
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max} more` : names.join(", ");
}

// ---------------------------------------------------------------------------------------------
// Celebrations (notify/: one at a time, held while a run is going; reduced motion: no animation). Two tiers: a moment
// (the slab, menus) and the celebration (the stage) for the top moments only: Heirloom / Golden items, a new rank group,
// the secret, Supporter thanks (and the tutorial's graduation, tutorial/mode.ts).

export interface Celebration {
  /** The stage instead of a moment. */
  stage?: boolean;
  /** Small coloured line above a moment's title (a rarity, "New gloves"); the stage doesn't show it. */
  kicker?: string;
  title: string;
  detail?: string;
  /** Hover text (why it unlocked): kept off the card. */
  hint?: string;
  tokens?: AchievementDef[];
  /**
   * The item unlocked: a live 3D model of it (notify/item3d.ts; its swatch for a knife / finish / gloves if that can't
   * show), in its rarity colour, instead of tokens.
   */
  item?: CosmeticDef;
  action?: { label: string; run: () => void };
  ms?: number;
  /** The bunny (big moments). */
  mood?: Mood;
  /** A level-up: the emblem counts the level from → to. */
  level?: [number, number];
  sound?: string;
  /** Playback rate of the sound (the rarity ladder: players learn rarity by ear). */
  rate?: number;
  /** Light sweep over the item (default: any item). */
  shine?: boolean;
  /** A ring spreading from the emblem as it lands. */
  ring?: boolean;
  confetti?: boolean | number;
  /** Feathers instead of confetti and a wingbeat on the emblem (the secret, progression.ts WINGS). */
  feathers?: boolean;
  priority?: number;
  /** Same key: merges into the card on screen / waiting instead of queueing another. */
  key?: string;
  /** Accent (default: the item's rarity colour, else amber). */
  color?: string;
}

/**
 * How an item's rarity is told (progression.ts RARITY): Garden a plain moment, Market with the shine, Prize with a
 * ring and a few bits of confetti and a slightly higher chime, Heirloom and Golden the stage with a deeper one.
 */
export function rarityLadder(r: Rarity | undefined): Pick<Celebration, "stage" | "shine" | "ring" | "confetti" | "rate" | "mood"> {
  switch (r ?? 1) {
    case 1:
      return { stage: false, shine: false, ring: false, confetti: false, rate: 1 };
    case 2:
      return { stage: false, shine: true, ring: false, confetti: false, rate: 1 };
    case 3:
      return { stage: false, shine: true, ring: true, confetti: 30, rate: 1.06 };
    default:
      return { stage: true, shine: true, ring: true, confetti: 80, rate: 0.84, mood: "proud" };
  }
}

export function celebrate(c: Celebration): void {
  const rar = c.item ? rarityOf(c.item) : null;
  const emblem = c.item ? (isLoadoutSlot(c.item.slot) ? loadoutSwatch(c.item, c.item.slot) : undefined) : c.tokens?.length ? badgeToken(c.tokens[0], { size: "md" }) : undefined;
  // The reward as a little 3D model (the item, or the first badge as a medal); the flat icon above stays as its fallback.
  const model = c.item ? liveEmblem({ cosmetic: c.item }, runGoing()) : c.tokens?.length ? liveEmblem({ achievement: c.tokens[0] }, runGoing()) : null;
  (c.stage ? notifyCelebrate : notifyMoment)({
    kicker: c.kicker,
    title: c.title,
    detail: c.detail,
    hint: c.hint,
    emblem,
    model: model ?? undefined,
    level: c.level,
    color: c.color ?? rar?.color,
    shine: c.shine ?? !!c.item,
    ring: c.ring ?? !c.item,
    mood: c.mood,
    confetti: c.confetti,
    feathers: c.feathers,
    sound: c.sound ?? (c.tokens?.length || c.item ? "achievement" : undefined),
    rate: c.rate,
    action: c.action,
    ms: c.ms,
    key: c.key,
    priority: c.priority ?? (c.stage ? PRIORITY.record : c.item ? PRIORITY.unlock : c.level ? PRIORITY.level : PRIORITY.achievement),
  });
}

// No knife: every knife is free (progression.ts) but the Supporter set's, so none is ever unlocked by a run.
const LOADOUT_KICKER: Record<string, string> = { finish: "New finish", glove: "New gloves" };


/**
 * The cards for a run's rewards (HUD, rooms); false when there's nothing to celebrate. In game the end card's reward
 * reel (hud.ts) shows the level, the achievement tokens and the items, so only what takes the stage is queued here
 * (Heirloom / Golden items, the secret: they wait for the run to end), plus achievements a room grants (moments).
 * Outside a game every reward is a moment, most special first. Only the item, its rarity and why: no pattern or wear.
 */
export function celebrateRun(r: RunRewards, customise?: (slot: string) => void): boolean {
  if (!r.achievements.length && !r.cosmetics.length && !r.levelUp) return false;
  // Shown here (or on the end card), so never again on another device (the dots stay until you look).
  recordShown([...r.achievements.map((a) => a.id), ...r.cosmetics.map((c) => c.id)]);
  // The secret (progression.ts WINGS) gets its own stage, before everything else, and stays out of the others.
  const secret = r.achievements.filter((a) => isSecret(a));
  if (secret.length) {
    celebrateSecret(secret, r.cosmetics, customise);
    const ids = new Set(secret.map((a) => a.id));
    const rest = { ...r, achievements: r.achievements.filter((a) => !ids.has(a.id)), cosmetics: r.cosmetics.filter((c) => !(c.unlock.kind === "achievement" && ids.has(c.unlock.id))) };
    if (rest.achievements.length || rest.cosmetics.length || rest.levelUp) celebrateRun(rest, customise);
    return true;
  }
  // In game the result's reel shows the level; the cards show what was earned.
  const reel = document.body.classList.contains("in-game");
  const achNames = (ids: Set<string>) => r.achievements.filter((a) => ids.has(a.id)).map((a) => a.name);
  const why = (c: CosmeticDef) => (c.unlock.kind === "level" ? `Level ${c.unlock.level}` : c.unlock.kind === "achievement" ? achNames(new Set([c.unlock.id]))[0] : undefined);
  const items = r.cosmetics.filter((c) => isLoadoutSlot(c.slot)).sort((a, b) => (b.rarity ?? 0) - (a.rarity ?? 0));
  for (const [i, top] of items.entries()) {
    const ladder = rarityLadder(top.rarity);
    // Below the stage: one card for the rarest.
    if (!ladder.stage && i > 0) continue;
    const rarity = rarityOf(top)?.name;
    const reason = why(top);
    celebrate({
      ...ladder,
      kicker: ladder.stage ? undefined : rarity ?? LOADOUT_KICKER[top.slot] ?? "New unlock",
      title: ladder.stage ? rarity ?? top.name : top.name,
      detail: ladder.stage ? top.name : undefined,
      hint: reason ? `For ${reason}` : undefined,
      item: top,
      action: customise ? { label: "Equip", run: () => customise(top.slot) } : undefined,
      key: `unlock-${top.id}`,
    });
  }
  const achievements = r.achievements;
  const rest = r.cosmetics.filter((c) => !isLoadoutSlot(c.slot));
  const fromLevel = rest.filter((c) => c.unlock.kind === "level");
  const fromAch = rest.filter((c) => c.unlock.kind !== "level");
  if (r.levelUp && !reel) {
    celebrate({
      title: `Level ${r.levelUp[1]}`,
      detail: fromLevel.length ? `New: ${cosmeticList(fromLevel)}` : undefined,
      level: r.levelUp,
      mood: "cheer",
      sound: "level_up",
      key: `level-${r.levelUp[1]}`,
    });
  }
  if (achievements.length) {
    const owner = achievements.some((a) => a.id === PLAY_WITH_OWNER);
    const [first] = achievements;
    celebrate({
      kicker: "Achievement",
      title: achievements.length > 1 ? `${first.name} and ${achievements.length - 1} more` : first.name,
      detail: fromAch.length ? `New: ${cosmeticList(fromAch)}` : achievements.length === 1 ? first.desc : undefined,
      tokens: achievements,
      // Meeting the owner on a server: the bunny waves.
      mood: owner ? "waving" : undefined,
      key: `ach-${achievements.map((a) => a.id).join(",")}`,
    });
  }
  return true;
}

/**
 * The secret's card (progression.ts WINGS): its item turning in 3D (the Tek look), feathers instead of confetti and a
 * wingbeat on the emblem; the achievement's name (revealed now) under it, and Equip.
 */
export function celebrateSecret(achievements: readonly AchievementDef[], cosmetics: readonly CosmeticDef[] = COSMETICS, customise: (slot: string) => void = openCustomise): void {
  for (const a of achievements) {
    const item = cosmetics.find((c) => c.unlock.kind === "achievement" && c.unlock.id === a.id) ?? COSMETICS.find((c) => c.unlock.kind === "achievement" && c.unlock.id === a.id);
    celebrate({
      stage: true,
      title: item?.name ?? a.name,
      detail: item ? a.name : a.desc,
      item,
      tokens: item ? undefined : [a],
      color: "#a6e22e",
      action: item ? { label: "Equip", run: () => customise(item.slot) } : undefined,
      confetti: 60,
      // Feathers are the wings' (the Tek look); the other hidden ones get the plain stage.
      feathers: a.id === WINGS,
      rate: 0.84,
      priority: PRIORITY.record,
      key: `secret-${a.id}`,
    });
  }
}

/**
 * The secret granted outside a run (the owner, from the admin panel): celebrated on the next profile load like the
 * community rewards, once per account.
 */
function secretNote(p: Profile): void {
  const recent = p.achievements.filter((a) => isSecret(achievement(a.id)) && Date.now() - Date.parse(a.unlockedAt) < COMMUNITY_RECENT_MS).map((a) => a.id);
  if (!recent.length) return;
  const fresh = claimFor(p, recent);
  if (fresh.length) celebrateSecret(fresh.map((id) => achievement(id)!));
}

/** Ids of every achievement, for "34/52". */
export const ACHIEVEMENT_COUNT = ACHIEVEMENTS.length;
