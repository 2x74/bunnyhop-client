// Supporter looks (v0.0.37): what supporters add to their name and card on top of the name colour and effect
// (creators.ts NAME_COLORS / NAME_EFFECTS). Shared and DOM-free: the API validates and stores the ids
// (apps/api/src/supporters.ts, users.name_font / avatar_deco / card_border / card_effect, migrations/0089), the web
// draws them (ui/name-fonts.css, ui/avatar-deco.ts + .css, ui/card.ts cardLayers + profile.css), the OG / Discord cards
// draw the font and the decoration still (apps/api/src/og/cards.ts).
//
// - Name font: one of NAME_FONTS everywhere the name shows (boards, ranks, chat, the room scoreboard, name tags, cards,
//   the dock, hover cards, Discord cards and OG images). Each is an openly licensed font (SIL OFL 1.1, or Apache 2.0
//   for Marker), pinned to one weight and subset to Latin and, where the font has it, Cyrillic
//   (tools/name-fonts/build.py). size-adjust brings every font near Inter's width and cap height on average, and every
//   name is then fitted on its own (ui/name-fit.ts, player/tag.ts, og/cards.ts fontName) so it is never wider than in
//   the default font; the line box stays Inter's (ascent / descent overrides): rows don't move. A letter the font lacks
//   falls back to the default font letter by letter. The files load only when a name in that font is on screen.
// - Avatar decoration: a still or animated ornament around the round avatar (AVATAR_DECOS), drawn as SVG in a box
//   1.5x the avatar's, centred on it, so it never changes layout. Animated on cards, still on boards and lists.
// - Card border and card effect: layers on the player card (CARD_BORDERS: a light round the frame; CARD_EFFECTS: a
//   moving layer behind the card's content). They share the peak treatment's layers (ui/card.ts cardLayers): see
//   cardLayerPlan for how a supporter's pick and a T7+ clearer's peak layers stack.
//
// Every look shows only while the player is a supporter: the pick is gated on write (403 for anyone else) and on every
// read (apps/api/src/supporter-cols.ts), so a revoked supporter keeps the stored pick, unshown, and gets it back if
// they support again. Defaults are off (null).

export type NameFontId = "grotesk" | "round" | "pixel" | "mono" | "serif" | "wide" | "marker" | "block" | "script";

export interface NameFont {
  id: NameFontId;
  /** What the picker calls it (the look, not the typeface: the typeface is on /credits). */
  name: string;
  /** The typeface and its licence (/credits). */
  typeface: string;
  licence: "OFL-1.1" | "Apache-2.0";
  /** Upstream project. */
  url: string;
  /**
   * size-adjust: the font scaled to Inter Bold's average advance width and cap height (tools/name-fonts/metrics.json),
   * never above 1. An average only: the per-name fit (ui/name-fit.ts) is what guarantees the width.
   */
  size: number;
}

export const NAME_FONTS: readonly NameFont[] = [
  { id: "grotesk", name: "Grotesk", typeface: "Space Grotesk", licence: "OFL-1.1", url: "https://github.com/floriankarsten/space-grotesk", size: 1 },
  { id: "round", name: "Rounded", typeface: "Fredoka", licence: "OFL-1.1", url: "https://github.com/hafontia/Fredoka-One", size: 1 },
  { id: "pixel", name: "Pixel", typeface: "Pixelify Sans", licence: "OFL-1.1", url: "https://github.com/eifetx/Pixelify-Sans", size: 1 },
  { id: "mono", name: "Mono", typeface: "JetBrains Mono", licence: "OFL-1.1", url: "https://github.com/JetBrains/JetBrainsMono", size: 0.96 },
  { id: "serif", name: "Serif", typeface: "Playfair Display", licence: "OFL-1.1", url: "https://github.com/clauseggers/Playfair-Display", size: 1 },
  { id: "wide", name: "Wide", typeface: "Orbitron", licence: "OFL-1.1", url: "https://github.com/theleagueof/orbitron", size: 0.86 },
  { id: "marker", name: "Marker", typeface: "Permanent Marker", licence: "Apache-2.0", url: "https://fonts.google.com/specimen/Permanent+Marker", size: 0.98 },
  { id: "block", name: "Block", typeface: "Russo One", licence: "OFL-1.1", url: "https://fonts.google.com/specimen/Russo+One", size: 0.98 },
  { id: "script", name: "Script", typeface: "Pacifico", licence: "OFL-1.1", url: "https://github.com/googlefonts/Pacifico", size: 0.96 },
];
export const isNameFont = (v: unknown): v is NameFontId => typeof v === "string" && NAME_FONTS.some((f) => f.id === v);
export const nameFontOf = (v: unknown): NameFontId | null => (isNameFont(v) ? v : null);
/** The CSS / canvas family of a name font (our own name, so a font installed on the player's machine never stands in). */
export const nameFontFamily = (id: NameFontId) => `bh-name-${id}`;
export const nameFontDef = (id: NameFontId): NameFont => NAME_FONTS.find((f) => f.id === id)!;

