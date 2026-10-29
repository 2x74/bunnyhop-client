// The first-person cosmetic loadout: which knife you hold, its finish and your gloves. DOM-free and three-free: shared
// by the client (viewmodel, third-person bunny, card editor, replays, rooms) and the API (room roster, tests). The
// catalogue and unlock rules are progression.ts (slots "knife" / "finish" / "glove"); this file says how an equipped
// choice becomes something to draw. See research/COSMETICS-PLAN.md §4.
//
//   item = (knife, finish, glove)
//
// - Finishes are single fixed designs (owner call, v0.0.6): the same Sunset for everyone, no per-player pattern seed
//   and no wear. Loadouts written before that carried `seed` / `wear`; every reader here ignores them.
// - Retired ids (the v0.0.5 finish lineup) read as their replacement (progression.ts FINISH_ALIASES via cosmetic()).
// - Wire forms: the room roster carries the object (`CosmeticLoadout`, JSON), replays carry `packLoadout()` text in an
//   optional trailer (replay.ts). Both are read leniently: anything unknown falls back to the defaults, never an error.

import { cosmetic, DEFAULT_COSMETICS, HAIR_HATS, HAIR_LENGTH, LENGTH_HATS, hairLengthOf, type CosmeticSlot } from "./progression";
export { HAIR_LENGTH, LENGTH_HATS, hairLengthOf };

export interface CosmeticLoadout {
  /** progression.ts "knife-*" id. */
  knife: string;
  /** progression.ts "fin-*" id ("fin-garden" = plain carrot, no finish). */
  finish: string;
  /** progression.ts "glove-*" id. */
  glove: string;
  /**
   * Overall place held when this loadout was taken (1 / 2 / 3: the crown on the bunny; progression.ts crownOf). Not a
   * choice: the server derives it from the rank board for the roster; absent = no crown.
   */
  crown?: 1 | 2 | 3;
  /**
   * progression.ts "hat-*" id (owner only, role-held; absent = none). Wins over `crown` on the bunny: a hat replaces
   * the rank crown while it's on (player/bunny/hats.ts headwear()).
   */
  hat?: string;
  /** Bunny build; omitted by older loadouts = Model A. Tek keeps its own shape. */
  body?: "body-a" | "body-b";
  /**
   * Bunny colourway (progression.ts "outfit-*" id). Only replay trailers carry it (v0.0.29+), so a replay shows the
   * colourway the run was played in; rooms send the colourway beside the loadout, and every other reader ignores it.
   * Absent = unknown (older replays: the viewer asks the account).
   */
  outfit?: string;
  /**
   * The wig's hair colour (sRGB 0xRRGGBB), only while a wig is the hat (isWig; Supporter items, so the saved choice is
   * checked like the hat). Absent = HAIR_DEFAULT. Older readers drop it and draw the default.
   */
  hairColor?: number;
  /**
   * The ponytail's length (a whole percent of the built length, progression.ts HAIR_LENGTH), only while the Ponytail is
   * the hat (LENGTH_HATS) and not the default. Absent = 100. Older readers drop it and draw the built length.
   */
  hairLength?: number;
  /**
   * RESERVED, not implemented: a player-picked colour (sRGB 0xRRGGBB) for finishes that offer one (FinishStyle.tintable).
   * Nothing writes, reads, validates or sends it yet; cleanLoadout drops it. Plan: research/COSMETICS-PLAN.md §4.1.
   */
  tint?: number;
}

/** Hats that are hair (player/bunny/wigs.ts): the standard bunny wears its hood down for them, and they take hairColor. */
export const WIGS = HAIR_HATS;
export const isWig = (hat: string | null | undefined): boolean => !!hat && WIGS.includes(hat);
/** Hair colour when none is picked (dark chestnut). */
export const HAIR_DEFAULT = 0x5a3426;
/** Hair colour presets for the picker (sRGB). Any other colour is allowed. */
export const HAIR_PRESETS: readonly { name: string; hex: string }[] = [
  { name: "Black", hex: "#1f1b1d" },
  { name: "Dark brown", hex: "#3d2620" },
  { name: "Chestnut", hex: "#5a3426" },
  { name: "Copper", hex: "#a2512b" },
  { name: "Blonde", hex: "#d9b46c" },
  { name: "Platinum", hex: "#e8e2d4" },
  { name: "Pink", hex: "#f29bbf" },
  { name: "Lavender", hex: "#a98be0" },
  { name: "Teal", hex: "#2fa59a" },
  { name: "Red", hex: "#b8262f" },
];

