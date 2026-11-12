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
// - Hover effect (v0.0.40, users.hover_fx, migrations/0104): how their mini profile comes in when someone rests on
//   their name (HOVER_FX, ui/hover-fx.ts). Behaviour, not a picture: the OG cards have nothing to draw for it.
//
// Every look shows only while the player is a supporter: the pick is gated on write (403 for anyone else) and on every
// read (apps/api/src/supporter-cols.ts), so a revoked supporter keeps the stored pick, unshown, and gets it back if
// they support again. Defaults are off (null).

export type NameFontId = "grotesk" | "round" | "pixel" | "mono" | "serif" | "wide" | "marker" | "block" | "script" | "condensed";

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
  // v0.0.40: the narrow one (a jersey / scoreboard face): long names keep their size where the others shrink to fit.
  { id: "condensed", name: "Condensed", typeface: "Barlow Condensed", licence: "OFL-1.1", url: "https://github.com/jpt/barlow", size: 1 },
];
export const isNameFont = (v: unknown): v is NameFontId => typeof v === "string" && NAME_FONTS.some((f) => f.id === v);
export const nameFontOf = (v: unknown): NameFontId | null => (isNameFont(v) ? v : null);
/** The CSS / canvas family of a name font (our own name, so a font installed on the player's machine never stands in). */
export const nameFontFamily = (id: NameFontId) => `bh-name-${id}`;
export const nameFontDef = (id: NameFontId): NameFont => NAME_FONTS.find((f) => f.id === id)!;

// v0.0.40: bold and italic (users.name_style, migrations/0105). Only real cuts, never a browser-faked bold or slant:
// a toggle shows only with a font that has that cut (NAME_STYLE_CUTS), and the faces are declared with
// font-synthesis: none. The default font is the player's system font on the page (real bold and italic everywhere we
// ship) and Inter on the OG cards (inter-b / -i / -bi, tools/name-fonts/build.py). Bold is a step heavier than names are
// drawn already (900 against 600 to 850), so it is only offered where that step shows: Condensed (600 to 800) and the
// default font. (Orbitron's 900 looked the same as the 700 Wide is pinned at, at board size: left out.) A pick stays stored as made; a font without the cut shows the name without it.
export type NameStyle = "b" | "i" | "bi";
export const isNameStyle = (v: unknown): v is NameStyle => v === "b" || v === "i" || v === "bi";
/** Which cuts each font has (null: the default font). Each bold or italic face is its own file: "<id>-b", "-i", "-bi". */
export const NAME_STYLE_CUTS: Record<NameFontId | "default", { bold: boolean; italic: boolean }> = {
  default: { bold: true, italic: true },
  condensed: { bold: true, italic: true },
  wide: { bold: false, italic: false },
  serif: { bold: false, italic: true },
  mono: { bold: false, italic: true },
  grotesk: { bold: false, italic: false },
  round: { bold: false, italic: false },
  pixel: { bold: false, italic: false },
  marker: { bold: false, italic: false },
  block: { bold: false, italic: false },
  script: { bold: false, italic: false },
};
/** The style a name shows in `font`: the picked one, less any cut the font lacks (null: plain). */
export function nameStyleShown(font: NameFontId | null | undefined, style: unknown): NameStyle | null {
  if (!isNameStyle(style)) return null;
  const cuts = NAME_STYLE_CUTS[font ?? "default"] ?? NAME_STYLE_CUTS.default;
  const b = style.includes("b") && cuts.bold, i = style.includes("i") && cuts.italic;
  return b && i ? "bi" : b ? "b" : i ? "i" : null;
}
/** The stored value for a pair of toggles (null when both are off). */
export const nameStyleOf = (bold: boolean, italic: boolean): NameStyle | null => (bold && italic ? "bi" : bold ? "b" : italic ? "i" : null);

// ---------------------------------------------------------------------------------------------
// Avatar decorations

export type AvatarDecoId = "ears" | "orbit" | "strafe" | "geode" | "stardust" | "carrot" | "clover" | "halo" | "gauge" | "frost" | "petals";

