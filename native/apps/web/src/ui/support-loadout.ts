// The Support page's Loadout section (ui/support.ts, the page's second tab): everything a Supporter wears and uses in
// the game, slot by slot, to try on.
//
//   Click anything to try it on. Nothing here is equipped or saved.            Support from $5 / Open Loadout
//   Knife        ┌ the Loadout's own stage ────────────────────┬ the slot's Supporter items ┐
//   Finish       │ an item you click is put on (nothing is     │ then the options of what   │
//   ...          │ equipped or saved)                          │ is on in that slot         │
//   Player glow  └─────────────────────────────────────────────┴────────────────────────────┘
//
// The slots, the stage, the tiles and each item's options (hair colour and length, the cape's and the robe's rows, the
// mask) are the Loadout's (ui/loadout-view.ts loadoutView in preview mode, Supporter items only), used whole: this
// file adds nothing to its DOM and its stylesheet lays nothing of it out, so the Loadout's own layout is the one that
// runs here, the slots down the left as on the profile (and across the top where the window is too narrow for the
// list: the view's own switch). (Until v0.0.42 the page took the Loadout's grid out and put its own pickers under it;
// every new Loadout row then squeezed the tiles.) The Player glow is the Loadout's own entry, as on the profile.
//
// What the page needs from the view it asks for (LoadoutViewOpts): the slot showing comes through onSlot, the Player
// glow is opened with slot: "glow" or the handle's select(), and the handle's dispose() lets the view go when the page
// closes. Nothing is read off the view's DOM.
//
// No sets here (owner, 2026-11-17): no set names, nothing that puts a whole set on. The stage opens wearing the first
// Supporter item of each slot (support-page.ts startLoadout) and every item is tried on by itself.
//
// Made the first time the tab is opened (the stage is the page's one WebGL context) and kept, hidden, while another
// tab shows: the Loadout view lets go of its model when it leaves the document.

import { getLoadout } from "../player/cosmetics";
import { DEFAULT_COSMETICS, supporterItem } from "../progression";
import { onSupportPage, startLoadout } from "../support-page";
import { h } from "./dom";
import { loadoutView, type LoadoutChoice, type LoadoutModel, type LoadoutViewHandle } from "./loadout-view";
import { LOADOUT_CATEGORIES, type LoadoutCategory } from "./cosmetic-slots";

/**
 * What the preview starts in: your own knife and model, the first Supporter item of every other slot that has one
 * (support-page.ts startLoadout) and the slot's default for the rest. Every Loadout slot is read from the Loadout's
 * own list, so a new slot starts here with no line of its own.
 */
function startLook(): LoadoutChoice {
  const defaults = Object.fromEntries(LOADOUT_CATEGORIES.map(({ slot }) => [slot, DEFAULT_COSMETICS[slot]])) as Record<LoadoutCategory, string | null>;
  return { ...defaults, ...startLoadout(), body: getLoadout().body ?? "body-a", knife: getLoadout().knife ?? DEFAULT_COSMETICS.knife };
}

export type PreviewModel = LoadoutModel & { changed(): void };

/** The Loadout's model for trying items on: every supporter item shown and clickable, nothing saved. */
export function previewModel(mine: () => boolean): PreviewModel {
  const choice = startLook();
  const fns = new Set<() => void>();
  return {
    userId: null,
    choice: () => ({ ...choice }),
    crown: () => null,
    owns: (c) => supporterItem(c),
    lock: () => ({ hint: "Supporter item", goal: "Supporter item", fraction: null }),
    earned: () => (mine() ? "Yours" : ""),
    setHairColor: (hex) => {
      choice.hairColor = hex;
      fns.forEach((f) => f());
    },
    setHairLength: (n) => {
      choice.hairLength = n;
      fns.forEach((f) => f());
    },
    setHairHighlight: (hex) => {
      choice.hairHighlight = hex;
      fns.forEach((f) => f());
    },
    setMaskOn: (on) => {
      choice.maskOn = on;
      fns.forEach((f) => f());
    },
    setCape: (patch) => {
      Object.assign(choice, patch);
      fns.forEach((f) => f());
    },
    // Support previews items only (the pool row is hidden: previewOnly).
    knifePool: () => null,
    setKnifePool: () => {},
    equip: (slot, id) => {
      choice[slot] = id;
      fns.forEach((f) => f());
    },
    status: () => ({ kind: "idle", text: "" }),
    isNew: () => false,
    see: () => {},
    clearIndicators: () => {},
    on: (fn) => (fns.add(fn), () => fns.delete(fn)),
    /** Something the captions read changed (we learned the player is a supporter). */
    changed: () => fns.forEach((f) => f()),
  };
}

export interface LoadoutSection {
  el: HTMLElement;
  /** Whether the player is a supporter changed (the captions, the line and the button over the view). */
  supporter(yes: boolean): void;
  /** The glow being edited changed: the stage shows it. */
  glowChanged(): void;
  /** The Loadout slot showing now (the Open Loadout button opens the same one); null on the Player glow. */
  slot(): LoadoutCategory | null;
  /** Shows a slot of the view, or "glow" (the first tab's row about the glow). */
  show(slot: string): void;
  /** The page closed: the view lets go of its model and its window key listeners at once. */
  closed(): void;
}

export function loadoutSection(o: {
  isSupporter: () => boolean;
  /** The glow editor (ui/player-glow-controls.ts): its panel becomes the view's Player glow tab. */
  glow: { panel: HTMLElement; get: () => import("../player/glow-config").PlayerGlow | null };
  /** The button for someone who isn't a supporter (to the ask), with its words. */
  toAsk: () => void;
  askLabel: () => string;
  /** A supporter's button: their real Loadout, on the slot showing here. */
  openLoadout: (slot: LoadoutCategory | null) => void;
  /** The slot to open on ("glow": the Player glow); the bunny's Colourway otherwise. */
  slot?: string;
}): LoadoutSection {
  const model = previewModel(o.isSupporter);
  let showing: LoadoutCategory | "glow" = "outfit";
  let handle: LoadoutViewHandle | null = null;
  const view = loadoutView(model, {
    only: onSupportPage,
    previewOnly: true,
    slot: o.slot ?? "outfit",
    onSlot: (s) => (showing = s),
    onReady: (v) => (handle = v),
    playerGlow: () => o.glow.get(),
    glow: { panel: o.glow.panel, onShown: () => {} },
  });
  const note = h("p.sp-loadout-note");
  const action = h("div.sp-actions");
  const slot = () => (showing === "glow" ? null : showing);
  const drawHead = () => {
    const yes = o.isSupporter();
    note.textContent = yes ? "Click anything to try it on. To wear it, open your Loadout." : "Click anything to try it on. Nothing here is equipped or saved.";
    action.replaceChildren(
      yes ? h("button.btn.btn-sm", { type: "button", onclick: () => o.openLoadout(slot()) }, "Open Loadout") : h("button.btn.primary.btn-sm", { type: "button", onclick: o.toAsk }, o.askLabel()),
    );
  };
  drawHead();
  const el = h("div.sp-loadout", { role: "tabpanel", "aria-labelledby": "sp-tab-loadout" }, h("div.sp-loadout-head", null, note, action), view);
  return {
    el,
    supporter: () => {
      model.changed();
      drawHead();
    },
    glowChanged: () => {
      model.changed();
      view.dispatchEvent(new Event("playerglowpreview"));
    },
    slot,
    show: (s) => handle?.select(s),
    closed: () => handle?.dispose(),
  };
}