/** A colour as saved ("#rrggbb", any case) or carried (0xRRGGBB) -> 0xRRGGBB, else null. */
export function hairColorOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null;
  if (typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v)) return parseInt(v.replace("#", ""), 16);
  return null;
}
export const hairHex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

export const DEFAULT_KNIFE = DEFAULT_COSMETICS.knife!;
export const DEFAULT_FINISH = DEFAULT_COSMETICS.finish!;
export const DEFAULT_GLOVE = DEFAULT_COSMETICS.glove!;
export const DEFAULT_LOADOUT: CosmeticLoadout = Object.freeze({ knife: DEFAULT_KNIFE, finish: DEFAULT_FINISH, glove: DEFAULT_GLOVE });

// ---------------------------------------------------------------------------------------------
// Render data (what the shaders need per item). Kept here so the API, tests and the UI agree on what exists.

/**
 * Shader finish designs (viewmodel/finishes/shader.ts FINISH_CODE): one per finish, each a fixed design baked into its
 * GLSL. "founder": Founder's Gold, the owner's finish (role-held in progression.ts).
 */
export type FinishKind = "none" | "sunset" | "ember" | "tigerlily" | "nebula" | "dewweb" | "frost" | "heartbeet" | "fourleaf" | "founder" | "geode" | "rift" | "spectrum" | "goldleaf" | "aurora" | "contour" | "meteor" | "hourglass" | "lantern" | "wildflower" | "tally" | "devgrid" | "emerald" | "ruby" | "sapphire" | "pearl" | "chromatic" | "chrome";

export interface FinishStyle {
  kind: FinishKind;
  /** RESERVED for the future player tint (CosmeticLoadout.tint): whether this design takes one. Unused today. */
  tintable?: boolean;
}

export const FINISH_STYLE: Record<string, FinishStyle> = {
  "fin-garden": { kind: "none" },
  "fin-sunset": { kind: "sunset" },
  "fin-ember": { kind: "ember" },
  "fin-tigerlily": { kind: "tigerlily" },
  "fin-nebula": { kind: "nebula" },
  "fin-dewweb": { kind: "dewweb" },
  "fin-frost": { kind: "frost" },
  "fin-heartbeet": { kind: "heartbeet" },
  "fin-fourleaf": { kind: "fourleaf" },
  "fin-founder": { kind: "founder" },
  "fin-geode": { kind: "geode" },
  "fin-rift": { kind: "rift" },
  "fin-spectrum": { kind: "spectrum" },
  "fin-goldleaf": { kind: "goldleaf" },
  "fin-aurora": { kind: "aurora" },
  // Supporter metals (v0.0.29, standalone: polished metal, no pattern).
  "fin-emerald-steel": { kind: "emerald" },
  "fin-ruby-steel": { kind: "ruby" },
  "fin-sapphire-steel": { kind: "sapphire" },
  "fin-pearl": { kind: "pearl" },
  "fin-chromatic": { kind: "chromatic" },
  "fin-chrome": { kind: "chrome" },
  // Batch 1 (progression.ts, research/PROGRESSION-BATCH1.md), earned by playing.
  "fin-contour": { kind: "contour" },
  "fin-meteor": { kind: "meteor" },
  "fin-hourglass": { kind: "hourglass" },
  "fin-lantern": { kind: "lantern" },
  "fin-wildflower": { kind: "wildflower" },
  "fin-tally": { kind: "tally" },
  "fin-devgrid": { kind: "devgrid" },
};

/** Render data of a finish id (retired ids resolve to their replacement; unknown -> the plain carrot). */
export const finishStyle = (id: string | null | undefined): FinishStyle => FINISH_STYLE[cosmetic(id)?.id ?? ""] ?? FINISH_STYLE[DEFAULT_FINISH];

/**
 * Glove styles: each is its own geometry on the hands (viewmodel/gloves/fp.ts first person, gloves/tp.ts on the bunny)
 * with per-part materials (leather, knit, cloth wrap, rubber, fuzz, hard plate, canvas, velcro; gloves/glsl.ts), and a
 * colourway fills its five colour slots. A glove item is (style, colourway): `glove-<style>-<colourway>`. "knit" is the
 * original glove and follows the bunny colourway (palette glove slot + accent strap); exposed paw (fingerless styles,
 * open backs) is the colourway's glove colour too.
 */
