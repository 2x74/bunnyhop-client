// Where each cosmetic is picked (v0.0.9): every in-game look is in the Loadout (knife, finish, gloves, colourway, hat,
// ghost, trail), the profile card's own parts are edited on the card itself (background, frame, title, badges, links).
// DOM-free and three-free: the profile, the Loadout, the unlock notes and apps/api/test/cosmetic-slots.test.ts share it.

import type { CosmeticSlot } from "../progression";

/** Loadout categories, in tab order. */
export type LoadoutCategory = "knife" | "finish" | "glove" | "outfit" | "hat" | "ghost" | "trail";
export const LOADOUT_CATEGORIES: readonly { slot: LoadoutCategory; label: string }[] = [
  { slot: "knife", label: "Knife" },
  { slot: "finish", label: "Finish" },
  { slot: "glove", label: "Gloves" },
  { slot: "outfit", label: "Colourway" },
  { slot: "hat", label: "Hat" },
  { slot: "ghost", label: "Ghost" },
  { slot: "trail", label: "Trail" },
];
export const isLoadoutCategory = (s: unknown): s is LoadoutCategory => LOADOUT_CATEGORIES.some((c) => c.slot === s);

/**
 * What the Loadout's stage shows for a category: your hands in first person (knife, finish, gloves), your bunny
 * (colourway, hat), or your PB ghost hopping with its trail (ghost, trail).
 */
export type StageKind = "hands" | "bunny" | "ghost";
export function stageKind(slot: LoadoutCategory): StageKind {
  return slot === "outfit" || slot === "hat" ? "bunny" : slot === "ghost" || slot === "trail" ? "ghost" : "hands";
}

/** Categories to show: the hat only for whoever has one (owner-only items never show as a goal). */
export function loadoutCategories(listed: (slot: LoadoutCategory) => number): LoadoutCategory[] {
  return LOADOUT_CATEGORIES.map((c) => c.slot).filter((s) => s !== "hat" || listed(s) > 0);
}

/** Slots that may be empty (a "None" tile first). */
export const EMPTYABLE: ReadonlySet<CosmeticSlot> = new Set(["hat", "title"]);

/** The card's editable parts, in order. */
export type CardPart = "background" | "frame" | "title" | "name" | "badges" | "links";
export const CARD_PARTS: readonly { part: CardPart; label: string }[] = [
  { part: "background", label: "Background" },
  { part: "frame", label: "Frame" },
  { part: "title", label: "Title" },
  /** Supporters only (Edit card hides it for everyone else): the name colour and the About page listing. */
  { part: "name", label: "Name" },
  { part: "badges", label: "Badges" },
  { part: "links", label: "Links" },
];
export const isCardPart = (s: unknown): s is CardPart => CARD_PARTS.some((c) => c.part === s);

export type ProfileTab = "overview" | "loadout" | "runs";

/**
 * Where a request to open the profile lands. Tabs are the three above; "card" (a new card item) and v0.0.8's
 * "customise" (old links, unlock buttons, a remembered tab) open the Overview with the card in edit mode on that part,
 * or the Loadout for an item that moved there (colourway, ghost, trail, hat). 0.0.13's removed Collection tab (old links,
 * a remembered tab) opens the Loadout.
 */
export function profileTarget(tab: string | null | undefined, slot: string | null | undefined): { tab: ProfileTab; slot: LoadoutCategory | null; edit: CardPart | null } {
  const s = slot === "body" ? "outfit" : slot ?? null;
  if (isLoadoutCategory(s) && (tab === "loadout" || tab === "customise" || tab === "card" || !tab)) return { tab: "loadout", slot: s, edit: null };
  if (tab === "customise" || tab === "card" || (isCardPart(s) && (!tab || tab === "overview"))) return { tab: "overview", slot: null, edit: isCardPart(s) ? s : "background" };
  if (tab === "collection") return { tab: "loadout", slot: isLoadoutCategory(s) ? s : null, edit: null };
  if (tab === "overview" || tab === "loadout" || tab === "runs") return { tab, slot: null, edit: null };
  return { tab: "overview", slot: null, edit: null };
}
