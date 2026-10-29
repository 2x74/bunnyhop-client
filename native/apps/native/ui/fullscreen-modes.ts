// Settings → Display → Fullscreen: the monitor, resolution and refresh rate exclusive fullscreen switches to, and
// how a resolution of another shape (4:3 on a 16:9 monitor) fills the screen. The host lists the modes
// (display_catalog.hpp) and tries a new one for ten seconds before keeping it (display_mode_tryout.hpp).

import { h } from "../../web/src/ui/dom";
import {
  state,
  type DisplayInfo,
  type DisplayModeInfo,
  type FullscreenMode,
  type FullscreenScaling,
  type SettingsPatch,
} from "./bridge";
import { followHost, type Ui } from "./native-rows";
import { sendNativeSettings } from "./prefs-bridge";

const DESKTOP = "desktop";
const HIGHEST = "0";
/** Shapes closer than this are the same shape (display_modes.hpp aspect_match). */
const SAME_SHAPE = 0.01;
const SHAPES: [number, number, string][] = [
  [4, 3, "4:3"],
  [5, 4, "5:4"],
  [16, 10, "16:10"],
  [16, 9, "16:9"],
  [21, 9, "21:9"],
  [32, 9, "32:9"],
];

/** "4:3", "16:10"... for a size, or "" for an unusual one (display_modes.hpp aspect_name). */
export function shapeName(width: number, height: number): string {
  const aspect = width / height;
  const shape = SHAPES.find(([across, down]) => Math.abs(aspect - across / down) < SAME_SHAPE * 2);
  if (shape) return shape[2];
  return aspect > 2.3 && aspect < 2.45 ? "21:9" : "";
}

export function sameShape(a: DisplayModeInfo, b: DisplayModeInfo): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) < SAME_SHAPE;
}

const sizeKey = (mode: { width: number; height: number }): string => `${mode.width}x${mode.height}`;

/** The monitor the setting names, else the one the game window is on. */
export function chosenDisplay(displays: DisplayInfo[], mode: FullscreenMode): DisplayInfo | undefined {
  return (
    displays.find((d) => d.name === mode.display && d.index === mode.displayIndex) ??
    displays.find((d) => mode.display !== "" && d.name === mode.display) ??
    displays.find((d) => d.window) ??
    displays[0]
  );
}

/** Each size the monitor offers once, largest first. */
export function displaySizes(display: DisplayInfo): DisplayModeInfo[] {
  const sizes = new Map<string, DisplayModeInfo>();
  for (const mode of display.modes) {
    const known = sizes.get(sizeKey(mode));
    if (!known || mode.refreshHz > known.refreshHz) sizes.set(sizeKey(mode), mode);
  }
  return [...sizes.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.width - a.width);
}

/** The refresh rates of one size, highest first. */
export function sizeRates(display: DisplayInfo, width: number, height: number): number[] {
  const rates = display.modes.filter((m) => m.width === width && m.height === height).map((m) => m.refreshHz);
  return [...new Set(rates)].sort((a, b) => b - a);
}

const rateText = (hz: number): string => `${Number.isInteger(hz) ? hz : hz.toFixed(2)} Hz`;

function sizeText(mode: { width: number; height: number }, desktop: DisplayModeInfo | null): string {
  const shape = shapeName(mode.width, mode.height);
  const native = desktop && mode.width === desktop.width && mode.height === desktop.height ? ", native" : "";
  return `${mode.width} × ${mode.height}${shape ? `  ${shape}` : ""}${native}`;
}

function setOptions(select: HTMLSelectElement, options: [string, string][], value: string): void {
  const same =
    select.options.length === options.length &&
    options.every(([v, label], i) => select.options[i].value === v && select.options[i].text === label);
  if (!same) select.replaceChildren(...options.map(([v, label]) => h("option", { value: v }, label)));
  select.value = options.some(([v]) => v === value) ? value : (options[0]?.[0] ?? "");
}

function sendMode(patch: Partial<FullscreenMode>, extra: SettingsPatch = {}): void {
  sendNativeSettings({ ...extra, fullscreenMode: { ...state.settings.fullscreenMode, ...patch } });
}

function chooseDisplay(value: string): void {
  const display = state.displays?.displays.find((d) => String(d.index) === value);
  if (!display) return;
  const { width, height } = state.settings.fullscreenMode;
  const keeps = display.modes.some((m) => m.width === width && m.height === height);
  sendMode({ display: display.name, displayIndex: display.index, ...(keeps ? {} : { width: 0, height: 0 }) });
}

