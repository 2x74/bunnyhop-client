// What the avatar editor offers (the website's avatar/main.ts, without its WebGL): the cosmetics an account owns, the
// spec with anything else put back to the default, and how each picker's thumbnails are posed. DOM-free.
import { COSMETICS, cosmetic, type CosmeticDef } from "../../web/src/progression";
import * as loadoutModule from "../../web/src/loadout";
import { FINISH_STYLE, GLOVE_STYLE } from "../../web/src/loadout";
import { cleanAvatar, defaultAvatar, defaultBg, type AvatarGun, type AvatarSpec } from "../../web/src/avatar/spec";
import { KNIFE_IDS, knifeById } from "./knife-catalog";

export type Slot = "outfit" | "hat" | "knife" | "finish" | "glove";

export const SLOT_NAME: Record<Slot, string> = {
  outfit: "Colourway",
  hat: "Headwear",
  knife: "Knife",
  finish: "Finish",
  glove: "Gloves",
};

/** The map-given guns' names (viewmodel/guns models; ui/avatar-choices.test.ts checks them against the web's). */
export const GUN_NAMES: Record<AvatarGun, string> = {
  usp: "Cottontail",
  glock: "Thumper",
  fiveseven: "Jackrabbit",
  m3: "Broadfork",
  xm1014: "Hedgerow",
  p90: "Seed Drill",
  ak47: "Furrow",
  awp: "Beanpole",
};

export function owns(unlocked: ReadonlySet<string>, c: CosmeticDef | null | undefined): boolean {
  return !!c && (c.unlock.kind === "free" || unlocked.has(c.id));
}

export interface Options {
  outfits: CosmeticDef[];
  hats: CosmeticDef[];
  knives: CosmeticDef[];
  finishes: CosmeticDef[];
  gloves: CosmeticDef[];
}

function ofSlot(unlocked: ReadonlySet<string>, slot: CosmeticDef["slot"]): CosmeticDef[] {
  return COSMETICS.filter((c) => c.slot === slot && owns(unlocked, c));
}

function ownedKnives(unlocked: ReadonlySet<string>): CosmeticDef[] {
  const knives = KNIFE_IDS.map((id) => cosmetic(knifeById(id)?.cosmeticId ?? ""));
  return knives.filter((c): c is CosmeticDef => owns(unlocked, c));
}

export function options(unlocked: ReadonlySet<string>): Options {
  return {
    outfits: ofSlot(unlocked, "outfit"),
    hats: ofSlot(unlocked, "hat"),
    knives: ownedKnives(unlocked),
    finishes: ofSlot(unlocked, "finish").filter((c) => FINISH_STYLE[c.id]),
    gloves: ofSlot(unlocked, "glove").filter((c) => GLOVE_STYLE[c.id]),
  };
}

/** The spec with anything you don't own put back to the default for that slot (main.ts ownedOnly). */
export function ownedOnly(spec: AvatarSpec, unlocked: ReadonlySet<string>): AvatarSpec {
  const d = defaultAvatar("", null);
  const ok = (id: string | null) => !id || owns(unlocked, cosmetic(id));
  return cleanAvatar({
    ...spec,
    outfit: ok(spec.outfit) ? spec.outfit : d.outfit,
    hat: ok(spec.hat) ? spec.hat : null,
    knife: ok(spec.knife) ? spec.knife : d.knife,
    finish: ok(spec.finish) ? spec.finish : d.finish,
    glove: ok(spec.glove) ? spec.glove : d.glove,
    bg: spec.bg.startsWith("outfit:") && !ok(spec.bg.slice(7)) ? defaultBg(d.outfit) : spec.bg,
  });
}

export interface Wearing {
  outfit?: string | null;
  knife?: string | null;
  finish?: string | null;
  glove?: string | null;
  hat?: string | null;
  body?: string | null;
}

/** What a loadout puts on the avatar; the default pose stays (main.ts wearing). */
export function wearing(l: Wearing): Partial<AvatarSpec> {
  const patch: Partial<AvatarSpec> = {};
  for (const key of ["outfit", "knife", "finish", "glove", "body"] as const) {
    const value = l[key];
    if (value) patch[key] = value;
  }
  patch.hat = l.hat ?? null;
  if (patch.outfit) patch.bg = defaultBg(patch.outfit);
  return patch;
}