export type GloveStyleId = "knit" | "sport" | "driver" | "wraps" | "moto" | "specialist" | "paws" | "garden" | "plush" | "bune";
export const GLOVE_STYLE_IDS: readonly GloveStyleId[] = ["knit", "sport", "driver", "wraps", "moto", "specialist", "paws", "garden", "plush", "bune"];
export interface GloveStyle {
  style: GloveStyleId;
  /**
   * sRGB hex colour slots (what each means per style: viewmodel/gloves/fp.ts). base = main shell, fingers = second panel
   * colour, tips = accent (plates, pads, dipped tips), strap = strap / cuff / trim, detail = stitching, snaps, logos.
   * Unused for knit.
   */
  base: number;
  fingers: number;
  tips: number;
  strap: number;
  detail: number;
}

const G = (style: GloveStyleId, base: number, fingers: number, tips: number, strap: number, detail: number): GloveStyle => ({ style, base, fingers, tips, strap, detail });

/**
 * Every glove item -> (style, colourway). Ids are stable forever (saved loadouts, rosters and replay trailers carry
 * them); a look can be retuned here without breaking anything. v0.0.5 retuned Sport · Pandora (was neon green on
 * purple) to plum / lilac with amber stitching so it sits with the bunny palettes.
 */
export const GLOVE_STYLE: Record<string, GloveStyle> = {
  "glove-plush": G("plush", 0x39343b, 0x39343b, 0xe8d7b9, 0xc9ad85, 0xffedcc),
  "glove-bune": G("bune", 0xf2e8d8, 0x222631, 0xffbd43, 0xd7c9b3, 0xffe5a0),
  "glove-knit": G("knit", 0, 0, 0, 0, 0),
  // Sport: neoprene shell, padded back panel, finger-gap side panels, velcro wrist strap.
  "glove-sport-carrot": G("sport", 0xff8a2a, 0x2f7d34, 0x58c64a, 0xfff1e0, 0xfff1e0),
  "glove-sport-vice": G("sport", 0xff6fae, 0x3fd2e4, 0x3fd2e4, 0xf4f4f8, 0xffffff),
  "glove-sport-pandora": G("sport", 0x5b2a86, 0xc9a8ff, 0xc9a8ff, 0xf1e8ff, 0xffb43c),
  "glove-sport-superconductor": G("sport", 0x9aa2b0, 0x2a62e8, 0x2a62e8, 0xe8eef8, 0x1c2230),
  // Community (progression.ts DISCORD_LINK): blurple shell, a near-black padded back and finger panels, a green "online"
  // stripe and strap tab, white strap and stitching. Colour only: no logos on cosmetics.
  "glove-sport-blurple": G("sport", 0x5865f2, 0x23262e, 0x57f287, 0xf4f5ff, 0xffffff),
  // Driver: thin leather, perforated knuckles, open back with a snap tab, short hem.
  "glove-driver-tan": G("driver", 0xc08a55, 0xb47d4a, 0x8a5a33, 0x6b4426, 0xf2e6d0),
  "glove-driver-racing": G("driver", 0x2f5a3a, 0x2a5234, 0x1f3d27, 0xece5d8, 0xffb43c),
  "glove-driver-cocoa": G("driver", 0x4a3326, 0x433022, 0x33241a, 0xff8a2a, 0xff8a2a),
  // Hand wraps: cloth wrapped round the palm, knuckles and wrist, bare paw fingertips, loose tails.
  "glove-wraps-ember": G("wraps", 0xd8433a, 0xc23a32, 0xd8433a, 0x2a2e38, 0xf2e6d0),
  "glove-wraps-ducttape": G("wraps", 0xa3a9b1, 0x949aa3, 0xa3a9b1, 0x5d636c, 0x2a2e38),
  "glove-wraps-spruce": G("wraps", 0x3f7a5a, 0x386e51, 0x3f7a5a, 0xece5d8, 0xffb43c),
  // Moto: padded shell, hard knuckle plate and finger guards, long cuff.
  "glove-moto-spearmint": G("moto", 0xe9f5ef, 0x24423a, 0x2fd39a, 0x24423a, 0x2fd39a),
  "glove-moto-eclipse": G("moto", 0x1d2130, 0x2b3142, 0xffb43c, 0x14171e, 0xffb43c),
  "glove-moto-boom": G("moto", 0xff7a3c, 0xff4f8b, 0x1b1b22, 0x1b1b22, 0xffd45e),
  // Community (progression.ts DISCORD_BOOSTER): deep violet shell and pads, glossy pink plates, guards and cuff strap.
  "glove-moto-afterglow": G("moto", 0x34205e, 0x22143f, 0xf47fff, 0x1c1030, 0xffc4ff),
  // Specialist: tactical fingerless, rubber palm grip, gauntlet cuff with a pull tab.
  "glove-specialist-crimson": G("specialist", 0x7a1f2b, 0x1d1a22, 0xb02a3a, 0x7a1f2b, 0xffb43c),
  "glove-specialist-forest": G("specialist", 0x3d5a3a, 0x232a22, 0x6f8f5a, 0x3d5a3a, 0xe8dcc0),
  "glove-specialist-arctic": G("specialist", 0xe8eef6, 0x8fa3b8, 0x49b6ff, 0xe8eef6, 0x49b6ff),
  // Paw Pads: fuzzy mitts, toe-bean fingertips, a paw print on the back, fluffy cuff.
  "glove-paws-snow": G("paws", 0xf7f4ef, 0xf7f4ef, 0xffa3c0, 0xffffff, 0xffa3c0),
  "glove-paws-cocoa": G("paws", 0x7a5236, 0x7a5236, 0xf2a7a0, 0xe9d7c4, 0xf2a7a0),
  "glove-paws-sakura": G("paws", 0xffd3e2, 0xffd3e2, 0xff7aa8, 0xffffff, 0xff7aa8),
  // Garden: canvas gloves, rubber-dipped fingertips, elastic cuff band.
  "glove-garden-classic": G("garden", 0xe8dcc0, 0xe8dcc0, 0x2e7d4a, 0x2e7d4a, 0xb9a27a),
  "glove-garden-tulip": G("garden", 0xf1e6d6, 0xf1e6d6, 0xe0457b, 0xffd45e, 0xc9a27a),
  "glove-garden-moss": G("garden", 0xc9c2a3, 0xc9c2a3, 0x4d6b2a, 0x8a5a2b, 0x8f8566),
  // Batch 1 (progression.ts, research/PROGRESSION-BATCH1.md), earned by playing.
  "glove-garden-buttercup": G("garden", 0xf1ead2, 0xf1ead2, 0xffc93a, 0x4f9a3a, 0xb9a27a),
  "glove-driver-saddle": G("driver", 0x8a4f2a, 0x7e4726, 0x5e341b, 0xf2e6d0, 0xf2e6d0),
  "glove-paws-hare": G("paws", 0xa07850, 0xa07850, 0x3a2a20, 0xf1e6d6, 0x3a2a20),
  "glove-wraps-chalk": G("wraps", 0xf2efe8, 0xe6e2d8, 0xf2efe8, 0x8a8f99, 0xc9c4b8),
  "glove-specialist-nightshift": G("specialist", 0x1b1d22, 0x2a2d33, 0xffa63a, 0x1b1d22, 0xffa63a),
  "glove-moto-racer": G("moto", 0xf4f4f6, 0xd8262f, 0xd8262f, 0x1b1b22, 0x1b1b22),
  "glove-garden-pumpkin": G("garden", 0xefe2c6, 0xefe2c6, 0xe0701c, 0x3d6b2a, 0x8a5a2b),
  "glove-moto-devgrid": G("moto", 0x6b6e73, 0x8c8f94, 0xe8862a, 0x4d5054, 0xffffff),
  // Supporter (progression.ts SUPPORTER): the Geode. Deep teal shell and cuff, a dark stone grip, amethyst knuckle
  // pads, crystal-aqua detail.
  // Supporter: High Roller (black leather, felt-green tips, gold snap and stitching) and Borealis (navy, aurora panels).
  "glove-driver-highroller": G("driver", 0x17181c, 0x1d1e23, 0x0f5a3a, 0xe0b13a, 0xe0b13a),
  "glove-sport-borealis": G("sport", 0x14203d, 0x3ff0a0, 0x9a6bff, 0xe8f6ff, 0x5dffb0),
  "glove-specialist-geode": G("specialist", 0x1d6b74, 0x23232e, 0x7a5ce8, 0x1d6b74, 0x5ff2df),
};

