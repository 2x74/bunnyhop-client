// Your mouse on your profile. The profile's "Mouse settings" button opens these rows in a small sheet: the same rows as
// Settings → Mouse & view (sensitivity, DPI, whether the DPI shows), applied live and published to your profile by
// mouse-profile.ts at the root (initMouseProfileSync). No separate form or Save step.

import { api } from "../api";
import { mouseFromPrefs } from "../mouse-settings";
import { DEFAULT_PREFS, prefs } from "./settings";
import { h } from "./dom";
import { range, toggle } from "./controls";
import "./mouse-profile.css";
import { dismissOutside } from "./dismiss";

export function mouseProfileEditor(saved: () => void = () => {}): void {
  const up = (fn: (p: ReturnType<typeof prefs.get>) => void) => prefs.update(fn);
  const dialog = h("dialog.acct-dialog.mouse-dialog", { "aria-labelledby": "mouse-title" });
  const close = () => dialog.close();
  const rows = h(
    "div.acct-body.quick-set",
    null,
    range("Sensitivity", () => prefs.get().sensitivity, (v) => up((p) => (p.sensitivity = Math.round(v * 1000) / 1000)), { min: 0.1, max: 10, step: 0.01, inputRange: [0.01, 100], hint: "CS:S units, as in your config" }),
    range("Mouse DPI", () => prefs.get().dpi, (v) => up((p) => ((p.dpi = Math.round(v)), (p.dpiConfirmed = true))), { min: 100, max: 6400, step: 50, inputRange: [50, 32000] }),
    api.available()
      ? toggle("Show DPI on profile", () => mouseFromPrefs(prefs.get()).dpi !== null, (v) => up((p) => (v ? ((p.dpiHidden = false), (p.dpiConfirmed = true)) : (p.dpiHidden = true))), {
          hint: `Off: ${DEFAULT_PREFS.dpi}, the default`,
        })
      : null,
    h("div.mouse-actions", null, h("button.btn.primary", { type: "button", onclick: close }, "Done")),
  );
  dialog.append(h("header.acct-head", null, h("h2#mouse-title", null, "Mouse"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: close }, "×")), rows);
  dialog.addEventListener("close", () => (dialog.remove(), saved()));
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  dismissOutside(dialog, close);
  document.body.append(dialog);
  dialog.showModal();
}

export function mouseProfileStats(mouse: ReturnType<typeof mouseFromPrefs> | null | undefined): HTMLElement {
  const dpi = mouse?.dpi ?? DEFAULT_PREFS.dpi;
  const box = h("div.pf-mouse", { "aria-label": "Mouse settings" });
  const stat = (label: string, value: string) => h("div", null, h("dt", null, label), h("dd", null, value));
  box.append(h("dl", null,
    stat("Sensitivity", mouse ? String(Number(mouse.sensitivity.toFixed(6))) : "Not shared yet"),
    stat("DPI", mouse?.dpi != null ? String(dpi) : `${dpi} (default)`),
    stat("eDPI", mouse ? String(Math.round(mouse.sensitivity * dpi)) : "—")));
  return box;
}
