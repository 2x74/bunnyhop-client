// The game's semantic colours and their colour-blind variants (Settings → HUD → Colour blind, Prefs.colorBlind). Red vs
// green carries a lot here: gaining or losing speed, ahead of or behind a split, the strafe trainer's zones, the sync
// bar, start and end zones, teleport vs gravity triggers, jump tiers. Every place that colours by meaning reads it from
// here, through CSS variables (applyPalette) or palette() in JS, so one switch moves them all.
//
// OFF IS THE ORIGINAL LOOK. PALETTES.off holds exactly the colours the game had before this existed (the stylesheets
// define the same values for the CSS variables; apps/web/test/palette.test.ts checks they agree), and applyPalette("off")
// removes every override, so the stylesheets' own values apply.
//
// THE VARIANTS. Red-green (deuteranopia / protanopia, by far the most common) swaps green for sky blue and red for
// vermillion, with yellow between them, from the Okabe-Ito set (#56B4E9 / #F0E442 / #D55E00). Blue-yellow (tritanopia)
// keeps red vs green (they stay apart for it) and moves what it confuses: amber vs red (the trainer's middle zone turns
// violet), blue vs green (boosters, bonus start zones), yellow vs violet (other triggers, jump tiers). The trigger, zone
// and jump-tier sets were picked by simulating each type (Machado et al. 2009) and maximising the smallest colour
// difference among the set, so no two kinds collapse into one.
//
// WHAT THE PLAYER PICKED STAYS. Colours with their own setting (trainer marker, keys overlay, crosshair, paint, trigger
// colours) aren't touched; a trigger colour still at its default follows the palette, one the player chose doesn't.
// MP4 exports (viewer/canvas-hud.ts) keep the original colours: other people watch them.

import { DEFAULT_TRIGGER_PREFS, KINDS, type KindId } from "./triggers/volumes";

export type ColorBlindMode = "off" | "redGreen" | "blueYellow";
export const COLOR_BLIND_MODES: readonly [ColorBlindMode, string][] = [
  ["off", "Off"],
  ["redGreen", "Red-green"],
  ["blueYellow", "Blue-yellow"],
];

export interface Palette {
  /** --gain / --loss: speed, splits and deltas, jump stats, the sync bar's ends. */
  gain: string;
  loss: string;
  /** --sync-ok: the sync bar between bad and good. */
  syncOk: string;
  /** --behind-soft: the end card's "behind" delta. */
  behindSoft: string;
  /** --st-g / --st-o / --st-r: the strafe trainer's on-pace, near and off zones. */
  trainer: { good: string; ok: string; bad: string };
  /** Zones in the world (zone-editor.ts); --zone-start is the start line under the timer. */
  zones: { start: string; end: string; bonusStart: string; bonusEnd: string; split: string };
  /** Trigger kinds at their default colour (triggers/). */
  triggers: Record<KindId, string>;
  /** Jump tiers, worst to best (movement-stats: the HUD distance and the chat line). */
  lj: readonly [string, string, string, string, string];
}

const OFF: Palette = {
  gain: "#4dff88",
  loss: "#ff5d5d",
  syncOk: "#ffd24d",
  behindSoft: "rgba(255, 110, 110, 0.72)",
  trainer: { good: "#4fd08a", ok: "#f29a3a", bad: "#e0473f" },
  zones: { start: "#33dd66", end: "#ee3344", bonusStart: "#33bbdd", bonusEnd: "#dd66ee", split: "#ffaa33" },
  triggers: { ...DEFAULT_TRIGGER_PREFS.colors },
  lj: ["#ffffff", "#5eb6ff", "#4dff88", "#ff5d5d", "#ffc53d"],
};

export const PALETTES: Readonly<Record<ColorBlindMode, Palette>> = {
  off: OFF,
  redGreen: {
    gain: "#56b4e9",
    loss: "#d55e00",
    syncOk: "#f0e442",
    behindSoft: "rgba(213, 94, 0, 0.85)",
    trainer: { good: "#56b4e9", ok: "#f0e442", bad: "#d55e00" },
    zones: { start: "#7fb8ff", end: "#ee3344", bonusStart: "#1f5fff", bonusEnd: "#f0e442", split: "#ffffff" },
    triggers: { teleport: "#e8202a", push: "#7fb8ff", gravity: "#f0e442", other: "#ffffff", clip: "#8040ff", wall: "#6f7681" },
    lj: ["#ffffff", "#5eb6ff", "#8040ff", "#ff5d5d", "#f0e442"],
  },
  blueYellow: {
    ...OFF,
    trainer: { ...OFF.trainer, ok: "#c879ff" },
    zones: { ...OFF.zones, bonusStart: "#1f5fff", split: "#ffffff" },
    triggers: { ...OFF.triggers, push: "#0072b2", other: "#e69f00", wall: "#e0e4ea" },
    lj: ["#ffffff", "#3d8bff", "#4dff88", "#ff5d5d", "#e69f00"],
  },
};

/** The palette for `mode` (anything unknown is Off). */
export function paletteFor(mode: unknown): Palette {
  return COLOR_BLIND_MODES.some(([m]) => m === mode) ? PALETTES[mode as ColorBlindMode] : OFF;
}

let current: Palette = OFF;
/** The palette in effect (applyPalette sets it). */
export const palette = (): Palette => current;

/** CSS custom properties the palette sets on <html> (their defaults: style.css, hud/hud.css, hud/strafe-trainer.css). */
export function paletteVars(p: Palette): Record<string, string> {
  return {
    "--gain": p.gain,
    "--loss": p.loss,
    "--sync-ok": p.syncOk,
    "--behind-soft": p.behindSoft,
    "--st-g": p.trainer.good,
    "--st-o": p.trainer.ok,
    "--st-r": p.trainer.bad,
    "--zone-start": p.zones.start,
  };
}

/** Puts `mode` in effect: the CSS variables (none for Off) and palette(). Returns whether it changed. */
export function applyPalette(mode: unknown, root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> } | undefined = globalThis.document?.documentElement): boolean {
  const next = paletteFor(mode);
  if (next === current) return false;
  current = next;
  if (root) for (const [k, v] of Object.entries(paletteVars(next))) next === OFF ? root.style.removeProperty(k) : root.style.setProperty(k, v);
  return true;
}

/**
 * The colour to draw a trigger kind in: the player's choice, or the palette's when it's still the default colour (a
 * colour the player picked is theirs, whatever the palette).
 */
export function triggerColor(kind: KindId, chosen: string | undefined, p: Palette = current): string {
  const def = DEFAULT_TRIGGER_PREFS.colors[kind];
  return !chosen || chosen.toLowerCase() === def ? p.triggers[kind] : chosen;
}

/** All trigger colours for drawing (triggerColor per kind). */
export function triggerColors(chosen: Partial<Record<KindId, string>> | undefined, p: Palette = current): Record<KindId, string> {
  return Object.fromEntries(KINDS.map((k) => [k.id, triggerColor(k.id, chosen?.[k.id], p)])) as Record<KindId, string>;
}

/** "#rrggbb" as a number (three.js colours). */
export const hexNum = (c: string): number => parseInt(c.slice(1), 16);