// ---------------------------------------------------------------------------------------------
// Avatar decorations

export type AvatarDecoId = "ears" | "orbit" | "strafe" | "geode" | "stardust";

/**
 * One SVG layer of a decoration, in a 120 x 120 box whose middle 80 x 80 is the avatar (centre 60,60, radius 40).
 * `anim`: how the layer moves (avatar-deco.css): spin / spin-back (a full turn), sway (a small rock back and forth),
 * twinkle (fades in and out). Every move is the whole layer's transform or opacity, so it stays on the compositor.
 * `currentColor` is the player's name colour (or the decoration's own accent without one).
 */
export interface DecoLayer {
  svg: string;
  anim?: "spin" | "spin-back" | "sway" | "twinkle" | "twinkle-late";
}

export interface AvatarDeco {
  id: AvatarDecoId;
  name: string;
  /** The accent `currentColor` stands for when the player has no name colour. */
  accent: string;
  layers: readonly DecoLayer[];
}

const ring = (r: number, w: number, o = 1, color = "currentColor") => `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" stroke-opacity="${o}"/>`;
/** A point on the circle of radius r round the avatar's centre, at `deg` clockwise from the top. */
const at = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [Math.round((60 + r * Math.cos(a)) * 100) / 100, Math.round((60 + r * Math.sin(a)) * 100) / 100] as const;
};
const arc = (from: number, to: number, r: number) => {
  const [x0, y0] = at(from, r), [x1, y1] = at(to, r);
  return `M${x0} ${y0}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};
/** A four-point star at x, y. */
const star = (x: number, y: number, s: number, fill: string) =>
  `<path d="M${x} ${y - s}Q${x + s * 0.18} ${y - s * 0.18} ${x + s} ${y}Q${x + s * 0.18} ${y + s * 0.18} ${x} ${y + s}Q${x - s * 0.18} ${y + s * 0.18} ${x - s} ${y}Q${x - s * 0.18} ${y - s * 0.18} ${x} ${y - s}z" fill="${fill}"/>`;
/** A crystal shard pointing out from the avatar at `deg`. */
const shard = (deg: number, len: number) => {
  const [bx, by] = at(deg, 39);
  return `<path transform="rotate(${deg} ${bx} ${by})" d="M${bx - 3.4} ${by}L${bx - 2.2} ${by - len * 0.7}L${bx} ${by - len}L${bx + 2.2} ${by - len * 0.7}L${bx + 3.4} ${by}z" fill="url(#dg)" stroke="#0d1424" stroke-width="0.8" stroke-linejoin="round"/><path transform="rotate(${deg} ${bx} ${by})" d="M${bx} ${by - len}L${bx + 0.6} ${by - 1}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.7"/>`;
};

export const AVATAR_DECOS: readonly AvatarDeco[] = [
  {
    // Two bunny ears over the avatar's top edge, the inner ear in the name colour; they rock a little, like a hop.
    id: "ears",
    name: "Ears",
    accent: "#ffa8cb",
    layers: [
      {
        anim: "sway",
        svg:
          `<g stroke="#0d1424" stroke-width="1.6" stroke-linejoin="round">` +
          `<path d="M41 30C33 20 31 6 37 2c6-3 12 9 13 24z" fill="#f4f1ea"/>` +
          `<path d="M79 30C87 20 89 6 83 2c-6-3-12 9-13 24z" fill="#f4f1ea"/></g>` +
          `<path d="M42.5 25.5C37.5 18 36.5 9 39 7c3-1.6 6.6 6 7.6 16.6z" fill="currentColor"/>` +
          `<path d="M77.5 25.5C82.5 18 83.5 9 81 7c-3-1.6-6.6 6-7.6 16.6z" fill="currentColor"/>`,
      },
      { svg: ring(41.5, 2.2, 0.9, "#f4f1ea") },
    ],
  },
  {
    // A thin ring and two moons going round it.
    id: "orbit",
    name: "Orbit",
    accent: "#6ff0f0",
    layers: [
      { svg: ring(47, 1.2, 0.45) + ring(42, 1.6, 0.8) },
      { anim: "spin", svg: (() => { const [ax, ay] = at(30, 47), [bx, by] = at(215, 47); return `<path d="${arc(-20, 30, 47)}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.55"/><circle cx="${ax}" cy="${ay}" r="4.2" fill="currentColor"/><circle cx="${ax}" cy="${ay}" r="1.8" fill="#ffffff"/><circle cx="${bx}" cy="${by}" r="2.6" fill="#ffffff" fill-opacity="0.85"/>`; })() },
    ],
  },
  {
    // A strafe: an A arc and a D arc either side of the avatar, rocking side to side.
    id: "strafe",
    name: "Strafe",
    accent: "#5fd8ff",
    layers: [
      {
        anim: "sway",
        svg:
          `<path d="${arc(200, 340, 45)}" fill="none" stroke="#5fd8ff" stroke-width="4.4" stroke-linecap="round"/>` +
          `<path d="${arc(20, 160, 45)}" fill="none" stroke="#ff8fc8" stroke-width="4.4" stroke-linecap="round"/>` +
          `<path d="${arc(215, 325, 50.5)}" fill="none" stroke="#5fd8ff" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.6"/>` +
          `<path d="${arc(35, 145, 50.5)}" fill="none" stroke="#ff8fc8" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.6"/>`,
      },
    ],
  },
  {
    // The Geode set's crystals: six shards round the avatar, aqua to amethyst, turning slowly.
    id: "geode",
    name: "Geode",
    accent: "#5ff2df",
    layers: [
      { svg: ring(41.5, 2.4, 0.95, "url(#dg)") },
      { anim: "spin", svg: [0, 60, 120, 180, 240, 300].map((d, i) => shard(d, i % 2 ? 9 : 13)).join("") },
    ],
  },
  {
    // A scatter of four-point stars round the avatar, half of them fading in as the others fade out.
    id: "stardust",
    name: "Stardust",
    accent: "#ffe08a",
    layers: [
      { svg: ring(42, 1.4, 0.55) },
      { anim: "twinkle", svg: [[-35, 50, 5.4], [70, 48, 4.2], [160, 51, 5], [250, 47, 3.6]].map(([d, r, s]) => star(...at(d, r), s, "currentColor")).join("") },
      { anim: "twinkle-late", svg: [[15, 52, 3.4], [115, 46, 4.4], [205, 50, 3.6], [300, 51, 4.8]].map(([d, r, s]) => star(...at(d, r), s, "#ffffff")).join("") },
    ],
  },
];
export const isAvatarDeco = (v: unknown): v is AvatarDecoId => typeof v === "string" && AVATAR_DECOS.some((d) => d.id === v);
export const avatarDecoOf = (v: unknown): AvatarDecoId | null => (isAvatarDeco(v) ? v : null);
export const avatarDecoDef = (id: AvatarDecoId): AvatarDeco => AVATAR_DECOS.find((d) => d.id === id)!;

