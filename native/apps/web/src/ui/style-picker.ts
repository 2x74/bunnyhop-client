// Selected run style (Normal / Legit Scroll / W-Only / Sideways / Half-Sideways, and the assisted Auto-strafe; see
// styles.ts) and the map list's style control.
// The style is not a setting: it decides the physics + key rules of a run and keys PBs, ghosts and leaderboards.
// It is remembered across maps (localStorage) and applies to main-track runs; bonus runs are always Normal.

import { DEFAULT_STYLE, isStyleId, STYLE_DEFS, styleDef, type StyleId } from "../styles";
import { h } from "./dom";

const KEY = "bunnyhop:style";
const listeners = new Set<(id: StyleId) => void>();

/** The player's chosen (main-track) style. */
export function selectedStyle(): StyleId {
  try {
    const v = localStorage.getItem(KEY);
    return isStyleId(v) ? v : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

export function setSelectedStyle(id: StyleId): void {
  if (id === selectedStyle()) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: still applied for this page */
  }
  for (const l of listeners) l(id);
}

/** Called on every change of the selected style. Returns an unsubscribe function. */
export function onStyleChange(fn: (id: StyleId) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Small inline style tag, e.g. on the HUD map line or leaderboard headers. */
export function styleTag(id: string): HTMLElement {
  const d = styleDef(id);
  return h(`span.style-tag.st-${id}`, { title: d ? `${d.name}: ${d.rule}` : id }, d?.name ?? id);
}

/** True if the player has a PB (any map, style, track) saved in this browser. */
export function hasAnyClear(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith("bunnyhop:pb:")) return true;
  } catch {
    /* storage blocked: say nothing */
    return true;
  }
  return false;
}
