// Settings -> Viewmodel (registered into the settings screen through ui/settings-registry.ts; imported by main.ts).
// Prefs live in ui/settings.ts (`viewmodel`), applied live by viewmodel.ts. The paused game keeps rendering behind the
// settings screen: holding the FOV / offset sliders in game hides the menu but that row to show the hands
// (ui/controls.ts peek, the same as every setting you can see in the world).

import { registerSettingsSection } from "../ui/settings-registry";
import { DEFAULT_PREFS, horizontalFovAt, keyLabel, prefs, type Action, type Prefs, type ViewmodelHand } from "../ui/settings";
import { VIEWMODEL_POS } from "./defaults";
import { getLoadout, onLoadout } from "../player/cosmetics";
import { h } from "../ui/dom";
import { loadoutSummary } from "../ui/loadout-ui";
import { openLoadout } from "../ui/unlocks";

const P = () => prefs.get();
const set = <K extends keyof Prefs["viewmodel"]>(k: K) => (v: Prefs["viewmodel"][K]) => prefs.update((p) => (p.viewmodel[k] = v));
const key = (a: Action) => {
  const c = P().binds[a]?.[0];
  return c ? keyLabel(c) : "unbound";
};

/** The carrot's keys as keycaps. */
function keycaps(ui: { keycap: (t: string) => HTMLElement }, keys: string[]): HTMLElement {
  const s = document.createElement("span");
  s.className = "keycaps";
  s.append(...keys.map((k) => ui.keycap(k)));
  return s;
}

/**
 * Position presets (viewmodel_fov + viewmodel_offset_x / _y / _z). Our offsets are Source units like CS:GO's (the rig
 * is the CS:S knife viewmodel skeleton), so CS:GO numbers carry over. Classic = the default (viewmodel/defaults.ts
 * VIEWMODEL_POS): CS:S's FOV 54 and its knife's footprint, low on the right (offsets 0 / 0 / 0 is CS:S's own pose,
 * which with the bunny's bigger hands and longer blades covers more of the screen than CS:S's knife did).
 */
type PresetId = "classic" | "csgo" | "minimal";
const PRESETS: Record<PresetId, { label: string; fov: number; x: number; y: number; z: number }> = {
  classic: { label: "Classic", ...VIEWMODEL_POS },
  // CS:GO's defaults (viewmodel_presetpos 1, "Desktop").
  csgo: { label: "CS:GO default", fov: 60, x: 1, y: 1, z: -1 },
  // Hands out wide, pulled back and down: as little of the screen covered as the sliders allow.
  minimal: { label: "Minimal", fov: 68, x: 2.5, y: -2, z: -2 },
};
const presetOf = (): PresetId | "custom" => {
  const v = P().viewmodel;
  for (const [id, p] of Object.entries(PRESETS) as [PresetId, (typeof PRESETS)[PresetId]][]) if (v.fov === p.fov && v.x === p.x && v.y === p.y && v.z === p.z) return id;
  return "custom";
};

/** The equipped knife / finish / gloves (kept current), with the way into the Loadout screen. */
function loadoutRow(ui: { row: (label: string, el: HTMLElement, o?: { desc?: string; hint?: string; keywords?: string }) => HTMLElement; button: (label: string, fn: () => void) => HTMLElement }): HTMLElement {
  const items = h("span.vm-loadout-items");
  const paint = () => {
    const s = loadoutSummary(getLoadout());
    items.replaceChildren(h("span", null, `${s.knife} · ${s.finish}`), h("small", null, `${s.glove} gloves`));
  };
  paint();
  const off = onLoadout(() => (items.isConnected ? paint() : off()));
  return ui.row("Equipped", h("div.vm-loadout", null, items, ui.button("Loadout", () => openLoadout("knife"))), {
    desc: "Your knife, finish and gloves show in first person, on your bunny, in replays and ghosts, and to other players. Every knife is free; finishes and gloves unlock by playing. Change them in the Loadout.",
    keywords: "knife finish skin gloves sunset nebula frost karambit karrotbit butterfly bunnyfly loadout cosmetic inspect",
  });
}

