// !bright: the quick menu for this map's Brightness and Fullbright (map-look.ts), a CS:S-style numbered menu
// (net/hud.ts NumberMenu) like the guns menu, in solo play and rooms. Opened from chat it keeps the chat's free cursor
// (free-cursor.ts holdFreeCursor) so its slider and rows can be clicked; a pick, 0, a click elsewhere or Esc closes it
// and the game takes the lock back. Changes are for this map only; "Use on all maps" writes the global setting.
//
//   !bright           the menu (again: closes it)        !bright 1.3 / 130 / 130%   this map's brightness
//   !bright reset     this map back to your settings     !fb [on|off]               this map's Fullbright
//
// The pause menu's On screen tab has the same controls (ui/map-look-rows.ts). Players say some maps look darker than
// in CS:S (bhop_aux_a9, bhop_dumb_blocks_3); the lighting matches Source, so this is about reaching the setting fast.

import { registerChatCommand, type ChatContext } from "./chat-commands";
import { holdFreeCursor, releaseHeldCursor } from "./free-cursor";
import { isTextField, type Input } from "./input";
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  BRIGHTNESS_STEP,
  brightnessLabel,
  clampBrightness,
  clearMapLook,
  lookMapNow,
  mapLook,
  parseBrightness,
  setMapLook,
  useMapLookEverywhere,
} from "./map-look";
import type { MenuSpec, NumberMenu } from "./net/hud";
import { h } from "./ui/dom";
import { prefs } from "./ui/settings";

let input: Input | null = null;
let menu: NumberMenu | null = null;
let hooked = false;

/** main.ts: once the input exists. */
export function initLookMenu(i: Input): void {
  input = i;
}

const look = (map: string) => mapLook(prefs.get(), map);

export function setBrightness(map: string, value: number): number {
  const b = clampBrightness(value)!;
  prefs.update((p) => setMapLook(p, map, { brightness: b }));
  return b;
}

export function toggleFullbright(map: string, on?: boolean): boolean {
  const next = on ?? !look(map).fullbright;
  prefs.update((p) => setMapLook(p, map, { fullbright: next }));
  return next;
}

export function resetMap(map: string): void {
  prefs.update((p) => clearMapLook(p, map));
}

function spec(map: string): MenuSpec {
  const l = look(map);
  const value = h("span.mm-detail", null, brightnessLabel(l.brightness));
  const slider = h("input.look-slider", { type: "range", min: String(BRIGHTNESS_MIN), max: String(BRIGHTNESS_MAX), step: String(BRIGHTNESS_STEP), "aria-label": "Brightness" });
  slider.value = String(l.brightness);
  slider.addEventListener("input", () => {
    setBrightness(map, Number(slider.value));
    value.textContent = brightnessLabel(look(map).brightness);
    if (menu) menu.el.querySelector(".mm-footer")!.textContent = footer(map);
  });
  // (Keys stay the menu's: arrows on a focused slider would also move the player.)
  slider.addEventListener("keydown", (e) => e.preventDefault());
  const sw = h("input.switch.sm.look-switch", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" });
  sw.checked = l.fullbright;
  return {
    title: "Brightness",
    head: h("div.mm-look", null, slider, value),
    items: [
      { label: "Darker" },
      { label: "Brighter" },
      { label: "Fullbright", control: sw },
      { label: "Reset this map", disabled: !l.own },
      { label: "Use on all maps", disabled: !l.own, quiet: true },
    ],
    footer: footer(map),
    exit: "Close",
    onPick: (i) => {
      if (i === 0 || i === 1) setBrightness(map, look(map).brightness + (i === 0 ? -BRIGHTNESS_STEP : BRIGHTNESS_STEP));
      else if (i === 2) toggleFullbright(map);
      else if (i === 3) resetMap(map);
      else if (i === 4) prefs.update((p) => useMapLookEverywhere(p, map));
      menu?.update("look", spec(map));
    },
  };
}

const footer = (map: string) => (look(map).own ? `Set for ${map} only.` : `Changes here are for ${map} only.`);

export const lookMenuOpen = (): boolean => menu?.id.current === "look";

/** Opens the quick menu for the map on screen (closes it if open). From chat, the cursor stays out for it. */
export async function openLookMenu(reply?: (text: string) => void): Promise<void> {
  const map = lookMapNow();
  if (!map) return reply?.("Not available here.");
  if (menu?.open) return menu.hide();
  if (!menu) {
    const { NumberMenu } = await import("./net/hud");
    menu = new NumberMenu(document.getElementById("hud") ?? document.body);
    menu.el.classList.add("look-menu");
    menu.onHide = () =>
      setTimeout(() => {
        if (!menu?.open && releaseHeldCursor()) input?.recapture();
      });
  }
  hook();
  menu.show("look", spec(map));
  holdFreeCursor();
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  // Capture phase, ahead of the game's keys (as the guns menu): its digits pick, Esc closes.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!menu?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
      if (e.code === "Escape") return menu.hide();
      const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (!d) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      menu.key(Number(d[1]));
    },
    true,
  );
  // A click on the game closes it (and takes the lock back: a click is the activation the browser wants).
  document.addEventListener(
    "mousedown",
    (e) => {
      if (menu?.open && !(e.target instanceof Element && menu.el.contains(e.target))) menu.hide();
    },
    true,
  );
  // The pause (the lock lost, not the chat's cursor) closes it too.
  document.addEventListener("pointerlockchange", () => {
    if (menu?.open && !document.pointerLockElement && !input?.locked) menu.hide();
  });
}

/** !bright and !fb (chat-commands.ts), solo and rooms. main.ts registers them once. */
export function registerLookCommands(): void {
  const needMap = (ctx: ChatContext): string | null => {
    const map = lookMapNow();
    if (!map) ctx.reply("Not available here.");
    return map;
  };
  registerChatCommand({
    name: "bright",
    aliases: ["brightness"],
    args: "[value|reset]",
    help: "brightness for this map",
    about: "a menu for this map's brightness and Fullbright. !bright 1.3 sets it, !bright reset goes back to your settings. Settings → Graphics has the value for every map.",
    group: "more",
    where: "both",
    run: (ctx, arg) => {
      const map = needMap(ctx);
      if (!map) return;
      const a = arg.trim().toLowerCase();
      if (!a) return void openLookMenu((t) => ctx.reply(t));
      if (a === "reset" || a === "default" || a === "off") {
        resetMap(map);
        return ctx.reply(`${map} uses your settings again.`);
      }
      const v = parseBrightness(a);
      if (v === null) return ctx.reply("Use !bright 1.3, !bright reset, or !bright for the menu.");
      ctx.reply(`Brightness ${brightnessLabel(setBrightness(map, v))} on ${map}.`);
    },
  });
  registerChatCommand({
    name: "fb",
    aliases: ["fullbright", "mat_fullbright"],
    args: "[on|off]",
    help: "Fullbright for this map",
    about: "turns Fullbright on or off for this map: no baked lighting, textures stay. Settings → Graphics has it for every map.",
    group: "more",
    where: "both",
    run: (ctx, arg) => {
      const map = needMap(ctx);
      if (!map) return;
      const a = arg.trim().toLowerCase();
      const on = a === "on" || a === "1" ? true : a === "off" || a === "0" ? false : a ? null : undefined;
      if (on === null) return ctx.reply("Use !fb, !fb on or !fb off.");
      ctx.reply(`Fullbright ${toggleFullbright(map, on) ? "on" : "off"} on ${map}.`);
    },
  });
}
