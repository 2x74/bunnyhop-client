import type * as THREE from "three";
import { registerSettingsSection } from "../ui/settings-registry";
import * as ui from "../ui/controls";
import { DEFAULT_PREFS, keyLabel, prefs } from "../ui/settings";
import { arrowNav, h } from "../ui/dom";
import { dismissOutside } from "../ui/dismiss";
import { guardSideMouseButtons } from "../binds";
import { registerPaintCommands } from "./commands";
import { PaintOverlay } from "./overlay";
import { PAINT_COLORS, PAINT_SIZES, paintPrefs, type PaintSize } from "./prefs";
import "../ui/account.css";

let host: { overlay: PaintOverlay; camera: THREE.Camera; canPaint: () => boolean } | null = null;
let pending = false;

export function initPaint(world: THREE.Object3D, camera: THREE.Camera, canPaint: () => boolean, skyFaces: THREE.Object3D[]): void {
  host?.overlay.dispose();
  host = { overlay: new PaintOverlay(world, new Set(skyFaces)), camera, canPaint };
  pending = false;
}
export function requestPaint(): boolean {
  if (!host?.canPaint()) return false;
  pending = true;
  return true;
}
export function clearPaint(): void { pending = false; host?.overlay.clear(); }
export function paintVisible(visible: boolean): void { host?.overlay.setVisible(visible); }
export function paintFrame(now: number, held: boolean): void {
  if (!host?.canPaint()) { pending = false; return; }
  if (pending || held) host.overlay.stamp(host.camera, prefs.get().paint, now, !pending);
  pending = false;
}

/** Plain colour squares; the selected one is outlined. */
function colorRow(): HTMLElement {
  const sw = h("div.swatches.paint-swatches", { role: "radiogroup", "aria-label": "Paint colour" });
  const paint = () => {
    const cur = paintPrefs(prefs.get().paint).color;
    for (const b of sw.children) {
      const on = (b as HTMLElement).dataset.c === cur;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  for (const [color, label] of PAINT_COLORS)
    sw.append(h("button.swatch", { type: "button", role: "radio", style: `--c:${color}`, "data-c": color, "aria-label": label, title: label, onclick: () => (prefs.update((p) => (p.paint.color = color)), paint()) }));
  arrowNav(sw, "button");
  paint();
  return ui.row("Colour", sw, { keywords: "paint color colour marker landmark" });
}

function controls(title: string | null): HTMLElement {
  const key = prefs.get().binds.paint[0];
  return ui.group(title,
    colorRow(),
    ui.segmented("Size", () => paintPrefs(prefs.get().paint).size, (size: PaintSize) => prefs.update((p) => (p.paint.size = size)),
      Object.keys(PAINT_SIZES).map((size) => [size as PaintSize, size[0].toUpperCase() + size.slice(1)]), { keywords: "paint size small medium large" }),
    ui.actions("Marks", [ui.button("Clear paint", clearPaint)], {
      hint: key ? `Hold ${keyLabel(key)} to paint` : "!paint places one mark",
      desc: "Only you see your paint. It clears when you leave the map.", keywords: "clear paint remove erase reset",
    }),
  );
}

export function openPaintOptions(): void {
  const existing = document.querySelector<HTMLDialogElement>("dialog.paint-dialog");
  if (existing) return existing.focus();
  const d = h("dialog.acct-dialog.paint-dialog", { "aria-label": "Paint options" }) as HTMLDialogElement;
  d.append(h("header.acct-head", null, h("h2", null, "Paint options"), ui.button("Close", () => d.close())), h("div.acct-body.quick-set", null, controls(null)));
  d.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); d.close(); } });
  dismissOutside(d, () => d.close());
  const stopMouse = guardSideMouseButtons(window, () => d.open);
  d.addEventListener("close", () => { stopMouse(); d.remove(); });
  document.body.append(d);
  if (document.pointerLockElement) document.exitPointerLock();
  d.showModal();
}

/** Registered before the main menu, so Paint is available even before a map is loaded. */
export function registerPaint(): void {
  registerSettingsSection("paint", () => [controls("Surface paint")], {
    label: "Paint", icon: "paint", order: 45,
    reset: () => prefs.update((p) => (p.paint = { ...DEFAULT_PREFS.paint })),
  });
  registerPaintCommands({ place: requestPaint, clear: clearPaint, options: openPaintOptions });
}
