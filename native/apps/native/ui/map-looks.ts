// Brightness and Fullbright per map in the native menu (web map-look.ts). Prefs keep `mapLooks` and the host has the
// same setting (src/map_look.hpp), so the renderer draws each map with its own look and the host's quick menu can
// change it. !bright and !fb answer as on the website; "!bright" alone opens the host's quick menu over the game,
// where the website opens its page overlay (look-menu.ts).

import { registerChatCommand, type ChatContext } from "../../web/src/chat-commands";
import {
  brightnessLabel,
  clampBrightness,
  cleanMapLook,
  clearMapLook,
  mapLook,
  parseBrightness,
  sanitizeMapLooks,
  setMapLook,
  validMapName,
  type MapLook,
} from "../../web/src/map-look";
import { prefs } from "../../web/src/ui/settings";

/** Names an object key can't safely be (the host refuses them too). */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

const sameLook = (a: MapLook, b: MapLook): boolean => a.brightness === b.brightness && a.fullbright === b.fullbright;

/** The host's overrides, cleaned entry by entry (its object has no order to keep, so nothing is capped here). */
function hostEntries(host: unknown): Map<string, MapLook> {
  const out = new Map<string, MapLook>();
  if (!host || typeof host !== "object" || Array.isArray(host)) return out;
  for (const [name, value] of Object.entries(host as Record<string, unknown>)) {
    const look = validMapName(name) && !RESERVED.has(name) ? cleanMapLook(value) : null;
    if (look) out.set(name, look);
  }
  return out;
}

/**
 * The host's overrides written into mine. The host keeps them by name, so the order is mine: maps it left alone keep
 * their place, and maps it changed or added (its quick menu) count as the most recent. The 200-map cap then drops the
 * oldest, as on the website.
 */
export function mergeHostLooks(mine: Record<string, MapLook>, host: unknown): Record<string, MapLook> {
  const theirs = hostEntries(host);
  const out: Record<string, MapLook> = {};
  const changed: string[] = [];
  for (const [name, look] of Object.entries(mine ?? {})) {
    const next = theirs.get(name);
    if (!next) continue;
    if (sameLook(look, next)) out[name] = next;
    else changed.push(name);
  }
  for (const name of theirs.keys()) if (!Object.hasOwn(mine ?? {}, name)) changed.push(name);
  for (const name of changed) out[name] = theirs.get(name)!;
  return sanitizeMapLooks(out);
}

const NOT_HERE = "Not available here.";

/** The map the command is for, or null (and the reason said) off a map. */
function lookMap(ctx: ChatContext, map: string | null): string | null {
  if (!map || !validMapName(map)) {
    ctx.reply(NOT_HERE);
    return null;
  }
  return map;
}

function setBrightness(map: string, value: number): number {
  const brightness = clampBrightness(value)!;
  prefs.update((p) => setMapLook(p, map, { brightness }));
  return brightness;
}

function setFullbright(map: string, on: boolean | undefined): boolean {
  const next = on ?? !mapLook(prefs.get(), map).fullbright;
  prefs.update((p) => setMapLook(p, map, { fullbright: next }));
  return next;
}

/** `!bright [value|reset]` for `map`: alone it opens the quick menu. */
export function brightCommand(ctx: ChatContext, arg: string, map: string | null, openMenu: () => void): void {
  const name = lookMap(ctx, map);
  if (!name) return;
  const value = arg.trim().toLowerCase();
  if (!value) return openMenu();
  if (value === "reset" || value === "default" || value === "off") {
    prefs.update((p) => clearMapLook(p, name));
    return ctx.reply(`${name} uses your settings again.`);
  }
  const brightness = parseBrightness(value);
  if (brightness === null) return ctx.reply("Use !bright 1.3, !bright reset, or !bright for the menu.");
  ctx.reply(`Brightness ${brightnessLabel(setBrightness(name, brightness))} on ${name}.`);
}

/** `!fb [on|off]` for `map`: alone it switches. */
export function fullbrightCommand(ctx: ChatContext, arg: string, map: string | null): void {
  const name = lookMap(ctx, map);
  if (!name) return;
  const value = arg.trim().toLowerCase();
  const on = value === "on" || value === "1" ? true : value === "off" || value === "0" ? false : undefined;
  if (value && on === undefined) return ctx.reply("Use !fb, !fb on or !fb off.");
  ctx.reply(`Fullbright ${setFullbright(name, on) ? "on" : "off"} on ${name}.`);
}

/** !bright and !fb (the website's look-menu.ts registerLookCommands). Returns the unregister. */
export function registerMapLookCommands(map: () => string | null, openMenu: () => void): () => void {
  const bright = registerChatCommand({
    name: "bright",
    aliases: ["brightness"],
    args: "[value|reset]",
    help: "brightness for this map",
    about:
      "a menu for this map's brightness and Fullbright. !bright 1.3 sets it, !bright reset goes back to your " +
      "settings. Settings → Graphics has the value for every map.",
    group: "more",
    where: "both",
    run: (ctx, arg) => brightCommand(ctx, arg, map(), openMenu),
  });
  const fullbright = registerChatCommand({
    name: "fb",
    aliases: ["fullbright", "mat_fullbright"],
    args: "[on|off]",
    help: "Fullbright for this map",
    about:
      "turns Fullbright on or off for this map: no baked lighting, textures stay. Settings → Graphics has it for " +
      "every map.",
    group: "more",
    where: "both",
    run: (ctx, arg) => fullbrightCommand(ctx, arg, map()),
  });
  return () => {
    bright();
    fullbright();
  };
}
