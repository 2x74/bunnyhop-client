// Where each cosmetic is picked (v0.0.9): every in-game look is in the Loadout (knife, finish, hilt, gloves, colourway, hat,
// ghost, trail), the profile card's own parts are edited on the card itself (background, frame, title, badges, links).
// DOM-free and three-free: the profile, the Loadout, the unlock notes and apps/api/test/cosmetic-slots.test.ts share it.

import { ROLE_SETS, SUPPORTER_SETS, supporterItem, type CosmeticDef, type CosmeticSlot } from "../progression";

/** Loadout categories, in tab order. */
export type LoadoutCategory = "knife" | "finish" | "hilt" | "glove" | "camo" | "outfit" | "hat" | "ghost" | "trail";
export const LOADOUT_CATEGORIES: readonly { slot: LoadoutCategory; label: string }[] = [
  { slot: "knife", label: "Knife" },
  { slot: "finish", label: "Finish" },
  { slot: "hilt", label: "Hilt" },
  { slot: "glove", label: "Gloves" },
  { slot: "camo", label: "Gun camo" },
  { slot: "outfit", label: "Colourway" },
  { slot: "hat", label: "Hat" },
  { slot: "ghost", label: "Ghost" },
  { slot: "trail", label: "Trail" },
];
export const isLoadoutCategory = (s: unknown): s is LoadoutCategory => LOADOUT_CATEGORIES.some((c) => c.slot === s);

/**
 * What the Loadout's stage shows for a category: your hands in first person (knife, finish, hilt, gloves), a gun in the
 * camo (gun camo), your bunny (colourway, hat), or your PB ghost hopping with its trail (ghost, trail).
 */
export type StageKind = "hands" | "guns" | "bunny" | "ghost";
export function stageKind(slot: LoadoutCategory): StageKind {
  return slot === "camo" ? "guns" : slot === "outfit" || slot === "hat" ? "bunny" : slot === "ghost" || slot === "trail" ? "ghost" : "hands";
}

/** Categories to show: the hat only for whoever has one (owner-only items never show as a goal). */
export function loadoutCategories(listed: (slot: LoadoutCategory) => number): LoadoutCategory[] {
  return LOADOUT_CATEGORIES.map((c) => c.slot).filter((s) => s !== "hat" || listed(s) > 0);
}

/** Slots that may be empty (a "None" tile first). */
export const EMPTYABLE: ReadonlySet<CosmeticSlot> = new Set(["hat", "title", "camo"]);
/** The empty tile's name in the Loadout. */
export const noneLabel = (slot: CosmeticSlot): string => (slot === "camo" ? "No camo" : "No hat");

/** The card's editable parts, in order. */
export type CardPart = "background" | "frame" | "title" | "name" | "avatar" | "effects" | "badges" | "links";
export const CARD_PARTS: readonly { part: CardPart; label: string }[] = [
  { part: "background", label: "Background" },
  { part: "frame", label: "Frame" },
  { part: "title", label: "Title" },
  /**
   * The supporter looks (supporter-looks.ts): the name's colour, effect and font; the avatar decoration; the card's
   * border and effect. Shown to everyone since v0.0.37, locked for players who aren't supporters (one line about it).
   */
  { part: "name", label: "Name" },
  { part: "avatar", label: "Avatar" },
  { part: "effects", label: "Effects" },
  { part: "badges", label: "Badges" },
  { part: "links", label: "Links" },
];
export const isCardPart = (s: unknown): s is CardPart => CARD_PARTS.some((c) => c.part === s);

export type ProfileTab = "overview" | "loadout" | "runs" | "compare";

/**
 * Where a request to open the profile lands. Tabs are the ones above (Compare on someone else's profile only); "card" (a new card item) and v0.0.8's
 * "customise" (old links, unlock buttons, a remembered tab) open the Overview with the card in edit mode on that part,
 * or the Loadout for an item that moved there (colourway, ghost, trail, hat). 0.0.13's removed Collection tab (old links,
 * a remembered tab) opens the Loadout.
 */
export function profileTarget(tab: string | null | undefined, slot: string | null | undefined): { tab: ProfileTab; slot: LoadoutCategory | null; edit: CardPart | null } {
  const s = slot === "body" ? "outfit" : slot ?? null;
  if (isLoadoutCategory(s) && (tab === "loadout" || tab === "customise" || tab === "card" || !tab)) return { tab: "loadout", slot: s, edit: null };
  if (tab === "customise" || tab === "card" || (isCardPart(s) && (!tab || tab === "overview"))) return { tab: "overview", slot: null, edit: isCardPart(s) ? s : "background" };
  if (tab === "collection") return { tab: "loadout", slot: isLoadoutCategory(s) ? s : null, edit: null };
  if (tab === "overview" || tab === "loadout" || tab === "runs" || tab === "compare") return { tab, slot: null, edit: null };
  return { tab: "overview", slot: null, edit: null };
}

/** A section's tile: the item and the line under its name (its set's name). */
export interface SectionItem {
  c: CosmeticDef;
  group: string;
}

/**
 * The Loadout grid's sections (loadout-view.ts drawGrid), keeping the order given within each: items earned by playing
 * (and everything else not in the ones below), Supporter items (set by set in SUPPORTER_SETS order, then the ones in no
 * set), Contributor items (their role sets in ROLE_SETS order; listed for everyone, locked for non-contributors) and
 * staff items (the moderator, admin and owner sets; the caller passes only the ones its player holds: loadout-ui.ts
 * shownCosmetic). `group`: the line a tile shows under its name (the set's name, else "Supporter" / "Contributor" /
 * "Staff").
 */
export function loadoutSections(items: readonly CosmeticDef[]): { earned: CosmeticDef[]; supporter: SectionItem[]; contributor: SectionItem[]; staff: SectionItem[] } {
  const earned = items.filter((c) => !supporterItem(c) && c.unlock.kind !== "role");
  const supporter = [
    ...SUPPORTER_SETS.flatMap((st) => items.filter((c) => supporterItem(c) && c.set === st.id).map((c) => ({ c, group: st.name }))),
    ...items.filter((c) => supporterItem(c) && !c.set).map((c) => ({ c, group: "Supporter" })),
  ];
  const held = (contributor: boolean): SectionItem[] => {
    const mine = items.filter((c) => c.unlock.kind === "role" && (c.unlock.role === "contributor") === contributor);
    return [
      ...ROLE_SETS.flatMap((st) => mine.filter((c) => c.roleSet === st.id).map((c) => ({ c, group: st.name }))),
      ...mine.filter((c) => !c.roleSet).map((c) => ({ c, group: contributor ? "Contributor" : "Staff" })),
    ];
  };
  return { earned, supporter, contributor: held(true), staff: held(false) };
}
