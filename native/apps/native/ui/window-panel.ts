// Settings → Display: the game window and frame pacing, which only the native client has.

import { h } from "../../web/src/ui/dom";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { send, state, WINDOW_MODES, type WindowMode } from "./bridge";
import { fullscreenGroup } from "./fullscreen-modes";
import { followHost, nativeChoice, nativeToggle, type Ui } from "./native-rows";

const MODE_LABELS: Record<WindowMode, string> = {
  windowed: "Windowed",
  borderless: "Borderless",
  fullscreen: "Fullscreen",
};

function windowGroup(ui: Ui): HTMLElement {
  const center = ui.button("Center", () => send({ type: "window", action: "center" }));
  const maximize = ui.button("Maximize", () => send({ type: "window", action: "maximize" }));
  const minimize = ui.button("Minimize", () => send({ type: "window", action: "minimize" }));
  const shortcuts = h("span.keycaps", null, ui.keycap("F10"), " Settings ", ui.keycap("Alt+Enter"), " Fullscreen");
  const group = ui.group(
    "Window",
    nativeChoice(
      ui,
      "Window mode",
      "windowMode",
      WINDOW_MODES.map((mode) => [mode, MODE_LABELS[mode]]),
      {
        hint: "Alt+Enter switches",
        desc:
          "Borderless covers the screen without changing its mode. Fullscreen is exclusive and uses the resolution " +
          "below. While the menu is open it shows as Borderless.",
        keywords: "window fullscreen borderless windowed display mode alt enter",
      },
    ),
    nativeToggle(ui, "Always on top", "alwaysOnTop", {
      desc: "Keeps the game above other windows where the window manager allows it.",
      keywords: "window top above pin",
    }),
    nativeToggle(ui, "Remember window size and position", "rememberWindowBounds", {
      desc: "Opens where you left it. A window saved off-screen comes back onto a connected display.",
      keywords: "window size position bounds restore",
    }),
    nativeToggle(ui, "Minimize fullscreen when switching apps", "minimizeOnFocusLoss", {
      desc: "Fullscreen only. Off keeps the game on screen while you use another app.",
      keywords: "alt tab minimize focus fullscreen",
    }),
    ui.actions("Window controls", [center, maximize, minimize], {
      hint: "Windowed mode",
      desc: "Center and maximize work in windowed mode.",
      keywords: "window center maximize minimize",
    }),
    ui.row("Shortcuts", shortcuts, {
      keywords: "shortcut keys f10 alt enter",
    }),
  );
  followHost(group, ui, () => {
    const windowed = state.settings.windowMode === "windowed";
    center.disabled = !windowed;
    maximize.disabled = !windowed;
  });
  return group;
}

function framesGroup(ui: Ui): HTMLElement {
  return ui.group(
    "Frame pacing",
    nativeToggle(ui, "VSync", "vsync", {
      desc:
        "Locks frames to your monitor's refresh rate. Off gives the lowest input latency. " +
        "Graphics → FPS limit caps it.",
      keywords: "vsync vertical sync tearing refresh latency fps",
    }),
    nativeToggle(ui, "GPU frame limit", "limitQueuedFrames", {
      desc:
        "Keeps at most one finished frame waiting on the graphics card, so the picture is closer to your input. Turn " +
        "it off if your frame rate drops.",
      keywords: "queued frames latency gpu input lag",
    }),
  );
}

function replaysGroup(ui: Ui): HTMLElement {
  return ui.group(
    "Local replays",
    nativeToggle(ui, "Capture device personal bests", "capturePbScreenshots", {
      desc:
        "Saves a result screenshot when this computer records a faster completed run. Device bests are separate from " +
        "account records.",
      keywords: "screenshot replay vault personal best local",
    }),
  );
}

/** Registers Settings → Display (call once). */
export function registerDisplaySection(): void {
  registerSettingsSection(
    "display",
    (ui) => ({
      columns: [
        [windowGroup(ui), fullscreenGroup(ui)],
        [framesGroup(ui), replaysGroup(ui)],
      ],
    }),
    {
      label: "Display",
      icon: "grid",
      order: 62,
    },
  );
}
