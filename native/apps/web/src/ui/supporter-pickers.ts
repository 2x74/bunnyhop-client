// The supporter looks' picker choices and swatches (supporter-looks.ts), one implementation for both places that pick
// them: Edit card → Name / Avatar / Effects (ui/card-editor.ts, a tile per choice) and the Support page's Player card
// section (ui/support-card.ts, a row of swatches per look). Both save through POST /me/supporter (api.saveSupporter).

import { nameColorHex, NAME_COLORS, NAME_EFFECTS, type NameColorId, type NameEffect, type NameLook, type PeakTier } from "../creators";
import { AVATAR_DECOS, CARD_BORDERS, CARD_EFFECTS, HOVER_FX, NAME_FONTS, NAME_STYLE_CUTS, type NameStyle, type AvatarDecoId, type CardBorderId, type CardEffectId, type HoverFxId, type NameFontId } from "../supporter-looks";
import { decorated } from "./avatar-deco";
import { avatarEl } from "./card";
import { cardLayers, SUPPORTER_FX } from "./card-fx";
import { h } from "./dom";
import { nameAttrs } from "./marks";

export const COLOUR_CHOICES: { id: NameColorId | null; name: string; hex: string }[] = [{ id: null, name: "White", hex: "#eef1f6" }, ...NAME_COLORS];
export const EFFECT_CHOICES: { id: NameEffect | null; name: string }[] = [{ id: null, name: "Plain" }, ...NAME_EFFECTS];
export const FONT_CHOICES: { id: NameFontId | null; name: string }[] = [{ id: null, name: "Default" }, ...NAME_FONTS];
/**
 * v0.0.40: bold and italic as one choice, offered only in the cuts `font` has (supporter-looks.ts NAME_STYLE_CUTS): an
 * empty list when it has none (the row is left out).
 */
export function styleChoices(font: NameFontId | null | undefined): { id: NameStyle | null; name: string }[] {
  const c = NAME_STYLE_CUTS[font ?? "default"];
  if (!c.bold && !c.italic) return [];
  return [
    { id: null, name: "Plain" },
    ...(c.bold ? [{ id: "b" as const, name: "Bold" }] : []),
    ...(c.italic ? [{ id: "i" as const, name: "Italic" }] : []),
    ...(c.bold && c.italic ? [{ id: "bi" as const, name: "Bold italic" }] : []),
  ];
}
export const DECO_CHOICES: { id: AvatarDecoId | null; name: string }[] = [{ id: null, name: "None" }, ...AVATAR_DECOS];
/** With a peak (T8+ frame light, T9+ motes), "none" keeps the tier's own layer (supporter-looks.ts cardLayerPlan). */
export const borderChoices = (peak: PeakTier | null): { id: CardBorderId | null; name: string }[] => [{ id: null, name: peak && peak >= 8 ? "Your tier's" : "None" }, ...CARD_BORDERS];
export const HOVER_FX_CHOICES: { id: HoverFxId | null; name: string }[] = [{ id: null, name: "None" }, ...HOVER_FX];
export { hoverFxSwatch } from "./hover-fx";
export const cardEffectChoices = (peak: PeakTier | null): { id: CardEffectId | null; name: string }[] => [{ id: null, name: peak && peak >= 9 ? "Your tier's" : "None" }, ...CARD_EFFECTS];

/** "Aa" in a name look (colour, effect, font). */
export function nameSample(look: NameLook): HTMLElement {
  const a = nameAttrs(look, "#eef1f6", "Aa");
  return h("span.pf-sw.pf-sw-name", { "aria-hidden": "true", ...a }, "Aa");
}

/** The player's avatar wearing a decoration (animated; still under reduced motion and Potato: avatar-deco.css). */
export function decoSwatch(player: { id?: string | null; name: string; avatarUrl: string | null }, id: AvatarDecoId | null, nameColor: NameColorId | null | undefined): HTMLElement {
  return h("span.pf-sw.pf-sw-av", { "aria-hidden": "true" }, decorated(avatarEl(player, "pf-sw-av-img"), { avatarDeco: id, nameColor }, { animate: true }));
}

/**
 * A small card: a border runs in its frame band as on the card; an effect is too fine to read at this size, so it
 * shows a still drawing of itself (EFFECT_ICON) in the player's colour.
 */
export function cardFxSwatch(peak: PeakTier | null, border: CardBorderId | null, effect: CardEffectId | null, nameColor: NameColorId | null | undefined): HTMLElement {
  const layers = cardLayers(peak, { cardBorder: border, cardEffect: effect, nameColor });
  // An effect with no still drawn yet (a new one in CARD_EFFECTS) shows its own layer, as the borders do.
  const icon = effect ? EFFECT_ICON[effect]?.(nameColorHex(nameColor) ?? SUPPORTER_FX) ?? null : null;
  return h(`span.pf-sw.pf-sw-fx${layers.cls}`, { "aria-hidden": "true", style: layers.style }, layers.aura, h("span.pf-sw-fx-in", { html: icon ?? undefined }, ...(icon ? [] : layers.inner)));
}

/** A four-point star (card-fx.css .pc-sfx-stars) of radius `r` at `x`, `y`. */
const star = (x: number, y: number, r: number): string => {
  const k = +(r * 0.16).toFixed(2);
  return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
};

/**
 * The effects drawn still at swatch size (38 x 22), in colour `c`: each a small drawing of what the layer in
 * card-fx.css does on the card, so a look redrawn there is redrawn here (v0.0.43: Foil's bands of spectrum over ruled
 * stock, Embers rising off the bottom edge and dying out, Stars and Snow as uneven scatters).
 */
