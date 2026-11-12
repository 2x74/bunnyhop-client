// A supporter's name font may never make a name wider than the default font would (Sol's review of v37/supporter,
// P2-2). size-adjust (ui/name-fonts.css) only matches the faces on average: a monospace "iiii" or a marker "llll" is
// still twice as wide. So every name is fitted on its own, measured in this browser:
//   k = min(1, width in the default font / width in the face)
// and drawn at that scale with CSS zoom (the layout box shrinks with it, so rows, ellipses and flex lines see the
// smaller width). The measure is the conservative one for every surface a name shows on:
//   - the default width is the narrowest of the two default stacks (--font-ui, --font-text) at weight 400, the
//     lightest any name is drawn at;
//   - the face is measured at weight 900, so letters it lacks (they fall back to the default font at the name's own
//     weight) are counted at their widest;
//   - both with the most negative letter-spacing a name element uses (-0.03em): fitting at the tightest spacing holds
//     for every looser one (the ratio grows with the spacing when the face is the wider one).
// Until the face has loaded, a name is drawn in the default font (no class, no zoom): nothing is wider while it loads.
// When it arrives, one pass upgrades the names waiting for it ([data-nm-font]).
//
// v0.0.40, bold and italic (supporter-looks.ts NAME_STYLE_CUTS): a face is a font and a cut ("condensed-bi"), measured
// in that cut (bold at 950, italic slanted) against the same default; the default font in bold or italic is fitted the
// same way (the system's own cuts, always loaded), so a bold name is never wider than the plain one either.

import { nameFontFamily, type NameFontId, type NameStyle } from "../supporter-looks";

/** A font in a cut: "serif", "serif-i", "default-b" (the default font bold). What [data-nm-font] carries. */
export type FaceKey = string;
export const faceKey = (font: NameFontId | null, style: NameStyle | null): FaceKey => `${font ?? "default"}${style ? `-${style}` : ""}`;
const parseKey = (key: FaceKey): { font: NameFontId | null; style: NameStyle | null } => {
  const [font, style] = key.split("-") as [string, NameStyle | undefined];
  return { font: font === "default" ? null : (font as NameFontId), style: style ?? null };
};
/** The CSS font of a face at `px` (the weight it is measured at: 900, or 950 bold). */
const faceFont = (key: FaceKey, px: number): string => {
  const { font, style } = parseKey(key);
  return `${style?.includes("i") ? "italic " : ""}${style?.includes("b") ? 950 : 900} ${px}px ${font ? `"${nameFontFamily(font)}", ` : ""}${FONT_UI}`;
};

/** The most negative letter-spacing on any name element (ui/profile.css .pc-name), in em. */
export const TIGHTEST_EM = -0.03;
const PX = 100;
const FONT_UI = `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const FONT_TEXT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/**
 * The scale for a name: wDefault and wFace at 0 letter-spacing, n letters, ls the spacing (px, at the measuring size).
 * Exported for tests: never above 1, and k * (wFace + n*ls) <= wDefault + n*ls for every ls >= the one given.
 */
export function fitScale(wDefault: number, wFace: number, n: number, ls: number): number {
  const face = wFace + n * ls;
  if (!(face > 0) || !(wDefault > 0)) return 1;
  const k = (wDefault + n * ls) / face;
  // Floor to 1/1000 so rounding never tips it over.
  return k >= 1 ? 1 : Math.floor(k * 1000) / 1000;
}

const ready = new Set<FaceKey>(["default", "default-b", "default-i", "default-bi"]);
const asked = new Set<FaceKey>();
const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null = null;

function measure(font: string, text: string): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * The fit of `name` in face `id` (a font, or a FaceKey for a font in a cut), or null while the face hasn't loaded (draw
 * the default font meanwhile).
 */
export function nameFit(id: NameFontId | FaceKey, name: string): number | null {
  if (typeof document === "undefined") return null;
  if (!ready.has(id)) {
    load(id);
    return null;
  }
  const key = `${id}|${name}`;
  let k = cache.get(key);
  if (k === undefined) {
    const { font, style } = parseKey(id);
    // A face against the default at 400 (faces are one weight, drawn the same at any weight). The default font in a cut
    // against itself at 600, the lightest weight a name column draws (the boards): its weight changes with the surface.
    const base = font ? 400 : 600;
    const wDefault = Math.min(measure(`${base} ${PX}px ${FONT_UI}`, name), measure(`${base} ${PX}px ${FONT_TEXT}`, name));
    const wFace = font ? measure(faceFont(id, PX), name) : measure(`${style?.includes("i") ? "italic " : ""}${style?.includes("b") ? 950 : base} ${PX}px ${FONT_UI}`, name);
    k = fitScale(wDefault, wFace, [...name].length, TIGHTEST_EM * PX);
    if (cache.size > 4000) cache.clear();
    cache.set(key, k);
  }
  return k;
}

function load(id: FaceKey): void {
  if (asked.has(id) || !document.fonts) return;
  asked.add(id);
  document.fonts.load(faceFont(id, 16).replace(`, ${FONT_UI}`, ""), "Aa").then(
    (faces) => {
      if (!faces.length) return;
      ready.add(id);
      upgrade(id);
    },
    () => {},
  );
}

/** Names drawn while `id` was loading: give them the face now, fitted. */
function upgrade(id: FaceKey): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-nm-font="${id}"]`)) {
    const k = nameFit(id, el.textContent ?? "");
    if (k === null) continue;
    applyFit(el, id, k);
  }
}

/** The classes of a face (font and cut) on a name element. */
export function faceClasses(id: FaceKey): string[] {
  const { font, style } = parseKey(id);
  return [...(font ? ["nm-font", `nm-font-${font}`] : ["nm-font"]), ...(style?.includes("b") ? ["nm-b"] : []), ...(style?.includes("i") ? ["nm-i"] : [])];
}

/** The face's classes and the fit on an element (also what nameAttrs returns for one created after the face loaded). */
export function applyFit(el: HTMLElement, id: FaceKey, k: number): void {
  el.classList.add(...faceClasses(id));
  el.style.setProperty("--nm-k", String(k));
  el.removeAttribute("data-nm-font");
}

/** For tests: mark a face loaded without a document. */
export const _markReady = (id: FaceKey) => ready.add(id);
