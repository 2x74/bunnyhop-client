// Website settings the native client doesn't have yet. Each one gets a native settings key named after its web pref
// path in camelCase ("hud.keys.opacity" -> "hudKeysOpacity"), takes the same values as the website and starts at the
// website's default. The menu shows a setting's row once the host lists its key (prefs-bridge.ts), so the C++ side can
// add them one at a time.

import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { KINDS, TRIGGER_OPACITY, TRIGGER_THICKNESS } from "../../web/src/triggers/volumes";
import { SSJ_FIELDS } from "../../web/src/ssj/stats";
import { VIDEO_LIMITS } from "../../web/src/video-settings";

export type KeyRule =
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly (string | number)[] }
  | { kind: "color" }
  | { kind: "number"; min: number; max: number; whole?: boolean };

export interface RequestedKey {
  /** Dotted path into the web Prefs. */
  path: string;
  /** The native settings key. */
  key: string;
  rule: KeyRule;
  /** Who adds it: in-game HUD, input and audio (WS4) or rendering (WS5). */
  owner: "hud" | "render";
}

const boolean: KeyRule = { kind: "boolean" };
const color: KeyRule = { kind: "color" };
const choice = (...values: (string | number)[]): KeyRule => ({ kind: "choice", values });
const number = (min: number, max: number, whole = false): KeyRule => ({ kind: "number", min, max, whole });

/** "hud.keys.opacity" -> "hudKeysOpacity". */
export function nativeKeyFor(path: string): string {
  const [first, ...rest] = path.split(".");
  return first + rest.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

const requestKey = (owner: RequestedKey["owner"]) => (path: string, rule: KeyRule): RequestedKey => ({
  path,
  key: nativeKeyFor(path),
  rule,
  owner,
});
const hud = requestKey("hud");
const render = requestKey("render");

export const REQUESTED_KEYS: readonly RequestedKey[] = [
  hud("nullBinds", boolean),
  hud("autoRestart.when", choice("off", "pb", "wr", "ghost")),
  hud("autoRestart.action", choice("restart", "sound")),
  hud("hud.place", choice("off", "place", "top")),
  hud("hud.edgeGlow", boolean),
  hud("hud.hiddenKeeps", choice("speedKeys", "nothing")),
  hud("hud.keys.opacity", number(0.2, 1)),
  hud("hud.keys.pressed", color),
  hud("hud.keys.idle", color),
  hud("hud.keys.rows.wasd", boolean),
  hud("hud.keys.rows.actions", boolean),
  hud("hud.keys.rows.mouse", boolean),
  hud("hud.strafeTrainer.style", choice("classic", "detailed", "minimal")),
  hud("hud.strafeTrainer.follow", boolean),
  hud("hud.strafeTrainer.zone", number(2, 30, true)),
  hud("hud.strafeTrainer.height", number(0.5, 3)),
  hud("hud.strafeTrainer.dimBelow", number(0, 90, true)),
  hud("hud.strafeTrainer.color", color),
  hud("hud.strafeTrainer.showPace", boolean),
  hud("hud.strafeTrainer.sound", boolean),
  hud("hud.ssj.chat", boolean),
  ...SSJ_FIELDS.map((field) => hud(`hud.ssj.fields.${field}`, boolean)),
  hud("hud.movement.fjtChat", boolean),
  hud("hud.movement.lj", boolean),
  hud("hud.movement.ljChat", boolean),
  hud("triggers.style", choice("filled", "outline", "bottom")),
  hud("triggers.thickness", number(TRIGGER_THICKNESS[0], TRIGGER_THICKNESS[1])),
  hud("triggers.opacity", number(TRIGGER_OPACITY[0], TRIGGER_OPACITY[1])),
  ...KINDS.map((kind) => hud(`triggers.colors.${kind.id}`, color)),
  hud("audio.musicMode", choice("always", "menus", "off")),
  hud("audio.shuffle", boolean),
  hud("audio.perfHud", boolean),
  render("ghost.pb", boolean),
  render("ghost.wr", boolean),
  render("ghost.custom", boolean),
  render("ghost.trail", boolean),
  render("ghost.route", boolean),
  render("ghost.routeSource", choice("auto", "pb", "wr", "custom")),
  render("ghost.routeMode", choice("jumps", "path")),
  render("tags.players", boolean),
  render("tags.throughWalls", boolean),
  render("graphics.potato", boolean),
  render("graphics.antialias", boolean),
  render("graphics.waterReflections", boolean),
  render("graphics.anisotropy", choice(1, 2, 4, 8, 16)),
  render("graphics.flashlight", boolean),
  render("graphics.menuBackground", choice("live", "still", "off")),
  render("graphics.brightness", number(VIDEO_LIMITS.brightness[0], VIDEO_LIMITS.brightness[1])),
  render("graphics.gamma", number(VIDEO_LIMITS.gamma[0], VIDEO_LIMITS.gamma[1])),
  render("graphics.vibrance", number(VIDEO_LIMITS.vibrance[0], VIDEO_LIMITS.vibrance[1])),
  render("graphics.fullbright", boolean),
  render("graphics.resolutionScale", number(0.25, 2)),
  render("graphics.aspect", choice("native", "4:3", "5:4", "16:10", "16:9")),
  render("graphics.aspectFit", choice("stretch", "bars")),
  render("graphics.pixelated", boolean),
  render("graphics.menuFps", choice(0, 30, 60, 120)),
  render("graphics.bloom", boolean),
  render("graphics.materialResponse", boolean),
  render("graphics.skyExposure", number(-4, 4)),
];

export const REQUESTED_BY_KEY = new Map(REQUESTED_KEYS.map((entry) => [entry.key, entry]));

/** The value at a dotted `path` of `root`. */
export function readPath(root: unknown, path: string): unknown {
  let at = root;
  for (const part of path.split(".")) {
    if (!at || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** Sets the value at a dotted `path` of `root`; the objects on the way must exist. */
export function writePath(root: object, path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop()!;
  let at = root as Record<string, unknown>;
  for (const part of parts) at = at[part] as Record<string, unknown>;
  at[last] = value;
}

export function followsRule(rule: KeyRule, value: unknown): boolean {
  switch (rule.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "color":
      return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    case "choice":
      return rule.values.includes(value as string | number);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (rule.whole && !Number.isInteger(value)) return false;
      return value >= rule.min && value <= rule.max;
  }
}

/** The requested keys in `input` that pass their rules. */
export function requestedPatch(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const entry = REQUESTED_BY_KEY.get(key);
    if (entry && followsRule(entry.rule, value)) out[key] = value;
  }
  return out;
}

/** The website's default for a requested key (what the C++ default should be). */
export const requestedDefault = (entry: RequestedKey): unknown => readPath(DEFAULT_PREFS, entry.path);