export const gloveStyle = (id: string | null | undefined): GloveStyle => (id && GLOVE_STYLE[id]) || GLOVE_STYLE[DEFAULT_GLOVE];

// ---------------------------------------------------------------------------------------------
// Reading

const slotId = (slot: CosmeticSlot, v: unknown, fallback: string): string => {
  const c = typeof v === "string" ? cosmetic(v) : null;
  return c && c.slot === slot ? c.id : fallback;
};

/**
 * The loadout a player wears, from their saved cosmetic choice (progression CosmeticChoice; unknown / wrong-slot ids
 * fall back to the defaults, retired ids read as their replacement). Unlocks are checked where choices are saved and
 * read (the API).
 */
export function loadoutFor(choice: { knife?: unknown; finish?: unknown; glove?: unknown; hat?: unknown; body?: unknown; hairColor?: unknown; hairLength?: unknown } | null | undefined, crown: 1 | 2 | 3 | null = null): CosmeticLoadout {
  const c = choice ?? {};
  const l: CosmeticLoadout = { knife: slotId("knife", c.knife, DEFAULT_KNIFE), finish: slotId("finish", c.finish, DEFAULT_FINISH), glove: slotId("glove", c.glove, DEFAULT_GLOVE) };
  if (crown) l.crown = crown;
  const hat = slotId("hat", c.hat, "");
  if (hat) l.hat = hat;
  if (c.body === "body-b") l.body = "body-b";
  const hair = isWig(hat) ? hairColorOf(c.hairColor) : null;
  if (hair !== null) l.hairColor = hair;
  const length = LENGTH_HATS.includes(hat) ? hairLengthOf(c.hairLength) : null;
  if (length !== null && length !== HAIR_LENGTH.default) l.hairLength = length;
  return l;
}

