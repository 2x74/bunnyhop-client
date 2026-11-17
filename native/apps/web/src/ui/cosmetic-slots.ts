// Where each cosmetic is picked (v0.0.9): every in-game look is in the Loadout (knife, finish, hilt, gloves, colourway, hat,
// back, ghost, trail, trail shape, hop effect), the profile card's own parts are edited on the card itself (background, frame, title, badges, links).
// DOM-free and three-free: the profile, the Loadout, the unlock notes and apps/api/test/cosmetic-slots.test.ts share it.

import { MEDAL_ITEM, CAPE_ITEM, LENGTH_HATS, MASK_HAT, ROBE_ITEM, ROLE_SETS, supporterItem, type CosmeticDef, type CosmeticSlot } from "../progression";
import { isWig } from "../loadout";

/** Loadout categories, in the order the Loadout lists them. */
export type LoadoutCategory = "knife" | "finish" | "hilt" | "glove" | "camo" | "outfit" | "hat" | "back" | "ghost" | "trail" | "shape" | "hop";
/**
 * What a category dresses, which is how the Loadout's list is spaced: your hands (first person), your bunny, and what
 * a run leaves behind (the ghost, its trail, the hop effect). A new slot (pets) joins the group it belongs to.
 */
export type LoadoutGroup = "hands" | "bunny" | "run";
/**
 * One entry per Loadout slot, and the one place a new slot is added for the menus: the Loadout's list (profile and
 * Support page alike) is drawn from it in this order, spaced by `group`; `kind` is what the stage's caption calls an
 * item of the slot when that isn't the label; `none` is the empty tile's name for a slot that may be empty (the
 * Loadout then lists that tile first: EMPTYABLE, noneLabel). What else a new slot needs is said by the typecheck:
 * a CosmeticSlot in progression.ts, a place on the Support page (support-page.ts SLOT_SECTION), and its option rows,
 * if it has any (LoadoutOption and loadoutOptions below).
 */
export const LOADOUT_CATEGORIES: readonly { slot: LoadoutCategory; label: string; group: LoadoutGroup; kind?: string; none?: string }[] = [
  { slot: "knife", label: "Knife", group: "hands" },
  { slot: "finish", label: "Finish", group: "hands" },
  { slot: "hilt", label: "Hilt", group: "hands" },
  { slot: "glove", label: "Gloves", group: "hands" },
  { slot: "camo", label: "Gun camo", group: "hands", none: "No camo" },
  { slot: "outfit", label: "Colourway", group: "bunny" },
  { slot: "hat", label: "Hat", group: "bunny", none: "No hat" },
  { slot: "back", label: "Back", group: "bunny", none: "Nothing" },
  { slot: "ghost", label: "Ghost", group: "run", kind: "Ghost colour" },
  { slot: "trail", label: "Trail", group: "run" },
  { slot: "shape", label: "Trail shape", group: "run" },
  { slot: "hop", label: "Hop effect", group: "run", none: "No effect" },
];
/** What the stage's caption calls an item of the slot ("Ghost colour"; the slot's label for the rest). */
export const loadoutKind = (slot: LoadoutCategory): string => {
  const c = LOADOUT_CATEGORIES.find((x) => x.slot === slot)!;
  return c.kind ?? c.label;
};
/** A category's group ("bunny" for the Player glow entry, which sits with the bunny's own). */
export const loadoutGroup = (slot: LoadoutCategory): LoadoutGroup => LOADOUT_CATEGORIES.find((c) => c.slot === slot)!.group;
export const isLoadoutCategory = (s: unknown): s is LoadoutCategory => LOADOUT_CATEGORIES.some((c) => c.slot === s);

/**
 * What the Loadout's stage shows for a category: your hands in first person (knife, finish, hilt, gloves), a gun in the
 * camo (gun camo), your bunny (colourway, hat, back), or your PB ghost hopping with its trail (ghost, trail, trail shape). The
 * hop effect is a "ghost" stage too (no inspect, no views to pick), showing your own bunny hopping on the spot instead.
 */
export type StageKind = "hands" | "guns" | "bunny" | "ghost";
export function stageKind(slot: LoadoutCategory): StageKind {
  return slot === "camo" ? "guns" : slot === "outfit" || slot === "hat" || slot === "back" ? "bunny" : slot === "ghost" || slot === "trail" || slot === "shape" || slot === "hop" ? "ghost" : "hands";
}

/** The Loadout's option rows (loadout-view.ts), under the slot's grid. */
export type LoadoutOption = "model" | "pool" | "hair" | "highlights" | "hair-length" | "mask" | "cape-length" | "cape-colour" | "cape-lining" | "robe-wear" | "robe-pattern" | "robe-colour" | "robe-print" | "medal-metal";
/**
 * The option rows a slot shows: its own (the player model on Colourway, the knife pool on Knife and Finish) and those
 * of the item WORN in it, if it is yours (a wig's colours, the lengths, the Kitsune Mask, the Cape, the Robe).
 *
 * `worn` is what the player wears, never the tile under the pointer. Rows that followed the hovered item took their
 * height from the grid, covered the hovered tile, and the stage flipped between two items for as long as the pointer
 * stayed (10-29, and again in v0.0.42 once the Cape and the Robe had three and four rows): so there is no way to ask
 * this for a previewed item's rows. `fixedModel`: the colourway brings its own body (no A / B). `previewOnly`: the
 * Support page, where nothing is saved.
 */
