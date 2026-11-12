// A supporter's hover effect (supporter-looks.ts HOVER_FX): how their mini profile (ui/hover-card.ts) comes in, and
// for Tilt how it follows the pointer while it rests on their name. The same calls play it on the pickers' small
// cards (hoverFxSwatch). Styles: ./hover-card.css (.hfx-*).
// - Entrances are one WAAPI run on the card (transform / opacity) plus, for Unfold and Glint, a few short-lived layers
//   that are removed when they finish. Each fits the plain entrance (hc-in, 140 ms) plus HOVER_FX_EXTRA_MS; the exit is
//   untouched (the card just hides).
// - Tilt (and Foil, the card effect that follows the pointer) is the only per-frame work: a pointermove watch, one write
//   per animation frame, from when the card shows until it hides (the pointer leaving the name hides it).
// - Nothing under reduced motion or Potato: the plain entrance, a still card.

import { nameColorHex, type NameColorId } from "../creators";
import { hopKeyframes } from "../notify/spring";
import { HOVER_FX_MS, type HoverFxId } from "../supporter-looks";
import { SUPPORTER_FX } from "./card-fx";
import { h } from "./dom";

const HFX_MS = HOVER_FX_MS;
const PLAIN_MS = 140;

export const quietFx = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

/**
 * Plays `fx`'s entrance on `card` (the frame element; its content box is `.hc-inner` or `.pf-sw-fx-in`). `nameAt`: where
 * the name is, as a CSS transform origin on the card (Unfold opens from it).
 */
export function enterHoverFx(card: HTMLElement, fx: HoverFxId | null, nameAt = "12px 0"): void {
  if (!fx || fx === "tilt" || quietFx() || typeof card.animate !== "function") return;
  const inner = card.querySelector<HTMLElement>(".hc-inner, .pf-sw-fx-in");
  if (fx === "glint") {
    if (!inner) return;
    const sheen = h("span.hfx-sheen", { "aria-hidden": "true" });
    inner.append(sheen);
    sheen
      .animate([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], { duration: HFX_MS.glint - PLAIN_MS, delay: PLAIN_MS, easing: "cubic-bezier(.4,0,.2,1)", fill: "backwards" })
      .finished.then(() => sheen.remove(), () => sheen.remove());
    return;
  }
  // The others replace the plain fade.
  card.classList.add("hfx-own");
  if (fx === "hop") {
    card.style.transformOrigin = "50% 100%";
    card.animate(hopKeyframes(12, 7) as Keyframe[], { duration: HFX_MS.hop });
  } else if (fx === "flip") {
    card.animate(
      [
        { transform: "perspective(800px) rotateY(-100deg)", opacity: 0, easing: "cubic-bezier(.2,.7,.3,1)" },
        { opacity: 1, offset: 0.3 },
        { transform: "perspective(800px) rotateY(9deg)", offset: 0.72, easing: "ease-in-out" },
        { transform: "perspective(800px) rotateY(0deg)" },
      ],
      { duration: HFX_MS.flip },
    );
  } else {
    // Unfold: out from the name, and the frame drawn round in the colour, edge after edge, fading into the frame.
    card.style.transformOrigin = nameAt;
    card.animate([{ transform: "scale(0.35, 0.12)", opacity: 0 }, { opacity: 1, offset: 0.35 }, { transform: "none" }], { duration: 250, easing: "cubic-bezier(.2,.8,.25,1.05)" });
    const edges: [string, string, number][] = [["t", "scaleX(0)", 0], ["r", "scaleY(0)", 0.22], ["b", "scaleX(0)", 0.42], ["l", "scaleY(0)", 0.6]];
    for (const [side, from, start] of edges) {
      const edge = h(`span.hfx-edge.hfx-edge-${side}`, { "aria-hidden": "true" });
      card.prepend(edge);
      edge
        .animate(
          [{ transform: from, opacity: 1 }, { transform: from, opacity: 1, offset: start }, { transform: "none", opacity: 1, offset: start + 0.2 }, { opacity: 1, offset: 0.8 }, { transform: "none", opacity: 0 }],
          { duration: HFX_MS.unfold },
        )
        .finished.then(() => edge.remove(), () => edge.remove());
    }
  }
}

