// Edit card's try-ons (v0.0.43): a card item you don't have (a Supporter frame or effect, a level 30 frame) can be
// picked to see it on your own card. That is all it is: a try-on lives here, in the open editor, and is drawn over the
// card by the preview hooks (ui/profile.ts cardPreview / namePreview). It never reaches the Loadout model
// (card-editor.ts Loadout.equip refuses an item you don't own), POST /me/cosmetics (400 bad_cosmetic for a locked item)
// or POST /me/supporter (403 not_supporter), and Done, Esc and leaving the profile drop it.
// DOM-free: the editor and apps/web/test/card-editor.test.ts share it.

import type { CosmeticChoice } from "../api";
import type { SupporterLook } from "./card";

/** One thing being tried on: its place (a card slot, or one field of a supporter's look), what to call it, how to get it. */
export interface Tried {
  /** "frame", "background", "title", or a look's field ("cardBorder", "nameColor", …): one try-on per place. */
  key: string;
  /** The item's id in that place (a cosmetic id, a look id). */
  id: string;
  /** As the note names it: "Geode frame", "Embers effect". */
  name: string;
  /** A Supporter item: the note links to the Support page. */
  supporter: boolean;
  /** Any other item's goal as a sentence start ("Reach level 30"); null: not said (a secret, a Contributor item). */
  goal: string | null;
}

type Entry = Tried & { cosmetics?: Partial<CosmeticChoice>; look?: SupporterLook };

export class TryOn {
  private entries = new Map<string, Entry>();

  /** Tries `t` on in its place, or takes it off if it is the one being tried there. True: it is on now. */
  toggle(t: Tried, what: { cosmetics?: Partial<CosmeticChoice>; look?: SupporterLook }): boolean {
    if (this.entries.get(t.key)?.id === t.id) {
      this.entries.delete(t.key);
      return false;
    }
    this.entries.set(t.key, { ...t, ...what });
    return true;
  }

  /** Whatever is tried in `key` comes off (you picked something of your own there). */
  drop(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** The id tried on in `key`, if any. */
  at(key: string): string | null {
    return this.entries.get(key)?.id ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  list(): Tried[] {
    return [...this.entries.values()].map(({ key, id, name, supporter, goal }) => ({ key, id, name, supporter, goal }));
  }

  /** The card slots tried on, for the card's preview only (null: none). */
  cosmetics(): Partial<CosmeticChoice> | null {
    const out: Partial<CosmeticChoice> = {};
    for (const e of this.entries.values()) Object.assign(out, e.cosmetics);
    return Object.keys(out).length ? out : null;
  }

  /** The supporter look tried on, for the card's preview only (undefined: none). */
  look(): SupporterLook | undefined {
    const out: SupporterLook = {};
    for (const e of this.entries.values()) Object.assign(out, e.look);
    return Object.keys(out).length ? out : undefined;
  }
}

/** "a", "a and b", "a, b and c". */
const listed = (names: string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The line beside the card while something is tried on: what it is, that it isn't saved or shown to anyone, and the
 * way to get it. `link`: the words of the one link to the Support page (null: no Supporter item among them); `goal`:
 * the unlock condition, when exactly one of them is earned by playing.
 */
export function tryNote(list: readonly Tried[]): { text: string; link: string | null; goal: string | null } | null {
  if (!list.length) return null;
  const many = list.length > 1;
  const names = listed(list.map((t) => t.name));
  const text = many ? `${names} are previews. They aren't saved and only you see them.` : `${names} is a preview. It isn't saved and only you see it.`;
  const sup = list.filter((t) => t.supporter);
  const rest = list.filter((t) => !t.supporter);
  const link = !sup.length ? null : !rest.length ? (sup.length > 1 ? "Supporters get these" : "Supporters get this") : rest.length === 1 ? "Supporters get the rest" : "Supporters get the Supporter items";
  const goal = rest.length === 1 && rest[0].goal ? `${rest[0].goal} to unlock ${many ? `the ${rest[0].name}` : "it"}.` : null;
  return { text, link, goal };
}

/**
 * What a click on a picker item does. Yours: it is put on the card and saved. Not yours: it is tried on (never saved),
 * unless it can't be previewed at all (a map whose record you lost, a badge you haven't earned).
 */
export function pickAction(owned: boolean, previewable = true): "save" | "try" | "none" {
  return owned ? "save" : previewable ? "try" : "none";
}
