// Native-only rows that belong in a website section: they open under that section's Advanced line (the registry's
// advancedUnder), so the website's own rows keep their places.

import { mouseCode } from "../../web/src/binds";
import { h } from "../../web/src/ui/dom";
import { icon } from "../../web/src/ui/icons";
import { keyLabel, prefs } from "../../web/src/ui/settings";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { uiSound } from "./audio";
import { DEFAULT_BINDS, nativeKeyCode, state } from "./bridge";
import { hudEditor } from "./hud-editor";
import { followHost, nativeChoice, nativeToggle, type Ui } from "./native-rows";
import { hostHas, sendNativeSettings } from "./prefs-bridge";

function rendererGroup(ui: Ui): HTMLElement {
  const group = ui.group(
    "Native renderer",
    nativeChoice(ui, "Water", "waterQuality", [["simple", "Simple"], ["refracted", "Refracted"]], {
      desc: "Refracted water bends what's under the surface, like CS:S. Simple is cheaper.",
      keywords: "water refraction quality reflections",
    }),
    nativeToggle(ui, "World effects", "effectsVisible", {
      desc: "Sprites, particles and ghost trails in the world.",
      keywords: "effects particles sprites trails",
    }),
  );
  followHost(group, ui);
  return group;
}

function jumpStatsGroup(ui: Ui): HTMLElement {
  const interval = ui.range("Every N jumps", () => state.settings.jumpStatsInterval, (value) => {
    sendNativeSettings({ jumpStatsInterval: Math.round(value) });
  }, {
    min: 2, max: 50, step: 1, def: 6,
    when: () => prefs.get().hud.ssj.mode === "everySixth",
    desc: "With Jumps on Every 6th: report jumps N, 2N, 3N…, each compared with the last one shown.",
    keywords: "ssj jump stats interval every n",
  });
  const group = ui.group(
    "More jump stats",
    nativeToggle(ui, "Gain colours", "jumpStatsColors", {
      desc:
        "Colours the jump stats by gain: red under 60%, orange 60-69%, green 70-79%, blue 80-89%, white 90% and up. " +
        "Off: amber from 80%.",
      keywords: "ssj jump stats gain colours colors",
    }),
    interval,
  );
  followHost(group, ui);
  return group;
}

/** The native HUD's placement canvas, until the host takes the website's layout (and its in-game editor). */
function positionsGroup(ui: Ui): HTMLElement | null {
  if (hostHas("hudLayoutWeb")) return null;
  const canvas = hudEditor(
    () => state.settings.hudLayout,
    (layout) => sendNativeSettings({ hudLayout: layout }),
  );
  const row = ui.row("Drag to place", canvas, {
    desc: "Drag an element to move it. Arrow keys move the selected one; Shift moves it less. Dim ones are hidden.",
    keywords: "hud layout position move drag editor place",
  });
  row.classList.add("mn-row");
  const group = ui.group("Positions", row);
  followHost(group, ui, () => (canvas as HTMLElement & { paint?: () => void }).paint?.());
  return group;
}

function packsGroup(ui: Ui): HTMLElement {
  const status = h("small.set-readout");
  const packs: [("default" | "custom"), string][] = [["default", "bunnyhop.lol"], ["custom", "Custom"]];
  const group = ui.group(
    "Sound packs",
    nativeChoice(ui, "Effects pack", "sfxPack", packs, {
      readout: status,
      desc:
        "Custom sounds come from the sound folder in your game data folder. Name a file after the cue it replaces, " +
        "such as jump.wav (WAV, MP3, FLAC or Ogg). Cues you haven't supplied keep the bunnyhop.lol sound.",
      keywords: "sound pack custom sfx folder wav",
    }),
    nativeChoice(ui, "Music pack", "musicPack", packs, {
      desc:
        "bunnyhop.lol is the game's own soundtrack, played offline. Custom plays the WAV, MP3, FLAC or Ogg files in " +
        "the bgm folder of your game data folder, in filename order.",
      keywords: "music pack custom bgm folder soundtrack",
    }),
    nativeToggle(ui, "Weapon sounds", "weaponSounds", {
      desc: "Gunfire, knife swings and stabs, reloads and impacts, yours and other players'.",
      keywords: "weapon gun knife sounds",
    }),
  );
  followHost(group, ui, () => {
    const audio = state.audio;
    status.textContent = audio ? audio.error || audio.sfxStatus || audio.classicStatus : "";
  });
  return group;
}

// ---------------------------------------------------------------------------------------------- native-only binds

export const NATIVE_BINDS: readonly [keyof typeof DEFAULT_BINDS, string][] = [
  ["chat", "Chat"],
  ["commandChat", "Command chat"],
  ["scoreboard", "Scoreboard"],
  ["spectatorNext", "Next player (spectating)"],
  ["spectatorPrevious", "Previous player (spectating)"],
  ["spectatorMode", "Spectator camera"],
  ["showTriggers", "Show triggers"],
  ["showClips", "Show player clips"],
];

let stopCapture: (() => void) | null = null;