/** `metals`: how many of the daily medals' metals the player holds: the Daily Medal's metal row is a choice from two. */
export function loadoutOptions(slot: LoadoutCategory, worn: { hat?: string | null; back?: string | null }, a: { owns: (id: string) => boolean; fixedModel?: boolean; previewOnly?: boolean; metals?: number }): LoadoutOption[] {
  if (slot === "outfit") return a.previewOnly || a.fixedModel ? [] : ["model"];
  if (slot === "knife" || slot === "finish") return a.previewOnly ? [] : ["pool"];
  if (slot === "hat") {
    const hat = worn.hat;
    if (!hat || !a.owns(hat)) return [];
    return [...(isWig(hat) ? (["hair", "highlights"] as const) : []), ...(LENGTH_HATS.includes(hat) ? (["hair-length"] as const) : []), ...(hat === MASK_HAT ? (["mask"] as const) : [])];
  }
  if (slot === "back") {
    const back = worn.back;
    if (!back || !a.owns(back)) return [];
    if (back === CAPE_ITEM) return ["cape-length", "cape-colour", "cape-lining"];
    if (back === ROBE_ITEM) return ["robe-wear", "robe-pattern", "robe-colour", "robe-print"];
    if (back === MEDAL_ITEM) return (a.metals ?? 0) > 1 ? ["medal-metal"] : [];
  }
  return [];
}

/** Categories to show: the hat only for whoever has one (owner-only items never show as a goal). */
export function loadoutCategories(listed: (slot: LoadoutCategory) => number): LoadoutCategory[] {
  return LOADOUT_CATEGORIES.map((c) => c.slot).filter((s) => s !== "hat" || listed(s) > 0);
}

/** Slots that may be empty (a "None" tile first): the Loadout's own (LOADOUT_CATEGORIES `none`) and the card's title. */
export const EMPTYABLE: ReadonlySet<CosmeticSlot> = new Set<CosmeticSlot>([...LOADOUT_CATEGORIES.filter((c) => c.none).map((c) => c.slot), "title"]);
/** The empty tile's name in the Loadout. */
export const noneLabel = (slot: CosmeticSlot): string => LOADOUT_CATEGORIES.find((c) => c.slot === slot)?.none ?? "No hat";

/** The card's editable parts, in order. */
export type CardPart = "background" | "frame" | "effects" | "avatar" | "flag" | "name" | "title" | "badges" | "links";
/**
 * How Edit card's list is spaced (v0.0.43: a list down the left like the Loadout's): the card itself, who is on it,
 * and what it shows off.
 */
export type CardPartGroup = "card" | "you" | "shown";
export const CARD_PARTS: readonly { part: CardPart; label: string; group: CardPartGroup }[] = [
  { part: "background", label: "Background", group: "card" },
  { part: "frame", label: "Frame", group: "card" },
  /**
   * The supporter looks (supporter-looks.ts): the card's border and effect; the avatar decoration; the name's colour,
   * effect and font. Shown to everyone since v0.0.37; since v0.0.43 a player who isn't a supporter can try them on.
   */
  { part: "effects", label: "Effects", group: "card" },
  { part: "avatar", label: "Avatar", group: "you" },
  /** The profile flag before your name (ui/country-picker.ts): not a cosmetic, saved with POST /me/country. */
  { part: "flag", label: "Flag", group: "you" },
  { part: "name", label: "Name", group: "you" },
  { part: "title", label: "Title", group: "you" },
  { part: "badges", label: "Badges", group: "shown" },
  { part: "links", label: "Links", group: "shown" },
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
 * (and everything else not in the ones below), Supporter items, Contributor items (their role sets in ROLE_SETS order;
 * listed for everyone, locked for non-contributors) and staff items (the moderator, admin and owner sets; the caller
 * passes only the ones its player holds: loadout-ui.ts shownCosmetic). `group`: "Supporter" for a Supporter item; for a
 * role item the line a tile shows under its name (its set's name, else "Contributor" / "Staff").
 *
 * Supporter items are one plain list (owner, 2026-11-17: no set names in the Loadout, the items are what matter): this
 * reads nothing of the Supporter sets (progression.ts SUPPORTER_SETS, CosmeticDef.set), only whether an item is a
 * Supporter item.
 */
export function loadoutSections(items: readonly CosmeticDef[]): { earned: CosmeticDef[]; supporter: SectionItem[]; contributor: SectionItem[]; staff: SectionItem[] } {
  const earned = items.filter((c) => !supporterItem(c) && c.unlock.kind !== "role");
  const supporter = items.filter((c) => supporterItem(c)).map((c) => ({ c, group: "Supporter" }));
  const held = (contributor: boolean): SectionItem[] => {
    const mine = items.filter((c) => c.unlock.kind === "role" && (c.unlock.role === "contributor") === contributor);
    return [
      ...ROLE_SETS.flatMap((st) => mine.filter((c) => c.roleSet === st.id).map((c) => ({ c, group: st.name }))),
      ...mine.filter((c) => !c.roleSet).map((c) => ({ c, group: contributor ? "Contributor" : "Staff" })),
    ];
  };
  return { earned, supporter, contributor: held(true), staff: held(false) };
}
