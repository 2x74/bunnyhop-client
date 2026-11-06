// DEV ONLY (glovelab.html ?concepts=1, tools/cosmetics/set-sheets.ts): v0.0.38 set concepts the owner picks from, as
// render data the lab can draw. Nothing here is in the catalogue (progression.ts): the picks that were built live there
// under their own ids (e.g. Lookout, Workbench, Keyholder, Founder's glove, Tidepool); the rest are only drawn here.
// Ids start with "concept-" so they can never collide with a real item.

import { GLOVE_STYLE, type GloveStyle, type GloveStyleId } from "../../loadout";
import { COLOURWAYS, type Colourway } from "../../player/bunny/palettes";

export interface SetConcept {
  id: string;
  /** Who it's for: a role, or "supporter". */
  for: "moderator" | "contributor" | "admin" | "owner" | "supporter";
  name: string;
  /** One plain line on the theme. */
  line: string;
  /** Built in this lane (the recommended pick): its real catalogue ids. */
  built?: { glove: string; outfit: string | null };
  glove: [GloveStyleId, number, number, number, number, number];
  outfit: Colourway | null;
  ghost: [string, string];
  trail: [string, string];
  /** Card: background CSS and frame CSS (the profile card's --bg-card / --frame), and the title shown on it. */
  card: { bg: string; frame: string; title: string };
  /** Slots without a render here (finish, hat): one line each on the idea. */
  notes?: string[];
}

const cw = (hoodie: number, trim: number, pants: number, pantsTrim: number, shoe: number, face: number, glove: number, detail: number, accent: number): Colourway => ({ hoodie, trim, pants, pantsTrim, shoe, face, glove, detail, accent });