function chooseSize(value: string): void {
  if (value === DESKTOP) return sendMode({ width: 0, height: 0, refreshHz: 0 });
  const [width, height] = value.split("x").map(Number);
  // Picking a resolution is asking for it: exclusive fullscreen is the only mode that changes it.
  sendMode({ width, height, refreshHz: 0 }, { windowMode: "fullscreen" });
}

function chooseRate(value: string): void {
  sendMode({ refreshHz: Number(value) });
}

const selectIn = (row: HTMLElement): HTMLSelectElement => row.querySelector("select")!;

/** The Fullscreen group; it shows only the rows the host's monitors make useful. */
export function fullscreenGroup(ui: Ui): HTMLElement {
  const monitor = ui.select("Monitor", () => "", chooseDisplay, [["", ""]], {
    desc: "Which monitor Fullscreen uses.",
    keywords: "monitor display screen second multi",
  });
  const size = ui.select("Resolution", () => DESKTOP, chooseSize, [[DESKTOP, "Desktop"]], {
    desc:
      "Fullscreen switches the monitor to this resolution, and asks to keep it for 10 seconds. Graphics → Aspect " +
      "ratio draws 4:3 in Borderless without changing the monitor's mode.",
    keywords: "resolution 4:3 stretched 1280x960 1024x768 1440x1080 exclusive fullscreen display mode",
  });
  const rate = ui.select("Refresh rate", () => HIGHEST, chooseRate, [[HIGHEST, "Highest"]], {
    desc: "Fullscreen's refresh rate at this resolution.",
    keywords: "refresh rate hz 144 240 360 monitor",
  });
  const scaling = ui.segmented<FullscreenScaling>(
    "Scaling",
    () => state.settings.fullscreenScaling,
    (value) => sendNativeSettings({ fullscreenScaling: value }),
    [
      ["stretch", "Stretched"],
      ["bars", "Black bars"],
    ],
    {
      desc:
        "For a resolution of another shape than the monitor. If it doesn't change, set scaling in your graphics " +
        "driver (NVIDIA: Adjust desktop size and position; AMD: GPU scaling) to override games.",
      keywords: "stretched black bars 4:3 scaling aspect gpu scaling",
    },
  );
  const group = ui.group("Fullscreen", monitor, size, rate, scaling);
  const paint = (): void => paintRows(monitor, size, rate, scaling);
  followHost(group, ui, paint);
  const onState = (): void => {
    if (group.isConnected) paint();
    else if (seen) removeEventListener("bunnyhop:host-state", onState);
    seen ||= group.isConnected;
  };
  let seen = false;
  addEventListener("bunnyhop:host-state", onState);
  return group;
}

function paintRows(monitor: HTMLElement, size: HTMLElement, rate: HTMLElement, scaling: HTMLElement): void {
  const displays = state.displays?.displays ?? [];
  const chosen = state.settings.fullscreenMode;
  const display = chosenDisplay(displays, chosen);
  monitor.hidden = displays.length < 2;
  size.hidden = !display || !display.modes.length;
  setOptions(
    selectIn(monitor),
    displays.map((d) => [String(d.index), d.primary ? `${d.name} (main)` : d.name]),
    String(display?.index ?? ""),
  );
  if (!display) {
    rate.hidden = scaling.hidden = true;
    return;
  }
  const desktopLabel = display.desktop ? `Desktop (${display.desktop.width} × ${display.desktop.height})` : "Desktop";
  const sizes: [string, string][] = displaySizes(display).map((m) => [sizeKey(m), sizeText(m, display.desktop)]);
  setOptions(selectIn(size), [[DESKTOP, desktopLabel], ...sizes], chosen.width ? sizeKey(chosen) : DESKTOP);
  const rates = chosen.width ? sizeRates(display, chosen.width, chosen.height) : [];
  rate.hidden = rates.length < 2;
  setOptions(
    selectIn(rate),
    [[HIGHEST, "Highest"], ...rates.map((hz): [string, string] => [String(hz), rateText(hz)])],
    String(chosen.refreshHz),
  );
  scaling.hidden = !chosen.width || !display.desktop || sameShape(chosen, display.desktop);
}
