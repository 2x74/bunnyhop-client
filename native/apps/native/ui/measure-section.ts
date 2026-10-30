// Settings → Measure: the website's row (web measure/index.ts), with the native renderer doing the measuring. The
// host picks the aimed surface, draws the points and the line, and answers with the distances as a notice.

import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { keyLabel, prefs } from "../../web/src/ui/settings";
import { send } from "./bridge";

/** Registers Settings → Measure (call once). */
export function registerMeasureSection(): void {
  registerSettingsSection(
    "measure",
    (ui) => {
      const key = prefs.get().binds.measurePoint[0];
      const point = ui.button("Set aimed point", () => send({ type: "measure", action: "point" }));
      const clear = ui.button("Clear measurement", () => send({ type: "measure", action: "clear" }));
      return [
        ui.group(
          "Distance measurement",
          ui.actions("Measurement", [point, clear], {
            hint: key ? `${keyLabel(key)} at each point` : "!measure at each point",
            desc:
              "Full distance, horizontal gap and height difference, in Source units. A third point starts a new " +
              "measurement. Only you see it; it clears when you leave the map.",
            keywords: "measure ruler distance gap height point",
          }),
        ),
      ];
    },
    { label: "Measure", icon: "measure", order: 46 },
  );
}
