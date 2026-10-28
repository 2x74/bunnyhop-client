import { send } from "../bridge";
import { onCssApplied } from "./custom-css";

// The native HUD is drawn by the game, not by this page, so Custom CSS can't
// style it directly. What it can draw (hud_theme.hpp) is resolved here by the
// browser itself, on probe elements under a hidden #hud, and sent as RGBA:
// - the colour variables --cream, --cream-2, --amber, --gain, --loss, --sync-ok;
// - `#hud [data-el="..."]` color and opacity for the elements in HUD_ELEMENTS.
// Everything else (fonts, sizes, backgrounds, shadows, images, live numbers,
// #custom-art) is website-only.

export type Rgba = [number, number, number, number];

export interface HudTheme {
  colors: Partial<Record<"text" | "secondary" | "accent" | "gain" | "loss" | "sync", Rgba>>;
  elements: Record<string, { color?: Rgba; opacity?: number }>;
}

/** CSS variable -> the HUD colour it sets. */
export const HUD_VARIABLES = {
  "--cream": "text",
  "--cream-2": "secondary",
  "--amber": "accent",
  "--gain": "gain",
  "--loss": "loss",
  "--sync-ok": "sync",
} as const;

/** Website HUD element name -> native HUD element id. */
export const HUD_ELEMENTS: Record<string, string> = {
  speed: "speed",
  timer: "timer",
  split: "splits",
  stats: "runStats",
  jumpStats: "jumpStats",
  strafeTrainer: "strafeTrainer",
  keys: "keys",
  graph: "speedGraph",
  map: "map",
  fps: "fps",
  ammo: "health",
};

let canvas: CanvasRenderingContext2D | null = null;

/** A computed CSS colour as RGBA in 0..1, or null. */
export function parseColor(value: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (match) {
    const alphaText = match[4] ?? "1";
    const alpha = alphaText.endsWith("%") ? parseFloat(alphaText) / 100 : parseFloat(alphaText);
    const parts: Rgba = [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255, alpha];
    return parts.every((part) => Number.isFinite(part) && part >= 0 && part <= 1) ? parts : null;
  }
  // Other notations (color(srgb ...), named colours): the canvas normalises them.
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return null;
  canvas.fillStyle = "#000000";
  canvas.fillStyle = value;
  const normal = String(canvas.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(normal)) {
    const hex = parseInt(normal.slice(1), 16);
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, 1];
  }
  return normal.startsWith("rgb") ? parseColor(normal) : null;
}

/** Whether `css` mentions the element `name` in a [data-el] selector. */
function mentionsElement(css: string, name: string): boolean {
  return new RegExp(`data-el\\s*=\\s*["']?${name}["'\\]]`).test(css);
}

/** Whether `css` declares the custom property `name`. */
function declares(css: string, name: string): boolean {
  return new RegExp(`${name}\\s*:`).test(css);
}

function probes(): { hud: HTMLElement; variable: HTMLElement; elements: Map<string, HTMLElement> } {
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.setAttribute("aria-hidden", "true");
  hud.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;contain:strict";
  const variable = document.createElement("span");
  hud.append(variable);
  const elements = new Map<string, HTMLElement>();
  for (const name of Object.keys(HUD_ELEMENTS)) {
    const probe = document.createElement("div");
    probe.dataset.el = name;
    hud.append(probe);
    elements.set(name, probe);
  }
  document.body.append(hud);
  return { hud, variable, elements };
}

/** The HUD theme `css` (as applied to this page) gives, resolved by the browser. */
export function resolveHudTheme(css: string): HudTheme {
  const theme: HudTheme = { colors: {}, elements: {} };
  if (!css.trim()) return theme;
  // The menu itself may already have a #hud: probe only when it doesn't.
  if (document.getElementById("hud")) return theme;
  const { hud, variable, elements } = probes();
  try {
    for (const [name, key] of Object.entries(HUD_VARIABLES)) {
      if (!declares(css, name)) continue;
      variable.style.color = `var(${name})`;
      const color = parseColor(getComputedStyle(variable).color);
      if (color) theme.colors[key] = color;
    }
    const inherited = getComputedStyle(hud).color;
    for (const [name, probe] of elements) {
      if (!mentionsElement(css, name)) continue;
      const style = getComputedStyle(probe);
      const entry: { color?: Rgba; opacity?: number } = {};
      const color = style.color !== inherited ? parseColor(style.color) : null;
      if (color) entry.color = color;
      const opacity = Number(style.opacity);
      if (Number.isFinite(opacity) && opacity < 1) entry.opacity = Math.max(0, opacity);
      if (entry.color || entry.opacity !== undefined) theme.elements[HUD_ELEMENTS[name]] = entry;
    }
  } finally {
    hud.remove();
  }
  return theme;
}

let lastSent = "";
/** Sends the HUD theme each time the applied CSS changes it. Once, at boot. */
export function installHudTheme(): void {
  onCssApplied((css) => {
    const theme = resolveHudTheme(css);
    const encoded = JSON.stringify(theme);
    if (encoded === lastSent) return;
    lastSent = encoded;
    send({ type: "hudTheme", theme });
  });
}
