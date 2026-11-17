// The Support page's plan (ui/support.ts): where each thing a Supporter gets has its place on the page. DOM-free and
// three-free, so test/support-page.test.ts can hold the page to the catalogue: a Supporter item added to
// progression.ts COSMETICS, a look added to supporter-looks.ts or a new field on POST /me/supporter with no place here
// fails that test (and, for a new slot or look field, the typecheck) before it can ship unseen.
//
// The page has two sections of things to look at, and the rest in words:
//   Loadout       what you wear and use in the game, slot by slot (ui/support-loadout.ts: the Loadout's own view, so
//                 each slot is one of its tabs and each item one of its tiles)
//   Player card   the card's frame, background and title, and the supporter looks: card border, card effect, mini
//                 profile effect, avatar decoration, and the name's colour, effect, font and style
//                 (ui/support-card.ts: one row of choices each)
//   and in words  the heart by the name, the Discord role, the spot on full servers, Top supporters (SUPPORT_EXTRAS)
// and, on its first tab, your card fading through designs put together from the same lists (cardDesign).
//
// Every item is shown as itself. The page has no sets (owner, 2026-11-17: the set names and the switch between them
// were bloat): progression.ts still groups some Supporter items into SUPPORTER_SETS for the Loadout, and nothing here
// reads that grouping, names a set or puts one on.
//
// Never listed: staff items (progression.ts staffItem: invisible to players who don't hold the role), Contributor
// items (not a Supporter's) and anything behind a hidden achievement (secretCosmetic: the Wings and the Tek look are
// found, never shown or named here).

import { NAME_COLORS, NAME_EFFECTS } from "./creators";
import { COSMETICS, secretCosmetic, supporterItem, type CosmeticDef, type CosmeticSlot } from "./progression";
import type { LookPicks } from "./support-look";
import { AVATAR_DECOS, CARD_BORDERS, CARD_EFFECTS, HOVER_FX, NAME_FONTS } from "./supporter-looks";
import { CARD_PARTS, LOADOUT_CATEGORIES, type CardPart, type LoadoutCategory } from "./ui/cosmetic-slots";

export type SupportSection = "loadout" | "card";

/**
 * The section a slot's Supporter items show in. Every slot is listed (a new CosmeticSlot fails the typecheck until it
 * is given a place); the test then checks the place can really show it (a Loadout tab, a card row).
 */
export const SLOT_SECTION: Record<CosmeticSlot, SupportSection> = {
  knife: "loadout",
  finish: "loadout",
  hilt: "loadout",
  charm: "loadout",
  glove: "loadout",
  camo: "loadout",
  outfit: "loadout",
  body: "loadout",
  hat: "loadout",
  back: "loadout",
  ghost: "loadout",
  trail: "loadout",
  shape: "loadout",
  hop: "loadout",
  background: "card",
  frame: "card",
  title: "card",
};

/** What the page may show: a Supporter's item that isn't a secret. (Role items are never Supporter items.) */
export const onSupportPage = (c: CosmeticDef): boolean => supporterItem(c) && !secretCosmetic(c);

export interface SupportGroup<S extends string = string> {
  /** The catalogue slot. */
  slot: S;
  /** What the page calls it (the Loadout's tab name, Edit card's part name). */
  label: string;
  /** Its Supporter items, in catalogue order. */
  items: CosmeticDef[];
}

/** The Loadout section: each Loadout category that has a Supporter item, in the Loadout's tab order. */
export function supportLoadout(catalogue: readonly CosmeticDef[] = COSMETICS): SupportGroup<LoadoutCategory>[] {
  return LOADOUT_CATEGORIES.map(({ slot, label }) => ({ slot, label, items: catalogue.filter((c) => c.slot === slot && onSupportPage(c)) })).filter((g) => g.items.length > 0);
}

/** The card's own parts that are catalogue items (Edit card's Background, Frame and Title), Supporter items only. */
export type CardItemPart = Extract<CardPart, "background" | "frame" | "title">;
const CARD_ITEM_PARTS: readonly CardItemPart[] = ["frame", "background", "title"];
export function supportCardItems(catalogue: readonly CosmeticDef[] = COSMETICS): SupportGroup<CardItemPart>[] {
  return CARD_ITEM_PARTS.map((slot) => ({ slot, label: CARD_PARTS.find((p) => p.part === slot)!.label, items: catalogue.filter((c) => c.slot === slot && onSupportPage(c)) })).filter((g) => g.items.length > 0);
}

/** A Supporter item the page has no place for (the test expects none): wrong kind of slot for its section. */
export function unplaced(catalogue: readonly CosmeticDef[] = COSMETICS): CosmeticDef[] {
  const placed = new Set([...supportLoadout(catalogue), ...supportCardItems(catalogue)].flatMap((g) => g.items.map((c) => c.id)));
  return catalogue.filter((c) => onSupportPage(c) && !placed.has(c.id));
}

/** How many things the Loadout section holds (the page's own count, never a number typed into the copy). */
export const supportLoadoutCount = (catalogue: readonly CosmeticDef[] = COSMETICS): number => supportLoadout(catalogue).reduce((n, g) => n + g.items.length, 0);

/**
 * What the Loadout section's stage wears when it opens: the first Supporter item of each slot it can dress (the knife
 * stays the player's own, so the finish shows on it; nothing on the back). Only where the preview starts: any item is
 * a click away.
 */