/**
 * One SVG layer of a decoration, in a 120 x 120 box whose middle 80 x 80 is the avatar (centre 60,60, radius 40).
 * `anim`: how the layer moves (avatar-deco.css): spin / spin-back (a full turn), sway (a small rock back and forth),
 * twinkle (fades in and out), gauge (a needle's climb, tremble and fall), glint (a rare short flash), drift (comes loose
 * and drifts off by `drift`, turning, fading out). Every move is the whole layer's transform or opacity, so it stays on
 * the compositor. The SVG as drawn is the layer at rest: the still (lists, reduced motion, Potato, OG cards).
 * `currentColor` is the player's name colour (or the decoration's own accent without one).
 */
export interface DecoLayer {
  svg: string;
  anim?: "spin" | "spin-back" | "sway" | "twinkle" | "twinkle-late" | "gauge" | "glint" | "drift";
  /** The point the layer turns or sways about, in box units (default: the centre; sway: 60, 72). */
  origin?: readonly [number, number];
  /** Seconds per cycle and start offset (negative: already partway), over the animation's own. */
  dur?: number;
  delay?: number;
  /** drift: how far it goes, in box units. */
  drift?: readonly [number, number];
  /**
   * A fixed placement of the whole layer round the box centre (moved by x, y; turned; scaled), under its animation: a
   * spin inside a squashed placement travels round an ellipse (Halo's glint).
   */
  place?: { x?: number; y?: number; rotate?: number; sx?: number; sy?: number };
}

const pct = (u: number) => `${Math.round((u / 1.2) * 1000) / 1000}%`;
/** A layer's placement as CSS (the outer span) and as an SVG transform (the stills), the same transform both ways. */
export function decoPlace(l: DecoLayer): { css: string; svg: string } | null {
  const p = l.place;
  if (!p) return null;
  const [x, y, r, sx, sy] = [p.x ?? 0, p.y ?? 0, p.rotate ?? 0, p.sx ?? 1, p.sy ?? 1];
  return {
    css: `transform:translate(${pct(x)},${pct(y)}) rotate(${r}deg) scale(${sx},${sy})`,
    svg: `translate(${60 + x} ${60 + y}) rotate(${r}) scale(${sx} ${sy}) translate(-60 -60)`,
  };
}
/** A moving layer's own timing, pivot and drift as inline CSS (empty when it uses avatar-deco.css's defaults). */
export function decoMotion(l: DecoLayer): string {
  const out: string[] = [];
  if (l.origin) out.push(`transform-origin:${pct(l.origin[0])} ${pct(l.origin[1])}`);
  if (l.dur) out.push(`animation-duration:${l.dur}s`);
  if (l.delay) out.push(`animation-delay:${l.delay}s`);
  if (l.drift) out.push(`--dx:${pct(l.drift[0])}`, `--dy:${pct(l.drift[1])}`);
  return out.join(";");
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

/** A pointed leaf from x0, y0 to x1, y1, `w` wide at its middle. */
const leaf = (x0: number, y0: number, x1: number, y1: number, w: number, fill: string, extra = "") => {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0);
  const nx = (-(y1 - y0) / len) * w, ny = ((x1 - x0) / len) * w;
  const f = (v: number) => Math.round(v * 100) / 100;
  return `<path d="M${f(x0)} ${f(y0)}Q${f(mx + nx)} ${f(my + ny)} ${f(x1)} ${f(y1)}Q${f(mx - nx)} ${f(my - ny)} ${f(x0)} ${f(y0)}z" fill="${fill}"${extra}/>`;
};
/** A heart-shaped clover leaflet pointing up from 0,0, about 8 long. */
const LEAFLET = "M0 0C-1.4-1.6-4.4-3-4.2-5.8C-4-8-1.2-8.6 0-6.2C1.2-8.6 4-8 4.2-5.8C4.4-3 1.4-1.6 0 0z";
/** A clover at x, y: `n` leaflets (3, or 4 for the lucky one), `s` its scale. */
const clover = (x: number, y: number, n: number, s: number, fill: string, turn = 0) =>
  `<g transform="translate(${x} ${y}) rotate(${turn}) scale(${s})" stroke="#0d1424" stroke-width="${Math.round((0.9 / s) * 100) / 100}" stroke-linejoin="round">` +
  Array.from({ length: n }, (_, i) => `<path transform="rotate(${(360 / n) * i})" d="${LEAFLET}" fill="${fill}"/>`).join("") +
  `</g>`;
