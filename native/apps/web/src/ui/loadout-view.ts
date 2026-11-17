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
import { medalCountsOf } from "../creators";
import { charmClamp, charmPlaces } from "../viewmodel/charms/places";
import { CHARM_LENGTH, CHARM_SIZE, CHARM_SWING, charmLengthOf, charmSizeOf, charmSwingOf, SUPPORTER_MIN_USD, CAPE_ITEM, CAPE_LENGTH, capeHexOf, capeLengthOf, heldMetals, MEDAL_ITEM, medalCode, medalMetalOf, medalOf, type MedalCounts, type MedalMetal, ROBE_ITEM, robePatternOf, COSMETICS, cosmetic, highlightHexOf, KNIFE_POOL_MAX, type KnifePool, crownOf, DEFAULT_COSMETICS, isUnlocked, secretCosmetic, supporterItem, type CosmeticDef } from "../progression";
import { colourway } from "../player/bunny/palettes";
import { ROBE_PATTERNS } from "../player/robe-names";
import { CAPE_LINING_DEFAULT, CAPE_PRESETS, HAIR_DEFAULT, HAIR_LENGTH, HAIR_PRESETS, HIGHLIGHT_PRESETS, hairColorOf, hairHex, hairLengthOf, loadoutFor, packLoadout, type CosmeticLoadout } from "../loadout";
import { glowColorPicker } from "./glow-color-picker";
import { getGhostCosmetics, getKnifePool, getLoadout, getOutfit, onGhostCosmetics, onHeldLoadout, onLoadout, onOutfit, setGhostCosmetics, setKnifePool, setLoadout, setOutfit } from "../player/cosmetics";
import { previewOf } from "../notify/item-preview";
import type { Loadout, NewTracker } from "./card-editor";
import { arrowNav, h } from "./dom";
import { scrollCue } from "./scroll-cue";
import type { LoadoutStage, StageLook, StageView, ThumbJob } from "./loadout-stage";
import { loadoutSwatch, shownCosmetic } from "./loadout-ui";
import { EMPTYABLE, isLoadoutCategory, LOADOUT_CATEGORIES, loadoutCategories, loadoutGroup, loadoutKind, loadoutOptions, loadoutSections, noneLabel, stageKind, type LoadoutCategory, type LoadoutOption } from "./cosmetic-slots";
import { keyLabel, prefs } from "./settings";
import { earnedLine, lockInfo, profileHolder, profileRanks, type LockInfo } from "./unlocks";
import { earnedHint } from "./unlock-text";
import { navigate } from "./nav";
import { sfx } from "../audio";
import { uiSound } from "../audio/ui";

export type LoadoutSlot = LoadoutCategory;
/** The Cape's settings (progression.ts CAPE_LENGTH, capeHexOf); null / absent = the defaults. */
export type CapeChoice = { capeLength?: number | null; capeColor?: string | null; capeLining?: string | null; medalMetal?: MedalMetal | null } & RobeChoice & CharmChoice;
/** The charm's options (progression.ts CHARM_*; set through setCape like the back items'); null / absent = the defaults. */
export type CharmChoice = { charmLength?: number | null; charmSize?: number | null; charmSwing?: number | null; charmPommel?: boolean | null };
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
  /** The daily medals the player holds (creators.ts medalCountsOf): the Daily Medal's metals and its face. Absent: none. */
  medals?: () => MedalCounts;
  /** The knife pool (progression.ts KnifePool; null = none). */
  knifePool(): KnifePool | null;
  setKnifePool(p: KnifePool | null): void;
  status(): { kind: "idle" | "saving" | "saved" | "error"; text: string };
  isNew(id: string): boolean;
  see(ids: string[]): void;
  clearIndicators(): void;
  on(fn: () => void): () => void;
}

/**
 * The choice from what is stored: every Loadout slot's item (cosmetic-slots.ts LOADOUT_CATEGORIES, so a new slot is
 * read with no line here; absent = the slot's default, or nothing for a slot that may be empty), the player model,
 * and the options of what is worn.
 */
