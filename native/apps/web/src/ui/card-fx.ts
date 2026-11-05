// Supporter card borders and effects (supporter-looks.ts CARD_BORDERS / CARD_EFFECTS), built on the peak treatment's
// layers (ui/card.ts peakLayers, v37/tier-rewards): cardLayers() returns the same { cls, style, aura, inner } shape, so
// both cards (playerCard, ui/hover-card.ts hoverCardBody) place it exactly where they placed the peak layers.
// How the two stack: supporter-looks.ts cardLayerPlan (the peak's sweep always stays; a supporter's border takes the
// frame light's place, a supporter's effect the motes' place, never both on one card). Styles: ./card-fx.css.

import "./card-fx.css";
import { nameColorHex, type NameColorId, type PeakTier } from "../creators";
import { cardBorderOf, cardEffectOf, cardLayerPlan, type CardBorderId, type CardEffectId } from "../supporter-looks";
import { fxVisibility } from "./avatar-deco";
import { peakLayers } from "./card";
import { h } from "./dom";

/** The supporter layers' colour without a name colour: the Supporter aqua. */
export const SUPPORTER_FX = "#6ff0f0";

export interface CardFx {
  cardBorder?: CardBorderId | null;
  cardEffect?: CardEffectId | null;
  nameColor?: NameColorId | null;
}

/** The card's moving layers: the peak's (tier) and a supporter's border and effect, stacked by cardLayerPlan. */
export function cardLayers(peak: PeakTier | null, fx: CardFx | null | undefined): ReturnType<typeof peakLayers> {
  const border = cardBorderOf(fx?.cardBorder);
  const effect = cardEffectOf(fx?.cardEffect);
  const base = peakLayers(peak);
  if (!border && !effect) return base;
  const plan = cardLayerPlan(peak, border, effect);
  const color = nameColorHex(fx?.nameColor) ?? SUPPORTER_FX;
  const aura = plan.frame === "peak" ? base.aura : plan.frame ? h(`div.pc-sborder.pc-sborder-${plan.frame}`, { "aria-hidden": "true" }) : null;
  const inner = [
    ...(plan.effect === "motes" ? base.inner.filter((el) => el.classList.contains("pc-motes")) : plan.effect ? [h(`div.pc-sfx.pc-sfx-${plan.effect}`, { "aria-hidden": "true" })] : []),
    ...base.inner.filter((el) => el.classList.contains("pc-glint")),
  ];
  return {
    cls: `${base.cls}.pc-sx`,
    style: [base.style, `--sx:${color}`].filter(Boolean).join(";"),
    aura,
    inner,
  };
}

/**
 * Pauses a card's layers, and the avatar decoration inside it, while it is off screen (call once the card element
 * exists). One registration per card; the observer lets go of it when the card is replaced (avatar-deco.ts).
 */
export const watchCardFx = (card: HTMLElement): (() => void) =>
  card.querySelector(".pc-sborder, .pc-sfx, .pc-aura, .pc-motes, .pc-glint, .av-spin, .av-spin-back, .av-sway, .av-twinkle, .av-twinkle-late") ? fxVisibility(card) : () => {};
