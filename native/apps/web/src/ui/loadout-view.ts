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
import { SUPPORTER_MIN_USD, COSMETICS, cosmetic, HAIR_HATS, KNIFE_POOL_MAX, type KnifePool, crownOf, DEFAULT_COSMETICS, isUnlocked, secretCosmetic, SUPPORTER_SETS, supporterItem, type CosmeticDef } from "../progression";
import { HAIR_DEFAULT, HAIR_LENGTH, HAIR_PRESETS, LENGTH_HATS, hairColorOf, hairHex, hairLengthOf, isWig, loadoutFor, packLoadout, type CosmeticLoadout } from "../loadout";
import { glowColorPicker } from "./glow-color-picker";
import { getGhostCosmetics, getKnifePool, getLoadout, getOutfit, onGhostCosmetics, onHeldLoadout, onLoadout, onOutfit, setGhostCosmetics, setKnifePool, setLoadout, setOutfit } from "../player/cosmetics";
import { previewOf } from "../notify/item-preview";
import type { Loadout, NewTracker } from "./card-editor";
import { arrowNav, h } from "./dom";
import type { LoadoutStage, StageLook, StageView, ThumbJob } from "./loadout-stage";
import { loadoutSwatch, rarityOf, shownCosmetic } from "./loadout-ui";
import { isLoadoutCategory, LOADOUT_CATEGORIES, loadoutCategories, stageKind, type LoadoutCategory } from "./cosmetic-slots";
import { keyLabel, prefs } from "./settings";
import { earnedLine, lockInfo, profileRanks, type LockInfo } from "./unlocks";
import { earnedHint } from "./unlock-text";
import { navigate } from "./nav";
import { sfx } from "../audio";
import { uiSound } from "../audio/ui";

export type LoadoutSlot = LoadoutCategory;
/** The worn ids per category, plus a wig's colour ("#rrggbb") and the ponytail's length (a percent); absent = the defaults. */
export type LoadoutChoice = Record<LoadoutCategory | "body", string | null> & { hairColor?: string | null; hairLength?: number | null };

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
  outfit: (c.outfit as string | null | undefined) ?? DEFAULT_COSMETICS.outfit,
  body: (c.body as string | null | undefined) ?? DEFAULT_COSMETICS.body,
  hat: (c.hat as string | null | undefined) ?? null,
  ghost: (c.ghost as string | null | undefined) ?? DEFAULT_COSMETICS.ghost,
  trail: (c.trail as string | null | undefined) ?? DEFAULT_COSMETICS.trail,
  hairColor: (c.hairColor as string | null | undefined) ?? null,
  hairLength: hairLengthOf(c.hairLength),
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
    lock: (c) => lockInfo(c, p.level, p.progress, profileRanks(p), p.role),
    earned: (c) => earnedLine(c, p),
    equip: (slot, id) => lo.equip(slot, id),
    setHairColor: (hex) => lo.apply({ hairColor: hex }),
    setHairLength: (n) => lo.apply({ hairLength: n }),
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
    return pick({ ...(l as unknown as Record<string, string>), hairColor: l.hairColor !== undefined ? hairHex(l.hairColor) : null, hairLength: l.hairLength ?? null, outfit: getOutfit(), ghost: g.ghostId, trail: g.trailId });
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
      else if (slot === "ghost" || slot === "trail") setGhostCosmetics(slot === "ghost" ? id : c.ghost, slot === "trail" ? id : c.trail);
      else setLoadout(loadoutFor({ ...c, [slot]: id }));
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

const NAME: Record<LoadoutCategory, string> = Object.fromEntries(LOADOUT_CATEGORIES.map((c) => [c.slot, c.label])) as Record<LoadoutCategory, string>;
/** The caption's second line per category (what the item is). */
const KIND: Record<LoadoutCategory, string> = { knife: "Knife", finish: "Finish", glove: "Gloves", outfit: "Colourway", hat: "Hat", ghost: "Ghost colour", trail: "Trail" };

export interface LoadoutViewOpts {
  playerGlow?: () => import("../player/glow-config").PlayerGlow | null;
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
  /** A hair colour being tried in the custom picker (shown on the stage, not saved). */
  let hairDraft: string | null = null;
  /** A ponytail length being dragged (shown on the stage; saved when the slider is let go). */
  let lengthDraft: number | null = null;
  let stage: LoadoutStage | null = null;
  let revertTimer = 0;
  let applyRaf = 0;

