// Settings → HUD for the desktop client's HUD, which is drawn by the host over the game. The website's "Show on
// screen" picture and its presets are laid out for the website's HUD; here the elements switch on and off in a plain
// list, and the presets are the host's (hud_editor_layout.hpp), the same ones its layout editor applies.

import * as ui from "./settings-controls";
import { extendGroup } from "./settings-controls";
import { prefs } from "../../web/src/ui/settings";
import type { HudElId } from "../../web/src/hud/layout";
import { send } from "./bridge";

/** The core elements the website switches in its picture; the others have rows of their own. */
const ELEMENT_SWITCHES: readonly [HudElId, string, string][] = [
  ["speed", "Speed", "speed velocity u/s"],
  ["timer", "Timer", "timer time clock"],
  ["stats", "Run stats", "jumps strafes sync perf"],
  ["split", "Split vs PB", "split delta pb ghost comparison"],
  ["sync", "Sync bar", "sync bar"],
  ["keys", "Keys overlay", "keys overlay wasd input display"],
  ["strafeTrainer", "Strafe trainer", "strafe trainer pace gauge"],
  ["fps", "FPS counter", "fps frames counter framerate"],
  ["chat", "Chat", "chat messages"],
];

export const HUD_PRESETS = [
  ["classic", "Classic centred"],
  ["minimal", "Minimal"],
  ["streamer", "Streamer"],
] as const;

function elementSwitches(): HTMLElement[] {
  return ELEMENT_SWITCHES.map(([id, label, keywords]) =>
    ui.toggle(
      label,
      () => prefs.get().hud.layout[id].on,
      (on) => prefs.update((p) => (p.hud.layout[id].on = on)),
      { keywords: `hud element show hide ${keywords}` },
    ),
  );
}

function presetRow(): HTMLElement {
  const buttons = HUD_PRESETS.map(([id, label]) => ui.button(label, () => send({ type: "hudPreset", id })));
  return ui.actions("Layout preset", buttons, {
    desc: "Moves every element to a ready-made layout. Classic centred is the built-in one. Edit layout fine-tunes it.",
    keywords: "classic minimal streamer layout preset reset default",
  });
}

/** Adds the HUD section's native rows (call once). */
export function registerHudRows(): void {
  extendGroup("hud/Show on screen", elementSwitches, true);
  extendGroup("hud/Layout", () => [presetRow()]);
}
