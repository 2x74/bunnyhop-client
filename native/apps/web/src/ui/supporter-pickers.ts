// The supporter looks' picker choices and swatches (supporter-looks.ts), one implementation for both places that pick
// them: Edit card → Name / Avatar / Effects (ui/card-editor.ts, a tile per choice) and the Support page beside the stage
// (ui/support.ts, the swatches alone in a row). Both save through POST /me/supporter (api.saveSupporter).

import { nameColorHex, NAME_COLORS, NAME_EFFECTS, type NameColorId, type NameEffect, type NameLook, type PeakTier } from "../creators";
import { AVATAR_DECOS, CARD_BORDERS, CARD_EFFECTS, NAME_FONTS, type AvatarDecoId, type CardBorderId, type CardEffectId, type NameFontId } from "../supporter-looks";
import { decorated } from "./avatar-deco";
import { avatarEl } from "./card";
import { cardLayers, SUPPORTER_FX } from "./card-fx";
import { h } from "./dom";
import { nameAttrs } from "./marks";

export const COLOUR_CHOICES: { id: NameColorId | null; name: string; hex: string }[] = [{ id: null, name: "White", hex: "#eef1f6" }, ...NAME_COLORS];
export const EFFECT_CHOICES: { id: NameEffect | null; name: string }[] = [{ id: null, name: "Plain" }, ...NAME_EFFECTS];
export const FONT_CHOICES: { id: NameFontId | null; name: string }[] = [{ id: null, name: "Default" }, ...NAME_FONTS];
export const DECO_CHOICES: { id: AvatarDecoId | null; name: string }[] = [{ id: null, name: "None" }, ...AVATAR_DECOS];
/** With a peak (T8+ frame light, T9+ motes), "none" keeps the tier's own layer (supporter-looks.ts cardLayerPlan). */
export const borderChoices = (peak: PeakTier | null): { id: CardBorderId | null; name: string }[] => [{ id: null, name: peak && peak >= 8 ? "Your tier's" : "None" }, ...CARD_BORDERS];
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
  const icon = effect ? EFFECT_ICON[effect](nameColorHex(nameColor) ?? SUPPORTER_FX) : null;
  return h(`span.pf-sw.pf-sw-fx${layers.cls}`, { "aria-hidden": "true", style: layers.style }, layers.aura, h("span.pf-sw-fx-in", { html: icon ?? undefined }, ...(icon ? [] : layers.inner)));
}

/** The effects drawn still at swatch size (38 x 22), in colour `c`. */
const EFFECT_ICON: Record<CardEffectId, (c: string) => string> = {
  hops: (c) => `<svg viewBox="0 0 38 22"><path d="M1 19Q7 5 13 19Q19 5 25 19Q31 5 37 19" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="0.5 2.6" stroke-linecap="round"/></svg>`,
  embers: (c) => `<svg viewBox="0 0 38 22"><g fill="${c}"><circle cx="7" cy="17" r="1.3"/><circle cx="16" cy="11" r="1"/><circle cx="25" cy="15" r="1.4"/><circle cx="31" cy="7" r="0.9"/><circle cx="11" cy="5" r="0.7"/></g><g fill="#ffe2b0"><circle cx="20" cy="19" r="0.9"/><circle cx="34" cy="16" r="0.8"/></g></svg>`,
  stars: (c) => `<svg viewBox="0 0 38 22"><path d="M9 4q.5 3 3 3.4q-2.5.5-3 3q-.5-2.5-3-3q2.5-.4 3-3.4zM27 11q.4 2.2 2.4 2.6q-2 .4-2.4 2.4q-.4-2-2.4-2.4q2-.4 2.4-2.6z" fill="${c}"/><path d="M19 3q.3 1.5 1.6 1.8q-1.3.3-1.6 1.6q-.3-1.3-1.6-1.6q1.3-.3 1.6-1.8zM14 15q.3 1.4 1.4 1.6q-1.1.3-1.4 1.4q-.3-1.1-1.4-1.4q1.1-.2 1.4-1.6z" fill="#fff"/></svg>`,
  aurora: (c) => `<svg viewBox="0 0 38 22"><defs><radialGradient id="au1"><stop offset="0" stop-color="${c}" stop-opacity=".9"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient><radialGradient id="au2"><stop offset="0" stop-color="#9a6bff" stop-opacity=".9"/><stop offset="1" stop-color="#9a6bff" stop-opacity="0"/></radialGradient></defs><ellipse cx="12" cy="5" rx="12" ry="7" fill="url(#au1)"/><ellipse cx="27" cy="4" rx="11" ry="6" fill="url(#au2)"/></svg>`,
};