  const choice = () => m.choice();
  /** The choice the stage shows: what you wear, with the previewed item swapped in (a veiled one as its silhouette). */
  const shownChoice = (): LoadoutChoice => {
    const c = choice();
    if (preview !== null) c[slot] = preview || null;
    if (hairDraft) c.hairColor = hairDraft;
    if (lengthDraft !== null) c.hairLength = lengthDraft;
    return c;
  };
  const loadoutOf = (c: LoadoutChoice): CosmeticLoadout => loadoutFor(c, m.crown());
  const lookOf = (c: LoadoutChoice): StageLook => ({ playerGlow: o.playerGlow ? o.playerGlow() : m.playerGlow?.() ?? null, previewGlow: !!o.playerGlow, outfit: c.outfit, ghost: c.ghost, trail: c.trail, veil: veiled(cosmetic(c.outfit)) });
  const viewFor = (s: LoadoutCategory): StageView => (stageKind(s) === "hands" ? lastHandsView : stageKind(s) === "bunny" ? "bunny" : "ghost");

  // --- stage
  const capName = h("h3.lo-cap-name");
  const capMeta = h("p.lo-cap-meta");
  const capHow = h("p.lo-cap-how");
  const capState = h("p.lo-cap-state", { "aria-live": "polite" });
  const viewSeg = h("div.seg.lo-viewseg", { role: "radiogroup", "aria-label": "View" });
  const inspectKey = () => prefs.get().binds.inspect?.find((k) => !k.startsWith("Mouse")) ?? "KeyF";
  const inspectBtn = h("button.btn.lo-insp", { type: "button", title: "Inspect (tap again for the next trick)", onclick: () => stage?.inspect() }, "Inspect", h("kbd", null, keyLabel(inspectKey())));
  const drag = h("span.lo-drag", { "aria-hidden": "true" }, "Drag to turn");
  // The room: a pool of light on the floor and a slow rim light behind the bunny, both in the shown item's rarity
  // colour (quiet for common items); a shine sweeps across when you equip something.
  const stageHost = h(
    "div.lo-stage",
    { "data-view": viewFor(slot), "data-kind": stageKind(slot) },
    h("span.lo-light", { "aria-hidden": "true" }),
    h("span.lo-rim", { "aria-hidden": "true" }),
    h("div.lo-cap", null, capName, capMeta, capHow, capState),
    h("div.lo-tools", null, viewSeg, drag),
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
    const hands = stageKind(slot) === "hands";
    viewSeg.hidden = !hands;
    if (!hands) return viewSeg.replaceChildren();
    const cur = stage?.view ?? lastHandsView;
    viewSeg.replaceChildren(
      ...(
        [
          ["fp", "First person"],
          ["close", "Close-up"],
        ] as [StageView, string][]
      ).map(([v, label]) => h(`button${cur === v ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(cur === v), onclick: () => setView(v) }, label)),
    );
  }
  function setView(v: StageView): void {
    if (v === "fp" || v === "close") lastHandsView = v;
    stageHost.dataset.view = v;
    stageHost.dataset.kind = stageKind(slot);
    stage?.setView(v);
    drawViewSeg();
  }

  // --- categories across the top, the grid beside the stage
  const tabs = h("div.lo-tabs", { role: "tablist", "aria-label": "Loadout" });
  const status = h("span.lo-status", { role: "status", "aria-live": "polite" });
  const clearIndicators = h("button.link-btn.lo-clear", { type: "button", onclick: () => m.clearIndicators() }, "Mark all seen");
  clearIndicators.hidden = !!o.previewOnly;
  const grid = h("div.lo-grid", { role: "group" });
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
   * A row that belongs to some hats (hair colour, ponytail length): on the Hat tab it keeps its place whenever you own
   * such a hat and is only blanked (and inert) while the hat on the stage isn't one. Hovering a card puts that hat on
   * the stage, so a row that came and went with it pushed the grid down under the cursor, onto the next card, which
   * took the row away again: the grid jittered between two cards (syl, 2026-10-29).
   */
  function reserveRow(row: HTMLElement, show: boolean, keep: boolean): void {
    row.hidden = !keep;
    row.classList.toggle("lo-row-idle", keep && !show);
    row.inert = keep && !show;
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
  // Ponytail length: under the hair colour while the Ponytail is on the stage and yours. Dragging shows it on the stage;
  // letting go saves it.
  const lengthValue = h("output");
  const lengthInput = h("input", { type: "range", min: String(HAIR_LENGTH.min), max: String(HAIR_LENGTH.max), step: "5", "aria-label": "Ponytail length",
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
  const root = h("section.lo", { "aria-label": "Loadout" }, h("div.lo-head", null, tabs, clearIndicators, status), bodyRow, hairRow, lengthRow, poolRow, h("div.lo-body", null, stageHost, grid));

  function drawTabs(): void {
    clearIndicators.disabled = !COSMETICS.some((c) => isLoadoutCategory(c.slot) && m.owns(c) && m.isNew(c.id));
    drawBody();
    drawHair();
    drawLength();
    drawPool();
    tabs.replaceChildren(
      ...cats.map((s) => {
        const fresh = s !== slot && listed(s).some((c) => m.isNew(c.id));
        // How many of the category you own (an account's; offline everything listed is free or locked the same way).
        const items = listed(s);
        const own = items.filter((c) => m.owns(c)).length;
        const count = m.userId && s !== "hat" && !o.previewOnly ? h("small", { title: `${own} of ${items.length} owned` }, `${own}/${items.length}`) : null;
        return h(
          `button.lo-tab${s === slot ? ".on" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(s === slot), tabindex: s === slot ? "0" : "-1", "data-slot": s, onclick: () => select(s) },
          NAME[s],
          count,
          fresh ? h("span.pf-new-dot", { role: "img", "aria-label": "new" }) : null,
        );
      }),
    );
  }
  tabs.addEventListener("keydown", (e) => {
    const i = cats.indexOf(slot);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -9;
    if (j === -9) return;
    e.preventDefault();
    select(cats[(j + cats.length) % cats.length], true);
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
    if (slot === "knife" || slot === "finish" || slot === "glove") {
      const l = loadoutFor({ ...choice(), [slot]: c.id });
      if (slot === "glove") return { key: `g|${packLoadout(l)}|${outfit}|${prefs.get().viewmodel.hand}`, kind: "glove", loadout: l };
      return { key: `k|${l.knife}|${l.finish}|${outfit}`, kind: "knife", knife: l.knife, loadout: l };
    }
    const spec = previewOf({ cosmetic: c }, { outfit, body: choice().body });
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

  function requestThumbs(): void {
    if (!stage) return;
    const keys = new Set<string>();
    for (const t of tiles) {
      const job = t.c ? thumbJob(t.c) : null;
      if (!job) continue;
      keys.add(job.key);
      if (job.key === t.key) continue;
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
    t.el.setAttribute("aria-label", `${nameOf(t.c) ?? "No hat"}${on ? ", equipped" : ""}${lock ? `, locked: ${lock.goal}` : ""}`);
  }

  /** Swatch under the thumbnail (also what shows without WebGL). */
  function swatch(c: CosmeticDef | null): HTMLElement {
    if (slot === "knife" || slot === "finish" || slot === "glove") return loadoutSwatch(c, slot);
    if (!c) return h("span.pf-sw.lo-sw-none", { "aria-hidden": "true" });
    return h("span.pf-sw.lo-sw-dot", { "aria-hidden": "true", style: `--sw:${c.color ?? "#888"}` });
  }

  function makeTile(c: CosmeticDef | null): TileRef {
    const lock = c && !m.owns(c) ? m.lock(c) : null;
    const rar = veiled(c) ? null : rarityOf(c);
    const canvas = h("canvas", { width: 384, height: 240, "aria-hidden": "true" }) as HTMLCanvasElement;
    const thumb = h(`span.lo-thumb${veiled(c) ? ".lo-veiled" : ""}`, null, veiled(c) ? h("span.pf-sw.lo-sw-none", { "aria-hidden": "true" }) : swatch(c), canvas, h("span.lo-on", { html: CHECK_SVG, "aria-hidden": "true" }));
    const sub = lock ? h("span.lo-sub.lo-lock", { title: lock.hint }, h("span.lo-lock-i", { html: LOCK_SVG }), goalText(c, lock.goal, true)) : rar ? h("span.lo-sub", null, rar.name) : null;
    const id = c?.id ?? "";
    const el = h(
      "button.lo-tile",
      { type: "button", "data-id": id, "data-sound": "none", style: rar ? `--rar:${rar.color}` : undefined, onclick: () => choose(t) },
      thumb,
      h("span.lo-name", null, h("span", null, nameOf(c) ?? "No hat"), c && m.isNew(c.id) ? h("span.pf-new-dot", { role: "img", "aria-label": "new" }) : null),
      sub,
      lock && lock.fraction !== null ? h("span.lo-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : null,
    ) as HTMLButtonElement;
    const t: TileRef = { c, id, el, thumb, canvas, key: "" };
    tileState(t);
    return t;
  }

  function drawGrid(): void {
    const items = listed(slot);
    const lockOf = (c: CosmeticDef) => m.lock(c).fraction ?? 0;
    const mine = items.filter((c) => m.owns(c));
    // Locked: nearest first, a secret one last.
    const locked = items.filter((c) => !m.owns(c)).sort((a, b) => Number(veiled(a)) - Number(veiled(b)) || lockOf(b) - lockOf(a));
    // Supporter items come last, grouped by set under the set's name (the rest keep their order: yours first).
    const plain = [...mine, ...locked].filter((c) => !c.set);
    const groups = SUPPORTER_SETS.map((st) => ({ st, items: [...mine, ...locked].filter((c) => c.set === st.id) })).filter((g) => g.items.length);
    const headed = groups.length > 1 || (!o.only && groups.length > 0);
    const els: HTMLElement[] = [];
    tiles = [];
    const add = (c: CosmeticDef | null) => {
      const t = makeTile(c);
      tiles.push(t);
      els.push(t.el);
    };
    if (slot === "hat" && !o.only) add(null);
    plain.forEach(add);
    for (const g of groups) {
      if (headed) els.push(h("h4.lo-set-h", null, g.st.name));
      g.items.forEach(add);
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
    if (lengthDraft === null) drawLength();
    drawPool();
    const c = shownChoice();
    stage?.display(loadoutOf(c), lookOf(c));
    drawCaption(c);
  }

  function drawCaption(c: LoadoutChoice): void {
    const hands = stageKind(slot) === "hands";
    const focus = cosmetic(preview !== null ? preview : c[slot]);
    if (hands) {
      const l = loadoutOf(c);
      capName.replaceChildren(h("span", null, cosmetic(l.knife)?.name ?? "Carrot Blade"), h("span.lo-cap-fin", null, cosmetic(l.finish)?.name ?? "Garden Fresh"));
    } else {
      capName.replaceChildren(h("span", null, nameOf(focus) ?? (slot === "hat" ? "No hat" : "")), h("span.lo-cap-fin", null, KIND[slot]));
    }
    const rar = veiled(focus) ? null : rarityOf(focus);
    // The room takes the shown item's rarity colour (common items barely tint it).
    const level = veiled(focus) ? 0 : focus?.rarity ?? 0;
    if (rar) stageHost.style.setProperty("--rar", rar.color);
    else stageHost.style.removeProperty("--rar");
    stageHost.dataset.rar = String(level);
    stage?.tint(rar?.color ?? null, level <= 1 ? 0.35 : 1);
    capMeta.replaceChildren(
      rar ? h("span.lo-cap-rar", { style: `--rar:${rar.color}` }, h("i", { "aria-hidden": "true" }), rar.name) : "",
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

  function select(s: LoadoutCategory, focusTab = false): void {
    if (s === slot) return;
    slot = lastSlot = s;
    preview = null;
    setView(viewFor(s));
    drawTabs();
    drawGrid();
    apply();
    if (focusTab) tabs.querySelector<HTMLElement>(".lo-tab.on")?.focus();
  }

  // Q / E (gamepad LB / RB): previous / next category; the inspect key inspects (held: keeps a spin going).
  root.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (k !== "q" && k !== "e") return;
    e.preventDefault();
    const i = cats.indexOf(slot);
    select(cats[(i + (k === "e" ? 1 : cats.length - 1)) % cats.length]);
    (grid.querySelector<HTMLElement>(".lo-tile.on") ?? grid.querySelector<HTMLElement>(".lo-tile"))?.focus({ preventScroll: true });
  });
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return removeKeys();
    if (e.code !== inspectKey() || e.ctrlKey || e.metaKey || e.altKey || stageKind(slot) !== "hands") return;
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
    if (!root.isConnected) return void off();
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