/** A five-petal blossom at x, y, `s` its scale, the middle in the name colour. */
const PETAL = "M0 0C-3.2-2.2-3.6-6.4-1.6-8.4L0-7.2L1.6-8.4C3.6-6.4 3.2-2.2 0 0z";
const blossom = (x: number, y: number, s: number, turn: number) =>
  `<g transform="translate(${x} ${y}) rotate(${turn}) scale(${s})" stroke="#0d1424" stroke-width="${Math.round((0.8 / s) * 100) / 100}" stroke-linejoin="round">` +
  [0, 72, 144, 216, 288].map((a) => `<path transform="rotate(${a})" d="${PETAL}" fill="#ffd9e6"/>`).join("") +
  `<circle r="2.3" fill="currentColor"/></g>`;
/** A loose petal at x, y, turned `turn`. */
const looseP = (x: number, y: number, turn: number) => `<path transform="translate(${x} ${y}) rotate(${turn}) scale(0.8)" d="${PETAL}" fill="#ffe6ee" stroke="#0d1424" stroke-width="1"/>`;
/** An ice shard hanging out from the avatar's rim at `deg`, lit on its left face. */
const ice = (deg: number, len: number) => {
  const [bx, by] = at(deg, 40);
  const t = `rotate(${deg + 180} ${bx} ${by})`;
  return `<g transform="${t}" stroke="#0d1424" stroke-width="0.8" stroke-linejoin="round"><path d="M${bx - 2.2} ${by}L${bx} ${by + len}L${bx + 2.2} ${by}z" fill="#bfe6fb"/><path d="M${bx - 2.2} ${by}L${bx} ${by + len}L${bx} ${by}z" fill="#f2fbff" stroke="none"/></g>`;
};
/** A six-armed frost crystal at x, y. */
const crystal = (x: number, y: number, s: number) =>
  `<g transform="translate(${x} ${y})" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">` +
  [0, 60, 120].map((a) => `<path transform="rotate(${a})" d="M0 ${-s}V${s}M-${s * 0.35} ${-s * 0.75}L0 ${-s * 0.45}L${s * 0.35} ${-s * 0.75}M-${s * 0.35} ${s * 0.75}L0 ${s * 0.45}L${s * 0.35} ${s * 0.75}"/>`).join("") +
  `</g>`;

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
  {
    // Carrot greens sprouting over the top of the ring, as if the avatar were the carrot; they sway a little.
    id: "carrot",
    name: "Carrot Top",
    accent: "#6ff0f0",
    layers: [
      { svg: ring(41.5, 2.4, 0.9) },
      {
        anim: "sway",
        origin: [60, 21],
        svg:
          `<g stroke="#0d1424" stroke-width="1.3" stroke-linejoin="round">` +
          leaf(56, 22, 38, 12, 3.6, "#4f9e3a") + leaf(64, 22, 82, 12, 3.6, "#4f9e3a") +
          leaf(58, 22, 45, 3, 4.6, "#7fd35f") + leaf(62, 22, 75, 3, 4.6, "#7fd35f") + leaf(60, 23, 60, 0, 5, "#97e06f") +
          `</g><path d="M53 22.5Q60 18 67 22.5" fill="none" stroke="#ff9d42" stroke-width="3.4" stroke-linecap="round"/>`,
      },
    ],
  },
  {
    // Small clovers round the ring; the lucky four-leafed one, in the name colour, turns slowly.
    id: "clover",
    name: "Clover",
    accent: "#6ff0f0",
    layers: [
      { svg: ring(41.5, 1.4, 0.6) + [[105, 0.62, 20], [165, 0.7, -15], [228, 0.6, 40], [292, 0.68, 10]].map(([d, sc, t]) => clover(...at(d, 45), 3, sc, "#6cc76a", t)).join("") },
      { anim: "spin", dur: 16, origin: at(38, 46), svg: clover(...at(38, 46), 4, 0.95, "currentColor") },
    ],
  },
  {
    // A thin tilted halo above the avatar; a glint travels slowly round it.
    id: "halo",
    name: "Halo",
    accent: "#6ff0f0",
    layers: [
      { svg: `<ellipse cx="60" cy="13" rx="31" ry="7.6" transform="rotate(-7 60 13)" fill="none" stroke="#0d1424" stroke-width="5.2" stroke-opacity="0.55"/><ellipse cx="60" cy="13" rx="31" ry="7.6" transform="rotate(-7 60 13)" fill="none" stroke="currentColor" stroke-width="3"/><ellipse cx="60" cy="13" rx="31" ry="7.6" transform="rotate(-7 60 13)" fill="none" stroke="#ffffff" stroke-width="0.9" stroke-opacity="0.7"/>` },
      { anim: "spin", dur: 5, place: { y: -47, rotate: -7, sx: 31 / 60, sy: 7.6 / 60 }, svg: `<ellipse cx="60" cy="0" rx="18" ry="24" fill="#ffffff" fill-opacity="0.35"/><ellipse cx="60" cy="0" rx="9" ry="14" fill="#ffffff"/>` },
    ],
  },
  {
    // A speed gauge round the ring: ticks from bottom left to bottom right, the last few in the name colour; the needle
    // climbs, trembles near the top of the scale and drops back.
    id: "gauge",
    name: "Speedometer",
    accent: "#6ff0f0",
    layers: [
      {
        svg:
          `<path d="${arc(-130, 130, 49)}" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1"/>` +
          Array.from({ length: 27 }, (_, i) => {
            const d = -130 + i * 10, major = i % 3 === 0;
            const [x0, y0] = at(d, major ? 42.5 : 43.5), [x1, y1] = at(d, major ? 49 : 47);
            return `<path d="M${x0} ${y0}L${x1} ${y1}" stroke="${d >= 90 ? "currentColor" : "#f4f1ea"}" stroke-width="${major ? 2.2 : 1.3}" stroke-linecap="round"${d >= 90 ? "" : ` stroke-opacity="0.8"`}/>`;
          }).join(""),
      },
      {
        anim: "gauge",
        svg: (() => {
          // A needle across the scale: from just inside the ring to past the ticks, with a white tip.
          const [tx, ty] = at(112, 56), [lx, ly] = at(106, 33), [rx, ry] = at(118, 33), [wx, wy] = at(112, 49);
          return `<path d="M${lx} ${ly}L${tx} ${ty}L${rx} ${ry}z" fill="currentColor" stroke="#0d1424" stroke-width="1.4" stroke-linejoin="round"/><path d="M${wx} ${wy}L${tx} ${ty}" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>`;
        })(),
      },
    ],
  },
  {
    // Ice on the lower rim: shards hanging off it and two frost crystals; now and then a glint on the ice.
    id: "frost",
    name: "Frost",
    accent: "#6ff0f0",
    layers: [
      {
        svg:
          `<path d="${arc(95, 265, 41.5)}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.85"/>` +
          [[134, 6], [150, 10], [166, 15], [176, 8], [192, 12], [212, 7], [226, 5]].map(([d, l]) => ice(d, l)).join("") +
          crystal(...at(104, 47), 4.2) + crystal(...at(256, 47.5), 3.6),
      },
      { anim: "glint", origin: at(166, 54), svg: star(...at(166, 54), 4.6, "#ffffff") },
      { anim: "glint", origin: at(212, 47.5), delay: -2.6, svg: star(...at(212, 47.5), 3.4, "#ffffff") },
    ],
  },
  {
    // Blossom round the ring; now and then a petal comes loose and drifts off, turning.
    id: "petals",
    name: "Petals",
    accent: "#6ff0f0",
    layers: [
      { svg: ring(41.5, 1.4, 0.55) + blossom(...at(-38, 45), 1, 10) + blossom(...at(95, 46), 0.85, -20) + blossom(...at(205, 45), 0.95, 30) },
      { anim: "drift", origin: at(-22, 47), drift: [20, 30], svg: looseP(...at(-22, 47), 60) },
      { anim: "drift", origin: at(110, 49), drift: [14, 26], delay: -2.4, svg: looseP(...at(110, 49), -30) },
      { anim: "drift", origin: at(222, 48), drift: [-16, 28], delay: -4.6, svg: looseP(...at(222, 48), 120) },
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
    .map((l) => {
      const svg = l.svg.replaceAll("url(#dg)", `url(#dg-${id})`).replaceAll("currentColor", c);
      const place = decoPlace(l);
      return place ? `<g transform="${place.svg}">${svg}</g>` : svg;
    })
    .join("")}</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Card borders and card effects

export type CardBorderId = "comet" | "twin" | "prism" | "pulse" | "stride" | "vine" | "neon";
export const CARD_BORDERS: readonly { id: CardBorderId; name: string }[] = [
  // One bright light with a long tail running round the frame, in the name colour.
  { id: "comet", name: "Comet" },
  // Two lights chasing each other round the frame, the name colour and white.
  { id: "twin", name: "Twin" },
  // The whole frame in slowly turning colour.
  { id: "prism", name: "Prism" },
  // The frame band breathing in the name colour.
  { id: "pulse", name: "Pulse" },
  // Dashes in the name colour walking round the frame.
  { id: "stride", name: "Stride" },
  // A vine along the frame, leaves at the two cut corners swaying a little.
  { id: "vine", name: "Vine" },
  // The frame as a lit tube in the name colour, with a rare flicker.
  { id: "neon", name: "Neon" },
];
export const isCardBorder = (v: unknown): v is CardBorderId => typeof v === "string" && CARD_BORDERS.some((b) => b.id === v);
export const cardBorderOf = (v: unknown): CardBorderId | null => (isCardBorder(v) ? v : null);

export type CardEffectId = "hops" | "embers" | "stars" | "aurora" | "rain" | "snow" | "petals" | "speed" | "foil";
export const CARD_EFFECTS: readonly { id: CardEffectId; name: string }[] = [
  // Dotted hop arcs drifting across the card, like a run's jumps.
  { id: "hops", name: "Hops" },
  // Sparks rising from the bottom edge.
  { id: "embers", name: "Embers" },
  // Small stars fading in and out.
  { id: "stars", name: "Stars" },
  // Soft bands of colour drifting across the back of the card.
  { id: "aurora", name: "Aurora" },
  // Thin slanting streaks, small splashes along the bottom edge.
  { id: "rain", name: "Rain" },
  // Slow snow, flakes of a few sizes.
  { id: "snow", name: "Snow" },
  // Blossom petals drifting across (pairs with the Petals decoration).
  { id: "petals", name: "Petals" },
  // Horizontal streaks passing behind the content.
  { id: "speed", name: "Speed Lines" },
  // A coloured sheen that follows the card's tilt and the pointer; still when nothing is over the card.
  { id: "foil", name: "Foil" },
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

// ---------------------------------------------------------------------------------------------
// Hover effect: how a supporter's mini profile (ui/hover-card.ts) comes in for everyone who rests on their name
// (ui/hover-fx.ts). The card's wait, size and manners stay the same; an effect adds at most HOVER_FX_EXTRA_MS to the
// entrance and nothing to the exit.

export type HoverFxId = "hop" | "flip" | "unfold" | "glint" | "tilt";
export const HOVER_FX: readonly { id: HoverFxId; name: string }[] = [
  // Drops in on the site's hop arc and lands with a squash (notify/spring.ts hopKeyframes).
  { id: "hop", name: "Hop" },
  // Turns in like a card.
  { id: "flip", name: "Flip" },
  // Opens out from the name while the frame draws itself.
  { id: "unfold", name: "Unfold" },
  // The usual entrance, then one sheen across the card.
  { id: "glint", name: "Glint" },
  // Leans toward the pointer with a soft light while you stay on the name.
  { id: "tilt", name: "Tilt" },
];
export const isHoverFx = (v: unknown): v is HoverFxId => typeof v === "string" && HOVER_FX.some((e) => e.id === v);
export const hoverFxOf = (v: unknown): HoverFxId | null => (isHoverFx(v) ? v : null);
/** The most an effect may add to the plain entrance (hover-card.css hc-in, 140 ms). */
export const HOVER_FX_EXTRA_MS = 250;
/** How long each entrance runs, ms (Glint: the plain 140 ms, then its sheen); Tilt has none. Tests hold them to the budget. */
export const HOVER_FX_MS: Record<Exclude<HoverFxId, "tilt">, number> = { hop: 340, flip: 360, unfold: 380, glint: 390 };