registerSettingsSection(
  "viewmodel",
  (ui, ctx) => {
    const preset = ui.segmented<PresetId | "custom">("Position preset", presetOf, (id) => {
      if (id === "custom") return;
      const p = PRESETS[id];
      prefs.update((q) => Object.assign(q.viewmodel, { fov: p.fov, x: p.x, y: p.y, z: p.z }));
      ctx.refresh();
    }, (Object.entries(PRESETS) as [PresetId, (typeof PRESETS)[PresetId]][]).map(([id, p]) => [id, p.label]), {
      desc: `Classic (the default): CS:S's FOV 54 and its knife's place on screen, low on the right (offsets ${VIEWMODEL_POS.x} / ${VIEWMODEL_POS.y} / ${VIEWMODEL_POS.z}). CS:GO default: FOV 60, 1 / 1 / -1. Minimal: FOV 68, hands out wide, back and down.`,
      keywords: "viewmodel_presetpos classic csgo cs:go minimal",
    }) as HTMLElement & { repaint?: () => void };
    /** Slider setter that also re-highlights the matching preset (or none: custom). */
    const live = <K extends "fov" | "x" | "y" | "z">(k: K) => (v: number) => (set(k)(v), preset.repaint?.());
    const offset = (axis: "x" | "y" | "z", label: string, min: number, max: number, desc: string, keywords: string) =>
      ui.range(label, () => P().viewmodel[axis], live(axis), { min, max, step: 0.1, peek: true, desc, keywords: `viewmodel_offset_${axis} offset position ${keywords}` });
    const swing = ui.row("Swing", keycaps(ui, [key("attack"), key("attack2"), key("inspect")]), {
      desc: () =>
        `${key("attack")} slashes (alternating sides, like the CS:S knife), ${key("attack2")} stabs, ${key("inspect")} inspects (tap it again during an inspect for the next trick, hold it to keep a spin going). Purely cosmetic: swings never touch your movement or your run (a mouse button bound to jump stays a jump), but replays, ghosts and other players show them. Rebind in Keys.`,
      keywords: "slash stab inspect attack mouse1 mouse2 swing knife",
    });
    return {
      columns: [
        [
          ui.group(
            "Viewmodel",
            ui.toggle("Show viewmodel", () => P().viewmodel.show, set("show"), {
              desc: "Your gloved bunny hands with the carrot blade, CS:S knife style.",
              hint: `${key("viewmodel")} toggles it in game`,
              keywords: "hands knife carrot weapon r_drawviewmodel first-person",
            }),
            ui.range("Viewmodel FOV", () => P().viewmodel.fov, live("fov"), {
              min: 40,
              max: 90,
              step: 1,
              unit: "°",
              desc: () => `viewmodel_fov: horizontal at 4:3 like your FOV (CS:S 54). Your screen: ${horizontalFovAt(P().viewmodel.fov, innerWidth / innerHeight).toFixed(0)}° horizontal.`,
              hint: "Lower is bigger",
              peek: true,
              keywords: "viewmodel_fov fov hands size bigger smaller",
            }),
            ui.segmented<ViewmodelHand>("Hand", () => P().viewmodel.hand, set("hand"), [
              ["right", "Right"],
              ["left", "Left"],
            ], { desc: "cl_righthand: which hand holds the carrot.", keywords: "cl_righthand left handed right hand" }),
            preset,
          ),
        ],
        [ui.group("Loadout", loadoutRow(ui), swing)],
      ],
      advanced: [
        ui.group(
          "Position",
          offset("x", "Offset X", -2, 2.5, "viewmodel_offset_x: sideways, + = outward (away from the centre, for either hand). Units like CS:GO.", "right left side"),
          offset("y", "Offset Y", -2, 2, "viewmodel_offset_y: + = forward (further from you), - = closer.", "forward back"),
          offset("z", "Offset Z", -2, 2, "viewmodel_offset_z: + = up, - = down.", "up down height"),
          ui.actions("Reset position", [ui.button("Reset", () => (prefs.update((q) => Object.assign(q.viewmodel, { x: VIEWMODEL_POS.x, y: VIEWMODEL_POS.y, z: VIEWMODEL_POS.z })), ctx.refresh()))], {
            desc: "Offsets back to the default (Classic); keeps your FOV. 0 / 0 / 0 is CS:S's own pose.",
            keywords: "reset offset position default",
          }),
        ),
        ui.group(
          "Movement feel",
          ui.range("Bob", () => P().viewmodel.bob, set("bob"), {
            min: 0,
            max: 1.5,
            step: 0.05,
            scale: 100,
            unit: "%",
            desc: "Walk bob (cl_bob style, on the ground only), landing dip and breathing. 0 = perfectly still.",
            keywords: "cl_bob bobbing",
          }),
          ui.range("Sway", () => P().viewmodel.sway, set("sway"), {
            min: 0,
            max: 1.5,
            step: 0.05,
            scale: 100,
            unit: "%",
            desc: "Lag behind mouse movement (CS:S viewmodel lag) and the tilt when strafing. 0 = locked to the view.",
            keywords: "lag tilt cl_viewmodel",
          }),
        ),
      ],
    };
  },
  {
    label: "Viewmodel",
    blurb: "",
    icon: "viewmodel",
    order: 65,
    reset: () => prefs.update((p) => (p.viewmodel = JSON.parse(JSON.stringify(DEFAULT_PREFS.viewmodel)))),
  },
);