/** Shared <defs> the layers reference (the Geode gradient). */
export const DECO_DEFS = `<defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7ff6e6"/><stop offset="0.55" stop-color="#5fb8f2"/><stop offset="1" stop-color="#9a72ff"/></linearGradient></defs>`;

/**
 * A decoration as one still SVG (OG and Discord cards, the board rows' still): every layer at rest, `color` for
 * currentColor. `size` px square; the avatar is the middle two thirds.
 */
export function decoStillSvg(id: AvatarDecoId, color: string | null, o: { x?: number; y?: number; size?: number } = {}): string {
  const d = avatarDecoDef(id);
  const c = color ?? d.accent;
  const s = o.size ?? 120;
  return `<svg x="${o.x ?? 0}" y="${o.y ?? 0}" width="${s}" height="${s}" viewBox="0 0 120 120" color="${c}">${DECO_DEFS.replace(/id="dg"/, `id="dg-${id}"`)}${d.layers
    .map((l) => l.svg.replaceAll("url(#dg)", `url(#dg-${id})`).replaceAll("currentColor", c))
    .join("")}</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Card borders and card effects

export type CardBorderId = "comet" | "twin" | "prism" | "pulse";
export const CARD_BORDERS: readonly { id: CardBorderId; name: string }[] = [
  // One bright light with a long tail running round the frame, in the name colour.
  { id: "comet", name: "Comet" },
  // Two lights chasing each other round the frame, the name colour and white.
  { id: "twin", name: "Twin" },
  // The whole frame in slowly turning colour.
  { id: "prism", name: "Prism" },
  // The frame band breathing in the name colour.
  { id: "pulse", name: "Pulse" },
];
export const isCardBorder = (v: unknown): v is CardBorderId => typeof v === "string" && CARD_BORDERS.some((b) => b.id === v);
export const cardBorderOf = (v: unknown): CardBorderId | null => (isCardBorder(v) ? v : null);

export type CardEffectId = "hops" | "embers" | "stars" | "aurora";
export const CARD_EFFECTS: readonly { id: CardEffectId; name: string }[] = [
  // Dotted hop arcs drifting across the card, like a run's jumps.
  { id: "hops", name: "Hops" },
  // Sparks rising from the bottom edge.
  { id: "embers", name: "Embers" },
  // Small stars fading in and out.
  { id: "stars", name: "Stars" },
  // Soft bands of colour drifting across the back of the card.
  { id: "aurora", name: "Aurora" },
];
export const isCardEffect = (v: unknown): v is CardEffectId => typeof v === "string" && CARD_EFFECTS.some((e) => e.id === v);
export const cardEffectOf = (v: unknown): CardEffectId | null => (isCardEffect(v) ? v : null);

/**
 * How a supporter's border and effect stack with the peak treatment (T7+ clearers, ui/card.ts peakLayers). The card
 * has three layers: the sweep (the peak's light crossing the card), the frame light and the effect behind the content.
 * - The sweep is the peak's own and always stays: it is how the card says "cleared a T7+ map", in the tier's colour.
 * - The frame light: a supporter's border, else the peak's (T8 and up). Never both: two lights on one frame read as noise.
 * - The effect: a supporter's effect, else the peak's motes (T9 and up). Never both, for the same reason.
 * So a T10 supporter who picks Comet and Embers wears the T10 sweep, Comet on the frame and Embers behind; one who
 * picks nothing keeps all three T10 layers. A supporter without a peak wears just their picks.
 */
export function cardLayerPlan(peak: number | null, border: CardBorderId | null, effect: CardEffectId | null): {
  sweep: boolean;
  frame: "peak" | CardBorderId | null;
  effect: "motes" | CardEffectId | null;
} {
  return {
    sweep: !!peak && peak >= 7,
    frame: border ?? (peak && peak >= 8 ? "peak" : null),
    effect: effect ?? (peak && peak >= 9 ? "motes" : null),
  };
}