/**
 * Follows the pointer while it moves (Tilt and Foil): --mx / --my on `card` (0..1 across it, clamped; Foil's band and
 * Tilt's light read them) and, with `lean`, `leanEl` turned toward the pointer (its side nearest the pointer comes
 * forward, at most `deg`). One write per animation frame. Returns the stop.
 */
export function followPointer(card: HTMLElement, o: { lean?: HTMLElement | null; deg?: number; from?: { x: number; y: number } | null } = {}): () => void {
  if (quietFx()) return () => {};
  const deg = o.deg ?? 6;
  let raf = 0;
  let x = o.from?.x ?? NaN, y = o.from?.y ?? NaN;
  const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
  const apply = () => {
    raf = 0;
    if (!card.isConnected || Number.isNaN(x)) return;
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    card.style.setProperty("--mx", (Math.max(0, Math.min(1, fx))).toFixed(3));
    card.style.setProperty("--my", (Math.max(0, Math.min(1, fy))).toFixed(3));
    if (o.lean) o.lean.style.transform = `perspective(700px) rotateX(${(clamp(fy * 2 - 1, 1.5) * deg * 0.5).toFixed(2)}deg) rotateY(${(-clamp(fx * 2 - 1, 1) * deg).toFixed(2)}deg)`;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    x = e.clientX;
    y = e.clientY;
    raf ||= requestAnimationFrame(apply);
  };
  card.classList.add("is-live");
  o.lean?.classList.add("hfx-leaning");
  addEventListener("pointermove", move, { passive: true });
  raf = requestAnimationFrame(apply);
  return () => {
    removeEventListener("pointermove", move);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    card.classList.remove("is-live");
    if (o.lean) {
      o.lean.classList.remove("hfx-leaning");
      o.lean.style.transform = "";
    }
  };
}

/** Tilt's soft light: a layer over the content that sits under the pointer (--mx / --my), by transform. */
export const tiltLight = (): HTMLElement => h("span.hfx-spot", { "aria-hidden": "true" });

/**
 * A picker's small card for a hover effect: a frame and a sketch of a mini profile that plays the entrance when the
 * pointer comes onto it (Tilt: leans while the pointer moves over it).
 */
export function hoverFxSwatch(id: HoverFxId | null, nameColor: NameColorId | null | undefined): HTMLElement {
  const color = nameColorHex(nameColor) ?? SUPPORTER_FX;
  const inner = h(
    "span.pf-sw-fx-in",
    null,
    h("span.hfx-sw-av"),
    h("span.hfx-sw-line"),
    h("span.hfx-sw-line.hfx-sw-short"),
    ...(id === "tilt" ? [tiltLight()] : []),
  );
  const mini = h("span.pf-sw-fx.hfx-sw-card", { style: `--sx:${color}` }, inner);
  const wrap = h("span.pf-sw.pf-sw-hfx", { "aria-hidden": "true" }, mini);
  let stop: (() => void) | null = null;
  const play = () => {
    mini.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    mini.classList.remove("hfx-own");
    mini.style.transformOrigin = "";
    if (id === "tilt") {
      stop ??= followPointer(mini, { lean: mini, deg: 10 });
      return;
    }
    // "None": the plain fade, so every choice shows how it comes in.
    if (id) enterHoverFx(mini, id, "8px 0");
    else if (!quietFx()) mini.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: PLAIN_MS, easing: "ease-out" });
  };
  wrap.addEventListener("pointerenter", (e) => e.pointerType !== "touch" && play());
  wrap.addEventListener("pointerleave", () => {
    stop?.();
    stop = null;
  });
  return wrap;
}