const crownIn = (v: unknown): 1 | 2 | 3 | null => (v === 1 || v === 2 || v === 3 ? v : null);

/**
 * Lenient read of a loadout object from the wire (room roster, the local cache): null when absent, defaults for
 * anything unknown. Fields from older writers (v0.0.5 `seed` / `wear`) and anything else are dropped.
 */
export function cleanLoadout(raw: unknown): CosmeticLoadout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return loadoutFor(r, crownIn(r.crown));
}

export const sameLoadout = (a: CosmeticLoadout | null | undefined, b: CosmeticLoadout | null | undefined) =>
  !!a && !!b && a.knife === b.knife && a.finish === b.finish && a.glove === b.glove && (a.crown ?? null) === (b.crown ?? null) && (a.hat ?? null) === (b.hat ?? null) && (a.body ?? "body-a") === (b.body ?? "body-a") && (a.outfit ?? null) === (b.outfit ?? null) && (a.hairColor ?? null) === (b.hairColor ?? null) && (a.hairLength ?? null) === (b.hairLength ?? null);

export const isDefaultLoadout = (l: CosmeticLoadout) => l.knife === DEFAULT_KNIFE && l.finish === DEFAULT_FINISH && l.glove === DEFAULT_GLOVE && l.body !== "body-b";

// ---------------------------------------------------------------------------------------------
// Packed text form: "2;<knife>;<finish>;<glove>[;<crown>[;<hat>[;<body>[;<outfit>[;<hair>[;<length>]]]]]]". Empty tail
// fields are placeholders; absent body means Model A, absent outfit an unknown colourway; hair is the wig's colour as 6
// hex digits, length the ponytail's length as a whole percent (absent = the defaults). Older readers ignore new fields
// (a v2 reader takes the fields it knows and stops), so every build keeps the v2 replay format.
// v1 (v0.0.5 replays) was "1;<knife>;<finish>;<seed>;<wear × 10000>;<glove>[;<crown>]": still read, seed / wear ignored.

const PACK_VERSION = "2";

export function packLoadout(l: CosmeticLoadout): string {
  const outfit = outfitId(l.outfit);
  const tail: (string | number)[] = [l.crown ?? "", l.hat ?? "", l.body === "body-b" ? l.body : "", outfit ?? "", l.hairColor !== undefined ? hairHex(l.hairColor).slice(1) : "", l.hairLength ?? ""];
  while (tail.length && tail[tail.length - 1] === "") tail.pop();
  return [PACK_VERSION, l.knife, l.finish, l.glove, ...tail].join(";");
}

/** A known colourway id (retired ids read as their replacement), else null. */
const outfitId = (v: unknown): string | null => {
  const c = typeof v === "string" && v ? cosmetic(v) : null;
  return c?.slot === "outfit" ? c.id : null;
};

/** Inverse of packLoadout (v2, or a v1 trailer); null for anything else. Unknown ids fall back to the defaults. */
export function unpackLoadout(s: string | null | undefined): CosmeticLoadout | null {
  if (!s || s.length > 200) return null;
  const f = s.split(";");
  if (f[0] === "2" && f.length >= 4) {
    const l = cleanLoadout({ knife: f[1], finish: f[2], glove: f[3], crown: f[4] ? Number(f[4]) : null, hat: f[5], body: f[6], hairColor: f[8] ? `#${f[8]}` : undefined, hairLength: f[9] && /^\d+$/.test(f[9]) ? Number(f[9]) : undefined })!;
    const outfit = outfitId(f[7]);
    return outfit ? { ...l, outfit } : l;
  }
  if (f[0] === "1" && f.length >= 6) {
    if (!Number.isInteger(Number(f[3])) || !Number.isInteger(Number(f[4]))) return null;
    return cleanLoadout({ knife: f[1], finish: f[2], glove: f[5], crown: f[6] ? Number(f[6]) : null });
  }
  return null;
}
