// Show triggers: the !showtriggers / !showclips of bhop servers (the showtriggers and showplayerclips plugins), and the
// !triggers menu that picks the kinds. Drawn in the world for you only, in solo, rooms and the replay viewer; they
// never touch the simulation, so a run with them on is as ranked as any other.
//
//   main.ts     initTriggerOverlay(core, world.root) once the world is built; triggerOverlayFrame(...) every frame
//   viewer      the same frame call with the replay's own core (its triggers switch with the replay)
//   prefs       Prefs.triggers (ui/settings.ts): on / off, the kinds and the look (colours, style, opacity, line
//               thickness: Settings → HUD → Triggers and clips; style and thickness also in the !triggers menu), per device
//
// The kinds and geometry are volumes.ts; the drawing overlay.ts. The overlay is built the first time something is
// shown on this map.

import type * as THREE from "three";
import { registerChatCommand, type ChatContext } from "../chat-commands";
import type { BrushTransform, Core } from "../core";
import type { MenuSpec, NumberMenu } from "../net/hud";
import { paletteFor, triggerColors } from "../palette";
import { prefs, type Prefs } from "../ui/settings";
import { closeGunPicker } from "../weapon-commands";
import { TriggerOverlay } from "./overlay";
import { KINDS, kindShown, nextStyle, nextThickness, toggleKind, TRIGGER_STYLES, type KindId } from "./volumes";

let host: { core: Core; parent: THREE.Object3D } | null = null;
/** Undefined until first shown; null if this wasm build has no overlay data. */
let overlay: TriggerOverlay | null | undefined;

/** The look to draw: trigger colours still at their default follow the colour-blind palette (palette.ts). */
const look = (p: Prefs) => ({ ...p.triggers, colors: triggerColors(p.triggers.colors, paletteFor(p.colorBlind)) });

const shownKinds = () => KINDS.map((k) => kindShown(prefs.get().triggers, k.id));

function built(): TriggerOverlay | null {
  if (overlay === undefined && host) {
    overlay = TriggerOverlay.build(host.core);
    overlay?.setLook(look(prefs.get()));
    if (overlay) host.parent.add(overlay.root);
    if (import.meta.env.DEV) Object.assign(window, { __triggers: overlay });
  }
  return overlay ?? null;
}

/** main.ts, once the world is built: the live core (its full map load) and the world's container. */
export function initTriggerOverlay(core: Core, parent: THREE.Object3D): void {
  host = { core, parent };
  prefs.watch((p) => {
    const on = shownKinds();
    const o = on.some(Boolean) ? built() : overlay;
    o?.setKinds(on);
    o?.setLook(look(p));
    if (menu?.open) showMenu();
  });
}

/**
 * Every rendered frame: `transforms` = `brushOrigins()` of `core`, the simulation on screen (the live run's, or the
 * replay viewer's). `hidden`: Hide UI is on (the overlay goes with the zones).
 */
export function triggerOverlayFrame(transforms: Map<number, BrushTransform>, core: Core, hidden: boolean): void {
  if (!overlay) return;
  const visible = !hidden && shownKinds().some((on, i) => on && overlay!.count(i) > 0);
  overlay.root.visible = visible;
  if (visible) overlay.update(transforms, core.overlayStates());
}

/** Volumes of a group on this map, or null if the overlay isn't available. */
function present(group: "triggers" | "clips"): number | null {
  const o = built();
  return o ? KINDS.reduce((n, k, i) => n + (k.group === group ? o.count(i) : 0), 0) : null;
}

/** !showtriggers / !showclips: flips the group; turning it on with every kind of it off in the menu turns them back on. */
function toggleGroup(ctx: ChatContext, group: "triggers" | "clips"): void {
  const kinds = KINDS.filter((k) => k.group === group);
  let on = false;
  prefs.update((p) => {
    const t = p.triggers;
    on = !(group === "triggers" ? t.show : t.clips);
    if (group === "triggers") t.show = on;
    else t.clips = on;
    if (on && kinds.every((k) => !t.kinds[k.id])) for (const k of kinds) t.kinds[k.id] = true;
  });
  const what = group === "triggers" ? "triggers" : "player clips or invisible walls";
  if (!on) return ctx.reply(group === "triggers" ? "Triggers hidden." : "Clips hidden.");
  if (present(group) === 0) return ctx.reply(`This map has no ${what}.`);
  ctx.reply(group === "triggers" ? "Showing triggers. !triggers picks which." : "Showing player clips and invisible walls.");
}

// ---------------------------------------------------------------------------------------------
// The !triggers menu (the game's numbered menu, like !guns)

let menu: NumberMenu | null = null;
let keysHooked = false;

function showMenu(): void {
  if (!menu) return;
  const o = built();
  const t = prefs.get().triggers;
  const spec: MenuSpec = {
    title: "Triggers",
    items: [
      ...KINDS.map((k, i) => {
        const none = !!o && o.count(i) === 0;
        return { label: k.label, detail: none ? "none" : kindShown(t, k.id) ? "on" : "off", disabled: none };
      }),
      // The look, a step per press (colours and fill opacity: Settings → HUD → Triggers and clips).
      { label: "Style", detail: TRIGGER_STYLES.find(([s]) => s === t.style)?.[1] ?? "" },
      { label: "Line thickness", detail: `${t.thickness} px` },
    ],
    onPick: (i) =>
      prefs.update((p) => {
        if (i < KINDS.length) return toggleKind(p.triggers, KINDS[i].id as KindId);
        if (i === KINDS.length) p.triggers.style = nextStyle(p.triggers.style);
        else p.triggers.thickness = nextThickness(p.triggers.thickness);
      }),
  };
  if (menu.open) menu.update("triggers", spec);
  else menu.show("triggers", spec);
}

async function openMenu(): Promise<void> {
  if (menu?.open) return menu.hide();
  if (!menu) {
    const { NumberMenu } = await import("../net/hud");
    menu = new NumberMenu(document.getElementById("hud") ?? document.body);
    menu.el.classList.add("trigger-menu");
  }
  if (!keysHooked) {
    keysHooked = true;
    // Capture phase, ahead of the game's keys: while the menu is open its digits pick instead of a weapon slot.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!menu?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
        if (!d) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        menu.key(Number(d[1]));
      },
      true,
    );
  }
  closeGunPicker(); // one numbered menu at a time
  showMenu();
}

registerChatCommand({
  name: "showtriggers",
  aliases: ["showtrigger"],
  help: "show triggers",
  about: "draws the map's teleports, boosters and other triggers (again to hide them). !triggers picks which.",
  group: "more",
  where: "both",
  run: (ctx) => toggleGroup(ctx, "triggers"),
});
registerChatCommand({
  name: "showclips",
  aliases: ["showplayerclips", "showclip"],
  help: "show clips",
  about: "draws player clips and invisible walls (again to hide them).",
  group: "more",
  panelOnly: true,
  where: "both",
  run: (ctx) => toggleGroup(ctx, "clips"),
});
registerChatCommand({
  name: "triggers",
  aliases: ["triggermenu"],
  help: "pick which triggers show",
  about: "a menu of what !showtriggers and !showclips draw.",
  group: "more",
  panelOnly: true,
  where: "both",
  run: () => void openMenu(),
});
