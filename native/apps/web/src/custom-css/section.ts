// Settings -> Custom CSS (registered through ui/settings-registry.ts; imported by main.ts): the switch and the editor.

import { registerSettingsSection } from "../ui/settings-registry";
import { cssStatus, customCss, onCssStatus, setCustomCss } from "./index";

let refresh: (() => void) | null = null;
// The hint names the desktop app's file when one is in use.
let lastDesktop: string | null = null;
onCssStatus((s) => {
  if (s.desktop === lastDesktop) return;
  lastDesktop = s.desktop;
  refresh?.();
});

registerSettingsSection(
  "css",
  (ui, ctx) => {
    refresh = ctx.refresh;
    const desktop = cssStatus().desktop;
    return [
      ui.group(
        "Custom CSS",
        ui.toggle("Use your CSS", () => customCss().on, (v) => setCustomCss({ on: v }, { now: true }), {
          desc: "Your own stylesheet over the menus and the HUD: colours, fonts, images. Ctrl+Shift+V switches it off from anywhere in the game.",
          keywords: "css custom css theme skin style stylesheet font fonts colour color ui interface image gif mod",
        }),
        ui.actions("Your CSS", [ui.button("Edit CSS", () => void import("./editor").then((m) => m.openCssEditor()), { primary: true })], {
          hint: desktop ? `${desktop} (desktop app)` : undefined,
          desc: desktop ? "The desktop app's CSS file is in use. Save the file to update it." : "Paste CSS or import it from a link. It applies as you type.",
          keywords: "css edit paste import link theme",
        }),
      ),
    ];
  },
  { label: "Custom CSS", icon: "pen", order: 75 },
);