const pick = (c: Record<string, unknown>): LoadoutChoice => ({
  ...(Object.fromEntries(LOADOUT_CATEGORIES.map(({ slot }) => [slot, (c[slot] as string | null | undefined) ?? DEFAULT_COSMETICS[slot]])) as Record<LoadoutCategory, string | null>),
  body: (c.body as string | null | undefined) ?? DEFAULT_COSMETICS.body,
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
  medalMetal: medalMetalOf(c.medalMetal),
  charmLength: charmLengthOf(c.charmLength),
  charmSize: charmSizeOf(c.charmSize),
  charmSwing: charmSwingOf(c.charmSwing),
  charmPommel: c.charmPommel === true ? true : null,
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
    medals: () => medalCountsOf(p.player.special),
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
/** The Hilt opens up close: in first person the fist is round it. (Its own memory, so Knife and Gloves keep theirs.) */
let lastHiltView: StageView = "close";
/** First person or side, for the Gun camo. */
let lastGunView: StageView = "gun";

const NAME: Record<LoadoutCategory, string> = Object.fromEntries(LOADOUT_CATEGORIES.map((c) => [c.slot, c.label])) as Record<LoadoutCategory, string>;

export interface LoadoutViewOpts {
  playerGlow?: () => import("../player/glow-config").PlayerGlow | null;
  /** A "Player glow" entry among the slots: this panel in place of the grid, your bunny on the stage. */
  glow?: { panel: HTMLElement; onShown: (on: boolean) => void };
  /** Open on this category, or on "glow" (the Player glow entry, with `glow`); else the last one used. */
  slot?: string | null;
  /**
   * The entry showing: told once when the view is made and again on every change (a click, Q / E, the arrows, the
   * host's own select()). A host that wants to know where the player is (the Support page's Open Loadout) listens
   * here instead of reading the list's marks off the DOM.
   */
  onSlot?: (slot: LoadoutCategory | "glow") => void;
  /** Only these items (the Support page: the supporter set). Categories with none are left out; no "No hat" tile. */
  only?: (c: CosmeticDef) => boolean;
  /** Nothing is equipped or saved (the Support page): a click shows the item, the state line says it's a preview. */
  previewOnly?: boolean;
  /**
   * Gets a redraw() for when `only` or the model's choice change from outside (the Support page dressing its preview),
   * a select() to show an entry from outside (a category listed here, or "glow"; anything else is ignored), and a
   * dispose() for a host that knows when it closes: it drops the view's window key listeners and its model
   * subscription at once. (Without it they go at the first key press or model change after the view left the page.)
   */
  onReady?: (view: LoadoutViewHandle) => void;
}

export interface LoadoutViewHandle {
  redraw(): void;
  select(slot: string): void;
  dispose(): void;
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
  /** The medals held, when there are any (with none the Daily Medal is only being looked at: drawn at its plainest). */
  const medals = (): MedalCounts | null => {
    const held = m.medals?.();
    return held && heldMetals(held).length ? held : null;
  };
  const loadoutOf = (c: LoadoutChoice): CosmeticLoadout => loadoutFor(c, m.crown(), medals());
  /**
   * The glow on the stage: the one being edited (the Player glow tab, the Support page: shown whatever the settings
   * say, it's a preview), else the player's own as the game shows it (their saved glow, under the Player glow /
   * First-person glow settings) on every other tab too: the bunny on Colourway and Hat, the hands on Knife, Finish and
   * Gloves. Thumbnails never show one.
   */
  const lookOf = (c: LoadoutChoice): StageLook => {
    const editing = o.playerGlow?.() ?? null;
    return { playerGlow: editing ?? m.playerGlow?.() ?? null, previewGlow: !!editing, outfit: c.outfit, ghost: c.ghost, trail: c.trail, shape: c.shape, veil: veiled(cosmetic(c.outfit)) || veiled(cosmetic(c.back)), facing: slot === "back" && c.back !== MEDAL_ITEM ? "back" : "front", focus: slot === "hat" && !glowTab ? "head" : "body", charm: slot === "charm" && !glowTab };
  };
  /** The charm hangs from the knife in your hand: the knife alone on its turntable (the close-up) has none. */
  const fpOnly = (s: LoadoutCategory): boolean => s === "charm";
  const viewFor = (s: LoadoutCategory): StageView => (fpOnly(s) ? "fp" : stageKind(s) === "hands" ? (s === "hilt" ? lastHiltView : lastHandsView) : stageKind(s) === "guns" ? lastGunView : stageKind(s) === "bunny" ? "bunny" : s === "hop" ? "hop" : "ghost");
  /** The stage's view was chosen (its toggle, an inspect): remembered for the slot's kind. */
  const keepView = (v: StageView): void => {
    if (fpOnly(slot)) return;
    if (v === "fp" || v === "close") slot === "hilt" ? (lastHiltView = v) : (lastHandsView = v);
    if (v === "gun" || v === "gunside") lastGunView = v;
  };

  // --- stage
  // The caption's lines are made once and keep their order: the name, what it is, (the hands: hilt and gloves), what a
  // click would do, then how it was earned. The earned line comes and goes with the item under the pointer; it is last
  // so nothing under it moves (it sat above the state line, which jumped a line on every other tile).
  const capTitle = h("span");
  const capKind = h("span.lo-cap-fin");
  const capName = h("h3.lo-cap-name", null, capTitle, capKind);
  const capHilt = h("span.dim");
  const capGlove = h("span.dim");
  const capMeta = h("p.lo-cap-meta", { hidden: true }, capHilt, capGlove);
  const capState = h("p.lo-cap-state", { "aria-live": "polite" });
  const capHow = h("p.lo-cap-how", { hidden: true });
  // A supporter item you're trying on: the way to get it, right under it (not on the Support page itself).
  const capCta = h("button.btn.primary.btn-sm.lo-cap-cta", { type: "button", hidden: true, onclick: () => navigate({ screen: "support" }) }, `Support from $${SUPPORTER_MIN_USD}`);
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
    h("div.lo-cap", null, capName, capMeta, capState, capHow, capCta),
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
    viewSeg.hidden = (kind !== "hands" && kind !== "guns") || fpOnly(slot);
    drawGunNav();
    if (viewSeg.hidden) return viewSeg.replaceChildren();
    const cur = stage?.view ?? viewFor(slot);
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
    keepView(v);
    stageHost.dataset.view = v;
    stageHost.dataset.kind = stageKind(slot);
    stage?.setView(v);
    drawViewSeg();
  }

  // --- the slots: a list down the left (like Settings' sections), or a row across the top where there's no room for
  // one; the grid beside the stage; the worn item's options under the grid. The same on the profile and on the
  // Support page (loadout-view.css lays it out by the view's own width).
  const tabs = h("div.lo-tabs", { role: "tablist", "aria-label": "Loadout" });
  // The row scrolls when it can't hold every slot, and the list when the window is short: the edge with more fades.
  scrollCue(tabs, "x");
  scrollCue(tabs, "y");
  const status = h("span.lo-status", { role: "status", "aria-live": "polite" });
  const clearIndicators = h("button.link-btn.lo-clear", { type: "button", onclick: () => m.clearIndicators() }, "Mark all seen");
  clearIndicators.hidden = !!o.previewOnly;
  const grid = h("div.lo-grid", { role: "group" });
  const glowPane = o.glow ? h("div.lo-glow-pane", { hidden: true }, o.glow.panel) : null;

  // The slots are built once and then only marked (which is selected, how many you own, the "new" dot): rebuilt on
  // every equip and every save, the whole row was replaced under the pointer and a focused slot lost its focus.
  type Entry = LoadoutCategory | "glow";
  interface TabRef {
    slot: Entry;
    el: HTMLButtonElement;
    count: HTMLElement | null;
    dot: HTMLElement;
  }
  /** The entries in order: the Player glow, when there is one, comes after the bunny's own slots. */
  const order: Entry[] = [...cats];
  if (o.glow) order.splice(Math.max(...cats.map((s, i) => (loadoutGroup(s) === "bunny" ? i : -1))) + 1 || order.length, 0, "glow");
  const tabRefs: TabRef[] = order.map((s, i) => {
    const group = s === "glow" ? "bunny" : loadoutGroup(s);
    const prev = order[i - 1];
    const gap = i > 0 && (prev === "glow" ? "bunny" : loadoutGroup(prev)) !== group;
    // How many of the category you own (an account's; offline everything listed is free or locked the same way).
    const count = s !== "glow" && m.userId && s !== "hat" && !o.previewOnly ? h("small") : null;
    const dot = h("span.pf-new-dot", { role: "img", "aria-label": "new", hidden: true });
    const el = h(
      `button.lo-tab${gap ? ".lo-tab-gap" : ""}`,
      // (Heading for Gun camo: its stage is built before the click: loadout-stage.ts warmGuns.)
      { type: "button", role: "tab", "data-slot": s, "data-group": group, onclick: () => (s === "glow" ? selectGlow() : select(s)), onpointerenter: s === "camo" ? () => stage?.warmGuns(true) : null, onfocus: s === "camo" ? () => stage?.warmGuns(true) : null },
      h("span.lo-tab-name", null, s === "glow" ? "Player glow" : NAME[s]),
      count,
      dot,
    ) as HTMLButtonElement;
    return { slot: s, el, count, dot };
  });
  tabs.append(...tabRefs.map((t) => t.el));
  /** The slots run down the side (not across the top): which arrows walk them. */
  const railed = () => getComputedStyle(tabs).flexDirection === "column";
  function syncTabs(): void {
    clearIndicators.disabled = !COSMETICS.some((c) => isLoadoutCategory(c.slot) && m.owns(c) && m.isNew(c.id));
    for (const t of tabRefs) {
      const on = t.slot === "glow" ? glowTab : t.slot === slot && !glowTab;
      t.el.classList.toggle("on", on);
      setAttr(t.el, "aria-selected", String(on));
      if (t.el.tabIndex !== (on ? 0 : -1)) t.el.tabIndex = on ? 0 : -1;
      if (t.slot === "glow") continue;
      const items = listed(t.slot);
      if (t.count) {
        const own = items.filter((c) => m.owns(c)).length;
        const text = `${own}/${items.length}`;
        if (t.count.textContent !== text) (t.count.textContent = text), (t.count.title = `${own} of ${items.length} owned`);
      }
      t.dot.hidden = t.slot === slot || !items.some((c) => m.isNew(c.id));
    }
  }
  /** Scrolls the slots (only them, never the page) so the selected one shows: Q / E could select one out of view. */
  function showTab(): void {
    const el = tabRefs.find((t) => t.el.classList.contains("on"))?.el;
    if (!el || !tabs.isConnected) return;
    tabs.setAttribute("aria-orientation", railed() ? "vertical" : "horizontal");
    const r = tabs.getBoundingClientRect(), b = el.getBoundingClientRect();
    const pad = 28;
    if (b.left < r.left) tabs.scrollLeft -= r.left - b.left + pad;
    else if (b.right > r.right) tabs.scrollLeft += b.right - r.right + pad;
    if (b.top < r.top) tabs.scrollTop -= r.top - b.top + pad;
    else if (b.bottom > r.bottom) tabs.scrollTop += b.bottom - r.bottom + pad;
  }
  tabs.addEventListener("keydown", (e) => {
    const side = railed();
    const j = e.key === (side ? "ArrowDown" : "ArrowRight") ? 1 : e.key === (side ? "ArrowUp" : "ArrowLeft") ? -1 : 0;
    if (j) {
      // Up from the first slot of the list leaves it (the profile's tabs are above: ui/profile.ts walks there).
      if (side && j < 0 && (glowTab ? order.indexOf("glow") : order.indexOf(slot)) === 0) return;
      e.preventDefault();
      stepTab(j, true);
    } else if (side && e.key === "ArrowRight" && !glowTab) {
      // From the list into the grid, on what you wear.
      e.preventDefault();
      (grid.querySelector<HTMLElement>(".lo-tile.on") ?? grid.querySelector<HTMLElement>(".lo-tile"))?.focus({ preventScroll: true });
    }
  });

  // --- options: the slot's own (player model, knife pool) and the worn item's (a wig's colours, the Cape's and the
  // Robe's settings), in one block under the grid.
  //
  // They follow what you WEAR, never the tile under the pointer. Rows that came and went with the hover took their
  // height out of the grid: with the Robe's four rows that covered the hovered tile itself, the pointer was then on a
  // row, the preview went back, the rows left, the tile was under the pointer again: the stage flipped between two
  // items for as long as the pointer stayed (the 10-29 jitter again, by another road). An owned item's rows could not
  // be reached from its tile anyway (leaving the tile ends the preview).
  //
  // Each row is built once and then only marked: a swatch keeps the pointer and the keyboard focus through a hover
  // (they were replaced on every hover, which dropped the focus to the page after a click).
  // Which rows show is cosmetic-slots.ts loadoutOptions (tested: apps/web/test/loadout-options.test.ts). A row is
  // made the first time it shows (most visits never open the Robe's four): the screen opens with none of them built.
  interface OptRow {
    el: HTMLElement;
    draw: () => void;
  }
  const rows: { id: LoadoutOption; make: () => OptRow; built?: OptRow }[] = [];
  const optRow = (cls: string, label: string, control: HTMLElement, id: LoadoutOption, draw: () => void): OptRow => ({
    el: h(`div.lo-model-row${cls}`, { hidden: true, "data-opt": id }, h("span.lo-model-label", null, label), control),
    draw,
  });
  /** A segmented choice. `arrows`: the arrow keys choose (a two-way switch) or only move the focus. */
  function segRow<T>(cls: string, segCls: string, label: string, choices: readonly (readonly [T, string, string?])[], a: { id: LoadoutOption; cur: () => T; pick: (v: T) => void; try?: (v: T | undefined) => void; arrows?: "pick"; disabled?: () => boolean }): void {
    rows.push({ id: a.id, make: () => {
      const seg = h(`div.seg${segCls}`, { role: "radiogroup", "aria-label": label });
      const btns = choices.map(([v, text, aria]) =>
        h("button", { type: "button", role: "radio", "aria-label": aria ?? null, onclick: () => a.pick(v), onmouseenter: a.try ? () => a.try!(v) : null, onmouseleave: a.try ? () => a.try!(undefined) : null }, text) as HTMLButtonElement,
      );
      seg.append(...btns);
      if (a.arrows === "pick")
        seg.addEventListener("keydown", (e) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || a.disabled?.()) return;
          e.preventDefault();
          const i = choices.findIndex(([v]) => v === a.cur());
          const j = (i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
          a.pick(choices[j][0]);
          btns[j].focus();
        });
      else arrowNav(seg, "button");
      return optRow(cls, label, seg, a.id, () => {
        const cur = a.cur();
        const off = !!a.disabled?.();
        choices.forEach(([v], i) => {
          const on = v === cur;
          btns[i].classList.toggle("on", on);
          btns[i].setAttribute("aria-checked", String(on));
          btns[i].tabIndex = on ? 0 : -1;
          btns[i].disabled = off;
        });
      });
    } });
  }
  interface Swatch {
    name: string;
    /** The colour shown ("" for "None": an empty ring). */
    hex: () => string;
    /** What choosing it stores. */
    value: string | null;
  }
  /**
   * A row of colours: the presets, then any colour (the picker dialog). `cur`: the stored colour (an option's value,
   * else a custom one). `tryOn`: the pointer is on a colour (shown on the stage), or off them (undefined).
   */
  function swatchRow(cls: string, label: string, options: readonly Swatch[], a: { id: LoadoutOption; cur: () => string | null; set: (value: string | null) => void; tryOn: (hex: string | undefined) => void; picker: { title: string; intro: string; start: () => string } }): void {
    rows.push({ id: a.id, make: () => {
      const sw = h("div.lo-hair-sw", { role: "radiogroup", "aria-label": label });
      const btns = options.map((s) =>
        h(`button.lo-hair-swatch${s.hex() ? "" : ".lo-hair-none"}`, { type: "button", role: "radio", "aria-label": s.name, title: s.name, onmouseenter: () => a.tryOn(s.hex()), onmouseleave: () => a.tryOn(undefined), onclick: () => (a.tryOn(undefined), a.set(s.value)) }) as HTMLButtonElement,
      );
      let dialog: HTMLDialogElement | null = null;
      const custom = h("button.lo-hair-swatch.lo-hair-custom", { type: "button", "aria-haspopup": "dialog", "aria-label": "Any colour", onclick: () => {
        if (dialog) return dialog.focus();
        dialog = glowColorPicker({
          title: a.picker.title,
          intro: a.picker.intro,
          current: a.picker.start() as `#${string}`,
          preview: (hex) => a.tryOn(hex),
          apply: (hex) => (a.tryOn(undefined), a.set(hex)),
          closed: () => ((dialog = null), a.tryOn(undefined)),
        });
      } }) as HTMLButtonElement;
      sw.append(...btns);
      arrowNav(sw, "button");
      return optRow(`.lo-hair-row${cls}`, label, h("div.lo-sw-line", null, sw, custom), a.id, () => {
        const cur = a.cur();
        const preset = options.some((s) => s.value === cur);
        options.forEach((s, i) => {
          const on = s.value === cur;
          const hex = s.hex();
          if (hex && btns[i].style.getPropertyValue("--sw") !== hex) btns[i].style.setProperty("--sw", hex);
          btns[i].classList.toggle("on", on);
          btns[i].setAttribute("aria-checked", String(on));
          btns[i].tabIndex = on || (!preset && i === 0) ? 0 : -1;
        });
        custom.classList.toggle("on", !preset);
        if (preset) custom.style.removeProperty("--sw");
        else custom.style.setProperty("--sw", cur!);
        custom.title = preset ? "Any colour" : `Your colour ${cur!.toUpperCase()}`;
      });
    } });
  }
  /** A slider that shows on the stage while it's dragged and saves when it's let go. */
  /**
   * `range` may depend on what is worn (a charm's Cord and Size are narrower on some knives): it is read on every
   * draw, and a stored value outside it is shown at the nearest end without being saved again.
   */
  type SliderRange = { min: number; max: number; step: number };
  function sliderRow(cls: string, label: string, aria: string, limits: SliderRange | (() => SliderRange), a: { id: LoadoutOption; cur: () => number; drag: (n: number | null) => void; set: (n: number) => void; unit?: string }): void {
    rows.push({ id: a.id, make: () => {
      const value = h("output");
      let dragging: number | null = null;
      const rangeNow = () => (typeof limits === "function" ? limits() : limits);
      let range = rangeNow();
      const input = h("input", { type: "range", min: String(range.min), max: String(range.max), step: String(range.step), "aria-label": aria,
        oninput: () => ((dragging = Number(input.value)), a.drag(dragging), draw(), apply()),
        onchange: () => {
          const n = Number(input.value);
          dragging = null;
          a.drag(null);
          a.set(n);
          draw();
          apply();
        },
      }) as HTMLInputElement;
      const draw = () => {
        range = rangeNow();
        if (input.min !== String(range.min)) input.min = String(range.min);
        if (input.max !== String(range.max)) input.max = String(range.max);
        const n = Math.min(range.max, Math.max(range.min, dragging ?? a.cur()));
        if (dragging === null) input.value = String(n);
        // The track's filled part (style.css input[type=range] reads --p, 0..1 along min..max).
        input.style.setProperty("--p", String((n - range.min) / (range.max - range.min)));
        value.textContent = `${n}${a.unit ?? "%"}`;
      };
      return optRow(`.lo-length-row${cls}`, label, h("span.lo-length", null, input, value), a.id, draw);
    } });
  }

  // Player model (Colourway): the bunny's build, apart from its colourway and accessories.
  segRow<string>("", ".lo-modelseg", "Player model", [["body-a", "A", "Model A"], ["body-b", "B", "Model B"]], {
    id: "model",
    cur: () => choice().body ?? "body-a",
    pick: (id) => (m.equip("body", id), drawOptions(), apply()),
    arrows: "pick",
  });

  // A wig (Hat): its colour and highlights; the Ponytail's length; the Kitsune Mask's two ways to wear it.
  const ownsId = (id: string | null | undefined): boolean => {
    const c = id ? cosmetic(id) : null;
    return !!c && m.owns(c);
  };
  swatchRow("", "Hair colour", HAIR_PRESETS.map((p) => ({ name: p.name, hex: () => p.hex, value: p.hex === hairHex(HAIR_DEFAULT) ? null : p.hex })), {
    id: "hair",
    cur: () => {
      const hex = hairHex(hairColorOf(choice().hairColor) ?? HAIR_DEFAULT);
      return hex === hairHex(HAIR_DEFAULT) ? null : hex;
    },
    set: (hex) => (m.setHairColor(hex), drawOptions(), apply()),
    tryOn: (hex) => ((hairDraft = hex ?? null), apply()),
    picker: { title: "Hair colour", intro: "Choose a colour for your hair.", start: () => hairHex(hairColorOf(choice().hairColor) ?? HAIR_DEFAULT) },
  });
  // "None" first: the hair in one colour.
  swatchRow(".lo-highlight-row", "Highlights", [{ name: "None", hex: () => "", value: null }, ...HIGHLIGHT_PRESETS.map((p) => ({ name: p.name, hex: () => p.hex, value: p.hex }))], {
    id: "highlights",
    cur: () => highlightHexOf(choice().hairHighlight),
    set: (hex) => (m.setHairHighlight(highlightHexOf(hex)), drawOptions(), apply()),
    tryOn: (hex) => ((highlightDraft = hex ?? null), apply()),
    picker: { title: "Highlights", intro: "Choose a colour for your hair's highlights.", start: () => highlightHexOf(choice().hairHighlight) ?? HIGHLIGHT_PRESETS[0].hex },
  });
  sliderRow("", "Length", "Hair length", { ...HAIR_LENGTH, step: 5 }, {
    id: "hair-length",
    cur: () => hairLengthOf(choice().hairLength) ?? HAIR_LENGTH.default,
    drag: (n) => (lengthDraft = n),
    set: (n) => m.setHairLength(n === HAIR_LENGTH.default ? null : n),
  });
  segRow<boolean>(".lo-mask-row", ".lo-modelseg", "Mask", [[false, "Pushed up"], [true, "On the face"]], {
    id: "mask",
    cur: () => !!choice().maskOn,
    pick: (v) => (m.setMaskOn(v), drawOptions(), apply()),
    arrows: "pick",
  });

  // The Cape (Back): its length and its two colours. The Robe: open or tied, its pattern and its two colours.
  const hexOf = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  const accentHex = () => hexOf(colourway(choice().outfit).accent);
  const pantsHex = () => hexOf(colourway(choice().outfit).pants);
  const setCape = (patch: CapeChoice) => ((capeDraft = null), m.setCape(patch), drawOptions(), apply());
  const tryCape = (patch: CapeChoice | null) => ((capeDraft = patch), apply());
  const capeColours = (key: "capeColor" | "capeLining" | "robeColor" | "robePrint", id: LoadoutOption, label: string, title: string, intro: string, def: { name: string; hex: () => string }) =>
    swatchRow(".lo-cape-row", label, [{ name: def.name, hex: def.hex, value: null }, ...CAPE_PRESETS.map((p) => ({ name: p.name, hex: () => p.hex, value: p.hex }))], {
      id,
      cur: () => capeHexOf(choice()[key]),
      set: (hex) => setCape({ [key]: capeHexOf(hex) }),
      // (The first swatch is "no colour of its own": the colourway's, or ivory.)
      tryOn: (hex) => tryCape(hex === undefined ? null : { [key]: hex === def.hex() ? null : hex }),
      picker: { title, intro, start: () => capeHexOf(choice()[key]) ?? def.hex() },
    });
  sliderRow(".lo-cape-row", "Length", "Cape length", CAPE_LENGTH, {
    id: "cape-length",
    cur: () => capeLengthOf(choice().capeLength) ?? CAPE_LENGTH.default,
    drag: (n) => (capeDraft = n === null ? null : { capeLength: n }),
    set: (n) => m.setCape({ capeLength: n === CAPE_LENGTH.default ? null : n }),
  });
  capeColours("capeColor", "cape-colour", "Colour", "Cape colour", "Choose a colour for the outside of your cape.", { name: "Colourway", hex: accentHex });
  capeColours("capeLining", "cape-lining", "Lining", "Cape lining", "Choose a colour for your cape's lining and trim.", { name: "Ivory", hex: () => CAPE_LINING_DEFAULT });
  segRow<boolean | null>(".lo-cape-row", ".lo-poolseg", "Wear", [[null, "Open"], [true, "Tied"]], {
    id: "robe-wear",
    cur: () => (choice().robeTied === true ? true : null),
    pick: (v) => setCape({ robeTied: v }),
    try: (v) => tryCape(v === undefined ? null : { robeTied: v }),
  });
  segRow<number | null>(".lo-cape-row", ".lo-poolseg", "Pattern", ROBE_PATTERNS.map((name, i): [number | null, string] => [i || null, name]), {
    id: "robe-pattern",
    cur: () => choice().robePattern ?? null,
    pick: (v) => setCape({ robePattern: v }),
    try: (v) => tryCape(v === undefined ? null : { robePattern: v }),
  });
  capeColours("robeColor", "robe-colour", "Colour", "Robe colour", "Choose a colour for your robe.", { name: "Colourway", hex: pantsHex });
  capeColours("robePrint", "robe-print", "Pattern colour", "Pattern colour", "Choose a colour for the pattern and the collar.", { name: "Colourway", hex: accentHex });

  // Knife pool (Knife and Finish): knives with their finishes the game swaps between, each map or each restart, in
  // order or at random (player/cosmetics.ts). "Add" puts the knife and finish you hold in it; a chip equips its pair,
  // its × takes it out.
  rows.push({ id: "pool", make: () => {
    const poolList = h("div.lo-pool-list", { role: "list", "aria-label": "Knife pool" });
    const heldPair = () => {
      const c = choice();
      return { knife: c.knife ?? DEFAULT_COSMETICS.knife!, finish: c.finish ?? DEFAULT_COSMETICS.finish! };
    };
    const poolAdd = h("button.btn.btn-sm.lo-pool-add", { type: "button", onclick: () => {
      const p = m.knifePool() ?? emptyPool();
      const pair = heldPair();
      if (p.items.length >= KNIFE_POOL_MAX || p.items.some((x) => x.knife === pair.knife && x.finish === pair.finish)) return;
      m.setKnifePool({ ...p, items: [...p.items, pair] });
      uiSound("ui_press");
      drawOptions();
    } }, "Add to pool") as HTMLButtonElement;
    const poolSeg = (label: string, key: "swap" | "order", choices: [string, string][]) => {
      const seg = h("div.seg.lo-poolseg", { role: "radiogroup", "aria-label": label });
      const btns = choices.map(([v, text]) => h("button", { type: "button", role: "radio", onclick: () => (m.setKnifePool({ ...(m.knifePool() ?? emptyPool()), [key]: v }), drawOptions()) }, text) as HTMLButtonElement);
      seg.append(...btns);
      arrowNav(seg, "button");
      return { seg, draw(p: KnifePool) {
        choices.forEach(([v], i) => {
          const on = p[key] === v;
          btns[i].classList.toggle("on", on);
          btns[i].setAttribute("aria-checked", String(on));
          btns[i].tabIndex = on ? 0 : -1;
        });
      } };
    };
    const swapSeg = poolSeg("Swap", "swap", [["map", "Each map"], ["restart", "Each restart"]]);
    const orderSeg = poolSeg("Order", "order", [["order", "In order"], ["random", "Random"]]);
    const poolHint = h("span.lo-model-note");
    /** The chips as last drawn: redrawn only when the pool or what you hold changes. */
    let poolKey = "";
    return optRow(".lo-pool-row", "Knife pool", h("div.lo-pool", null, poolList, poolAdd, swapSeg.seg, orderSeg.seg, poolHint), "pool", () => {
      const p = m.knifePool() ?? emptyPool();
      const held = heldPair();
      const inPool = p.items.some((x) => x.knife === held.knife && x.finish === held.finish);
      poolAdd.disabled = inPool || p.items.length >= KNIFE_POOL_MAX || !ownsId(held.knife) || !ownsId(held.finish);
      poolAdd.title = inPool ? "Already in the pool" : p.items.length >= KNIFE_POOL_MAX ? `The pool holds ${KNIFE_POOL_MAX}` : "Add the knife and finish you hold";
      const key = `${JSON.stringify(p.items)}|${held.knife}|${held.finish}|${choice().outfit}`;
      if (key !== poolKey) {
        poolKey = key;
        poolList.replaceChildren(...p.items.map((it, i) => {
          const k = cosmetic(it.knife), f = cosmetic(it.finish);
          const plain = it.finish === DEFAULT_COSMETICS.finish;
          const name = `${k?.name ?? it.knife}${plain ? "" : ` · ${f?.name ?? it.finish}`}`;
          const worn = held.knife === it.knife && held.finish === it.finish;
          return h(`span.lo-pool-chip${worn ? ".on" : ""}`, { role: "listitem", style: `--sw:${f && !plain ? f.color : k?.color ?? "#ff7a1a"}` },
            h("button.lo-pool-pick", { type: "button", title: `Equip ${name}`, onclick: () => { m.equip("knife", it.knife); m.equip("finish", it.finish); drawOptions(); apply(); } }, h("span.lo-pool-dot", { "aria-hidden": "true" }), name),
            h("button.lo-pool-x", { type: "button", "aria-label": `Take ${name} out of the pool`, title: "Take out", onclick: () => { const now = m.knifePool() ?? emptyPool(); m.setKnifePool({ ...now, items: now.items.filter((_, j) => j !== i) }); drawOptions(); } }, "×"));
        }));
      }
      const active = p.items.length >= 2;
      swapSeg.seg.hidden = orderSeg.seg.hidden = !active;
      if (active) (swapSeg.draw(p), orderSeg.draw(p));
      poolHint.textContent = active ? "" : p.items.length ? "Add one more to swap between them" : "Swap between knives each map or restart";
    });
  } });
  // The Daily Medal's metal: the ones the player holds, best first, each with how many (the face follows the count).
  const metalName = { gold: "Gold", silver: "Silver", bronze: "Bronze" } as const;
  const held = medals();
  segRow<MedalMetal>(".lo-cape-row.lo-medal-row", ".lo-poolseg", "Metal", heldMetals(held).map((k): [MedalMetal, string, string] => [k, `${metalName[k]} ×${held![k]}`, `${metalName[k]}, ${held![k]} ${held![k] === 1 ? "medal" : "medals"}`]), {
    id: "medal-metal",
    cur: () => medalOf(medalCode(choice().medalMetal, held)).metal,
    pick: (v) => setCape({ medalMetal: v }),
    try: (v) => tryCape(v === undefined ? null : { medalMetal: v }),
  });
  // The charm (Charm): the cord's length, the size, how lively it swings, and where it hangs on a knife with two
  // places. Cord and Size are narrower on some knives and places (viewmodel/charms/places.ts charmClamp: the settings
  // that keep the charm out of the hand): the sliders take that range, and show a stored value outside it at the
  // nearest end, which is where the game draws it. Nothing is saved until a slider is moved.
  const charmAtPommel = (): boolean => {
    const c = choice();
    const places = charmPlaces(c.knife);
    return places.guard ? places.pommel && (capeDraft?.charmPommel !== undefined ? capeDraft.charmPommel === true : c.charmPommel === true) : true;
  };
  type Limits = { min: number; max: number; step: number };
  const charmRange = (key: "cord" | "size", r: Limits) => (): Limits => {
    const knife = choice().knife, pommel = charmAtPommel();
    return { min: charmClamp(knife, pommel, CHARM_LENGTH.min, CHARM_SIZE.min)[key], max: charmClamp(knife, pommel, CHARM_LENGTH.max, CHARM_SIZE.max)[key], step: r.step };
  };
  const charmSlider = (id: LoadoutOption, key: "charmLength" | "charmSize" | "charmSwing", label: string, r: Limits & { default: number }, of: (v: unknown) => number | null, limits: Limits | (() => Limits), unit?: string) =>
    sliderRow(".lo-cape-row.lo-charm-row", label, `Charm ${label.toLowerCase()}`, limits, {
      id,
      cur: () => of(choice()[key]) ?? r.default,
      drag: (n) => (capeDraft = n === null ? null : { [key]: n }),
      set: (n) => m.setCape({ [key]: n === r.default ? null : n }),
      unit,
    });
  charmSlider("charm-cord", "charmLength", "Cord", CHARM_LENGTH, charmLengthOf, charmRange("cord", CHARM_LENGTH));
  charmSlider("charm-size", "charmSize", "Size", CHARM_SIZE, charmSizeOf, charmRange("size", CHARM_SIZE));
  charmSlider("charm-swing", "charmSwing", "Swing", CHARM_SWING, charmSwingOf, CHARM_SWING, "");
  segRow<boolean | null>(".lo-cape-row.lo-charm-row", ".lo-poolseg", "Hangs from", [[null, "Guard"], [true, "Pommel"]], {
    id: "charm-place",
    cur: () => (choice().charmPommel === true ? true : null),
    pick: (v) => setCape({ charmPommel: v }),
    try: (v) => tryCape(v === undefined ? null : { charmPommel: v }),
  });
  // In the block's order: the slot's own rows first, then the worn item's.
  const rowOrder: LoadoutOption[] = ["model", "pool", "hair", "highlights", "hair-length", "mask", "cape-length", "cape-colour", "cape-lining", "robe-wear", "robe-pattern", "robe-colour", "robe-print", "medal-metal", "charm-cord", "charm-size", "charm-swing", "charm-place"];
  rows.sort((a, b) => rowOrder.indexOf(a.id) - rowOrder.indexOf(b.id));

  const opts = h("div.lo-opts", { hidden: true });
  /** Shows the rows that apply to the slot and what you wear in it, and marks their choices. */
  function drawOptions(): void {
    const c = choice();
    const on = new Set<LoadoutOption>(glowTab ? [] : loadoutOptions(slot, c, { owns: ownsId, fixedModel: fixedModel(c.outfit), previewOnly: !!o.previewOnly, metals: heldMetals(held).length }));
    let any = false;
    rows.forEach((r, i) => {
      const show = on.has(r.id);
      if (show && !r.built) {
        r.built = r.make();
        // Into its place among the rows made so far.
        opts.insertBefore(r.built.el, rows.slice(i + 1).find((x) => x.built)?.built?.el ?? null);
      }
      if (!r.built) return;
      if (r.built.el.hidden === show) r.built.el.hidden = !show;
      if (show) (any = true), r.built.draw();
    });
    if (opts.hidden === any) opts.hidden = !any;
  }

  const frame = h("div.lo-frame", { "data-layout": "rail" }, h("div.lo-head", null, tabs, clearIndicators, status), h("div.lo-body", null, stageHost, h("div.lo-side", null, grid, glowPane, opts)));
  const root = h("section.lo", { "aria-label": "Loadout" }, frame);

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
    // The Daily Medal's tile shows yours: the metal you picked, at the look of how many you hold.
    if (spec && c.id === MEDAL_ITEM && medals()) {
      const code = medalCode(choice().medalMetal, medals());
      return { key: `i|${spec.key}|m${code}`, kind: "item", spec: { ...spec, medal: code } };
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
    setAttr(t.el, "aria-pressed", String(on));
    const lock = owned(t) || !t.c ? null : m.lock(t.c);
    setAttr(t.el, "aria-label", `${nameOf(t.c) ?? noneLabel(slot)}${on ? ", equipped" : ""}${lock ? `, locked: ${lock.goal}` : ""}`);
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
    // The line under the name: how to get a locked item ("Supporter" for a Supporter item: the way to the Support
    // page), or in the Contributor and Staff sections the item's role set ("Workbench"), unless that is the item's own
    // name. An item you own says nothing more: no rarity anywhere (owner 11-12), and a Supporter item no set name
    // (owner 11-17): it sits under the Supporter heading and is picked like any other item.
    const sub = lock
      ? h("span.lo-sub.lo-lock", { title: lock.hint }, h("span.lo-lock-i", { html: LOCK_SVG }), goalText(c, group ?? lock.goal, true))
      : group && group !== nameOf(c) && !(c && supporterItem(c))
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
    // one heading (a plain list: no sets), then the Contributor sets (shown to everyone), then the staff sets you hold
    // (no one else ever sees those: shownCosmetic).
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
    // (A slot that may be empty lists its "None" tile first: cosmetic-slots.ts EMPTYABLE.)
    if (EMPTYABLE.has(slot) && !o.only) add(null);
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
    // The options that come with what was just put on (a wig's, the Cape's) may cover its tile: keep it in view.
    requestAnimationFrame(() => keepTile(t.el));
  }

  /** Scrolls the grid (only the grid) so a tile is inside its view. */
  function keepTile(el: HTMLElement): void {
    if (!el.isConnected || getComputedStyle(grid).overflowY === "visible") return;
    const g = grid.getBoundingClientRect(), b = el.getBoundingClientRect();
    if (b.bottom > g.bottom) grid.scrollTop += b.bottom - g.bottom + 4;
    else if (b.top < g.top) grid.scrollTop -= g.top - b.top + 4;
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
    const c = shownChoice();
    stage?.display(loadoutOf(c), lookOf(c));
    drawCaption(c);
  }

  // Written only when they change: every tile and the caption are gone over on each equip, save and hover.
  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const setHidden = (el: HTMLElement, hidden: boolean): void => {
    if (el.hidden !== hidden) el.hidden = hidden;
  };
  function setAttr(el: HTMLElement, name: string, value: string): void {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  /** What the state line shows now: rebuilt only when that changes (not on every hover). */
  let stateKey = "";
  function drawCaption(c: LoadoutChoice): void {
    if (glowTab) {
      setText(capTitle, "Player glow");
      setText(capKind, "");
      for (const el of [capMeta, capHow, capCta]) setHidden(el, true);
      if (stateKey !== "glow") {
        stateKey = "glow";
        capState.className = "lo-cap-state";
        capState.replaceChildren();
      }
      stageHost.style.removeProperty("--rar");
      stageHost.dataset.rar = "0";
      stage?.tint(null, 0.35);
      return;
    }
    // (The Charm slot's stage is the hands too, but its caption names the charm.)
    const hands = stageKind(slot) === "hands" && !fpOnly(slot);
    const l = loadoutOf(c);
    const focus = cosmetic(preview !== null ? preview : c[slot]);
    setText(capTitle, hands ? cosmetic(l.knife)?.name ?? "Carrot Blade" : nameOf(focus) ?? (EMPTYABLE.has(slot) ? noneLabel(slot) : ""));
    setText(capKind, hands ? cosmetic(l.finish)?.name ?? "Garden Fresh" : loadoutKind(slot));
    setText(capHilt, hands && l.hilt ? `${cosmetic(l.hilt)?.name ?? ""} hilt` : "");
    setText(capGlove, hands ? `${cosmetic(c.glove)?.name ?? "Knit"} gloves` : "");
    setHidden(capMeta, !hands);
    // What a click would do (a locked item: how to get it).
    const pc = preview ? cosmetic(preview) : null;
    const lock = pc && !m.owns(pc) ? m.lock(pc) : null;
    const key = lock ? `locked|${pc!.id}|${lock.hint}|${lock.fraction}` : preview !== null ? (o.previewOnly ? "try" : "equip") : o.previewOnly ? "none" : "on";
    if (key !== stateKey) {
      stateKey = key;
      capState.className = `lo-cap-state${lock ? " locked" : key === "on" ? " on" : ""}`;
      if (lock) capState.replaceChildren(h("span.lo-lock-i", { html: LOCK_SVG }), goalText(pc, lock.hint), lock.fraction !== null ? h("span.lo-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : "");
      else if (key === "on") capState.replaceChildren(h("span.lo-status-ok", { html: CHECK_SVG }), "Equipped");
      else capState.replaceChildren(key === "try" ? "Click to try it on" : key === "equip" ? "Click to equip" : "");
    }
    setHidden(capCta, !(lock && pc && supporterItem(pc) && !o.previewOnly));
    // How the item shown was earned (a locked one says how to get it in the state line instead).
    const how = focus && m.owns(focus) ? m.earned(focus) : "";
    setHidden(capHow, !how);
    setText(capHow, how);
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
    o.onSlot?.(s);
    setView(viewFor(s));
    // (A step away from Gun camo with Q / E: its stage's parts are built in idle time.)
    if (order[order.indexOf("camo") - 1] === s || order[order.indexOf("camo") + 1] === s) stage?.warmGuns();
    syncTabs();
    drawOptions();
    drawGrid();
    apply();
    // (Next frame: reading the slots' boxes here would lay the new grid out inside the click.)
    requestAnimationFrame(showTab);
    if (focusTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus({ preventScroll: true });
  }

  function selectGlow(focusTab = false): void {
    if (glowTab) return;
    showGlowTab(true);
    slot = "outfit";
    preview = null;
    o.onSlot?.("glow");
    setView(viewFor(slot));
    syncTabs();
    drawOptions();
    apply();
    requestAnimationFrame(showTab);
    if (focusTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus({ preventScroll: true });
  }

  /** The next / previous slot, wrapping. */
  function stepTab(by: number, focusTab = false): void {
    const n = order.length;
    const next = order[(((glowTab ? order.indexOf("glow") : order.indexOf(slot)) + by) % n + n) % n];
    if (next === "glow") selectGlow(focusTab);
    else select(next, focusTab);
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
        keepView(v);
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
    syncTabs();
    drawOptions();
    drawStatus();
    requestThumbs();
    if (!applyRaf) applyRaf = requestAnimationFrame(apply);
  });

  drawViewSeg();
  syncTabs();
  drawOptions();
  drawGrid();
  drawStatus();
  apply();
  // Asked to open on the Player glow: its panel in place of the grid from the first frame.
  if (o.slot === "glow" && o.glow) selectGlow();
  else o.onSlot?.(slot);
  o.onReady?.({
    redraw: () => {
      preview = null;
      syncTabs();
      drawOptions();
      drawGrid();
      apply();
    },
    select: (s) => {
      if (s === "glow") o.glow && selectGlow();
      else if (isLoadoutCategory(s) && cats.includes(s)) select(s);
    },
    dispose: () => {
      off();
      nearIo?.disconnect();
      removeKeys();
      clearTimeout(revertTimer);
      clearTimeout(statusTimer);
      cancelAnimationFrame(applyRaf);
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

