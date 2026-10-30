// Settings → Paint: the website's colour, size and Clear paint rows (web paint/index.ts), and the paint keys. The
// website's own section is built with its 3D paint engine, which the menu doesn't load; the native renderer paints,
// so this section writes the same prefs and prefs-bridge.ts hands them to the host.

import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { DEFAULT_PREFS, keyLabel, prefs, type Action } from "../../web/src/ui/settings";
import { arrowNav, h } from "../../web/src/ui/dom";
import { PAINT_COLORS, PAINT_SIZES, paintPrefs, type PaintSize } from "../../web/src/paint/prefs";
import { send } from "./bridge";
import type { Ui } from "./native-rows";

const PAINT_KEYS: readonly [Action, string][] = [
  ["paint", "Paint (hold)"],
  ["paintOnce", "Place paint mark"],
  ["clearPaint", "Clear paint"],
];

function colorRow(ui: Ui): HTMLElement {
  const swatches = h("div.swatches.paint-swatches", { role: "radiogroup", "aria-label": "Paint colour" });
  const paint = (): void => {
    const current = paintPrefs(prefs.get().paint).color;
    for (const swatch of swatches.children) {
      const on = (swatch as HTMLElement).dataset.c === current;
      swatch.classList.toggle("on", on);
      swatch.setAttribute("aria-checked", String(on));
    }
  };
  const choose = (color: string): void => {
    prefs.update((p) => (p.paint.color = color));
    paint();
  };
  for (const [color, label] of PAINT_COLORS)
    swatches.append(
      h("button.swatch", {
        type: "button",
        role: "radio",
        style: `--c:${color}`,
        "data-c": color,
        "aria-label": label,
        title: label,
        onclick: () => choose(color),
      }),
    );
  arrowNav(swatches, "button");
  paint();
  return ui.row("Colour", swatches, { keywords: "paint color colour marker landmark" });
}

function sizeRow(ui: Ui): HTMLElement {
  const sizes = Object.keys(PAINT_SIZES) as PaintSize[];
  const label = (size: PaintSize): string => size[0].toUpperCase() + size.slice(1);
  return ui.segmented(
    "Size",
    () => paintPrefs(prefs.get().paint).size,
    (size: PaintSize) => prefs.update((p) => (p.paint.size = size)),
    sizes.map((size) => [size, label(size)]),
    {
      desc: `Marks are ${sizes.map((size) => PAINT_SIZES[size]).join(", ")} units across.`,
      keywords: "paint size small medium large",
    },
  );
}

function marksRow(ui: Ui): HTMLElement {
  const key = prefs.get().binds.paint[0];
  return ui.actions("Marks", [ui.button("Clear paint", () => send({ type: "paint", action: "clear" }))], {
    hint: key ? `Hold ${keyLabel(key)} to paint` : "!paint places one mark",
    desc: "Only you see your paint. It clears when you leave the map.",
    keywords: "clear paint remove erase reset",
  });
}

/** The keys are set in Keys, where every bind lives; here they're shown with a way there. */
function keysGroup(ui: Ui): HTMLElement {
  const openKeys = (): void => {
    const item = document.querySelector<HTMLButtonElement>('.set-rail-item[data-sec="keys"]');
    item?.click();
  };
  const rows = PAINT_KEYS.map(([action, label]) => {
    const codes = prefs.get().binds[action];
    const keys = codes.length
      ? codes.map((code) => ui.keycap(keyLabel(code)))
      : [h("small.set-readout", null, "Not set")];
    return ui.row(label, h("div.native-paint-keys", null, ...keys), { keywords: `paint bind key ${label}` });
  });
  return ui.group(
    "Keys",
    ...rows,
    ui.actions("Change keys", [ui.button("Open Keys", openKeys)], { keywords: "paint bind rebind keys" }),
  );
}

/** Registers Settings → Paint (call once). */
export function registerPaintSection(): void {
  registerSettingsSection(
    "paint",
    (ui) => ({ columns: [[ui.group("Surface paint", colorRow(ui), sizeRow(ui), marksRow(ui))], [keysGroup(ui)]] }),
    {
      label: "Paint",
      icon: "paint",
      order: 45,
      reset: () => prefs.update((p) => (p.paint = { ...DEFAULT_PREFS.paint })),
    },
  );
}