export function startLoadout(catalogue: readonly CosmeticDef[] = COSMETICS): Partial<Record<LoadoutCategory, string>> {
  const out: Partial<Record<LoadoutCategory, string>> = {};
  for (const g of supportLoadout(catalogue)) if (g.slot !== "knife" && g.slot !== "back") out[g.slot] = g.items[0].id;
  return out;
}

/** The Player card section's first frame, background and title: the first Supporter item of each. */
export function startCard(catalogue: readonly CosmeticDef[] = COSMETICS): Record<CardItemPart, string | null> {
  const of = (slot: CardItemPart) => supportCardItems(catalogue).find((g) => g.slot === slot)?.items[0].id ?? null;
  return { frame: of("frame"), background: of("background"), title: of("title") };
}

/**
 * The supporter looks, one row each on the Player card section, grouped as the page heads them. Keyed by the pick it
 * sets (support-look.ts LookPicks), so a look field added there has no row until it is listed here: the `satisfies`
 * below fails the typecheck, and the test checks every catalogue list is the one named.
 */
export type LookGroup = "card" | "avatar" | "name";
export const SUPPORT_LOOKS = {
  border: { group: "card", label: "Border", list: "CARD_BORDERS" },
  cardEffect: { group: "card", label: "Effect", list: "CARD_EFFECTS" },
  hoverFx: { group: "card", label: "Mini profile", list: "HOVER_FX" },
  deco: { group: "avatar", label: "Decoration", list: "AVATAR_DECOS" },
  color: { group: "name", label: "Colour", list: "NAME_COLORS" },
  effect: { group: "name", label: "Effect", list: "NAME_EFFECTS" },
  font: { group: "name", label: "Font", list: "NAME_FONTS" },
  style: { group: "name", label: "Bold and italic", list: "NAME_STYLES" },
} as const satisfies Record<keyof LookPicks, { group: LookGroup; label: string; list: string }>;

/** The catalogue list behind each look row (what the test counts the page's choices against). */
export const LOOK_LISTS: Record<(typeof SUPPORT_LOOKS)[keyof LookPicks]["list"], readonly { id: string; name: string }[]> = {
  CARD_BORDERS,
  CARD_EFFECTS,
  HOVER_FX,
  AVATAR_DECOS,
  NAME_COLORS,
  NAME_EFFECTS,
  NAME_FONTS,
  NAME_STYLES: [
    { id: "b", name: "Bold" },
    { id: "i", name: "Italic" },
    { id: "bi", name: "Bold italic" },
  ],
};

/** The look rows under a heading, in page order. */
export const looksIn = (group: LookGroup): (keyof LookPicks)[] => (Object.keys(SUPPORT_LOOKS) as (keyof LookPicks)[]).filter((k) => SUPPORT_LOOKS[k].group === group);

/** The rest of what a Supporter gets, said in words on the page's first tab (no picture to show for them). */
export const SUPPORT_EXTRAS = ["a heart by your name", "the Supporter role on our Discord", "a reserved spot on full servers", "a place in Top supporters"] as const;

// ---------------------------------------------------------------------------------------------
// The first tab's card (ui/support-card.ts cardShowcase): the viewer's own card fading from one design to the next.
// A design is a pick from each list above, the n-th taking the n-th of every list (each wrapping at its own length),
// so the designs are never typed in: a border or an effect added to supporter-looks.ts, or a Supporter frame added
// to the catalogue, is in the rotation the day it exists.

export interface CardDesign {
  frame: string | null;
  background: string | null;
  title: string | null;
  look: LookPicks;
}

const turn = <T>(list: readonly T[], n: number): T | null => (list.length ? list[((n % list.length) + list.length) % list.length] : null);
/** The newest first: a list's latest entry is the first one a visitor sees. */
const newest = <T>(list: readonly T[]): T[] => [...list].reverse();

/** The n-th design (n = 0, 1, 2, ... without end). */
export function cardDesign(n: number, catalogue: readonly CosmeticDef[] = COSMETICS): CardDesign {
  const part = (slot: CardItemPart) => supportCardItems(catalogue).find((g) => g.slot === slot)?.items ?? [];
  return {
    // The frame and the background step together, so a pair made for each other stays one.
    frame: turn(part("frame"), n)?.id ?? null,
    background: turn(part("background"), n)?.id ?? null,
    title: turn(part("title"), n)?.id ?? null,
    look: {
      border: turn(newest(CARD_BORDERS), n)?.id ?? null,
      cardEffect: turn(newest(CARD_EFFECTS), n)?.id ?? null,
      deco: turn(AVATAR_DECOS, n)?.id ?? null,
      color: turn(NAME_COLORS, n + 4)?.id ?? null,
      effect: turn(newest(NAME_EFFECTS), n)?.id ?? null,
      // The name keeps the default font and cut in every design: one design fades into the next with both on screen,
      // and a name set in two fonts at once is a smear. Its colour and effect change (the letters stay where they are).
      font: null,
      style: null,
      hoverFx: null,
    },
  };
}

/** How many designs it takes for every card border and every card effect to have been on screen once. */
export const showcaseLap = (): number => Math.max(CARD_BORDERS.length, CARD_EFFECTS.length);
