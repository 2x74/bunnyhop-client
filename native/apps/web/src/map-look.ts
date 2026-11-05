// Brightness and Fullbright per map: the quick menu (!bright, !fb; look-menu.ts) and the pause menu's On screen tab
// change them for the map you're on only. Prefs keep them in `mapLooks`, keyed by map name; Settings → Graphics →
// Colour & visibility keeps the global values (graphics.brightness / graphics.fullbright), which every map without its
// own value uses. main.ts applies the effective look in play and in replays of the map. DOM-free (tests).
//
// A map's entry has only what was set for it: { brightness: 1.3 } keeps the global Fullbright. At most MAP_LOOK_CAP
// maps are kept; changing one moves it to the end, and the oldest go first.

import type { Prefs } from "./ui/settings";
import { VIDEO_LIMITS } from "./video-settings";

export interface MapLook {
  brightness?: number;
  fullbright?: boolean;
}

/** The look a map is drawn with, and whether any of it is the map's own. */
export interface EffectiveLook {
  brightness: number;
  fullbright: boolean;
  own: boolean;
}

export const MAP_LOOK_CAP = 200;
/** One notch of the quick menu's Darker / Brighter (and the Settings slider's step). */
export const BRIGHTNESS_STEP = 0.05;
export const [BRIGHTNESS_MIN, BRIGHTNESS_MAX] = VIDEO_LIMITS.brightness;

const NAME_RE = /^[\w.+-]{1,64}$/;

/** A brightness inside the Settings slider's range (to the hundredth, so steps don't drift); null if not a number. */
export function clampBrightness(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Number(Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, v)).toFixed(2));
}

/** One map's entry, cleaned (null: nothing valid in it). */
export function cleanMapLook(raw: unknown): MapLook | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: MapLook = {};
  const b = clampBrightness(r.brightness);
  if (b !== null) out.brightness = b;
  if (typeof r.fullbright === "boolean") out.fullbright = r.fullbright;
  return Object.keys(out).length ? out : null;
}

export const validMapName = (name: unknown): name is string => typeof name === "string" && NAME_RE.test(name);

/** Saved or imported overrides, cleaned: valid map names, valid values, the newest MAP_LOOK_CAP. */
export function sanitizeMapLooks(raw: unknown): Record<string, MapLook> {
  const out: Record<string, MapLook> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const look = validMapName(name) ? cleanMapLook(v) : null;
    if (look) out[name] = look;
  }
  return capLooks(out);
}

function capLooks(looks: Record<string, MapLook>): Record<string, MapLook> {
  const names = Object.keys(looks);
  for (const n of names.slice(0, Math.max(0, names.length - MAP_LOOK_CAP))) delete looks[n];
  return looks;
}

/** The look `map` is drawn with (null map: the home screen and anything else not on a map: the global values). */
export function mapLook(p: Pick<Prefs, "graphics" | "mapLooks">, map: string | null | undefined): EffectiveLook {
  const own = map ? p.mapLooks?.[map] : undefined;
  return {
    brightness: own?.brightness ?? p.graphics.brightness,
    fullbright: own?.fullbright ?? p.graphics.fullbright,
    own: !!own && (own.brightness !== undefined || own.fullbright !== undefined),
  };
}

/** Sets part of `map`'s own look (mutates the prefs: call inside prefs.update). */
export function setMapLook(p: Pick<Prefs, "mapLooks">, map: string, patch: MapLook): void {
  if (!validMapName(map)) return;
  const next = { ...p.mapLooks[map], ...cleanMapLook(patch) };
  delete p.mapLooks[map]; // (re-added last: the most recently changed map is the last to be dropped)
  p.mapLooks[map] = next;
  capLooks(p.mapLooks);
}

/** `map` goes back to the global values. */
export function clearMapLook(p: Pick<Prefs, "mapLooks">, map: string): void {
  delete p.mapLooks[map];
}

/** Every map goes back to the global values (Settings → Colour & visibility). */
export function clearAllMapLooks(p: Pick<Prefs, "mapLooks">): void {
  p.mapLooks = {};
}

/** "Use on all maps": `map`'s look becomes the global setting, and the map has nothing of its own left. */
export function useMapLookEverywhere(p: Pick<Prefs, "graphics" | "mapLooks">, map: string): void {
  const look = mapLook(p, map);
  p.graphics.brightness = look.brightness;
  p.graphics.fullbright = look.fullbright;
  clearMapLook(p, map);
}

export const mapLookCount = (p: Pick<Prefs, "mapLooks">): number => Object.keys(p.mapLooks ?? {}).length;

/**
 * Imported overrides over mine (settings-io.ts): maps in the file replace those values, field by field; maps and
 * fields it doesn't mention keep mine. Returns the paths it took ("mapLooks.<map>.<field>") and the ones it refused.
 */
export function importMapLooks(mine: Record<string, MapLook>, raw: unknown): { next: Record<string, MapLook>; applied: string[]; invalid: string[] } {
  const next: Record<string, MapLook> = JSON.parse(JSON.stringify(mine ?? {}));
  const applied: string[] = [];
  const invalid: string[] = [];
  if (raw === undefined) return { next, applied, invalid };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { next, applied, invalid: ["mapLooks"] };
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const look = validMapName(name) ? cleanMapLook(v) : null;
    if (!look) {
      invalid.push(`mapLooks.${name}`);
      continue;
    }
    for (const k of Object.keys(look) as (keyof MapLook)[]) applied.push(`mapLooks.${name}.${k}`);
    const merged = { ...next[name], ...look };
    delete next[name];
    next[name] = merged;
  }
  return { next: capLooks(next), applied, invalid };
}

let current: string | null = null;
/** The map on screen now (main.ts sets it once the page knows its map; null on the home screen). */
export const lookMapNow = (): string | null => current;
export function setLookMapNow(map: string | null): void {
  current = map && validMapName(map) ? map : null;
}

/** A typed brightness (!bright 1.3, 130 or 130%), before clamping; null if it isn't a number. */
export function parseBrightness(arg: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(arg.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] || n > 2.5 ? n / 100 : n;
}

/** "130%": brightness as the Settings slider shows it. */
export const brightnessLabel = (b: number): string => `${Math.round(b * 100)}%`;