export function choicesOf(slot: Slot, o: Options): { id: string; name: string }[] {
  const lists: Record<Slot, CosmeticDef[]> = {
    outfit: o.outfits,
    hat: o.hats,
    knife: o.knives,
    finish: o.finishes,
    glove: o.gloves,
  };
  const items = lists[slot].map((c) => ({ id: c.id, name: c.id === "fin-garden" ? "Plain" : c.name }));
  return slot === "hat" ? [{ id: "", name: "None" }, ...items] : items;
}

export const currentOf = (spec: AvatarSpec, slot: Slot): string => (slot === "hat" ? (spec.hat ?? "") : spec[slot]);

/** What picking `id` in a slot changes (main.ts renderPicker). */
export function pickPatch(spec: AvatarSpec, slot: Slot, id: string): Partial<AvatarSpec> {
  if (slot === "hat") return { hat: id || null };
  if (slot === "outfit") return { outfit: id, bg: spec.bg.startsWith("outfit:") ? defaultBg(id) : spec.bg };
  if (slot === "glove") return { glove: id };
  return { [slot]: id, hand: "knife" };
}

/** How each slot's thumbnails show a choice: the bunny as you've made it, wearing it, posed to show it. */
export function thumbSpec(spec: AvatarSpec, slot: Slot, id: string): AvatarSpec {
  const still = { tilt: 0, ears: 0.4, bg: "clear" };
  switch (slot) {
    case "outfit":
      return cleanAvatar({
        ...spec,
        outfit: id,
        pose: "idle",
        moment: 0.5,
        tilt: 0.2,
        ears: 0.5,
        turn: -15,
        frame: "close",
        zoom: 1,
        bg: "clear",
      });
    case "hat":
      return cleanAvatar({
        ...spec,
        ...still,
        hat: id || null,
        pose: "idle",
        moment: 0.5,
        turn: -15,
        frame: "face",
        zoom: 1.08,
      });
    case "knife":
      return cleanAvatar({ ...spec, ...still, knife: id, hand: "knife", pose: "holdup", moment: 0.3, turn: -30 });
    case "finish":
      return cleanAvatar({ ...spec, ...still, finish: id, hand: "knife", pose: "holdup", moment: 0.3, turn: -30 });
    case "glove":
      return cleanAvatar({ ...spec, ...still, glove: id, hand: "none", pose: "wave", moment: 0.3, turn: -30 });
  }
}

/** Knives, finishes and gloves are framed on the hand; the rest on the bunny. */
export const FOCUS: Partial<Record<Slot, "hand" | "glove">> = { knife: "hand", finish: "hand", glove: "glove" };

/** Empty-hand gestures put the knife away; the knife poses take it back out (main.ts Pose list). */
export function handForPose(spec: AvatarSpec, free: boolean, pose: string): AvatarSpec["hand"] {
  if (free) return "none";
  return ["holdup", "showoff", "swing"].includes(pose) && spec.hand === "none" ? "knife" : spec.hand;
}

/**
 * A wig's hair (the website's v0.0.29 loadout.ts: HAIR_PRESETS, the Ponytail's length). Read from the web code when
 * it has them, so the editor shows the controls once the vendored copy does; null before.
 */
export interface Hair {
  presets: readonly { name: string; hex: string }[];
  defaultHex: string;
  length: { min: number; max: number; default: number };
  lengthHats: readonly string[];
  isWig: (hat: string | null | undefined) => boolean;
}

export function hairOptions(): Hair | null {
  const l = loadoutModule as unknown as Record<string, unknown>;
  const presets = l.HAIR_PRESETS as Hair["presets"] | undefined;
  const isWig = l.isWig as Hair["isWig"] | undefined;
  const hairHex = l.hairHex as ((c: number) => string) | undefined;
  const fallback = l.HAIR_DEFAULT as number | undefined;
  const length = l.HAIR_LENGTH as Hair["length"] | undefined;
  if (!presets || !isWig || !hairHex || fallback === undefined || !length) return null;
  return { presets, defaultHex: hairHex(fallback), length, lengthHats: (l.LENGTH_HATS as string[]) ?? [], isWig };
}
