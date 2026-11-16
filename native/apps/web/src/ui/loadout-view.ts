import { getPlayerGlow, onPlayerGlow } from "../player/cosmetics";
// Loadout: everything you look like in the game. The profile's Loadout tab (ui/profile.ts), which the menus' Loadout
// shortcuts open (pause menu, Settings → Viewmodel, unlock cards); offline, kept on this device.
//
//   Knife  Finish  Gloves  Colourway  (Hat)  Ghost  Trail                                    Saved
//   ┌──────────────────────────────────────┬──────────────────┐
//   │ the stage (ui/loadout-stage.ts):      │ ┌────┐┌────┐┌────┐ │  rendered thumbnails, a thin rarity line, the
//   │ your hands in first person, your      │ │    ││    ││    │ │  name; a locked item says how to get it in one
//   │ bunny, or your ghost and its trail    │ └────┘└────┘└────┘ │  short line
//   └──────────────────────────────────────┴──────────────────┘
//
// The caption names the item shown and says in one quiet line how it's earned: the goal while locked, how (and when,
// on which map) it was earned once it's yours.
//
// Hover (or focus) an item: the stage shows it at once. Click / Enter: equips it (autosaved through the profile's
// Loadout, ui/card-editor.ts). Arrows move in the grid, Q / E (LB / RB) switch category, F (your inspect key) inspects
// the knife, held F keeps a spin going. One WebGL context for all of it (the stage also draws the thumbnails).

import "./loadout-view.css";
import { fixedModel } from "../player/bunny/look";
import type { Profile } from "../api";
import { SUPPORTER_MIN_USD, CAPE_ITEM, CAPE_LENGTH, capeHexOf, capeLengthOf, ROBE_ITEM, robePatternOf, COSMETICS, cosmetic, HAIR_HATS, MASK_HAT, highlightHexOf, KNIFE_POOL_MAX, type KnifePool, crownOf, DEFAULT_COSMETICS, isUnlocked, secretCosmetic, supporterItem, type CosmeticDef } from "../progression";
import { colourway } from "../player/bunny/palettes";
import { ROBE_PATTERNS } from "../player/robe-names";
import { CAPE_LINING_DEFAULT, CAPE_PRESETS, HAIR_DEFAULT, HAIR_LENGTH, HAIR_PRESETS, HIGHLIGHT_PRESETS, LENGTH_HATS, hairColorOf, hairHex, hairLengthOf, isWig, loadoutFor, packLoadout, type CosmeticLoadout } from "../loadout";
import { glowColorPicker } from "./glow-color-picker";
import { getGhostCosmetics, getKnifePool, getLoadout, getOutfit, onGhostCosmetics, onHeldLoadout, onLoadout, onOutfit, setGhostCosmetics, setKnifePool, setLoadout, setOutfit } from "../player/cosmetics";
import { previewOf } from "../notify/item-preview";
import type { Loadout, NewTracker } from "./card-editor";
import { arrowNav, h } from "./dom";
import { scrollCue } from "./scroll-cue";
import type { LoadoutStage, StageLook, StageView, ThumbJob } from "./loadout-stage";
import { loadoutSwatch, shownCosmetic } from "./loadout-ui";
import { EMPTYABLE, isLoadoutCategory, LOADOUT_CATEGORIES, loadoutCategories, loadoutSections, noneLabel, stageKind, type LoadoutCategory } from "./cosmetic-slots";
import { keyLabel, prefs } from "./settings";
import { earnedLine, lockInfo, profileHolder, profileRanks, type LockInfo } from "./unlocks";
import { earnedHint } from "./unlock-text";
import { navigate } from "./nav";
import { sfx } from "../audio";
import { uiSound } from "../audio/ui";

export type LoadoutSlot = LoadoutCategory;
/** The Cape's settings (progression.ts CAPE_LENGTH, capeHexOf); null / absent = the defaults. */
export type CapeChoice = { capeLength?: number | null; capeColor?: string | null; capeLining?: string | null } & RobeChoice;
/** The Robe's settings (progression.ts robePatternOf); null / absent = plain, open, the colourway's colours. */
export type RobeChoice = { robePattern?: number | null; robeTied?: boolean | null; robeColor?: string | null; robePrint?: string | null };
/**
 * The worn ids per category, plus a wig's colour and highlight ("#rrggbb"), the hair's length (a percent), the Kitsune
 * Mask over the face and the Cape's settings; absent = the defaults.
 */
export type LoadoutChoice = Record<LoadoutCategory | "body", string | null> & { hairColor?: string | null; hairLength?: number | null; hairHighlight?: string | null; maskOn?: boolean | null } & CapeChoice;

/** What the view needs from whoever saves the choice (the profile's Loadout, or this device when offline). */
export interface LoadoutModel {
  playerGlow?: () => import("../player/glow-config").PlayerGlow | null;
  /** Account id, null offline. */
  userId: string | null;
  choice(): LoadoutChoice;
  /** The overall place held (1 / 2 / 3: the crown on the bunny when no hat is on). */
  crown(): 1 | 2 | 3 | null;
  owns(c: CosmeticDef): boolean;
  lock(c: CosmeticDef): LockInfo;
  /** How an owned item was earned ("Cleared a T3 map · Oct 5 on bhop_eazy", "Free"). */
  earned(c: CosmeticDef): string;
  equip(slot: LoadoutCategory | "body", id: string | null): void;
  /** A wig's hair colour ("#rrggbb"; null = the default). */
  setHairColor(hex: string | null): void;
  /** The ponytail's length (a percent, HAIR_LENGTH; null = the default). */
  setHairLength(n: number | null): void;
  /** A wig's highlight colour ("#rrggbb"; null = none). */
  setHairHighlight(hex: string | null): void;
  /** The Kitsune Mask over the face (true) or pushed up on the side of the head (false). */
  setMaskOn(on: boolean): void;
  /** The Cape's length and colours (null = the default). */
  setCape(patch: CapeChoice): void;
  /** The knife pool (progression.ts KnifePool; null = none). */
  knifePool(): KnifePool | null;
  setKnifePool(p: KnifePool | null): void;
  status(): { kind: "idle" | "saving" | "saved" | "error"; text: string };
  isNew(id: string): boolean;
  see(ids: string[]): void;
  clearIndicators(): void;
  on(fn: () => void): () => void;
}

const pick = (c: Record<string, unknown>): LoadoutChoice => ({
  knife: (c.knife as string | null | undefined) ?? DEFAULT_COSMETICS.knife,
  finish: (c.finish as string | null | undefined) ?? DEFAULT_COSMETICS.finish,
  glove: (c.glove as string | null | undefined) ?? DEFAULT_COSMETICS.glove,
  hilt: (c.hilt as string | null | undefined) ?? DEFAULT_COSMETICS.hilt,
  outfit: (c.outfit as string | null | undefined) ?? DEFAULT_COSMETICS.outfit,
  body: (c.body as string | null | undefined) ?? DEFAULT_COSMETICS.body,
  hat: (c.hat as string | null | undefined) ?? null,
  back: (c.back as string | null | undefined) ?? null,
  camo: (c.camo as string | null | undefined) ?? null,
  ghost: (c.ghost as string | null | undefined) ?? DEFAULT_COSMETICS.ghost,
  trail: (c.trail as string | null | undefined) ?? DEFAULT_COSMETICS.trail,
  shape: (c.shape as string | null | undefined) ?? DEFAULT_COSMETICS.shape,
  hop: (c.hop as string | null | undefined) ?? null,
  hairColor: (c.hairColor as string | null | undefined) ?? null,
  hairLength: hairLengthOf(c.hairLength),
  hairHighlight: highlightHexOf(c.hairHighlight),
  maskOn: c.maskOn === true,
  capeLength: capeLengthOf(c.capeLength),
  capeColor: capeHexOf(c.capeColor),
  capeLining: capeHexOf(c.capeLining),
  robePattern: robePatternOf(c.robePattern),
  robeTied: c.robeTied === true ? true : null,
  robeColor: capeHexOf(c.robeColor),
  robePrint: capeHexOf(c.robePrint),
});
const emptyPool = (): KnifePool => ({ items: [], swap: "map", order: "order" });

/** The profile owner's loadout (saved to the account as you go). */
export function profileModel(p: Profile, lo: Loadout, news: NewTracker): LoadoutModel {
  return {
    userId: p.player.id,
    playerGlow: () => p.mine ? getPlayerGlow() : p.player.playerGlow ?? null,
    choice: () => pick(lo.choice),
    crown: () => crownOf(profileRanks(p)),
    owns: (c) => lo.owned.has(c.id),
    lock: (c) => lockInfo(c, p.level, p.progress, profileRanks(p), profileHolder(p)),
    earned: (c) => earnedLine(c, p),
    equip: (slot, id) => lo.equip(slot, id),
    setHairColor: (hex) => lo.apply({ hairColor: hex }),
    setHairLength: (n) => lo.apply({ hairLength: n }),
    setHairHighlight: (hex) => lo.apply({ hairHighlight: hex }),
    setMaskOn: (on) => lo.apply({ maskOn: on }),
    setCape: (patch) => lo.apply(patch),
    knifePool: () => lo.choice.knifePool ?? null,
    setKnifePool: (pool) => lo.apply({ knifePool: pool && pool.items.length ? pool : null }),
    status: () => lo.status,
    isNew: (id) => news.isNew(id),
    see: (ids) => news.see(ids),
    clearIndicators: () => news.clear(COSMETICS.filter((c) => isLoadoutCategory(c.slot) && lo.owned.has(c.id)).map((c) => c.id)),
    on: (fn) => {
      const offs = [lo.on(fn), news.on(fn), onPlayerGlow(fn)];
      return () => offs.forEach((off) => off());
    },
  };
}

