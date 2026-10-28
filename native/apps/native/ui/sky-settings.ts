// The website's Sky group (web sky-packs/settings.ts) for the native menu. Sky packs install into the browser's
// storage and draw with the website's renderer; the native renderer shows each map's own sky (settings-gates.ts
// PACKS). The web module's converters load Three, which the menu never bundles, so this stands in for it and keeps
// the one sky row the native renderer honours.

import type * as Controls from "../../web/src/ui/controls";
import { prefs } from "../../web/src/ui/settings";

export const SKIES_GUIDE_URL = "https://bunnyhop.lol/custom-skies";

/** No sky files are accepted, so a file dropped on Settings → Graphics is ignored. */
export function skyFileKind(_name: string): null {
  return null;
}

export function importSkyFile(_file: File): void {}

/** The Sky group: brightness of the map's own sky. */
export function skyGroup(ui: typeof Controls, _ctx: unknown): HTMLElement {
  const brightness = ui.range(
    "Sky brightness",
    () => prefs.get().graphics.skyExposure,
    (value) => prefs.update((p) => (p.graphics.skyExposure = value)),
    {
      min: -4,
      max: 4,
      step: 0.1,
      desc: "Brighter or darker sky, in stops: +1 doubles it.",
      keywords: "sky exposure brightness stops",
    },
  );
  return ui.group("Sky", brightness);
}
