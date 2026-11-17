// A world record holder's map as the card background (v0.0.43; rules apps/web/src/map-bg.ts, server apps/api
// src/map-bg.ts, look ui/card-mapbg.css). The profile card (ui/card.ts) and the mini profile (ui/hover-card.ts) put
// mapBgLayer() first in their content box and add the record line; both only when the API sent a `mapBg` (it never
// does while the server's MAP_BG switch is off, so nothing here shows then).
//
// The picture's box is the content box (absolute, nothing reserved in the flow), so the card never moves while it
// loads: the image fades in over the card's own background. A picture that fails to load takes the whole treatment
// off that card and is remembered for the page's life, so a redraw (ui/card.ts updatePlayerCard) builds the plain
// card again rather than the broken one. A picture already loaded is built shown, so a redraw never fades it twice.

import type { MapBgView } from "../map-bg";
import { MAP_BG_LINE } from "../map-bg";
import { styleLabel } from "../styles";
import { formatTime } from "../timer";
import { h } from "./dom";
import "./card-mapbg.css";

const loaded = new Set<string>();
const failed = new Set<string>();

/** The class the card gets while it draws a map (and the picture it would use is not known to fail). */
export const MAP_BG_CLASS = "pc-has-mapbg";

/** The picture to draw for `v` at this size (the profile card takes the 1280x720 render, the mini profile the 480x270). */
export function mapBgSrc(v: MapBgView | null | undefined, small = false): string | null {
  const src = v ? (small ? (v.card ?? v.hero) : (v.hero ?? v.card)) : null;
  return src && !failed.has(src) ? src : null;
}

function settle(img: HTMLImageElement, ok: boolean): void {
  // Read the element now: a redraw may have pointed this same node at another map since it started loading.
  const src = img.getAttribute("src");
  if (!src) return;
  if (ok) {
    loaded.add(src);
    img.classList.add("on");
    return;
  }
  failed.add(src);
  const card = img.closest<HTMLElement>(".pc, .hc");
  card?.classList.remove(MAP_BG_CLASS);
  card?.querySelector(".pc-wrline, .hc-wrline")?.remove();
  img.parentElement?.remove();
}

/** The picture and its scrim (div.pc-mapbg > img.pc-mapbg-img), for the first child of the card's content box. */
export function mapBgLayer(v: MapBgView, src: string): HTMLElement {
  const img = h(`img.pc-mapbg-img${loaded.has(src) ? ".on" : ""}`, { src, alt: "", decoding: "async", draggable: "false" }) as HTMLImageElement;
  img.addEventListener("load", () => settle(img, true));
  img.addEventListener("error", () => settle(img, false));
  if (img.complete && img.naturalWidth) loaded.add(src);
  return h("div.pc-mapbg", { "aria-hidden": "true", "data-map": v.map, style: `--map-dim:${v.dim}` }, img);
}

/** "WR bhop_sqee Sideways 08:38.895" (the style only when it isn't Normal): what the picture is. null when the line is off. */
export function wrLine(v: MapBgView, cls: "pc-wrline" | "hc-wrline", run = false): HTMLElement | null {
  if (!MAP_BG_LINE) return null;
  const style = v.style !== "autohop" ? styleLabel(v.style) : null;
  return h(
    `${cls === "pc-wrline" ? "span" : "div"}.${cls}`,
    { title: `World record on ${v.map}${style ? ` in ${style}` : ""}. It's this card's background.`, ...(run ? { "data-run": v.runId } : {}) },
    h("b", null, "WR"),
    h("span.pc-wrline-map", null, v.map),
    style ? h("span.pc-wrline-style", null, style) : null,
    h("span.pc-wrline-time", null, formatTime(v.time)),
  );
}