const EFFECT_ICON: Partial<Record<CardEffectId, (c: string) => string>> = {
  hops: (c) => `<svg viewBox="0 0 38 22"><path d="M1 19Q7 5 13 19Q19 5 25 19Q31 5 37 19" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="0.5 2.6" stroke-linecap="round"/></svg>`,
  embers: (c) => `<svg viewBox="0 0 38 22"><g fill="${c}"><circle cx="5" cy="19.4" r="1.3"/><circle cx="14.5" cy="17.2" r="1"/><circle cx="24" cy="19" r="1.4"/><circle cx="33" cy="16.6" r="0.9"/><circle cx="19.5" cy="12.6" r="0.8" opacity=".55"/><circle cx="8.5" cy="11.4" r="0.6" opacity=".4"/><circle cx="29" cy="9.6" r="0.6" opacity=".3"/></g><path d="M10 20.6l.9-2.6M29.6 21l.7-2" fill="none" stroke="${c}" stroke-width="0.8" stroke-linecap="round"/><g fill="#ffe2b0"><circle cx="18" cy="19.8" r="0.7"/><circle cx="35.4" cy="20" r="0.6"/><circle cx="26" cy="14" r="0.5" opacity=".6"/></g></svg>`,
  stars: (c) => `<svg viewBox="0 0 38 22"><path d="${star(6.5, 5.5, 3.4)}${star(25, 9.5, 2.1)}${star(14.5, 16, 2.6)}${star(34, 17.5, 1.5)}" fill="${c}"/><path d="${star(19.5, 4, 1.7)}${star(31, 3.5, 1.1)}${star(4.5, 15.5, 1.2)}${star(26.5, 18.5, 1.9)}" fill="#fff" fill-opacity=".42"/></svg>`,
  rain: (c) => `<svg viewBox="0 0 38 22"><g stroke="${c}" stroke-width="0.9" stroke-linecap="round"><path d="M9 2l-3 7M21 5l-3 7M32 1l-3 7M15 11l-2.5 6M28 12l-2.5 6"/></g><g stroke="#fff" stroke-width="0.7" stroke-linecap="round" fill="none"><path d="M10 21l-1.4-2.4M12 21v-2.8M14 21l1.4-2.4M27 21l-1.2-2M29 21l1.2-2"/></g></svg>`,
  snow: (c) => `<svg viewBox="0 0 38 22"><g fill="#fff" fill-opacity=".8"><circle cx="6" cy="6" r="1.7"/><circle cx="26.5" cy="4" r="1.2"/><circle cx="19" cy="15.5" r="1.6"/></g><g fill="${c}" fill-opacity=".75"><circle cx="13.5" cy="9.5" r="0.7"/><circle cx="33" cy="12" r="0.8"/><circle cx="8" cy="18" r="0.6"/></g></svg>`,
  petals: (c) => `<svg viewBox="0 0 38 22"><g fill="${c}"><path transform="translate(6 6) rotate(20)" d="M0 0C2-2.6 6-2.6 7.4-.7L6.4 0L7.4.7C6 2.6 2 2.6 0 0z"/><path transform="translate(22 14) rotate(-35)" d="M0 0C2-2.6 6-2.6 7.4-.7L6.4 0L7.4.7C6 2.6 2 2.6 0 0z"/></g><g fill="#ffe6ee"><path transform="translate(26 3) rotate(110) scale(.8)" d="M0 0C2-2.6 6-2.6 7.4-.7L6.4 0L7.4.7C6 2.6 2 2.6 0 0z"/><path transform="translate(9 16) rotate(60) scale(.75)" d="M0 0C2-2.6 6-2.6 7.4-.7L6.4 0L7.4.7C6 2.6 2 2.6 0 0z"/></g></svg>`,
  speed: (c) => `<svg viewBox="0 0 38 22"><g fill="${c}"><path d="M4 5.2L22 6L4 6.8z"/><path d="M12 11.1L36 12L12 12.9z"/><path d="M6 17.2L20 18L6 18.8z"/></g><path d="M24 4.6L34 5L24 5.4z" fill="#fff" fill-opacity=".6"/></svg>`,
  foil: (c) => {
    const id = `fo-${c.replace(/[^0-9a-z]/gi, "")}`;
    return `<svg viewBox="0 0 38 22"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="1" y1="2" x2="37" y2="19"><stop offset=".06" stop-color="${c}" stop-opacity="0"/><stop offset=".2" stop-color="${c}" stop-opacity=".7"/><stop offset=".33" stop-color="#ff7aa8" stop-opacity=".62"/><stop offset=".45" stop-color="#ffd66b" stop-opacity=".58"/><stop offset=".56" stop-color="#8cf5a6" stop-opacity=".54"/><stop offset=".67" stop-color="#79d2ff" stop-opacity=".62"/><stop offset=".79" stop-color="#b98cff" stop-opacity=".62"/><stop offset=".9" stop-color="${c}" stop-opacity=".5"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient><pattern id="${id}-r" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(25)"><rect width="2.6" height="0.6" fill="#fff" fill-opacity=".1"/></pattern></defs><rect width="38" height="22" fill="url(#${id})"/><rect width="38" height="22" fill="url(#${id}-r)"/></svg>`;
  },
  aurora: (c) => `<svg viewBox="0 0 38 22"><defs><radialGradient id="au1"><stop offset="0" stop-color="${c}" stop-opacity=".9"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient><radialGradient id="au2"><stop offset="0" stop-color="#9a6bff" stop-opacity=".9"/><stop offset="1" stop-color="#9a6bff" stop-opacity="0"/></radialGradient></defs><ellipse cx="12" cy="5" rx="12" ry="7" fill="url(#au1)"/><ellipse cx="27" cy="4" rx="11" ry="6" fill="url(#au2)"/></svg>`,
};
