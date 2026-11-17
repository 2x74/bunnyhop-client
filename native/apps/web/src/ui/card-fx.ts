// Supporter card borders and effects (supporter-looks.ts CARD_BORDERS / CARD_EFFECTS), built on the peak treatment's
// layers (ui/card.ts peakLayers, v37/tier-rewards): cardLayers() returns the same { cls, style, aura, inner } shape, so
// both cards (playerCard, ui/hover-card.ts hoverCardBody) place it exactly where they placed the peak layers.
// How the two stack: supporter-looks.ts cardLayerPlan (the peak's sweep always stays; a supporter's border takes the
// frame light's place, a supporter's effect the motes' place, never both on one card). Styles: ./card-fx.css.

import "./card-fx.css";
import { nameColorHex, type NameColorId, type PeakTier } from "../creators";
import { cardBorderOf, cardEffectOf, cardLayerPlan, type CardBorderId, type CardEffectId } from "../supporter-looks";
import { fxClock, fxVisibility } from "./avatar-deco";
export { fxClock };
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
  if (!border && !effect) return base.cls ? { ...base, style: [base.style, fxClock()].filter(Boolean).join(";") } : base;
  const plan = cardLayerPlan(peak, border, effect);
  const color = nameColorHex(fx?.nameColor) ?? SUPPORTER_FX;
  // Stride walks its dashes on six strips (the four sides and the two cut corners: card-fx.css).
  const strips = plan.frame === "stride" ? ["t", "r", "b", "l", "c1", "c2"].map((k) => h(`i.pc-stride-${k}`)) : [];
  const aura = plan.frame === "peak" ? base.aura : plan.frame ? h(`div.pc-sborder.pc-sborder-${plan.frame}`, { "aria-hidden": "true" }, ...strips) : null;
  // Vine and Neon also put a layer behind the content (the leaves in the cut corners; the tube's glow on its edge).
  const borderInner = plan.frame === "vine" || plan.frame === "neon" ? [h(`div.pc-sfx.pc-sfx-${plan.frame}`, { "aria-hidden": "true" })] : [];
  const inner = [
    ...borderInner,
    ...(plan.effect === "motes" ? base.inner.filter((el) => el.classList.contains("pc-motes")) : plan.effect ? [h(`div.pc-sfx.pc-sfx-${plan.effect}`, { "aria-hidden": "true" })] : []),
    ...base.inner.filter((el) => el.classList.contains("pc-glint")),
  ];
  return {
    cls: `${base.cls}.pc-sx`,
    style: [base.style, `--sx:${color}`, fxClock()].filter(Boolean).join(";"),
    aura,
    inner,
  };
}

/** The layers that follow the pointer (--mx / --my: card-fx.css, hover-card.css). */
const POINTER_LAYERS = ".pc-sheen, .pc-holo, .pc-sfx-foil, .hfx-spot";
/**
 * Puts the pointer's place (0..1 across the card) on the card's pointer layers. On the layers, not the card: a custom
 * property on the card restyles every node in it.
 */
export function setPointer(card: HTMLElement, mx: number, my: number): void {
  const x = mx.toFixed(3), y = my.toFixed(3);
  for (const el of card.querySelectorAll<HTMLElement>(POINTER_LAYERS)) {
    el.style.setProperty("--mx", x);
    el.style.setProperty("--my", y);
  }
}

/**
 * A frame's own layer in the band, first inside the card (under the peak's and a supporter's layers): Holo's foil, which
 * slides with the pointer (card-fx.css .pc-holo). Every other frame is its --frame paint alone.
 */
export const frameLayers = (frame: string | null | undefined): HTMLElement | null => (frame === "frame-holo" || frame === "holo" ? h("div.pc-holo", { "aria-hidden": "true" }) : null);

/**
 * Pauses a card's layers, and the avatar decoration inside it, while it is off screen (call once the card element
 * exists). One registration per card; the observer lets go of it when the card is replaced (avatar-deco.ts).
 */
export const watchCardFx = (card: HTMLElement): (() => void) =>
  card.querySelector(".pc-sborder, .pc-sfx, .pc-aura, .pc-motes, .pc-glint, .av-anim") ? fxVisibility(card) : () => {};