/** Gives `code` to `action`: it leaves every other action, the website's and the native ones. */
function assign(action: string, slot: number, code: string | null): void {
  const binds: Record<string, string[]> = {};
  const list = [...(state.settings.binds[action] ?? [])];
  if (code) {
    list[slot] = code;
    prefs.update((p) => {
      for (const other of Object.keys(p.binds) as (keyof typeof p.binds)[]) {
        p.binds[other] = p.binds[other].filter((item) => item !== code);
      }
    });
    for (const [other] of NATIVE_BINDS) {
      const codes = state.settings.binds[other] ?? [];
      if (other !== action && codes.includes(code)) binds[other] = codes.filter((item) => item !== code);
    }
  } else {
    list.splice(slot, 1);
  }
  binds[action] = [...new Set(list.filter(Boolean))];
  sendNativeSettings({ binds });
}

function capture(button: HTMLButtonElement, action: string, slot: number, done: () => void): void {
  stopCapture?.();
  button.classList.add("capturing");
  button.textContent = "Press a key or mouse button…";
  const finish = (code: string | null | undefined): void => {
    stop();
    if (code !== undefined) assign(action, slot, code);
    done();
  };
  const key = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") return finish(undefined);
    if (event.key === "Backspace" || event.key === "Delete") return finish(null);
    take(event.code);
  };
  const mouse = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    take(mouseCode(event.button));
  };
  const wheel = (event: WheelEvent): void => {
    event.preventDefault();
    take(event.deltaY < 0 ? "MWheelUp" : "MWheelDown");
  };
  const take = (code: string): void => {
    if (nativeKeyCode(code)) return finish(code);
    uiSound("ui_error", 0.6);
    button.textContent = `${keyLabel(code)} can't be bound here`;
  };
  const stop = (): void => {
    removeEventListener("keydown", key, true);
    removeEventListener("mousedown", mouse, true);
    removeEventListener("wheel", wheel, true);
    stopCapture = null;
  };
  stopCapture = () => (stop(), done());
  // Deferred, so the click that started it isn't taken as Mouse 1.
  setTimeout(() => {
    addEventListener("keydown", key, true);
    addEventListener("mousedown", mouse, true);
    addEventListener("wheel", wheel, { capture: true, passive: false });
  }, 0);
}

/** A bind row in the website's look (two keycap slots and a reset) for an action only the native client has. */
function bindRow(ui: Ui, action: keyof typeof DEFAULT_BINDS, label: string): HTMLElement {
  const slots = [0, 1].map((slot) => {
    return h("button.bind", { type: "button", "data-action": action, "data-slot": String(slot) }) as HTMLButtonElement;
  });
  const defaults = DEFAULT_BINDS[action];
  const defaultText = defaults.map(keyLabel).join(", ") || "unbound";
  const reset = h("button.bind-reset", { type: "button", title: `Default: ${defaultText}` }, icon("reset"));
  const paint = (): void => {
    const codes = state.settings.binds[action] ?? [];
    slots.forEach((button, slot) => {
      const code = codes[slot];
      button.textContent = code ? keyLabel(code) : "—";
      button.classList.toggle("empty", !code);
      button.classList.remove("capturing");
      button.setAttribute("aria-label", `${label} bind ${slot + 1}: ${code ? keyLabel(code) : "unbound"}`);
    });
    const isDefault = codes.length === defaults.length && defaults.every((code) => codes.includes(code));
    (reset as HTMLButtonElement).disabled = isDefault;
  };
  slots.forEach((button, slot) => button.addEventListener("click", () => capture(button, action, slot, paint)));
  reset.addEventListener("click", () => {
    sendNativeSettings({ binds: { [action]: [...defaults] } });
    paint();
  });
  paint();
  const row = ui.row(label, h("div.bind-line", null, h("div.bind-pair", null, ...slots), reset), {
    desc: `Default: ${defaultText}.`,
    keywords: `bind key rebind keybind ${label.toLowerCase()}`,
  });
  row.classList.add("bind-row");
  (row as HTMLElement & { sync?: () => void }).sync = paint;
  row.classList.add("is-syncable");
  return row;
}

function nativeBindsGroup(ui: Ui): HTMLElement {
  const group = ui.group("Desktop client", ...NATIVE_BINDS.map(([action, label]) => bindRow(ui, action, label)));
  followHost(group, ui);
  return group;
}

function registerNativeHud(): void {
  registerSettingsSection("native-hud", (ui) => {
    const positions = positionsGroup(ui);
    return positions ? [jumpStatsGroup(ui), positions] : [jumpStatsGroup(ui)];
  }, { advancedUnder: "hud" });
}

/**
 * Redraws an open settings screen (a registration change redraws it in place): after the host changed what the rows
 * show, or what it has.
 */
export const redrawSettings = registerNativeHud;

/** Registers the native rows under the website's sections (call once). */
export function registerNativeExtras(): void {
  registerSettingsSection("native-graphics", (ui) => [rendererGroup(ui)], { advancedUnder: "graphics" });
  registerNativeHud();
  registerSettingsSection("native-audio", (ui) => [packsGroup(ui)], { advancedUnder: "audio" });
  registerSettingsSection("native-keys", (ui) => [nativeBindsGroup(ui)], { advancedUnder: "keys" });
}
