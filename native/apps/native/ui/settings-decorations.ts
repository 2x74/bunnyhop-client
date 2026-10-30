// Small changes to website rows the native client shows with a difference.

import { prefs } from "../../web/src/ui/settings";
import { hostCan } from "./prefs-bridge";
import { decorateRow } from "./settings-controls";

/** Looks that build on the Source look, which a host without the graphicsPreset key can't draw. */
const COMPOSER_LOOKS = ["enhanced", "cinematic"];

/** Show on screen's pieces that are HUD elements (quick-toggles.ts), by web element id. */
const MINIATURE_ELEMENTS = ["speed", "timer", "split", "stats", "sync", "keys", "strafeTrainer", "fps", "chat"];

export function decorateNativeRows(): void {
  decorateRow("graphics/Quality/Look", (row) => {
    if (hostCan("graphicsPreset")) return;
    for (const option of row.querySelectorAll<HTMLOptionElement>("option")) {
      if (!COMPOSER_LOOKS.includes(option.value)) continue;
      option.disabled = true;
      option.textContent = `${option.textContent} (website only)`;
    }
  });
  // An FPS limit typed in before (or another build's default) stays listed as it is.
  decorateRow("graphics/Frame rate/FPS limit", (row) => {
    const select = row.querySelector("select");
    const limit = prefs.get().graphics.fpsLimit;
    if (!select || [...select.options].some((option) => Number(option.value) === limit)) return;
    const option = new Option(String(limit), String(limit));
    const after = [...select.options].find((item) => Number(item.value) > limit || Number(item.value) === 0);
    select.insertBefore(option, after ?? null);
    select.value = String(limit);
  });
  decorateRow("hud/Show on screen/Show on screen", (row) => {
    for (const id of MINIATURE_ELEMENTS) {
      if (hostCan(`hud:${id}`)) continue;
      row.querySelector<HTMLElement>(`.mn-el-${id}`)?.remove();
    }
  });
}
