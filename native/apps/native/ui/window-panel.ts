// Settings → Display: the game window and frame pacing, which only the native client has.

import { h } from "../../web/src/ui/dom";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { send, state, WINDOW_MODES, type LowLatencyMode, type WindowMode } from "./bridge";
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

function lowLatencyText(): string {
  if (state.client?.renderer === "d3d11")
    return "Direct3D 11 always presents through DXGI. Low latency mode enables NVIDIA Reflex or AMD Anti-Lag 2.";
  const info = state.lowLatency;
  const card = info?.reflex ? "NVIDIA Reflex" : info?.antiLag ? "AMD Anti-Lag 2" : "a waitable swapchain";
  const using = info?.active ? ` In use: ${info.active === "DXGI" ? "DXGI" : info.active}.` : "";
  return (
    `Presents through DXGI with ${card}: the frame starts as late as the card allows, and borderless gets the ` +
    `latency and VRR of exclusive fullscreen.${using}`
  );
}

function lowLatencyRows(ui: Ui): HTMLElement[] {
  const nativeD3D = state.client?.renderer === "d3d11";
  const available = !nativeD3D || state.lowLatency?.reflex === true || state.lowLatency?.antiLag === true;
  const supported = (): boolean => state.lowLatency?.dxgi === true && available;
  const modes: [LowLatencyMode, string][] = [
    ["off", "Off"],
    ["on", "On"],
  ];
  if (state.lowLatency?.reflex) modes.push(["boost", "On + Boost"]);
  const mode = nativeChoice(ui, "Low latency mode", "lowLatencyMode", modes, {
    desc: lowLatencyText,
    keywords: "reflex nvidia anti-lag amd latency dxgi vrr gsync freesync boost",
    hint: nativeD3D && !available ? "NVIDIA Reflex and AMD Anti-Lag 2 are unavailable on this device" : undefined,
    when: () => nativeD3D || supported(),
  });
  if (nativeD3D && !available)
    for (const control of mode.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
  const flash = nativeToggle(ui, "Reflex flash indicator", "reflexFlash", {
    desc: "Flashes on each left click for NVIDIA's Reflex Latency Analyzer.",
    keywords: "reflex latency analyzer flash ldat",
    when: () => supported() && state.lowLatency?.reflex === true && state.settings.lowLatencyMode !== "off",
  });
  return [mode, flash];
}

function rendererGroup(ui: Ui): HTMLElement | null {
  if (!state.capabilities?.includes("renderer")) return null;
  return ui.group(
    "Renderer",
    nativeChoice(
      ui,
      "Renderer",
      "renderer",
      [
        ["opengl", "OpenGL"],
        ["d3d11", "Direct3D 11"],
      ],
      {
        hint: "Takes effect after restarting the game",
        desc: "OpenGL is the default. Video export uses OpenGL with either renderer.",
        keywords: "renderer opengl direct3d d3d11 dx11 restart",
      },
    ),
  );
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
    ...lowLatencyRows(ui),
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
        [
          ...[rendererGroup(ui)].filter((group): group is HTMLElement => group !== null),
          framesGroup(ui),
          replaysGroup(ui),
        ],
      ],
    }),
    {
      label: "Display",
      icon: "grid",
      order: 62,
    },
  );
}
