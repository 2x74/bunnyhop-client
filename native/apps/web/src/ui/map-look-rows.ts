// This map's Brightness and Fullbright as settings rows, for the pause menu's On screen tab: the same choices as the
// !bright quick menu (look-menu.ts), for players who never type commands. Changes are for this map only (map-look.ts).

import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, BRIGHTNESS_STEP, clearAllMapLooks, clearMapLook, lookMapNow, mapLook, mapLookCount, setMapLook, useMapLookEverywhere } from "../map-look";
import { actions, button, group, range, toggle } from "./controls";
import { h } from "./dom";
import { prefs } from "./settings";

export function mapLookRows(map: string): HTMLElement {
  const look = () => mapLook(prefs.get(), map);
  const redraw = () => el.replaceWith((el = mapLookRows(map)));
  const foot = look().own
    ? h(
        "div.pp-screen-foot",
        null,
        h("span.dim", null, `Set for ${map} only.`),
        h("button.link-btn", { type: "button", onclick: () => (prefs.update((p) => clearMapLook(p, map)), redraw()) }, "Reset this map"),
        h("button.link-btn.dim", { type: "button", onclick: () => (prefs.update((p) => useMapLookEverywhere(p, map)), redraw()) }, "Use on all maps"),
      )
    : h("div.pp-screen-foot", null, h("span.dim", null, `Changes here are for ${map} only. !bright opens them in game.`));
  let el: HTMLElement = h(
    "div.pp-map-look",
    null,
    group(
      "This map",
      range("Brightness", () => look().brightness, (v) => prefs.update((p) => setMapLook(p, map, { brightness: v })), {
        min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, step: BRIGHTNESS_STEP, scale: 100, unit: "%", peek: true,
        desc: "Lighten or darken this map only. Settings → Graphics has the value for every other map.",
        keywords: "brightness light dark exposure visibility map",
      }),
      toggle("Fullbright", () => look().fullbright, (v) => prefs.update((p) => setMapLook(p, map, { fullbright: v })), {
        desc: "Remove baked lighting on this map only. Keeps textures, fog and transparency.",
        keywords: "fullbright full bright lighting dark map",
      }),
    ),
    foot,
  );
  // The line under it follows once a change is made (after a slider is let go, not while it's dragged).
  const own = look().own;
  el.addEventListener("change", () => look().own !== own && redraw());
  return el;
}

/**
 * Settings → Graphics → Colour & visibility: one line when maps have their own Brightness / Fullbright (the values
 * above are the global ones), with a button that puts every map back on them. Hidden while no map has its own.
 */
export function mapLooksSettingsRow(): HTMLElement {
  const line = () => {
    const n = mapLookCount(prefs.get());
    const here = lookMapNow();
    const mine = here ? mapLook(prefs.get(), here).own : false;
    return `Own brightness or Fullbright on ${n === 1 ? "1 map" : `${n} maps`}${mine ? ", this one too" : ""}`;
  };
  const r = actions(line(), [button("Reset all maps", () => prefs.update(clearAllMapLooks))], {
    when: () => mapLookCount(prefs.get()) > 0,
    desc: "Set with !bright, !fb or the pause menu's On screen tab, for one map at a time. Reset puts every map back on the values above.",
    keywords: "brightness fullbright map per map override reset bright fb",
  });
  const name = r.querySelector(".set-name")!;
  let shown = false;
  const stop = prefs.watch(() => {
    if (r.isConnected) shown = true;
    else if (shown) return void queueMicrotask(stop);
    name.textContent = line();
  });
  return r;
}