/** Offline: free items, kept on this device. */
export function localModel(): LoadoutModel {
  let status: ReturnType<LoadoutModel["status"]> = { kind: "idle", text: "" };
  const level = { level: 1, xp: 0, into: 0, need: 100, fraction: 0 };
  const choice = (): LoadoutChoice => {
    const g = getGhostCosmetics();
    const l = getLoadout();
    return pick({ ...(l as unknown as Record<string, string>), hairColor: l.hairColor !== undefined ? hairHex(l.hairColor) : null, hairLength: l.hairLength ?? null, hairHighlight: l.hairHighlight !== undefined ? hairHex(l.hairHighlight) : null, maskOn: !!l.maskOn, capeLength: l.capeLength ?? null, capeColor: l.capeColor !== undefined ? hairHex(l.capeColor) : null, capeLining: l.capeLining !== undefined ? hairHex(l.capeLining) : null, robePattern: l.robePattern ?? null, robeTied: l.robeTied ?? null, robeColor: l.robeColor !== undefined ? hairHex(l.robeColor) : null, robePrint: l.robePrint !== undefined ? hairHex(l.robePrint) : null, outfit: getOutfit(), ghost: g.ghostId, trail: g.trailId, shape: g.shapeId });
  };
  return {
    userId: null,
    choice,
    crown: () => null,
    owns: (c) => isUnlocked(c, 1, []),
    lock: (c) => lockInfo(c, level, null),
    earned: (c) => earnedHint(c, { level: 1, achievements: [] }),
    equip: (slot, id) => {
      const c = choice();
      if (slot === "outfit") setOutfit(id);
      else if (slot === "ghost" || slot === "trail" || slot === "shape") {
        setGhostCosmetics(slot === "ghost" ? id : c.ghost, slot === "trail" ? id : c.trail, slot === "shape" ? id : c.shape);
        // The hop effect takes the trail's colours.
        if (slot === "trail") setLoadout(loadoutFor({ ...c, trail: id }));
      } else setLoadout(loadoutFor({ ...c, [slot]: id }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    setHairColor: (hex) => {
      setLoadout(loadoutFor({ ...choice(), hairColor: hex }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    setHairLength: (n) => {
      setLoadout(loadoutFor({ ...choice(), hairLength: n }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    setHairHighlight: (hex) => {
      setLoadout(loadoutFor({ ...choice(), hairHighlight: hex }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    setMaskOn: (on) => {
      setLoadout(loadoutFor({ ...choice(), maskOn: on }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    setCape: (patch) => {
      setLoadout(loadoutFor({ ...choice(), ...patch }));
      status = { kind: "saved", text: "Saved on this device" };
    },
    knifePool: () => getKnifePool(),
    setKnifePool: (pool) => {
      setKnifePool(pool && pool.items.length ? pool : null);
      status = { kind: "saved", text: "Saved on this device" };
    },
    status: () => status,
    isNew: () => false,
    see: () => {},
    clearIndicators: () => {},
    on: (fn) => {
      const offs = [onLoadout(() => fn()), onOutfit(() => fn()), onGhostCosmetics(() => fn()), onHeldLoadout(() => fn())];
      return () => offs.forEach((off) => off());
    },
  };
}

// ---------------------------------------------------------------------------------------------

const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor"/></svg>`;

let lastSlot: LoadoutCategory = "knife";
/** First person or close-up, for the hands' categories. */
let lastHandsView: StageView = "fp";
/** First person or side, for the Gun camo. */
let lastGunView: StageView = "gun";

const NAME: Record<LoadoutCategory, string> = Object.fromEntries(LOADOUT_CATEGORIES.map((c) => [c.slot, c.label])) as Record<LoadoutCategory, string>;
/** The caption's second line per category (what the item is). */
const KIND: Record<LoadoutCategory, string> = { knife: "Knife", finish: "Finish", hilt: "Hilt", glove: "Gloves", camo: "Gun camo", outfit: "Colourway", hat: "Hat", back: "Back", ghost: "Ghost colour", trail: "Trail", shape: "Trail shape", hop: "Hop effect" };

export interface LoadoutViewOpts {
  playerGlow?: () => import("../player/glow-config").PlayerGlow | null;
  /** A "Player glow" tab beside the categories: this panel in place of the grid, your bunny on the stage. */
  glow?: { panel: HTMLElement; onShown: (on: boolean) => void };
  /** Open on this category (else the last one used). */
  slot?: string | null;
  /** Only these items (the Support page: the supporter set). Categories with none are left out; no "No hat" tile. */
  only?: (c: CosmeticDef) => boolean;
  /** Nothing is equipped or saved (the Support page): a click shows the item, the state line says it's a preview. */
  previewOnly?: boolean;
  /** Gets a redraw() for when `only` or the model's choice change from outside (the Support page's set switcher). */
  onReady?: (view: { redraw(): void }) => void;
}

/**
 * A locked supporter item's goal ("Supporter item") as a link to the Support page, else the plain text. `inButton`:
 * inside a tile (a button can't hold a link): a span that opens the page on click and keeps the tile's own click.
 */
export function goalText(c: CosmeticDef | null, text: string, inButton = false): HTMLElement | string {
  if (!c || !supporterItem(c)) return text;
  const go = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    navigate({ screen: "support" });
  };
  return inButton
    ? h("span.lo-goal-link", { title: "How to support bunnyhop.lol", onclick: go }, text)
    : h("a.lo-goal-link", { href: "/?support", onclick: go }, text);
}

export function loadoutView(m: LoadoutModel, o: LoadoutViewOpts = {}): HTMLElement {
  /**
   * A secret item you don't own yet (progression.ts secretCosmetic): "???", its model drawn as a flat silhouette (tile
   * and stage: player/materials.ts silhouetteMaterial, which never reads its colours), and it can't be equipped.
   */
  const veiled = (c: CosmeticDef | null | undefined): boolean => !!c && secretCosmetic(c) && !m.owns(c);
  /** An item's name as this player may see it. */
  const nameOf = (c: CosmeticDef | null | undefined): string | undefined => (veiled(c) ? "???" : c?.name);
  const listed = (s: LoadoutCategory) => COSMETICS.filter((c) => c.slot === s && shownCosmetic(c, m.owns) && (!o.only || o.only(c)));
  const cats = loadoutCategories((s) => listed(s).length).filter((s) => !o.only || listed(s).length > 0);
  let slot: LoadoutCategory = isLoadoutCategory(o.slot) && cats.includes(o.slot) ? o.slot : cats.includes(lastSlot) ? lastSlot : "knife";
  let preview: string | null = null;
  /** On the Player glow tab (o.glow). The stage stays on the Colourway category meanwhile, for your whole bunny. */
  let glowTab = false;
  /** A hair colour being tried in the custom picker (shown on the stage, not saved). */
  let hairDraft: string | null = null;
  /** A ponytail length being dragged (shown on the stage; saved when the slider is let go). */
  let lengthDraft: number | null = null;
  /** A highlight colour being tried (hovered or in the custom picker): a colour, "" for none, null = not trying one. */
  let highlightDraft: string | null = null;
  /** The Cape's settings being tried (a length being dragged, a colour in a picker or under the pointer). */
  let capeDraft: CapeChoice | null = null;
  let stage: LoadoutStage | null = null;
  let revertTimer = 0;
  let applyRaf = 0;

  const choice = () => m.choice();
  /** The choice the stage shows: what you wear, with the previewed item swapped in (a veiled one as its silhouette). */
  const shownChoice = (): LoadoutChoice => {
    const c = choice();
    // (A secret camo not earned yet isn't put on the guns: its tile shows the gun's shape only.)
    if (preview !== null) c[slot] = slot === "camo" && veiled(cosmetic(preview)) ? null : preview || null;
    if (hairDraft) c.hairColor = hairDraft;
    if (lengthDraft !== null) c.hairLength = lengthDraft;
    if (highlightDraft !== null) c.hairHighlight = highlightDraft || null;
    if (capeDraft) Object.assign(c, capeDraft);
    return c;
  };
  const loadoutOf = (c: LoadoutChoice): CosmeticLoadout => loadoutFor(c, m.crown());
  /**
   * The glow on the stage: the one being edited (the Player glow tab, the Support page: shown whatever the settings
   * say, it's a preview), else the player's own as the game shows it (their saved glow, under the Player glow /
   * First-person glow settings) on every other tab too: the bunny on Colourway and Hat, the hands on Knife, Finish and
   * Gloves. Thumbnails never show one.
   */
  const lookOf = (c: LoadoutChoice): StageLook => {
    const editing = o.playerGlow?.() ?? null;
    return { playerGlow: editing ?? m.playerGlow?.() ?? null, previewGlow: !!editing, outfit: c.outfit, ghost: c.ghost, trail: c.trail, shape: c.shape, veil: veiled(cosmetic(c.outfit)) || veiled(cosmetic(c.back)), facing: slot === "back" ? "back" : "front" };
  };
  const viewFor = (s: LoadoutCategory): StageView => (stageKind(s) === "hands" ? lastHandsView : stageKind(s) === "guns" ? lastGunView : stageKind(s) === "bunny" ? "bunny" : s === "hop" ? "hop" : "ghost");

  // --- stage
  const capName = h("h3.lo-cap-name");
  const capMeta = h("p.lo-cap-meta");
  const capHow = h("p.lo-cap-how");
  const capState = h("p.lo-cap-state", { "aria-live": "polite" });
  const viewSeg = h("div.seg.lo-viewseg", { role: "radiogroup", "aria-label": "View" });
  const inspectKey = () => prefs.get().binds.inspect?.find((k) => !k.startsWith("Mouse")) ?? "KeyF";
  const inspectBtn = h("button.btn.lo-insp", { type: "button", title: "Inspect (tap again for the next trick)", onclick: () => stage?.inspect() }, "Inspect", h("kbd", null, keyLabel(inspectKey())));
  const drag = h("span.lo-drag", { "aria-hidden": "true" }, "Drag to turn");
  // Gun camo: which gun the stage holds (every gun takes the same camo).
  const gunName = h("span.lo-gun-name", { "aria-live": "polite" });
  const gunNav = h(
    "div.lo-gunnav",
    { hidden: true },
    h("button.lo-gun-step", { type: "button", "aria-label": "Previous gun", title: "Previous gun", onclick: () => stepGun(-1) }, "‹"),
    gunName,
    h("button.lo-gun-step", { type: "button", "aria-label": "Next gun", title: "Next gun", onclick: () => stepGun(1) }, "›"),
  );
  function stepGun(by: number): void {
    if (!stage) return;
    gunName.textContent = stage.stepGun(by);
  }
  function drawGunNav(): void {
    gunNav.hidden = stageKind(slot) !== "guns";
    if (!gunNav.hidden && stage) gunName.textContent = stage.stepGun(0);
  }
  // The room: a pool of light on the floor and a slow rim light behind the bunny, both in the shown item's rarity
  // colour (quiet for common items); a shine sweeps across when you equip something.
  const stageHost = h(
    "div.lo-stage",
    { "data-view": viewFor(slot), "data-kind": stageKind(slot) },
    h("span.lo-light", { "aria-hidden": "true" }),
    h("span.lo-rim", { "aria-hidden": "true" }),
    h("div.lo-cap", null, capName, capMeta, capHow, capState),
    h("div.lo-tools", null, viewSeg, gunNav, drag),
    inspectBtn,
    h("span.lo-shine", { "aria-hidden": "true" }),
  );
  const motion = () => !matchMedia("(prefers-reduced-motion: reduce)").matches && !document.body.classList.contains("potato");
  /** The equip moment on the stage: the item pops (scale 0.94, 1.04, 1 over 220 ms) under a shine. */
  function equipPop(): void {
    if (!motion()) return;
    stageHost.querySelector(".lo-canvas")?.animate([{ scale: "1" }, { scale: "0.94" }, { scale: "1.04" }, { scale: "1" }], { duration: 220, easing: "ease-out" });
    stageHost.querySelector(".lo-shine")?.animate([{ transform: "translateX(-60%)", opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: "translateX(160%)", opacity: 0 }], { duration: 520, easing: "ease-out" });
  }
  /** Running the pointer down the grid flips through a rack: each new preview slides in 4 px and fades up (90 ms). */
  let lastPreviewIdx = -1;
  function scrub(id: string | null): void {
    const i = id === null ? -1 : tiles.findIndex((t) => t.id === id);
    const dir = i >= 0 && lastPreviewIdx >= 0 ? Math.sign(i - lastPreviewIdx) || 1 : 1;
    lastPreviewIdx = i;
    if (!motion()) return;
    stageHost.querySelector(".lo-canvas")?.animate([{ translate: `${4 * dir}px 0`, opacity: 0.55 }, { translate: "0 0", opacity: 1 }], { duration: 90, easing: "ease-out" });
  }

  function drawViewSeg(): void {
    const kind = stageKind(slot);
    viewSeg.hidden = kind !== "hands" && kind !== "guns";
    drawGunNav();
    if (viewSeg.hidden) return viewSeg.replaceChildren();
    const cur = stage?.view ?? (kind === "guns" ? lastGunView : lastHandsView);
    viewSeg.replaceChildren(
      ...(
        (kind === "guns"
          ? [
              ["gun", "First person"],
              ["gunside", "Side"],
            ]
          : [
              ["fp", "First person"],
              ["close", "Close-up"],
            ]) as [StageView, string][]
      ).map(([v, label]) => h(`button${cur === v ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(cur === v), onclick: () => setView(v) }, label)),
    );
  }
  function setView(v: StageView): void {
    if (v === "fp" || v === "close") lastHandsView = v;
    if (v === "gun" || v === "gunside") lastGunView = v;
    stageHost.dataset.view = v;
    stageHost.dataset.kind = stageKind(slot);
    stage?.setView(v);
    drawViewSeg();
  }

  // --- categories across the top, the grid beside the stage
  const tabs = h("div.lo-tabs", { role: "tablist", "aria-label": "Loadout" });
  // Nine categories don't fit a 1024 px window: the row scrolls, and the edge with more fades (it ran off with no cue).
  scrollCue(tabs, "x");
  const status = h("span.lo-status", { role: "status", "aria-live": "polite" });
  const clearIndicators = h("button.link-btn.lo-clear", { type: "button", onclick: () => m.clearIndicators() }, "Mark all seen");
  clearIndicators.hidden = !!o.previewOnly;
  const grid = h("div.lo-grid", { role: "group" });
  const glowPane = o.glow ? h("div.lo-glow-pane", { hidden: true }, o.glow.panel) : null;
  const bodySeg = h("div.seg.lo-modelseg", { role: "radiogroup", "aria-label": "Player model" });
  const bodyRow = h("div.lo-model-row", null, h("span.lo-model-label", null, "Player model"), bodySeg);
  function drawBody(): void {
    const c = choice();
    const fixed = fixedModel(c.outfit);
    bodyRow.hidden = !!o.previewOnly || slot !== "outfit" || fixed;
    bodySeg.replaceChildren(...(["a", "b"] as const).map((key) => {
      const id = `body-${key}`;
      const selected = (c.body ?? "body-a") === id;
      return h(`button${selected ? ".on" : ""}`, { type: "button", role: "radio", "aria-label": `Model ${key.toUpperCase()}`, "aria-checked": String(selected), tabindex: selected ? "0" : "-1", disabled: fixed,
        onclick: () => { m.equip("body", id); if (stageKind(slot) === "hands") select("outfit"); drawBody(); apply(); },
      }, key.toUpperCase());
    }));
  }
  bodySeg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || fixedModel(choice().outfit)) return;
    e.preventDefault();
    m.equip("body", choice().body === "body-b" ? "body-a" : "body-b");
    drawBody(); apply(); bodySeg.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  /**
   * A row that belongs to some hats (hair colour, ponytail length). Hovering a card puts that hat on the stage; when the
   * rows sat over the grid, one that came and went with it pushed the grid down under the cursor, onto the next card,
   * which took the row away again (syl, 2026-10-29). They sit under the grid now, so they simply show while they apply.
   */
  function reserveRow(row: HTMLElement, show: boolean, _keep: boolean): void {
    // Under the grid (v0.0.38): coming and going there only shortens the grid's view, it never moves a tile under the
    // pointer, so the row no longer needs to keep its place while unused.
    row.hidden = !show;
    row.classList.remove("lo-row-idle");
    row.inert = false;
  }
  // Hair colour: under the tabs while a wig is on the stage (worn or hovered) and yours. Presets and a custom colour.
  const hairSw = h("div.lo-hair-sw", { role: "radiogroup", "aria-label": "Hair colour" });
  const hairDot = h("span.lo-hair-dot", { "aria-hidden": "true" });
  let hairDialog: HTMLDialogElement | null = null;
  const hairCustom = h("button.btn.btn-sm.lo-hair-custom", { type: "button", "aria-haspopup": "dialog", onclick: () => {
    if (hairDialog) return hairDialog.focus();
    hairDialog = glowColorPicker({
      title: "Hair colour",
      intro: "Choose a colour for your hair.",
      current: hairHex(hairColorOf(choice().hairColor) ?? HAIR_DEFAULT) as `#${string}`,
      preview: (hex) => ((hairDraft = hex), apply()),
      apply: (hex) => ((hairDraft = null), m.setHairColor(hex), drawHair(), apply()),
      closed: () => ((hairDialog = null), (hairDraft = null), apply()),
    });
  } }, hairDot, "Custom…");
  const hairRow = h("div.lo-model-row.lo-hair-row", null, h("span.lo-model-label", null, "Hair colour"), hairSw, hairCustom);
  function drawHair(): void {
    const shown = shownChoice().hat;
    const wig = shown ? cosmetic(shown) : null;
    const show = slot === "hat" && isWig(shown) && !!wig && m.owns(wig);
    reserveRow(hairRow, show, show || (slot === "hat" && HAIR_HATS.some((id) => { const c = cosmetic(id); return !!c && m.owns(c); })));
    if (!show) return;
    const cur = hairHex(hairColorOf(choice().hairColor) ?? HAIR_DEFAULT);
    const preset = HAIR_PRESETS.some((p) => p.hex === cur);
    hairSw.replaceChildren(...HAIR_PRESETS.map((p) => {
      const on = p.hex === cur;
      return h(`button.lo-hair-swatch${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), "aria-label": p.name, title: p.name, tabindex: on || (!preset && p === HAIR_PRESETS[0]) ? "0" : "-1", style: `--sw:${p.hex}`,
        onmouseenter: () => ((hairDraft = p.hex), apply()), onmouseleave: () => ((hairDraft = null), apply()),
        onclick: () => ((hairDraft = null), m.setHairColor(p.hex === hairHex(HAIR_DEFAULT) ? null : p.hex), drawHair(), apply()),
      });
    }));
    hairDot.style.setProperty("--sw", cur);
    hairCustom.classList.toggle("on", !preset);
    hairCustom.title = preset ? "Choose any colour" : `Custom colour ${cur.toUpperCase()}`;
  }
  arrowNav(hairSw, "button");
  // Highlights: under the hair colour, for the same hats. "None" first (the hair in one colour), presets, any colour.
  const hiSw = h("div.lo-hair-sw", { role: "radiogroup", "aria-label": "Highlights" });
  const hiDot = h("span.lo-hair-dot", { "aria-hidden": "true" });
  let hiDialog: HTMLDialogElement | null = null;
  const hiCustom = h("button.btn.btn-sm.lo-hair-custom", { type: "button", "aria-haspopup": "dialog", onclick: () => {
    if (hiDialog) return hiDialog.focus();
    hiDialog = glowColorPicker({
      title: "Highlights",
      intro: "Choose a colour for your hair's highlights.",
      current: (highlightHexOf(choice().hairHighlight) ?? HIGHLIGHT_PRESETS[0].hex) as `#${string}`,
      preview: (hex) => ((highlightDraft = hex), apply()),
      apply: (hex) => ((highlightDraft = null), m.setHairHighlight(highlightHexOf(hex)), drawHighlight(), apply()),
      closed: () => ((hiDialog = null), (highlightDraft = null), apply()),
    });
  } }, hiDot, "Custom…");
  const hiRow = h("div.lo-model-row.lo-hair-row.lo-highlight-row", null, h("span.lo-model-label", null, "Highlights"), hiSw, hiCustom);
  function drawHighlight(): void {
    const shown = shownChoice().hat;
    const wig = shown ? cosmetic(shown) : null;
    const show = slot === "hat" && isWig(shown) && !!wig && m.owns(wig);
    reserveRow(hiRow, show, show);
    if (!show) return;
    const cur = highlightHexOf(choice().hairHighlight);
    const preset = !cur || HIGHLIGHT_PRESETS.some((p) => p.hex === cur);
    const sw = (name: string, hex: string | null) => {
      const on = hex === cur;
      return h(`button.lo-hair-swatch${hex ? "" : ".lo-hair-none"}${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), "aria-label": name, title: name, tabindex: on ? "0" : "-1", style: hex ? `--sw:${hex}` : "",
        onmouseenter: () => ((highlightDraft = hex ?? ""), apply()), onmouseleave: () => ((highlightDraft = null), apply()),
        onclick: () => ((highlightDraft = null), m.setHairHighlight(hex), drawHighlight(), apply()),
      });
    };
    hiSw.replaceChildren(sw("None", null), ...HIGHLIGHT_PRESETS.map((p) => sw(p.name, p.hex)));
    hiDot.style.setProperty("--sw", cur ?? "transparent");
    hiCustom.classList.toggle("on", !preset);
    hiCustom.title = preset ? "Choose any colour" : `Custom colour ${cur!.toUpperCase()}`;
  }
  arrowNav(hiSw, "button");
  // The Kitsune Mask's two ways to wear it: while it is on the stage and yours.
  const maskSeg = h("div.seg.lo-modelseg", { role: "radiogroup", "aria-label": "Mask" });
  const maskRow = h("div.lo-model-row.lo-hair-row.lo-mask-row", null, h("span.lo-model-label", null, "Mask"), maskSeg);
  function drawMask(): void {
    const shown = shownChoice().hat;
    const item = shown === MASK_HAT ? cosmetic(shown) : null;
    const show = slot === "hat" && !!item && m.owns(item);
    reserveRow(maskRow, show, show);
    if (!show) return;
    const on = !!choice().maskOn;
    maskSeg.replaceChildren(...([[false, "Pushed up"], [true, "On the face"]] as const).map(([v, label]) =>
      h(`button${on === v ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on === v), tabindex: on === v ? "0" : "-1", onclick: () => { m.setMaskOn(v); drawMask(); apply(); } }, label)));
  }
  maskSeg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    m.setMaskOn(!choice().maskOn);
    drawMask(); apply(); maskSeg.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  // Ponytail length: under the hair colour while the Ponytail is on the stage and yours. Dragging shows it on the stage;
  // letting go saves it.
  const lengthValue = h("output");
  const lengthInput = h("input", { type: "range", min: String(HAIR_LENGTH.min), max: String(HAIR_LENGTH.max), step: "5", "aria-label": "Hair length",
    oninput: () => ((lengthDraft = Number(lengthInput.value)), drawLength(), apply()),
    onchange: () => {
      const n = Number(lengthInput.value);
      lengthDraft = null;
      m.setHairLength(n === HAIR_LENGTH.default ? null : n);
      drawLength();
      apply();
    },
  }) as HTMLInputElement;
  const lengthRow = h("div.lo-model-row.lo-length-row", null, h("label.lo-length", null, h("span.lo-model-label", null, "Length"), lengthInput, lengthValue));
  function drawLength(): void {
    const shown = shownChoice().hat;
    const pony = shown ? cosmetic(shown) : null;
    const show = slot === "hat" && !!shown && LENGTH_HATS.includes(shown) && !!pony && m.owns(pony);
    reserveRow(lengthRow, show, show || (slot === "hat" && LENGTH_HATS.some((id) => { const c = cosmetic(id); return !!c && m.owns(c); })));
    if (!show) return;
    const n = lengthDraft ?? hairLengthOf(choice().hairLength) ?? HAIR_LENGTH.default;
    lengthInput.value = String(n);
    // The track's filled part (style.css input[type=range] reads --p, 0..1 along min..max).
    lengthInput.style.setProperty("--p", String((n - HAIR_LENGTH.min) / (HAIR_LENGTH.max - HAIR_LENGTH.min)));
    lengthValue.textContent = `${n}%`;
  }
  // The Cape (Back tab): its length and its two colours, under the grid while the Cape is on the stage (worn or
  // hovered) and yours. Dragging the length and trying a colour show on the stage; letting go / choosing saves.
  const capeShown = (): boolean => {
    const c = cosmetic(CAPE_ITEM);
    return slot === "back" && shownChoice().back === CAPE_ITEM && !!c && m.owns(c);
  };
  const capeLengthValue = h("output");
  const capeLengthInput = h("input", { type: "range", min: String(CAPE_LENGTH.min), max: String(CAPE_LENGTH.max), step: String(CAPE_LENGTH.step), "aria-label": "Cape length",
    oninput: () => ((capeDraft = { capeLength: Number(capeLengthInput.value) }), drawCape(), apply()),
    onchange: () => {
      const n = Number(capeLengthInput.value);
      capeDraft = null;
      m.setCape({ capeLength: n === CAPE_LENGTH.default ? null : n });
      drawCape();
      apply();
    },
  }) as HTMLInputElement;
  const capeLengthRow = h("div.lo-model-row.lo-length-row.lo-cape-row", null, h("label.lo-length", null, h("span.lo-model-label", null, "Length"), capeLengthInput, capeLengthValue));
  /** A colour row of the Cape: "Colourway" / "Ivory" (the default), the presets, and any colour. */
  const capeColourRow = (key: "capeColor" | "capeLining", label: string, title: string, intro: string, def: { name: string; hex: () => string }) => {
    const sw = h("div.lo-hair-sw", { role: "radiogroup", "aria-label": label });
    const dot = h("span.lo-hair-dot", { "aria-hidden": "true" });
    let dialog: HTMLDialogElement | null = null;
    const set = (hex: string | null) => ((capeDraft = null), m.setCape({ [key]: hex }), drawCape(), apply());
    const custom = h("button.btn.btn-sm.lo-hair-custom", { type: "button", "aria-haspopup": "dialog", onclick: () => {
      if (dialog) return dialog.focus();
      dialog = glowColorPicker({
        title,
        intro,
        current: (capeHexOf(choice()[key]) ?? def.hex()) as `#${string}`,
        preview: (hex) => ((capeDraft = { [key]: hex }), apply()),
        apply: (hex) => set(capeHexOf(hex)),
        closed: () => ((dialog = null), (capeDraft = null), apply()),
      });
    } }, dot, "Custom…");
    const row = h(`div.lo-model-row.lo-hair-row.lo-cape-row`, null, h("span.lo-model-label", null, label), sw, custom);
    arrowNav(sw, "button");
    const draw = () => {
      const cur = capeHexOf(choice()[key]);
      const options: { name: string; hex: string; value: string | null }[] = [{ name: def.name, hex: def.hex(), value: null }, ...CAPE_PRESETS.map((p) => ({ ...p, value: p.hex }))];
      const preset = options.some((o) => o.value === cur);
      sw.replaceChildren(...options.map((o) => {
        const on = o.value === cur;
        return h(`button.lo-hair-swatch${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), "aria-label": o.name, title: o.name, tabindex: on || (!preset && o.value === null) ? "0" : "-1", style: `--sw:${o.hex}`,
          onmouseenter: () => ((capeDraft = { [key]: o.value }), apply()), onmouseleave: () => ((capeDraft = null), apply()),
          onclick: () => set(o.value),
        });
      }));
      dot.style.setProperty("--sw", cur ?? def.hex());
      custom.classList.toggle("on", !preset);
      custom.title = preset ? "Choose any colour" : `Custom colour ${cur!.toUpperCase()}`;
    };
    return { row, draw };
  };
  const accentHex = () => `#${colourway(shownChoice().outfit).accent.toString(16).padStart(6, "0")}`;
  const capeOuter = capeColourRow("capeColor", "Colour", "Cape colour", "Choose a colour for the outside of your cape.", { name: "Colourway", hex: accentHex });
  const capeLining = capeColourRow("capeLining", "Lining", "Cape lining", "Choose a colour for your cape's lining and trim.", { name: "Ivory", hex: () => CAPE_LINING_DEFAULT });
  function drawCape(): void {
    const show = capeShown();
    for (const row of [capeLengthRow, capeOuter.row, capeLining.row]) reserveRow(row, show, show);
    if (!show) return;
    const n = capeDraft?.capeLength ?? capeLengthOf(choice().capeLength) ?? CAPE_LENGTH.default;
    capeLengthInput.value = String(n);
    capeLengthInput.style.setProperty("--p", String((n - CAPE_LENGTH.min) / (CAPE_LENGTH.max - CAPE_LENGTH.min)));
    capeLengthValue.textContent = `${n}%`;
    capeOuter.draw();
    capeLining.draw();
  }
  // The Robe (Back tab): open or tied, its pattern and its two colours, shown like the Cape's rows. Pointing at a
  // choice shows it on the stage; choosing saves.
  const robeShown = (): boolean => {
    const c = cosmetic(ROBE_ITEM);
    return slot === "back" && shownChoice().back === ROBE_ITEM && !!c && m.owns(c);
  };
  const robeSeg = <K extends "robeTied" | "robePattern">(label: string, key: K, opts: [RobeChoice[K], string][]) => {
    const seg = h("div.seg.lo-poolseg", { role: "radiogroup", "aria-label": label });
    const row = h("div.lo-model-row.lo-hair-row.lo-cape-row", null, h("span.lo-model-label", null, label), seg);
    arrowNav(seg, "button");
    const draw = () => {
      const cur = choice()[key] ?? null;
      seg.replaceChildren(...opts.map(([v, text]) => {
        const on = (v ?? null) === cur;
        return h(`button${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1",
          onmouseenter: () => ((capeDraft = { [key]: v }), apply()), onmouseleave: () => ((capeDraft = null), apply()),
          onclick: () => ((capeDraft = null), m.setCape({ [key]: v }), drawRobe(), apply()),
        }, text);
      }));
    };
    return { row, draw };
  };
  const robeWear = robeSeg("Wear", "robeTied", [[null, "Open"], [true, "Tied"]]);
  const robePattern = robeSeg("Pattern", "robePattern", ROBE_PATTERNS.map((name, i): [number | null, string] => [i || null, name]));
  const robeColourRow = (key: "robeColor" | "robePrint", label: string, title: string, intro: string, def: () => string) => {
    const sw = h("div.lo-hair-sw", { role: "radiogroup", "aria-label": label });
    const dot = h("span.lo-hair-dot", { "aria-hidden": "true" });
    let dialog: HTMLDialogElement | null = null;
    const set = (hex: string | null) => ((capeDraft = null), m.setCape({ [key]: hex }), drawRobe(), apply());
    const custom = h("button.btn.btn-sm.lo-hair-custom", { type: "button", "aria-haspopup": "dialog", onclick: () => {
      if (dialog) return dialog.focus();
      dialog = glowColorPicker({
        title,
        intro,
        current: (capeHexOf(choice()[key]) ?? def()) as `#${string}`,
        preview: (hex) => ((capeDraft = { [key]: hex }), apply()),
        apply: (hex) => set(capeHexOf(hex)),
        closed: () => ((dialog = null), (capeDraft = null), apply()),
      });
    } }, dot, "Custom…");
    const row = h("div.lo-model-row.lo-hair-row.lo-cape-row", null, h("span.lo-model-label", null, label), sw, custom);
    arrowNav(sw, "button");
    const draw = () => {
      const cur = capeHexOf(choice()[key]);
      const options: { name: string; hex: string; value: string | null }[] = [{ name: "Colourway", hex: def(), value: null }, ...CAPE_PRESETS.map((p) => ({ ...p, value: p.hex }))];
      const preset = options.some((o) => o.value === cur);
      sw.replaceChildren(...options.map((o) => {
        const on = o.value === cur;
        return h(`button.lo-hair-swatch${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), "aria-label": o.name, title: o.name, tabindex: on || (!preset && o.value === null) ? "0" : "-1", style: `--sw:${o.hex}`,
          onmouseenter: () => ((capeDraft = { [key]: o.value }), apply()), onmouseleave: () => ((capeDraft = null), apply()),
          onclick: () => set(o.value),
        });
      }));
      dot.style.setProperty("--sw", cur ?? def());
      custom.classList.toggle("on", !preset);
      custom.title = preset ? "Choose any colour" : `Custom colour ${cur!.toUpperCase()}`;
    };
    return { row, draw };
  };
  const pantsHex = () => `#${colourway(shownChoice().outfit).pants.toString(16).padStart(6, "0")}`;
  const robeCloth = robeColourRow("robeColor", "Colour", "Robe colour", "Choose a colour for your robe.", pantsHex);
  const robePrint = robeColourRow("robePrint", "Pattern colour", "Pattern colour", "Choose a colour for the pattern and the collar.", accentHex);
  function drawRobe(): void {
    const show = robeShown();
    for (const r of [robeWear, robePattern, robeCloth, robePrint]) reserveRow(r.row, show, show);
    if (!show) return;
    for (const r of [robeWear, robePattern, robeCloth, robePrint]) r.draw();
  }
  // Knife pool (Knife and Finish tabs): knives with their finishes the game swaps between, each map or each restart, in
  // order or at random (player/cosmetics.ts). "Add" puts the knife and finish on the stage in it; a chip equips its
  // pair, its × takes it out.
  const poolList = h("div.lo-pool-list", { role: "list", "aria-label": "Knife pool" });
  const poolAdd = h("button.btn.btn-sm.lo-pool-add", { type: "button", onclick: () => {
    const c = shownChoice();
    const p = m.knifePool() ?? emptyPool();
    const pair = { knife: c.knife ?? DEFAULT_COSMETICS.knife!, finish: c.finish ?? DEFAULT_COSMETICS.finish! };
    if (p.items.length >= KNIFE_POOL_MAX || p.items.some((x) => x.knife === pair.knife && x.finish === pair.finish)) return;
    // The first add also keeps what you hold now, so one click makes a pool of two.
    const cur = choice();
    const first = !p.items.length && (cur.knife !== pair.knife || cur.finish !== pair.finish) ? [{ knife: cur.knife ?? DEFAULT_COSMETICS.knife!, finish: cur.finish ?? DEFAULT_COSMETICS.finish! }] : [];
    m.setKnifePool({ ...p, items: [...p.items, ...first, pair] });
    uiSound("ui_press");
    drawPool();
  } }, "Add to pool");
  const poolSeg = (label: string, key: "swap" | "order", opts: [string, string][]) => {
    const seg = h("div.seg.lo-poolseg", { role: "radiogroup", "aria-label": label });
    return { seg, draw(p: KnifePool) {
      seg.replaceChildren(...opts.map(([v, text]) => {
        const on = p[key] === v;
        return h(`button${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), onclick: () => { m.setKnifePool({ ...p, [key]: v }); drawPool(); } }, text);
      }));
    } };
  };
  const swapSeg = poolSeg("Swap", "swap", [["map", "Each map"], ["restart", "Each restart"]]);
  const orderSeg = poolSeg("Order", "order", [["order", "In order"], ["random", "Random"]]);
  const poolHint = h("span.lo-model-note");
  const poolRow = h("div.lo-model-row.lo-pool-row", null, h("span.lo-model-label", null, "Knife pool"), poolList, poolAdd, swapSeg.seg, orderSeg.seg, poolHint);
  function drawPool(): void {
    poolRow.hidden = !!o.previewOnly || (slot !== "knife" && slot !== "finish");
    if (poolRow.hidden) return;
    const p = m.knifePool() ?? emptyPool();
    const c = shownChoice();
    const inPool = p.items.some((x) => x.knife === c.knife && x.finish === c.finish);
    poolAdd.disabled = inPool || p.items.length >= KNIFE_POOL_MAX || !m.owns(cosmetic(c.knife) ?? cosmetic(DEFAULT_COSMETICS.knife)!) || !m.owns(cosmetic(c.finish) ?? cosmetic(DEFAULT_COSMETICS.finish)!);
    poolAdd.title = inPool ? "Already in the pool" : p.items.length >= KNIFE_POOL_MAX ? `The pool holds ${KNIFE_POOL_MAX}` : "Add the knife and finish shown";
    const cur = choice();
    poolList.replaceChildren(...p.items.map((it, i) => {
      const k = cosmetic(it.knife), f = cosmetic(it.finish);
      const plain = it.finish === DEFAULT_COSMETICS.finish;
      const name = `${k?.name ?? it.knife}${plain ? "" : ` · ${f?.name ?? it.finish}`}`;
      const worn = cur.knife === it.knife && cur.finish === it.finish;
      return h(`span.lo-pool-chip${worn ? ".on" : ""}`, { role: "listitem", style: `--sw:${f && !plain ? f.color : k?.color ?? "#ff7a1a"}` },
        h("button.lo-pool-pick", { type: "button", title: `Equip ${name}`, onclick: () => { m.equip("knife", it.knife); m.equip("finish", it.finish); drawPool(); apply(); } }, h("span.lo-pool-dot", { "aria-hidden": "true" }), name),
        h("button.lo-pool-x", { type: "button", "aria-label": `Take ${name} out of the pool`, title: "Take out", onclick: () => { m.setKnifePool({ ...p, items: p.items.filter((_, j) => j !== i) }); drawPool(); } }, "×"));
    }));
    const active = p.items.length >= 2;
    swapSeg.seg.hidden = orderSeg.seg.hidden = !active;
    if (active) (swapSeg.draw(p), orderSeg.draw(p));
    poolHint.textContent = active ? "" : p.items.length ? "Add one more to swap between them" : "Swap between knives each map or restart";
  }
  // The category's own options (player model, hair, ponytail length, knife pool) sit over the grid, beside the stage,
  // so the stage keeps its place and size on every tab (they used to push it down on Hat, Knife and Finish).
  const root = h("section.lo", { "aria-label": "Loadout" }, h("div.lo-head", null, tabs, clearIndicators, status), h("div.lo-body", null, stageHost, h("div.lo-side", null, bodyRow, poolRow, grid, glowPane, hairRow, hiRow, lengthRow, maskRow, capeLengthRow, capeOuter.row, capeLining.row, robeWear.row, robePattern.row, robeCloth.row, robePrint.row)));

  function drawTabs(): void {
    clearIndicators.disabled = !COSMETICS.some((c) => isLoadoutCategory(c.slot) && m.owns(c) && m.isNew(c.id));
    drawBody();
    drawHair();
    drawHighlight();
    drawLength();
    drawMask();
    drawCape();
    drawRobe();
    drawPool();
    tabs.replaceChildren(
      ...cats.map((s) => {
        const fresh = s !== slot && listed(s).some((c) => m.isNew(c.id));
        // How many of the category you own (an account's; offline everything listed is free or locked the same way).
        const items = listed(s);
        const own = items.filter((c) => m.owns(c)).length;
        const count = m.userId && s !== "hat" && !o.previewOnly ? h("small", { title: `${own} of ${items.length} owned` }, `${own}/${items.length}`) : null;
        const on = s === slot && !glowTab;
        return h(
          `button.lo-tab${on ? ".on" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-slot": s, onclick: () => select(s) },
          NAME[s],
          count,
          fresh ? h("span.pf-new-dot", { role: "img", "aria-label": "new" }) : null,
        );
      }),
      o.glow
        ? h(`button.lo-tab${glowTab ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(glowTab), tabindex: glowTab ? "0" : "-1", "data-slot": "glow", onclick: () => selectGlow() }, "Player glow")
        : "",
    );
  }
  tabs.addEventListener("keydown", (e) => {
    const j = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!j) return;
    e.preventDefault();
    stepTab(j, true);
  });

  let statusTimer = 0;
  function drawStatus(): void {
    const s = m.status();
    status.className = `lo-status ${s.kind}`;
    status.replaceChildren(s.kind === "saved" ? h("span.lo-status-ok", { html: CHECK_SVG }) : "", s.kind === "idle" ? "" : s.text);
    clearTimeout(statusTimer);
    if (s.kind === "saved") statusTimer = window.setTimeout(() => status.classList.add("fade"), 2200);
  }

  // --- tiles
  interface TileRef {
    /** null: the "No hat" tile. */
    c: CosmeticDef | null;
    id: string;
    el: HTMLButtonElement;
    thumb: HTMLElement;
    canvas: HTMLCanvasElement;
    key: string;
  }
  let tiles: TileRef[] = [];

  /** The thumbnail a tile shows: knife / finish / gloves on your equipped loadout, the item's model for the rest. */
  function thumbJob(c: CosmeticDef): ThumbJob | null {
    const outfit = choice().outfit ?? getOutfit();
    if (slot === "knife" || slot === "finish" || slot === "hilt" || slot === "glove") {
      const l = loadoutFor({ ...choice(), [slot]: c.id });
      if (slot === "glove") return { key: `g|${packLoadout(l)}|${outfit}|${prefs.get().viewmodel.hand}`, kind: "glove", loadout: l };
      // (The Hilt tab frames the tiles on the hilt; the knife and finish tabs show the whole knife.)
      if (slot === "hilt") return { key: `h|${l.knife}|${l.finish}|${l.hilt ?? ""}|${outfit}`, kind: "knife", knife: l.knife, loadout: l, focus: "hilt" };
      return { key: `k|${l.knife}|${l.finish}|${l.hilt ?? ""}|${outfit}`, kind: "knife", knife: l.knife, loadout: l };
    }
    const tc = cosmetic(choice().trail);
    const spec = previewOf({ cosmetic: c }, { outfit, body: choice().body, trail: tc?.color ? { color: tc.color, color2: tc.color2 } : null, shape: choice().shape });
    // The Cape's tile shows yours: its length and colours.
    if (spec && c.id === CAPE_ITEM && m.owns(c)) {
      const ch = choice();
      const cape = { length: capeLengthOf(ch.capeLength), color: capeHexOf(ch.capeColor), lining: capeHexOf(ch.capeLining) };
      if (cape.length || cape.color || cape.lining) return { key: `i|${spec.key}|${cape.length ?? ""}|${cape.color ?? ""}|${cape.lining ?? ""}`, kind: "item", spec: { ...spec, cape } };
    }
    // The Robe's tile shows yours too: its pattern, colours and whether it is tied.
    if (spec && c.id === ROBE_ITEM && m.owns(c)) {
      const ch = choice();
      const robe = { pattern: robePatternOf(ch.robePattern), tied: ch.robeTied === true, color: capeHexOf(ch.robeColor), print: capeHexOf(ch.robePrint) };
      if (robe.pattern || robe.tied || robe.color || robe.print) return { key: `i|${spec.key}|${robe.pattern ?? ""}|${robe.tied ? "t" : ""}|${robe.color ?? ""}|${robe.print ?? ""}`, kind: "item", spec: { ...spec, robe } };
    }
    if (spec && veiled(c)) return { key: `i|${spec.key}|veil`, kind: "item", spec: { ...spec, veil: true } };
    return spec ? { key: `i|${spec.key}`, kind: "item", spec } : null;
  }

  function paintThumb(t: TileRef, src: HTMLCanvasElement): void {
    // A software canvas: painted with the grid like an image. (An accelerated one is a compositor layer of its own: a
    // grid of them, some filtered when locked, made every scroll frame recomposite dozens of layers.) The stage's
    // cached thumbnail is one already (loadout-stage.ts runJob): it goes into the tile as it is, instead of a copy into
    // a new canvas per tile every time a category is drawn. (Copied only if another tile on screen shows it.)
    if (src !== t.canvas && !src.isConnected) {
      src.setAttribute("aria-hidden", "true");
      t.canvas.replaceWith(src);
      t.canvas = src;
    } else if (src !== t.canvas) {
      const ctx = t.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      ctx.drawImage(src, 0, 0, t.canvas.width, t.canvas.height);
    }
    t.thumb.classList.add("ready");
  }

  /**
   * Tiles in or near the grid's view (a screen of grid either way): only their thumbnails are drawn, the rest as they're
   * scrolled to (and any already drawn or stored come at once). Every tile drawn on open cost a model build, a GPU
   * readback and often a new shader for tiles nobody had scrolled to: on SwiftShader the Gun camo and Finish tabs took
   * 20-40 s of blocked main thread (research/PERF-LOADOUT-0.0.38.md).
   */
  const near = new Set<Element>();
  const nearIo = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (es) => {
          for (const e of es) e.isIntersecting ? near.add(e.target) : near.delete(e.target);
          requestThumbs();
        },
        { root: grid, rootMargin: "100% 0px" },
      )
    : null;

  function requestThumbs(): void {
    if (!stage) return;
    const keys = new Set<string>();
    for (const t of tiles) {
      const job = t.c ? thumbJob(t.c) : null;
      if (!job) continue;
      if (job.key === t.key) {
        keys.add(job.key);
        continue;
      }
      if (nearIo && !near.has(t.el)) {
        // Off screen: only what's at hand (drawn already this visit); stored or new ones once it's scrolled near.
        const hit = stage.cachedThumb(job.key);
        if (hit) (t.key = job.key), paintThumb(t, hit);
        continue;
      }
      keys.add(job.key);
      t.key = job.key;
      stage.requestThumb(job, (src) => t.key === job.key && paintThumb(t, src));
    }
    stage.cancelThumbs((k) => keys.has(k));
  }

  const owned = (t: TileRef) => !t.c || m.owns(t.c);
  function tileState(t: TileRef): void {
    const on = (choice()[slot] ?? "") === t.id;
    t.el.classList.toggle("on", on);
    t.el.classList.toggle("locked", !owned(t));
    t.el.setAttribute("aria-pressed", String(on));
    const lock = owned(t) || !t.c ? null : m.lock(t.c);
    t.el.setAttribute("aria-label", `${nameOf(t.c) ?? noneLabel(slot)}${on ? ", equipped" : ""}${lock ? `, locked: ${lock.goal}` : ""}`);
  }

  /** Swatch under the thumbnail (also what shows without WebGL). */
  function swatch(c: CosmeticDef | null): HTMLElement {
    if (slot === "knife" || slot === "finish" || slot === "hilt" || slot === "glove") return loadoutSwatch(c, slot);
    if (!c) return h("span.pf-sw.lo-sw-none", { "aria-hidden": "true" });
    return h("span.pf-sw.lo-sw-dot", { "aria-hidden": "true", style: `--sw:${c.color ?? "#888"}` });
  }

  function makeTile(c: CosmeticDef | null, group?: string): TileRef {
    const lock = c && !m.owns(c) ? m.lock(c) : null;
    const canvas = h("canvas", { width: 384, height: 240, "aria-hidden": "true" }) as HTMLCanvasElement;
    const thumb = h(`span.lo-thumb${veiled(c) ? ".lo-veiled" : ""}`, null, veiled(c) ? h("span.pf-sw.lo-sw-none", { "aria-hidden": "true" }) : swatch(c), canvas, h("span.lo-on", { html: CHECK_SVG, "aria-hidden": "true" }));
    // The line under the name: how to get a locked item, or in the Supporter and Staff sections the item's set
    // ("Geode"), unless that is the item's own name (the Geode colourway read "Geode / Geode"). An item you own says
    // nothing more: no rarity anywhere (owner 11-12).
    const sub = lock
      ? h("span.lo-sub.lo-lock", { title: lock.hint }, h("span.lo-lock-i", { html: LOCK_SVG }), goalText(c, group ?? lock.goal, true))
      : group && group !== nameOf(c)
        ? h("span.lo-sub", null, group)
        : null;
    const id = c?.id ?? "";
    const el = h(
      "button.lo-tile",
      { type: "button", "data-id": id, "data-sound": "none", onclick: () => choose(t) },
      thumb,
      h("span.lo-name", null, h("span", null, nameOf(c) ?? noneLabel(slot)), c && m.isNew(c.id) ? h("span.pf-new-dot", { role: "img", "aria-label": "new" }) : null),
      sub,
      lock && lock.fraction !== null ? h("span.lo-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : null,
    ) as HTMLButtonElement;
    const t: TileRef = { c, id, el, thumb, canvas, key: "" };
    tileState(t);
    nearIo?.observe(el);
    return t;
  }

  function drawGrid(): void {
    const items = listed(slot);
    const lockOf = (c: CosmeticDef) => m.lock(c).fraction ?? 0;
    const mine = items.filter((c) => m.owns(c));
    // Locked: nearest first, a secret one last.
    const locked = items.filter((c) => !m.owns(c)).sort((a, b) => Number(veiled(a)) - Number(veiled(b)) || lockOf(b) - lockOf(a));
    const ordered = [...mine, ...locked];
    // Four sections: what's earned by playing (yours first, then the nearest goals), then every Supporter item under
    // one heading, set by set (the sets in their order, then the ones in no set), then the Contributor sets (shown to
    // everyone), then the staff sets you hold (no one else ever sees those: shownCosmetic).
    const sections = loadoutSections(ordered);
    const headed = !o.only;
    const els: HTMLElement[] = [];
    for (const t of tiles) nearIo?.unobserve(t.el);
    near.clear();
    tiles = [];
    const add = (c: CosmeticDef | null, group?: string) => {
      const t = makeTile(c, group);
      tiles.push(t);
      els.push(t.el);
    };
    if ((slot === "hat" || slot === "camo" || slot === "back" || slot === "hop") && !o.only) add(null);
    sections.earned.forEach((c) => add(c));
    if (sections.supporter.length) {
      const owner = sections.supporter.some((x) => m.owns(x.c));
      if (headed)
        els.push(h("h4.lo-set-h", null, h("span", null, "Supporter"), !owner && !o.previewOnly ? h("a.lo-set-link", { href: "/?support", onclick: (e: Event) => (e.preventDefault(), navigate({ screen: "support" })) }, `Support from $${SUPPORTER_MIN_USD}`) : ""));
      sections.supporter.forEach((x) => add(x.c, x.group));
    }
    if (sections.contributor.length) {
      const holder = sections.contributor.some((x) => m.owns(x.c));
      if (headed) els.push(h("h4.lo-set-h", null, h("span", null, "Contributor"), !holder && !o.previewOnly ? h("span.lo-set-note", null, "For players who worked on the game") : ""));
      sections.contributor.forEach((x) => add(x.c, x.group));
    }
    if (sections.staff.length) {
      if (headed) els.push(h("h4.lo-set-h", null, h("span", null, "Staff")));
      sections.staff.forEach((x) => add(x.c, x.group));
    }
    grid.replaceChildren(...els);
    grid.setAttribute("aria-label", NAME[slot]);
    grid.scrollTop = 0;
    requestThumbs();
    m.see(items.map((c) => c.id));
  }
  arrowNav(grid, ".lo-tile", { grid: true });

  function choose(t: TileRef): void {
    if (!owned(t)) {
      t.el.classList.remove("nope");
      void t.el.offsetWidth;
      t.el.classList.add("nope");
      uiSound("ui_error", 0.4);
      setPreview(t.id);
      return;
    }
    if ((choice()[slot] ?? "") === t.id) {
      uiSound("ui_press");
      stage?.flourish(slot);
      return;
    }
    // Rarer items chime higher; a knife also swings.
    uiSound("ui_confirm", 0.8, 1 + 0.08 * Math.max(0, (t.c?.rarity ?? 1) - 1));
    if (slot === "knife") sfx("carrot_swing", 0.35);
    preview = null;
    m.equip(slot, t.id || null);
    t.el.classList.remove("just");
    void t.el.offsetWidth;
    t.el.classList.add("just");
    window.setTimeout(() => t.el.classList.remove("just"), 900);
    apply();
    stage?.flourish(slot);
    equipPop();
  }

  // --- preview (hover / focus), batched to one update per frame
  function setPreview(id: string | null): void {
    clearTimeout(revertTimer);
    const next = id !== null && id !== (choice()[slot] ?? "") ? id : null;
    for (const t of tiles) t.el.classList.toggle("preview", next !== null && t.id === next);
    if (next === preview) return;
    preview = next;
    scrub(next ?? (choice()[slot] ?? ""));
    if (!applyRaf) applyRaf = requestAnimationFrame(apply);
  }
  function revertSoon(): void {
    clearTimeout(revertTimer);
    revertTimer = window.setTimeout(() => setPreview(null), 140);
  }
  const tileAt = (el: EventTarget | null) => (el instanceof Element ? (el.closest(".lo-tile") as HTMLElement | null) : null);
  grid.addEventListener("pointerover", (e) => {
    const el = tileAt(e.target);
    if (el) setPreview(el.dataset.id ?? null);
  });
  grid.addEventListener("pointerleave", revertSoon);
  grid.addEventListener("focusin", (e) => {
    const el = tileAt(e.target);
    if (el) setPreview(el.dataset.id ?? null);
  });
  grid.addEventListener("focusout", (e) => {
    if (!grid.contains(e.relatedTarget as Node | null)) revertSoon();
  });

  function apply(): void {
    applyRaf = 0;
    if (!hairDraft) drawHair();
    if (highlightDraft === null) drawHighlight();
    if (lengthDraft === null) drawLength();
    drawMask();
    if (!capeDraft) (drawCape(), drawRobe());
    drawPool();
    const c = shownChoice();
    stage?.display(loadoutOf(c), lookOf(c));
    drawCaption(c);
  }

  function drawCaption(c: LoadoutChoice): void {
    if (glowTab) {
      capName.replaceChildren(h("span", null, "Player glow"));
      capMeta.replaceChildren();
      capHow.hidden = true;
      capState.className = "lo-cap-state";
      capState.replaceChildren();
      capState.parentElement?.querySelector(".lo-cap-cta")?.remove();
      stageHost.style.removeProperty("--rar");
      stageHost.dataset.rar = "0";
      stage?.tint(null, 0.35);
      return;
    }
    const hands = stageKind(slot) === "hands";
    const l0 = loadoutOf(c);
    const focus = cosmetic(preview !== null ? preview : c[slot]);
    if (hands) {
      const l = loadoutOf(c);
      capName.replaceChildren(h("span", null, cosmetic(l.knife)?.name ?? "Carrot Blade"), h("span.lo-cap-fin", null, cosmetic(l.finish)?.name ?? "Garden Fresh"));
    } else {
      capName.replaceChildren(h("span", null, nameOf(focus) ?? (EMPTYABLE.has(slot) ? noneLabel(slot) : "")), h("span.lo-cap-fin", null, KIND[slot]));
    }
    capMeta.replaceChildren(
      hands && l0.hilt ? h("span.dim", null, `${cosmetic(l0.hilt)?.name ?? ""} hilt`) : "",
      hands ? h("span.dim", null, `${cosmetic(c.glove)?.name ?? "Knit"} gloves`) : "",
    );
    // How the item shown was earned (a locked one says how to get it in the state line instead).
    const how = focus && m.owns(focus) ? m.earned(focus) : "";
    capHow.hidden = !how;
    capHow.textContent = how;
    // What a click would do.
    const pc = preview ? cosmetic(preview) : null;
    capState.parentElement?.querySelector(".lo-cap-cta")?.remove();
    if (pc && !m.owns(pc)) {
      const lock = m.lock(pc);
      capState.className = "lo-cap-state locked";
      capState.replaceChildren(h("span.lo-lock-i", { html: LOCK_SVG }), goalText(pc, lock.hint), lock.fraction !== null ? h("span.lo-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : "");
      // A supporter item you're trying on: the way to get it, right under it (not on the Support page itself).
      if (supporterItem(pc) && !o.previewOnly)
        capState.after(
          h("button.btn.primary.btn-sm.lo-cap-cta", { type: "button", onclick: () => navigate({ screen: "support" }) }, `Support from $${SUPPORTER_MIN_USD}`),
        );
    } else if (preview !== null) {
      capState.className = "lo-cap-state";
      capState.replaceChildren(o.previewOnly ? "Click to try it on" : "Click to equip");
    } else if (o.previewOnly) {
      capState.className = "lo-cap-state";
      capState.replaceChildren();
    } else {
      capState.className = "lo-cap-state on";
      capState.replaceChildren(h("span.lo-status-ok", { html: CHECK_SVG }), "Equipped");
    }
  }

  function showGlowTab(on: boolean): void {
    if (on === glowTab) return;
    glowTab = on;
    root.classList.toggle("glow-tab", on);
    grid.hidden = on;
    if (glowPane) glowPane.hidden = !on;
    o.glow?.onShown(on);
  }

  function select(s: LoadoutCategory, focusTab = false): void {
    if (s === slot && !glowTab) return;
    showGlowTab(false);
    slot = lastSlot = s;
    preview = null;
    setView(viewFor(s));
    drawTabs();
    drawGrid();
    apply();
    if (focusTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus();
  }

  function selectGlow(focusTab = false): void {
    if (glowTab) return;
    showGlowTab(true);
    slot = "outfit";
    preview = null;
    setView(viewFor(slot));
    drawTabs();
    apply();
    if (focusTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus();
  }

  /** The next / previous tab, wrapping; the glow tab, when there is one, comes last. */
  function stepTab(by: number, focusTab = false): void {
    const n = cats.length + (o.glow ? 1 : 0);
    const i = (((glowTab ? cats.length : cats.indexOf(slot)) + by) % n + n) % n;
    if (i === cats.length) selectGlow(focusTab);
    else select(cats[i], focusTab);
  }

  // Q / E (gamepad LB / RB): previous / next category; the inspect key inspects (held: keeps a spin going).
  root.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (k !== "q" && k !== "e") return;
    e.preventDefault();
    stepTab(k === "e" ? 1 : -1);
    if (glowTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus();
    else (grid.querySelector<HTMLElement>(".lo-tile.on") ?? grid.querySelector<HTMLElement>(".lo-tile"))?.focus({ preventScroll: true });
  });
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return removeKeys();
    if (e.code !== inspectKey() || e.ctrlKey || e.metaKey || e.altKey || (stageKind(slot) !== "hands" && stageKind(slot) !== "guns")) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || root.closest("[inert]") || !root.offsetParent) return;
    if (e.type === "keydown") {
      e.preventDefault();
      if (!e.repeat) stage?.inspect();
      stage?.holdInspect(true);
    } else stage?.holdInspect(false);
  };
  const removeKeys = () => {
    removeEventListener("keydown", onKey, true);
    removeEventListener("keyup", onKey, true);
  };
  addEventListener("keydown", onKey, true);
  addEventListener("keyup", onKey, true);

  // --- the stage (WebGL, loaded on demand; without it the swatches and the caption still say it all)
  stageHost.classList.add("loading");
  void import("./loadout-stage").then(({ LoadoutStage }) => {
    // Built before being attached (the menu attaches a screen when its transition swaps, a few frames later): wait for
    // it, a few seconds at most (a view thrown away unattached is left alone).
    let frames = 0;
    const when = () => {
      if (root.isConnected) start(LoadoutStage);
      else if (++frames < 240) requestAnimationFrame(when);
    };
    when();
  });
  function start(Stage: typeof LoadoutStage): void {
    if (!root.isConnected || stage) return;
    try {
      const c = shownChoice();
      stage = Stage.acquire(stageHost, loadoutOf(c));
      if (import.meta.env.DEV) Object.assign(window, { __loStage: stage });
      stage.display(loadoutOf(c), lookOf(c));
      stage.setView(viewFor(slot));
      stage.onView = (v) => {
        if (v === "fp" || v === "close") lastHandsView = v;
        if (v === "gun" || v === "gunside") lastGunView = v;
        stageHost.dataset.view = v;
        drawViewSeg();
      };
      stageHost.classList.remove("loading");
      stageHost.classList.add("ready");
      apply();
      requestThumbs();
    } catch {
      stageHost.classList.remove("loading");
      stageHost.classList.add("failed");
    }
    drawViewSeg();
  }

  // --- model changes (an equip, a save, another device): tiles, tabs, status, stage
  const off = m.on(() => {
    if (!root.isConnected) return void (off(), nearIo?.disconnect());
    for (const t of tiles) tileState(t);
    drawTabs();
    drawStatus();
    requestThumbs();
    if (!applyRaf) applyRaf = requestAnimationFrame(apply);
  });

  drawViewSeg();
  drawTabs();
  drawGrid();
  drawStatus();
  apply();
  o.onReady?.({
    redraw: () => {
      preview = null;
      drawTabs();
      drawGrid();
      apply();
    },
  });
  // The glow being edited: redraw where you are. First-person views (knife, finish, gloves) show it on the hands now, the
  // others on the bunny, so the tab never changes under you.
  root.addEventListener("playerglowpreview", () => apply());
  return root;
}

/** Focuses the equipped item (keyboard / controller start here). */
export function focusEquipped(view: HTMLElement): void {
  (view.querySelector<HTMLElement>(".lo-tile.on") ?? view.querySelector<HTMLElement>(".lo-tile"))?.focus({ preventScroll: false });
}