export const SET_CONCEPTS: SetConcept[] = [
  // --- Moderators
  {
    id: "lookout", for: "moderator", name: "Lookout", line: "Storm navy, hi-vis lime, reflective silver. Someone on watch.",
    built: { glove: "glove-specialist-lookout", outfit: "outfit-lookout" },
    glove: ["specialist", 0x1b2740, 0x141a26, 0xc8f53a, 0x1b2740, 0xd8dee8],
    outfit: null, ghost: ["#c8f53a", "#d8dee8"], trail: ["#c8f53a", "#d8dee8"],
    card: { bg: "linear-gradient(118deg, transparent 38%, rgba(200,245,58,.16) 46%, rgba(200,245,58,.03) 60%, transparent 70%), radial-gradient(60% 40% at 20% 0%, rgba(216,222,232,.14), transparent 70%), linear-gradient(170deg, #1b2740, #111a2c 55%, #0a101c)", frame: "repeating-linear-gradient(135deg, #c8f53a 0 14px, #d8dee8 14px 20px, #1b2740 20px 26px)", title: "Moderator" },
    notes: ["Finish idea: navy steel with one lime safety stripe along the spine.", "Hat idea: a lime cap with a reflective band."],
  },
  {
    id: "lighthouse", for: "moderator", name: "Lighthouse", line: "White and signal red bands, a warm lamp glow.",
    glove: ["moto", 0xf4f2ee, 0xd8262f, 0xd8262f, 0x1b2333, 0xffd84a],
    outfit: cw(0xf4f2ee, 0xd8262f, 0x1b2333, 0xd8262f, 0xffffff, 0x0b0e16, 0xd8262f, 0xffffff, 0xffd84a), ghost: ["#ffd84a", "#ffffff"], trail: ["#ffffff", "#d8262f"],
    card: { bg: "radial-gradient(50% 35% at 80% 10%, rgba(255,216,74,.35), transparent 70%), linear-gradient(170deg, #182235, #0d1422)", frame: "repeating-linear-gradient(90deg, #f4f2ee 0 18px, #d8262f 18px 36px)", title: "Moderator" },
    notes: ["Hat idea: a small lamp-room crown that glows.", "Finish idea: red and white bands with a lit tip."],
  },
  {
    id: "nightwatch", for: "moderator", name: "Night Watch", line: "Indigo, moon silver and a soft blue lantern.",
    glove: ["aviator", 0x1f2457, 0x2b3170, 0x7fb2ff, 0xdfe5f2, 0xdfe5f2],
    outfit: cw(0x1f2457, 0xdfe5f2, 0x141838, 0x7fb2ff, 0xe8ecf7, 0x05060f, 0x1f2457, 0xffffff, 0x7fb2ff), ghost: ["#7fb2ff", "#dfe5f2"], trail: ["#dfe5f2", "#7fb2ff"],
    card: { bg: "radial-gradient(18% 18% at 82% 18%, rgba(223,229,242,.55), transparent 70%), linear-gradient(170deg, #1f2457, #0f122e)", frame: "linear-gradient(135deg, #3a4180, #dfe5f2 30%, #7fb2ff 60%, #1f2457)", title: "Moderator" },
  },
  // --- Contributors (the Contributor badge's teal #3fd4c6 and ink #0e1428)
  {
    id: "workbench", for: "contributor", name: "Workbench", line: "Ink canvas, the badge's teal, brass. The workshop.",
    built: { glove: "glove-garden-workbench", outfit: "outfit-workbench" },
    glove: ["garden", 0x2b3448, 0x2b3448, 0x3fd4c6, 0xc9a24a, 0x8a7a5a],
    outfit: null, ghost: ["#3fd4c6", "#c9a24a"], trail: ["#3fd4c6", "#c9a24a"],
    card: { bg: "repeating-linear-gradient(90deg, rgba(63,212,198,.12) 0 1px, transparent 1px 12px) 0 100% / 100% 14px no-repeat, radial-gradient(60% 45% at 85% 110%, rgba(201,162,74,.28), transparent 70%), linear-gradient(165deg, #2b3448, #18202f 60%, #0e1420)", frame: "linear-gradient(135deg, #c9a24a, #3fd4c6 16%, #1f8f86 50%, #3fd4c6 84%, #c9a24a)", title: "Contributor" },
    notes: ["Finish idea: teal anodised blade with brass ruler ticks on the spine.", "Hat idea: a pencil tucked behind one ear."],
  },
  {
    id: "draftsman", for: "contributor", name: "Draftsman", line: "Blueprint blue with white linework.",
    glove: ["dress", 0x1d4f91, 0x1d4f91, 0xffffff, 0x10284a, 0xbfe0ff],
    outfit: cw(0x1d4f91, 0xffffff, 0x10284a, 0xffffff, 0xf4f8ff, 0x050d1c, 0x1d4f91, 0xffffff, 0xbfe0ff), ghost: ["#bfe0ff", "#ffffff"], trail: ["#ffffff", "#3f86e0"],
    card: { bg: "repeating-linear-gradient(0deg, rgba(255,255,255,.08) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(255,255,255,.08) 0 1px, transparent 1px 24px), linear-gradient(160deg, #1d4f91, #10284a)", frame: "linear-gradient(135deg, #ffffff, #bfe0ff 50%, #ffffff)", title: "Contributor" },
  },
  {
    id: "patchnotes", for: "contributor", name: "Patch Notes", line: "Paper cream, teal ink, a red pen.",
    glove: ["mitts", 0xf1ead9, 0x3fd4c6, 0xf1ead9, 0x2b3448, 0xe24a3b],
    outfit: cw(0xf1ead9, 0x3fd4c6, 0x2b3448, 0x3fd4c6, 0xffffff, 0x0e1428, 0x3fd4c6, 0x0e1428, 0xe24a3b), ghost: ["#3fd4c6", "#e24a3b"], trail: ["#f1ead9", "#3fd4c6"],
    card: { bg: "repeating-linear-gradient(0deg, rgba(63,212,198,.18) 0 1px, transparent 1px 22px), linear-gradient(170deg, #f1ead9, #ddd3bd)", frame: "linear-gradient(135deg, #3fd4c6, #0e1428 50%, #e24a3b)", title: "Contributor" },
  },
  // --- Admins
  {
    id: "keyholder", for: "admin", name: "Keyholder", line: "Oxblood and polished silver.",
    built: { glove: "glove-dress-keyholder", outfit: "outfit-keyholder" },
    glove: ["dress", 0x5a1420, 0x5a1420, 0xcfd6e0, 0x3a0c14, 0xe8edf3],
    outfit: null, ghost: ["#e8edf3", "#c0283c"], trail: ["#e8edf3", "#8a1c2c"],
    card: { bg: "radial-gradient(70% 45% at 50% -10%, rgba(232,237,243,.22), transparent 70%), radial-gradient(60% 50% at 10% 110%, rgba(192,40,60,.3), transparent 70%), linear-gradient(170deg, #5a1420, #2a0a10 60%, #16050a)", frame: "linear-gradient(135deg, #5a1420, #cfd6e0 22%, #8c96a6 44%, #ffffff 60%, #a9b2c0 80%, #5a1420)", title: "Staff" },
    notes: ["Finish idea: oxblood lacquer with one thin silver inlay line.", "Hat idea: a silver key on a ribbon round the hood."],
  },
  {
    id: "marshal", for: "admin", name: "Marshal", line: "Royal blue, white and gold.",
    glove: ["moto", 0x1f3fa8, 0x18318a, 0xe0b13a, 0xffffff, 0xffe08a],
    outfit: cw(0x1f3fa8, 0xffffff, 0x101c4a, 0xe0b13a, 0xffffff, 0x060a1c, 0x18318a, 0xffffff, 0xffd45e), ghost: ["#ffd45e", "#ffffff"], trail: ["#ffffff", "#1f3fa8"],
    card: { bg: "radial-gradient(60% 40% at 50% -5%, rgba(255,212,94,.25), transparent 70%), linear-gradient(170deg, #1f3fa8, #0d1a52)", frame: "linear-gradient(135deg, #e0b13a, #ffffff 30%, #1f3fa8 50%, #ffffff 70%, #e0b13a)", title: "Staff" },
  },
  {
    id: "sentinel", for: "admin", name: "Sentinel", line: "Graphite with an electric violet line.",
    glove: ["specialist", 0x2a2d33, 0x1b1d22, 0x8a5cff, 0x2a2d33, 0xc9b8ff],
    outfit: cw(0x2a2d33, 0x8a5cff, 0x1b1d22, 0x8a5cff, 0xe9e6f5, 0x08080b, 0x1b1d22, 0xc9b8ff, 0x9a70ff), ghost: ["#8a5cff", "#c9b8ff"], trail: ["#8a5cff", "#2a2d33"],
    card: { bg: "linear-gradient(90deg, transparent 49.6%, rgba(138,92,255,.6) 50%, transparent 50.4%), linear-gradient(170deg, #2a2d33, #121317)", frame: "linear-gradient(135deg, #2a2d33, #8a5cff 50%, #2a2d33)", title: "Staff" },
  },
  // --- The owner: the Founder set (violet, carrot orange, gold, cyan) only lacked a glove and a card background.
  {
    id: "founder-aviator", for: "owner", name: "Founder · Aviator", line: "The Founder colours as a flying gauntlet: violet, a carrot knuckle panel, gold strap, cyan buckle.",
    built: { glove: "glove-aviator-founder", outfit: "outfit-founder" },
    glove: ["aviator", 0x241450, 0xff7a1a, 0xffc23d, 0xfff4dc, 0x3ff0ff],
    outfit: null, ghost: ["#3ff0ff", "#3ff0ff"], trail: ["#ff7a1a", "#ff7a1a"],
    card: { bg: "radial-gradient(80% 50% at 50% 118%, rgba(255,122,26,.42), transparent 70%), radial-gradient(40% 30% at 88% 6%, rgba(63,240,255,.22), transparent 70%), linear-gradient(170deg, #241450, #1a0f3a 55%, #0e0822)", frame: "linear-gradient(135deg, #241450, #ff7a1a 18%, #ffd45e 34%, #3ff0ff 50%, #ffd45e 66%, #ff7a1a 82%, #241450)", title: "Owner" },
  },
  {
    id: "founder-dress", for: "owner", name: "Founder · Dress", line: "Violet dress gloves, a carrot cuff, gold points, a cyan button.",
    glove: ["dress", 0x241450, 0x241450, 0xffc23d, 0xff7a1a, 0x3ff0ff],
    outfit: COLOURWAYS["outfit-founder"], ghost: ["#3ff0ff", "#3ff0ff"], trail: ["#ff7a1a", "#ff7a1a"],
    card: { bg: "radial-gradient(70% 45% at 50% -10%, rgba(255,212,94,.3), transparent 70%), linear-gradient(170deg, #241450, #0e0822)", frame: "linear-gradient(135deg, #241450, #ff7a1a 18%, #ffd45e 34%, #3ff0ff 50%, #ffd45e 66%, #ff7a1a 82%, #241450)", title: "Owner" },
  },
  {
    id: "founder-moto", for: "owner", name: "Founder · Moto", line: "Violet shell, gold plates, a carrot cuff strap.",
    glove: ["moto", 0x241450, 0x1a0f3a, 0xffc23d, 0xff7a1a, 0x3ff0ff],
    outfit: COLOURWAYS["outfit-founder"], ghost: ["#3ff0ff", "#3ff0ff"], trail: ["#ff7a1a", "#ff7a1a"],
    card: { bg: "radial-gradient(60% 40% at 15% 110%, rgba(63,240,255,.25), transparent 70%), linear-gradient(170deg, #241450, #0e0822)", frame: "linear-gradient(135deg, #241450, #ff7a1a 18%, #ffd45e 34%, #3ff0ff 50%, #ffd45e 66%, #ff7a1a 82%, #241450)", title: "Owner" },
  },
  // --- Supporter sets
  {
    id: "tidepool", for: "supporter", name: "Tidepool", line: "Sea glass, coral and pearl. A starfish on the hood.",
    built: { glove: "glove-mitts-tidepool", outfit: "outfit-tidepool" },
    glove: ["mitts", 0x5fc8b8, 0xff7f6e, 0x5fc8b8, 0xf3ece2, 0xfff4e6],
    outfit: null, ghost: ["#7fe0cf", "#ff8a78"], trail: ["#f3ece2", "#5fc8b8"],
    card: { bg: "radial-gradient(70% 50% at 40% -12%, rgba(159,242,226,.45), transparent 70%), radial-gradient(45% 35% at 92% 108%, rgba(255,127,110,.32), transparent 70%), repeating-radial-gradient(ellipse 60% 30% at 40% 30%, rgba(255,255,255,.05) 0 2px, transparent 2px 22px), linear-gradient(175deg, #13504c, #0c3533 55%, #072120)", frame: "linear-gradient(135deg, #2f8f86, #9ff2e2 24%, #f3ece2 42%, #ff7f6e 58%, #9ff2e2 78%, #2f8f86)", title: "Beachcomber" },
    notes: ["Finish: Pearl (the supporter metal) joins the set.", "Finish idea for later: Tide, light rippling over a sea-glass blade."],
  },
  {
    id: "nocturne", for: "supporter", name: "Nocturne", line: "A moonlit garden: plum, moon silver, pale night flowers.",
    glove: ["dress", 0x2a1838, 0x2a1838, 0xdfe3f0, 0xd8b8ff, 0xdfe3f0],
    outfit: cw(0x2a1838, 0xd8b8ff, 0x170d20, 0xdfe3f0, 0xf1eef8, 0x07040a, 0x2a1838, 0xffffff, 0xd8b8ff), ghost: ["#d8b8ff", "#dfe3f0"], trail: ["#dfe3f0", "#9a6bd8"],
    card: { bg: "radial-gradient(14% 14% at 80% 16%, rgba(241,238,248,.6), transparent 70%), radial-gradient(60% 40% at 20% 110%, rgba(216,184,255,.3), transparent 70%), linear-gradient(170deg, #2a1838, #120a18)", frame: "linear-gradient(135deg, #2a1838, #dfe3f0 35%, #d8b8ff 60%, #2a1838)", title: "Night Gardener" },
    notes: ["Hat idea: a ring of moonflowers that open slowly.", "Finish idea: Moonflower, pale flowers opening along a plum blade."],
  },
  {
    id: "taffy", for: "supporter", name: "Taffy", line: "A sweet shop: strawberry, mint and cream.",
    glove: ["mitts", 0x9ff0d0, 0xff8fb0, 0x9ff0d0, 0xfff4e6, 0xff8fb0],
    outfit: cw(0xfff4e6, 0xff8fb0, 0x9ff0d0, 0xff8fb0, 0xffffff, 0x2a1d26, 0x9ff0d0, 0xff8fb0, 0xff6f9c), ghost: ["#ff8fb0", "#9ff0d0"], trail: ["#ff8fb0", "#9ff0d0"],
    card: { bg: "repeating-linear-gradient(135deg, rgba(255,143,176,.22) 0 18px, rgba(255,244,230,.12) 18px 36px, rgba(159,240,208,.22) 36px 54px), linear-gradient(170deg, #3a2030, #1c1018)", frame: "repeating-linear-gradient(135deg, #ff8fb0 0 10px, #fff4e6 10px 20px, #9ff0d0 20px 30px)", title: "Sweet Tooth" },
    notes: ["Hat idea: a swirl lollipop tucked in the hood.", "Finish idea: soft candy stripes that slide slowly."],
  },
  // --- Standalone supporter gloves (ideas)
  {
    id: "opera", for: "supporter", name: "Dress · Opera", line: "Black dress gloves with a crimson velvet cuff.",
    glove: ["dress", 0x101012, 0x101012, 0x3a3a40, 0x8a1020, 0xd9dbe0],
    outfit: null, ghost: ["#c0283c", "#ffffff"], trail: ["#c0283c", "#101012"],
    card: { bg: "linear-gradient(170deg, #2a0a10, #0d0507)", frame: "linear-gradient(135deg, #8a1020, #101012 50%, #8a1020)", title: "" },
  },
  {
    id: "cocoa", for: "supporter", name: "Flip Mitts · Hot Cocoa", line: "Cocoa knit with a marshmallow flap.",
    glove: ["mitts", 0x6b4430, 0xfff4ea, 0x6b4430, 0x4a2e20, 0xd9b48a],
    outfit: null, ghost: ["#fff4ea", "#6b4430"], trail: ["#fff4ea", "#6b4430"],
    card: { bg: "linear-gradient(170deg, #3a2418, #1a0f0a)", frame: "linear-gradient(135deg, #6b4430, #fff4ea 50%, #6b4430)", title: "" },
  },
  {
    id: "glacier", for: "supporter", name: "Aviator · Glacier", line: "Ice blue leather, white fleece, a silver buckle.",
    glove: ["aviator", 0x9fd4f0, 0xd8f0ff, 0x5aa8d8, 0xffffff, 0xe8edf3],
    outfit: null, ghost: ["#d8f0ff", "#5aa8d8"], trail: ["#ffffff", "#9fd4f0"],
    card: { bg: "linear-gradient(170deg, #1a3a52, #0a1a28)", frame: "linear-gradient(135deg, #9fd4f0, #ffffff 50%, #9fd4f0)", title: "" },
  },
];

/** Registers every concept's glove ("concept-glove-<id>") and colourway ("concept-outfit-<id>") for the lab to draw. */
export function registerConcepts(): void {
  for (const c of SET_CONCEPTS) {
    const [style, base, fingers, tips, strap, detail] = c.glove;
    GLOVE_STYLE[`concept-glove-${c.id}`] = { style, base, fingers, tips, strap, detail } satisfies GloveStyle;
    if (c.outfit) COLOURWAYS[`concept-outfit-${c.id}`] = c.outfit;
  }
}

/** The glove id a concept is drawn with: the built item's, else the registered concept's. */
export const conceptGlove = (c: SetConcept) => c.built?.glove ?? `concept-glove-${c.id}`;
/** The colourway a concept is drawn in. */
export const conceptOutfit = (c: SetConcept) => c.built?.outfit ?? (c.outfit ? `concept-outfit-${c.id}` : "outfit-cream");
/** Display name of a lab id (concept ids have no catalogue entry). */
export function conceptName(id: string): string | null {
  const m = /^concept-glove-(.+)$/.exec(id);
  return m ? (SET_CONCEPTS.find((c) => c.id === m[1])?.name ?? null) : null;
}
