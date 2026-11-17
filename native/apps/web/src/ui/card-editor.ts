import {profileWriteGuard} from "./profile-write";
import { NewTracker as IndicatorTracker } from "./new-tracker";
// Your profile card, edited in place (v0.0.9: no Customise tab). cardEditor() is the small editor under the card in
// ui/profile.ts's "Edit card" mode: background, frame, title, name (supporters), badges and links; one click equips and
// autosaves (POST /me/cosmetics, /me/badges, /me/links, /me/supporter; strict server-side validation). Everything you look like in the game
// (knife, finish, gloves, colourway, hat, ghost, trail) is the Loadout (ui/loadout-view.ts).
//
// Also here, shared with the Loadout: the Loadout model (draft + saved choice, autosave) and the NewTracker ("new since
// last seen" dots).

import { api, ApiError, type CosmeticChoice, type MapBackgrounds, type Profile, type SupporterSettings } from "../api";
import { MAP_BG_MIN_FINISHERS, type MapBgView } from "../map-bg";
import { styleLabel } from "../styles";
import { formatTime } from "../timer";
import { getGhostCosmetics, getLoadout, getOutfit, rememberUnlocks, setGhostCosmetics, setKnifePool, setLoadout, setOutfit } from "../player/cosmetics";
import { loadoutFor, sameLoadout } from "../loadout";
import { colourway } from "../player/bunny/palettes";
import { MEDAL_ITEM, achievement, ACHIEVEMENTS, COSMETICS, crownOf, DEFAULT_COSMETICS, secretCosmetic, supporterItem, type CosmeticDef, type CosmeticSlot } from "../progression";
import { medalCountsOf } from "../creators";
import { badgeToken } from "./badges";
import { arrowNav, h } from "./dom";
import { isLoadoutSlot, listedCosmetic, loadoutSwatch, shownCosmetic } from "./loadout-ui";
import { availableNow } from "./community";
import { CARD_PARTS, loadoutSections, type CardPart } from "./cosmetic-slots";
import { accountGeneration, refreshMyProfile } from "./account-state";
import { nameMarks } from "./marks";
import { SPECIAL_BADGES, GIFTER_TIERS } from "../creators";
import { linkIcon } from "./marks";
import { LINK_PLATFORMS, linkHint, NAME_COLORS, NAME_EFFECTS, parseHandle, PLATFORM_NAME, usesColor2, type LinkPlatform, type NameColorId, type NameEffect, type NameLook, type ProfileLinks } from "../creators";
import "./loadout-view.css";
import "./settings.css";
import { nameAttrs } from "./marks";
import { autoBadges, earnedLine, lockInfo, profileHolder, profileRanks, progressText, newDot, ownedCosmetics, shortGoal, ownedIds, type LockInfo } from "./unlocks";
import { pastGoal } from "./unlock-text";
import { NUMBER_ONE, rankColorOf, rankGroupById } from "../ranking";
import { nameStyleShown, type AvatarDecoId, type CardBorderId, type CardEffectId, type HoverFxId, type NameFontId, type NameStyle } from "../supporter-looks";
import { peakOf } from "../creators";
import { type SupporterLook } from "./card";
import { borderChoices, cardEffectChoices, cardFxSwatch, COLOUR_CHOICES, DECO_CHOICES, EFFECT_CHOICES, FONT_CHOICES, HOVER_FX_CHOICES, hoverFxSwatch, nameSample, decoSwatch, styleChoices } from "./supporter-pickers";
import { navigate } from "./nav";
import { pickAction, TryOn, tryNote } from "./card-tryon";
import { flagList, type FlagList } from "./country-picker";
import { countryFlag } from "./country-flag";
import { countryCode, flagName } from "../countries";
import { scrollCue } from "./scroll-cue";

export const MAX_BADGES = 3;

// ---------------------------------------------------------------------------------------------
// Loadout: what the card wears (draft), saved as you go.

type Status = { kind: "idle" | "saving" | "saved" | "error"; text: string; undo?: () => void };

export class Loadout {
  choice: CosmeticChoice;
  /** Chosen badges ([] = automatic). */
  badges: string[];
  readonly owned: Set<string>;
  readonly earned: Set<string>;
  status: Status = { kind: "idle", text: "" };
  private readonly writes:ReturnType<typeof profileWriteGuard>;
  private current():boolean { return this.writes.current(); }
  private saved: CosmeticChoice;
  private pending: Partial<CosmeticChoice> = {};
  private timer = 0;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  /**
   * v0.0.43 map backgrounds (map-bg.ts): the maps whose world record you hold (GET /me/map-backgrounds), loaded the
   * first time Edit card → Background shows; null until then, and always while the server's MAP_BG switch is off
   * (the profile then has no `mapBg` field at all).
   */
  mapBgs: MapBackgrounds | null = null;
  private mapBgsLoading = false;

  constructor(readonly p: Profile) {
    this.writes=profileWriteGuard(p.player.id);
    this.choice = { ...DEFAULT_COSMETICS, ...p.cosmetics, ...(p.mapBgChoice !== undefined ? { mapBg: p.mapBgChoice } : {}) };
    this.saved = { ...this.choice };
    this.badges = [...p.badges];
    this.owned = ownedCosmetics(p);
    this.earned = new Set(p.achievements.map((a) => a.id));
    if (p.mine) {
      // Keep this device's ghost colours / colourway in step with the account (another device may have changed them).
      rememberUnlocks([...this.owned]);
      if (this.choice.outfit && this.choice.outfit !== getOutfit()) setOutfit(this.choice.outfit);
      const g = getGhostCosmetics();
      if (g.ghostId !== this.choice.ghost || g.trailId !== this.choice.trail || g.shapeId !== this.choice.shape) setGhostCosmetics(this.choice.ghost, this.choice.trail, this.choice.shape);
      this.syncLoadout();
    }
  }

  /** Your equipped knife / finish / gloves -> the viewmodel, your bunny, replays. */
  private syncLoadout(): void {
    if (!this.p.mine || !this.current()) return;
    // (The Daily Medal's face: from the medals on the player's marks, as everywhere.)
    const l = loadoutFor(this.choice, crownOf(profileRanks(this.p)), this.choice.back === MEDAL_ITEM ? medalCountsOf(this.p.player.special) : null);
    setKnifePool(this.choice.knifePool ?? null);
    if (!sameLoadout(l, getLoadout())) setLoadout(l);
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }
  private setStatus(s: Status): void {
    this.status = s;
    this.emit();
  }

  /** Badges the card shows: the picks, else the automatic three. */
  shownBadges(): string[] {
    return this.badges.length ? this.badges : autoBadges(this.p);
  }

  isOwned(c: CosmeticDef): boolean {
    return this.owned.has(c.id);
  }

  equip(slot: CosmeticSlot, id: string | null): void {
    if (!this.current()) return;
    const c = id ? COSMETICS.find((x) => x.id === id) : null;
    if (id && (!c || !this.owned.has(id) || !listedCosmetic(c))) return;
    // A background picked while a map is on: that background, not "under the map" (the server says the same).
    if (slot === "background" && this.choice.mapBg) return this.apply({ background: id, mapBg: null });
    if (this.choice[slot] === id) return;
    this.apply({ [slot]: id });
  }

  /** Whether map backgrounds are on for this profile (the server sent the field). */
  mapBgsOn(): boolean {
    return this.p.mine && this.p.mapBg !== undefined;
  }

  /** Loads the maps you hold once (Edit card → Background); the editor and the card redraw when they arrive. */
  loadMapBgs(): void {
    if (!this.mapBgsOn() || this.mapBgs || this.mapBgsLoading) return;
    this.mapBgsLoading = true;
    api.mapBackgrounds().then(
      (m) => {
        this.mapBgs = m;
        this.emit();
      },
      () => {
        this.mapBgsLoading = false; // tried again the next time the tab draws
      },
    );
  }

  /** The held map `map` as the card draws it (null: not held, or not loaded yet). */
  heldMap(map: string | null | undefined): MapBgView | null {
    return (map && this.mapBgs?.maps.find((m) => m.map === map)) || null;
  }

  /** Changes several slots at once (Randomise / Reset); `label` + undo in the status line. */
  apply(patch: Partial<CosmeticChoice>, label?: string): void {
    if (!this.current()) return;
    const before = { ...this.choice };
    this.choice = { ...this.choice, ...patch };
    Object.assign(this.pending, patch);
    // Loadout items show at once (the preview stage and the game follow it); a refused save puts it back.
    if (Object.keys(patch).some((k) => isLoadoutSlot(k) || k === "camo" || k === "hop" || k === "trail" || k === "hat" || k === "back" || k === "body" || k === "hairColor" || k === "hairLength" || k === "hairHighlight" || k === "maskOn" || k === "capeLength" || k === "capeColor" || k === "capeLining" || k.startsWith("robe") || k === "knifePool")) this.syncLoadout();
    this.status = { kind: "saving", text: "Saving…" };
    this.emit();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(label, label ? () => this.apply(before) : undefined), 220);
  }

  private async flush(label?: string, undo?: () => void): Promise<void> {
    if (this.inflight) await this.inflight;
    if (!this.current()) { this.pending = {}; return; }
    const patch = this.pending;
    this.pending = {};
    if (!Object.keys(patch).length) return;
    this.inflight = (async () => {
      try {
        const res = await api.saveCosmetics(patch,this.writes);
        if (!this.current()) return;
        this.saved = res;
        // What's saved is the profile now (the Loadout screen builds from it); the page's cached own profile refetches.
        this.p.cosmetics = { ...res };
        if (this.p.mine) refreshMyProfile();
        // Anything picked while this save was in flight wins over the server's echo.
        this.choice = { ...res, ...this.pending };
        setGhostCosmetics(this.choice.ghost, this.choice.trail, this.choice.shape);
        if ("outfit" in patch) setOutfit(this.choice.outfit);
        this.syncLoadout();
        this.setStatus({ kind: "saved", text: label ? `${label} saved` : "Saved", undo });
      } catch (e) {
        if (!this.current()) return;
        this.choice = { ...this.saved };
        this.pending = {};
        this.syncLoadout();
        this.setStatus({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't save (offline?)" });
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  toggleBadge(id: string): void {
    if (!this.earned.has(id)) return;
    const cur = this.badges.length ? this.badges : [];
    const next = cur.includes(id) ? cur.filter((b) => b !== id) : cur.length >= MAX_BADGES ? [...cur.slice(1), id] : [...cur, id];
    this.setBadges(next);
  }

  setBadges(next: string[]): void {
    if (!this.current()) return;
    const before = this.badges;
    this.badges = next;
    this.status = { kind: "saving", text: "Saving…" };
    this.emit();
    api.saveBadges(next,this.writes).then(
      () => { if (this.current()) this.setStatus({ kind: "saved", text: "Saved" }); },
      (e) => {
        if (!this.current()) return;
        this.badges = before;
        this.setStatus({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't save" });
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// "New since last seen": a snapshot taken when the profile opens (dots stay put while you look), and the ids still
// unseen in storage (they clear as each slot / filter is viewed).

export class NewTracker extends IndicatorTracker {
  static forProfile(p: Profile): NewTracker {
    return new NewTracker(p.mine ? p.player.id : null, p.mine ? ownedIds(p) : []);
  }
}

// ---------------------------------------------------------------------------------------------
// Swatches and marks (shared with the card editor's picker)

const LOCK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The cosmetic's look at tile size. */
export function cosmeticSwatch(c: CosmeticDef | null, slot: CosmeticSlot, label?: string): HTMLElement {
  switch (slot) {
    case "background":
      return h(`span.pf-sw.pf-sw-card.pc-bg-${(c?.id ?? "bg-night").replace(/^bg-/, "")}`, { "aria-hidden": "true" });
    case "frame":
      return h(`span.pf-sw.pf-sw-frame.pc-frame-${(c?.id ?? "frame-plain").replace(/^frame-/, "")}`, { "aria-hidden": "true" }, h("span"));
    case "title":
      return h("span.pf-sw.pf-sw-title", { "aria-hidden": "true" }, label ?? c?.name ?? "");
    case "outfit": {
      const cw = colourway(c?.id);
      const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
      return h("span.pf-sw.pf-sw-outfit", { "aria-hidden": "true", style: `--a:${hex(cw.hoodie)};--b:${hex(cw.pants)};--c:${hex(cw.accent)}` });
    }
    case "knife":
    case "finish":
    case "hilt":
    case "glove":
      return loadoutSwatch(c, slot);
    default:
      // Two-tone ghosts / trails (CosmeticDef.color2): the main colour with a crescent of the second.
      return c?.color2
        ? h("span.pf-sw.pf-sw-dot.pf-sw-two", { "aria-hidden": "true", style: `--sw:${c.color ?? "#888"};--sw2:${c.color2}` })
        : h("span.pf-sw.pf-sw-dot", { "aria-hidden": "true", style: `--sw:${c?.color ?? "#888"}` });
  }
}

// ---------------------------------------------------------------------------------------------
// The card editor: your own profile's card in edit mode (ui/profile.ts "Edit card"), v0.0.43 in the Loadout's shape:
// the card's parts in a list (Settings' rail), the card in the middle, the selected part's choices beside it. The card
// is redrawn in place (ui/card.ts updatePlayerCard) and the lists keep their nodes: a pick changes classes only.
// Hover previews on the card; a click on an item of yours puts it on and saves it at once (the line under the card
// says so); a click on one you don't have tries it on (ui/card-tryon.ts: shown on your card only, never saved), with
// one link to the Support page for a Supporter item or its unlock condition for the rest.

export interface CardEditor {
  el: HTMLElement;
  part(): CardPart;
  select(part: CardPart): void;
  /** The next (1) or previous (-1) part in the list. */
  step(dir: 1 | -1): void;
  /** Edit card is being left: try-ons come off and no preview is sent to the card after this. */
  close(): void;
}

export interface CardEditorOpts {
  part?: CardPart | null;
  /** A hovered item to show on the card (null: back to what's equipped). */
  onPreview: (patch: Partial<CosmeticChoice> | null) => void;
  onLinks?: (links: ProfileLinks, show: boolean) => void;
  /** The "Show booster badge" switch was saved. */
  onBooster?: (show: boolean) => void;
  /** A supporter's settings were saved (name colour, badge switch, About listing). */
  onSupporter?: (s: SupporterSettings) => void;
  /** A supporter look to show on the card while hovered, over the saved one (undefined: back to the saved one). */
  onNamePreview?: (look: SupporterLook | undefined) => void;
  /** The Number One's title colour while it's picked (null: the title's own). */
  onRankColor?: (hex: string | null) => void;
  /** Edit card → Flag: a flag to show on the card while it is under the pointer (undefined: back to the saved one). */
  onFlagPreview?: (code: string | null | undefined) => void;
  /** The profile flag was saved (null: none). */
  onFlag?: (code: string | null) => void;
  done: () => void;
}

let lastPart: CardPart = "background";

/**
 * Edit card → Title, for the overall Number One only: the title's colour (CosmeticChoice.rankColor, ranking.ts
 * shownRankColor). The card follows while picking; Default goes back to the title's own colour.
 */
function rankColorRow(p: Profile, lo: { choice: CosmeticChoice; apply(patch: Partial<CosmeticChoice>): void }, o: CardEditorOpts): HTMLElement | null {
  if (p.rank.group.id !== NUMBER_ONE) return null;
  const base = rankGroupById(NUMBER_ONE).color;
  const cur = rankColorOf(lo.choice.rankColor) ?? base;
  const input = h("input.ce-rank-color", { type: "color", value: cur, "aria-label": "Number One colour" }) as HTMLInputElement;
  input.addEventListener("input", () => o.onRankColor?.(input.value));
  input.addEventListener("change", () => {
    o.onRankColor?.(input.value);
    lo.apply({ rankColor: input.value.toLowerCase() === base ? null : input.value.toLowerCase() });
  });
  const reset = rankColorOf(lo.choice.rankColor)
    ? h("button.link-btn", { type: "button", onclick: () => (o.onRankColor?.(null), lo.apply({ rankColor: null })) }, "Default")
    : null;
  return h("div.ce-booster.ce-rank-row", null, h("label.acct-toggle", { title: "Your Number One role on Discord uses it too" }, input, h("span", null, "Number One colour")), reset);
}

/**
 * A picker item: look, name, one line. Built once per draw of its part; `sync` then carries its state (on the card,
 * tried on, its number, its line) onto the same node, so picking changes a class and never rebuilds the list.
 */
interface ItemState {
  on: boolean;
  /** Locked and being tried on the card (card-tryon.ts). */
  trying?: boolean;
  /** A badge's place among the picked ones ("1" to "3"). */
  tag?: string | null;
  /** The line under an owned item's name. */
  sub?: string | null;
}
interface Item {
  el: HTMLElement;
  sync(): void;
}
function pickItem(
  look: HTMLElement | null,
  name: string,
  o: { id: string; state: () => ItemState; isNew?: boolean; lock?: LockInfo | null; /** Locked, and a click tries it on (else it only says how to get it). */ tryable?: boolean; pick: () => void; preview?: () => void },
): Item {
  const lock = o.lock ?? null;
  const tryable = !!lock && !!o.tryable;
  const sub = lock ? h("small", null, h("span.pf-tile-lock", { html: LOCK_SVG }), lock.goal) : h("small");
  const tag = h("span.ce-tag", { hidden: true });
  const el = h(
    `button.ce-item${lock ? ".locked" : ""}${tryable ? ".tryable" : ""}`,
    { type: "button", "data-id": o.id, "aria-disabled": lock && !tryable ? "true" : undefined, title: lock ? lock.hint : undefined, onclick: () => (lock && !tryable ? undefined : o.pick()) },
    look,
    // ("Preview" sits at the end of the name's line, so the unlock line under it keeps the row's whole width.)
    h("span.ce-text", null, h("b", null, h("span.ce-name", null, name), o.isNew ? newDot("new") : null, tryable ? h("span.ce-try", { "aria-hidden": "true" }, "Preview") : null), sub),
    tag,
    lock ? null : h("span.ce-on", { html: CHECK_SVG }),
    lock && lock.fraction !== null ? h("span.pf-tile-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : null,
  );
  if (o.preview) {
    el.addEventListener("pointerenter", o.preview);
    el.addEventListener("focus", o.preview);
  }
  const sync = () => {
    const s = o.state();
    el.classList.toggle("on", s.on);
    el.classList.toggle("trying", !!s.trying);
    if (!lock) el.setAttribute("aria-pressed", String(s.on));
    else if (tryable) el.setAttribute("aria-pressed", String(!!s.trying));
    el.setAttribute("aria-label", `${name}${s.on ? ", on your card" : ""}${lock ? `, locked: ${lock.goal}${tryable ? (s.trying ? ", previewing on your card" : ", press to preview") : ""}` : ""}${o.isNew ? ", new" : ""}`);
    const t = s.tag ?? "";
    if (tag.textContent !== t) tag.textContent = t;
    tag.hidden = !t;
    if (!lock) {
      const line = s.sub ?? "";
      if (sub.textContent !== line) sub.textContent = line;
      sub.hidden = !line;
      if (line) el.title = line;
    }
  };
  sync();
  return { el, sync };
}

/** One tab stop per list: Tab moves between the lists and the arrow keys within one (ui/dom.ts arrowNav). */
function roving(list: HTMLElement, selector = ".ce-item"): void {
  const set = (cur?: HTMLElement | null) => {
    const all = [...list.querySelectorAll<HTMLElement>(selector)];
    const at = cur ?? all.find((x) => x.classList.contains("on")) ?? all[0];
    for (const x of all) x.tabIndex = x === at ? 0 : -1;
  };
  set();
  list.addEventListener("focusin", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (t && list.contains(t)) set(t);
  });
}

/** The one link to the Support page, as the Loadout's locked Supporter items link there (loadout-view.ts goalText). */
function supportLink(text: string): HTMLElement {
  return h("a.lo-goal-link", { href: "/?support", onclick: (e: Event) => (e.preventDefault(), navigate({ screen: "support" })) }, text);
}

/** What the try-on note calls an item of each part. */
const TRY_NOUN: Record<"background" | "frame" | "title", string> = { background: "background", frame: "frame", title: "title" };
/** A supporter look's fields (SupporterPatch's looks): one try-on each. */
type LookKey = "nameColor" | "nameEffect" | "nameColor2" | "nameFont" | "nameStyle" | "avatarDeco" | "cardBorder" | "cardEffect" | "hoverFx";

export function cardEditor(p: Profile, lo: Loadout, news: NewTracker, o: CardEditorOpts): CardEditor {
  let part: CardPart = o.part ?? lastPart;
  const linksEd = linksEditor(p, o.onLinks);
  const boosterRow = boosterSwitch(p, o.onBooster);
  const supporter = supporterEditor(p, (s) => {
    o.onSupporter?.(s);
    show();
    refresh();
  });

  // --- what the card shows over what is saved: the item under the pointer, else whatever is tried on. Neither is
  // ever saved (card-tryon.ts); a pick of your own goes through lo.equip / POST /me/supporter instead.
  const tries = new TryOn();
  let hoverCos: Partial<CosmeticChoice> | null = null;
  let hoverLook: SupporterLook | undefined;
  /** Edit card was left (Done, Esc, another tab): nothing here may reach the card any more. */
  let closed = false;
  const show = () => {
    if (closed) return;
    const c = { ...tries.cosmetics(), ...hoverCos };
    o.onPreview(Object.keys(c).length ? c : null);
    const l = { ...tries.look(), ...hoverLook };
    o.onNamePreview?.(Object.keys(l).length ? l : undefined);
  };
  const hover = (c: Partial<CosmeticChoice> | null, l?: SupporterLook) => {
    hoverCos = c;
    hoverLook = l;
    show();
  };

  // --- the parts: a list (Settings' rail items), built once; picking a part or an item only changes classes and counts
  const parts = CARD_PARTS;
  const tabs = h("div.ce-parts", { role: "tablist", "aria-label": "Card parts", "aria-orientation": "vertical" });
  const rail = new Map<CardPart, { el: HTMLElement; count: HTMLElement; dot: HTMLElement; said: string }>();
  parts.forEach(({ part: x, label, group }, i) => {
    const count = h("small.ce-count");
    const dot = newDot("new unlocks");
    dot.hidden = true;
    const el = h(`button.ce-part.set-rail-item${i && parts[i - 1].group !== group ? ".ce-gap" : ""}`, { type: "button", role: "tab", id: `ce-tab-${x}`, "aria-controls": "ce-body", "data-part": x, onclick: () => select(x) }, h("span.set-rail-label", null, label), dot, count);
    rail.set(x, { el, count, dot, said: "" });
    tabs.append(el);
  });
  scrollCue(tabs, "x");
  const status = h("span.pf-status", { role: "status", "aria-live": "polite" });
  const note = h("p.ce-note");
  const body = h("div.ce-body#ce-body", { role: "tabpanel", tabindex: "-1" });
  // A redraw (the map list arriving) replaces the grid under a resting pointer, and the new grid never sees it leave:
  // the panel itself ends any hover preview.
  body.addEventListener("pointerleave", () => hover(null));
  const doneBtn = h("button.btn.primary.ce-done", { type: "button", onclick: () => leave() }, "Done");
  const flagPreview = (code: string | null | undefined) => !closed && o.onFlagPreview?.(code);
  // Source order is the keyboard's: the parts, the choices, Done. (On screen the card and this line sit between.)
  const el = h("section.ce", { "aria-label": "Edit your card" }, h("div.ce-head", null, tabs), body, h("div.ce-foot", null, note, doneBtn));

  /**
   * Leaving (ui/profile.ts calls it for Done, Esc and a tab switch alike): whatever was tried on comes off and the
   * editor goes quiet, so nothing but what was saved is left on the card. (Taking the editor out of the page ends
   * focus inside it, which would otherwise ask for the try-ons to be shown once more.)
   */
  function close(): void {
    tries.clear();
    hoverCos = null;
    hoverLook = undefined;
    closed = true;
  }
  function leave(): void {
    close();
    o.done();
  }

  const listedIn = (x: CardPart) => COSMETICS.filter((c) => c.slot === x && shownCosmetic(c, lo.owned));
  const partIds = (x: CardPart) => (x === "badges" ? [...lo.earned] : x === "background" || x === "frame" || x === "title" ? listedIn(x).map((c) => c.id) : []);
  /** Badges still to earn that are listed (ones that can't be earned right now aren't; nor Supporter, which isn't a goal to chase). */
  const toEarn = () => ACHIEVEMENTS.filter((a) => !lo.earned.has(a.id) && availableNow(a) && a.availability !== "support");

  /** The end of a part's row: how many of its items you have (the Loadout's counts), the flag itself for Flag. */
  function countOf(x: CardPart): string {
    if (x === "background" || x === "frame" || x === "title") {
      const list = listedIn(x);
      return `${list.filter((c) => lo.owned.has(c.id)).length}/${list.length}`;
    }
    if (x === "badges") return `${lo.earned.size}/${lo.earned.size + toEarn().length}`;
    if (x === "flag") return `flag:${countryCode(p.player.country) ?? ""}`;
    return "";
  }
  function syncRail(): void {
    for (const [x, r] of rail) {
      const on = x === part;
      r.el.classList.toggle("on", on);
      r.el.setAttribute("aria-selected", String(on));
      r.el.tabIndex = on ? 0 : -1;
      r.dot.hidden = on || news.pendingIn(partIds(x)) === 0;
      const say = countOf(x);
      if (say === r.said) continue;
      r.said = say;
      if (x === "flag") {
        const flag = countryFlag(p.player.country);
        r.count.replaceChildren(flag ?? "None");
        r.el.setAttribute("aria-label", flag ? `Flag, ${flagName(countryCode(p.player.country)!)}` : "Flag, none set");
      } else r.count.textContent = say;
    }
  }
  /** The next (1) or previous (-1) part, round the ends (Q / E on the profile: ui/profile.ts). */
  function step(dir: 1 | -1): void {
    const i = parts.findIndex((x) => x.part === part);
    select(parts[(i + dir + parts.length) % parts.length].part);
  }
  /** Into the choices: the item that holds its list's tab stop, else the first field or button. */
  const enterBody = () => (body.querySelector<HTMLElement>('.ce-item[tabindex="0"]') ?? body.querySelector<HTMLElement>("input, button"))?.focus();
  // Arrows along the list move between parts (down the left: up and down; across the top: left and right); the arrow
  // across it goes into the part's choices. Home and End: the first and the last part.
  tabs.addEventListener("keydown", (e) => {
    const down = getComputedStyle(tabs).flexDirection === "column";
    const next = down ? "ArrowDown" : "ArrowRight", prev = down ? "ArrowUp" : "ArrowLeft", into = down ? "ArrowRight" : "ArrowDown";
    if (e.key === into) return void (e.preventDefault(), enterBody());
    if (e.key === next || e.key === prev) step(e.key === next ? 1 : -1);
    else if (e.key === "Home" || e.key === "End") select(parts[e.key === "Home" ? 0 : parts.length - 1].part);
    else return;
    e.preventDefault();
    rail.get(part)!.el.focus();
  });

  // --- the line under the card: what is saved, or what is only tried on
  let statusTimer = 0;
  /** A save outside the Loadout model (the flag, a supporter's look), said in the same place. */
  let said: Status | null = null;
  function say(st: Status): void {
    said = st;
    drawNote();
  }
  let noteKey = "";
  function drawNote(): void {
    const st = said ?? lo.status;
    const t = tryNote(tries.list());
    // (A save reports three times; the line is only touched when what it says changes.)
    const key = JSON.stringify([st.kind, st.text, t, part === "links"]);
    if (key === noteKey) return;
    noteKey = key;
    status.className = `pf-status ${st.kind}`;
    status.replaceChildren(st.kind === "saved" ? h("span.pf-status-ok", { html: CHECK_SVG }) : "", st.kind === "idle" ? "" : st.text);
    clearTimeout(statusTimer);
    if (st.kind === "saved") statusTimer = window.setTimeout(() => status.classList.add("fade"), 2200);
    note.classList.toggle("trying", !!t);
    // (While something is tried on, "Saved" beside "it isn't saved" would read as its opposite: only a failure shows.)
    if (t) note.replaceChildren(t.text, t.goal ? ` ${t.goal}` : "", t.link ? " " : "", t.link ? supportLink(t.link) : "", st.kind === "error" ? status : "");
    // (Links are the one part with fields to type in: they have their own Save button and status.)
    else note.replaceChildren(part === "links" ? "Links are saved with their own button." : "Changes save as you pick them.", status);
  }

  const lockOf = (c: CosmeticDef) => lockInfo(c, p.level, p.progress, profileRanks(p), profileHolder(p));

  /** The lists a part draws, kept so a pick can carry its state onto them (refresh) instead of redrawing. */
  let items: Item[] = [];
  /** What the drawn part's structure depends on; a change means a redraw, anything else a sync in place. */
  let shape = "";
  const add = (it: Item): HTMLElement => (items.push(it), it.el);
  /** A list of items: the pointer leaving ends the hover preview, arrows move within it, Tab past it. */
  function listOf(cls: string, els: (HTMLElement | null)[]): HTMLElement {
    const g = h(`div.ce-grid.${cls}`, null, ...els);
    g.addEventListener("pointerleave", () => hover(null));
    g.addEventListener("focusout", (e) => !g.contains(e.relatedTarget as Node | null) && hover(null));
    arrowNav(g, ".ce-item", { grid: true });
    roving(g);
    return g;
  }

  /** The look saved for this account (a supporter's), all off for anyone else. */
  const savedLook = (): Record<LookKey, string | null> => {
    const s = p.supporterSettings ?? null;
    return { nameColor: s?.nameColor ?? null, nameEffect: s?.nameEffect ?? null, nameColor2: s?.nameColor2 ?? null, nameFont: s?.nameFont ?? null, nameStyle: s?.nameStyle ?? null, avatarDeco: s?.avatarDeco ?? null, cardBorder: s?.cardBorder ?? null, cardEffect: s?.cardEffect ?? null, hoverFx: s?.hoverFx ?? null };
  };

  async function saveLook(patch: SupporterPatch): Promise<void> {
    if (!supporter) return;
    const before = p.supporterSettings;
    say({ kind: "saving", text: "Saving…" });
    await supporter.save(patch);
    say(p.supporterSettings !== before ? { kind: "saved", text: "Saved" } : { kind: "error", text: "Not saved" });
  }

  /**
   * Edit card → Name, Avatar, Effects: a supporter's looks (supporter-looks.ts). Each shows on the card while hovered
   * and, for a supporter, saves on click (POST /me/supporter). Anyone else tries them on: a click keeps the look on
   * their own card until it is clicked again or they leave, and nothing is sent (the server would refuse it: 403
   * not_supporter). A lapsed supporter too (their picks stay stored, unshown). "None" is theirs already.
   */
  function supporterPart(which: "name" | "avatar" | "effects"): HTMLElement[] {
    const s = p.supporterSettings ?? null;
    const lock: LockInfo | null = s ? null : { hint: "Supporter item", goal: "Supporter", fraction: null };
    const cur = savedLook() as SupporterLook & Record<LookKey, string | null>;
    const grid = (list: HTMLElement[], cls = "ce-grid-name") => listOf(cls, list);
    const item = <K extends LookKey>(look: HTMLElement | null, name: string, key: K, value: SupporterPatch[K] & (string | null), noun: string, isOn: () => boolean = () => savedLook()[key] === value) =>
      add(
        pickItem(look, name, {
          id: String(value ?? "none"),
          lock: value === null ? null : lock,
          tryable: true,
          // (What is saved keeps its tick while something else is tried on: the tick is what others see.)
          state: () => ({ on: isOn(), trying: tries.at(key) === String(value) }),
          pick: () => {
            if (pickAction(!!p.supporterSettings) === "save") return void saveLook({ [key]: value } as SupporterPatch);
            if (value === null) tries.drop(key);
            else tries.toggle({ key, id: String(value), name: `${name} ${noun}`, supporter: true, goal: null }, { look: { [key]: value } as SupporterLook });
            show();
            refresh();
          },
          preview: () => hover(null, { [key]: value } as SupporterLook),
        }),
      );
    const label = (t: string) => h("p.ce-label", null, t);
    const head = s ? [] : [h("p.ce-support", null, "Supporter items. Pick one to see it on your card.")];
    if (which === "name") {
      const dot = (hex: string) => h("span.pf-sw.pf-sw-dot", { "aria-hidden": "true", style: `--sw:${hex}` });
      const second = s && usesColor2(cur.nameEffect)
        ? [label("Second colour"), grid([{ id: null as NameColorId | null, name: "Automatic", hex: "" }, ...NAME_COLORS].map((c) => item(c.id ? dot(c.hex) : nameSample({ ...cur, nameColor2: null }), c.name, "nameColor2", c.id, "second colour")))]
        : [];
      return [
        ...head,
        label("Colour"),
        grid(COLOUR_CHOICES.map((c) => item(dot(c.hex), c.name, "nameColor", c.id, "name colour"))),
        label("Effect"),
        grid(EFFECT_CHOICES.map((e) => item(nameSample({ ...cur, nameEffect: e.id }), e.name, "nameEffect", e.id, "name effect"))),
        ...second,
        label("Font"),
        grid(FONT_CHOICES.map((f) => item(nameSample({ ...cur, nameFont: f.id }), f.name, "nameFont", f.id, "font"))),
        // v0.0.40: bold / italic, in the cuts the font has (none: no row). A pick the font lacks shows as Plain.
        ...(styleChoices(cur.nameFont).length
          ? [label("Bold and italic"), grid(styleChoices(cur.nameFont).map((st) => item(nameSample({ ...cur, nameStyle: st.id }), st.name, "nameStyle", st.id, "name style", () => nameStyleShown(p.supporterSettings?.nameFont ?? null, p.supporterSettings?.nameStyle ?? null) === st.id)))]
          : []),
      ];
    }
    if (which === "avatar")
      return [...head, label("Decoration"), grid(DECO_CHOICES.map((d) => item(decoSwatch(p.player, d.id, cur.nameColor), d.name, "avatarDeco", d.id, "decoration")), "ce-grid-name.ce-grid-deco")];
    // Effects: with a peak (T7+), "none" keeps the tier's own frame light / motes (supporter-looks.ts cardLayerPlan).
    const peak = peakOf(p.player.special);
    return [
      ...head,
      label("Border"),
      grid(borderChoices(peak).map((b) => item(cardFxSwatch(peak, b.id, null, cur.nameColor), b.name, "cardBorder", b.id, "border"))),
      label("Effect"),
      grid(cardEffectChoices(peak).map((e) => item(cardFxSwatch(peak, null, e.id, cur.nameColor), e.name, "cardEffect", e.id, "effect"))),
      // How your mini profile comes in when someone rests on your name: each small card plays it under the pointer.
      label("Hover effect"),
      grid(HOVER_FX_CHOICES.map((e) => item(hoverFxSwatch(e.id, cur.nameColor), e.name, "hoverFx", e.id, "hover effect"))),
    ];
  }

  /**
   * Edit card → Background, Frame, Title: yours first, then the ones still to earn (closest first), then the Supporter
   * and Contributor items under the Loadout's headings (cosmetic-slots.ts loadoutSections; staff items only for their
   * holders). A click on one of yours puts it on the card and saves it; a click on any other tries it on.
   */
  function cosmeticPart(slot: "background" | "frame" | "title"): HTMLElement {
    const sec = loadoutSections(listedIn(slot));
    const own = (c: CosmeticDef) => lo.owned.has(c.id);
    const mapOn = () => !!lo.choice.mapBg && !!lo.heldMap(lo.choice.mapBg);
    const make = (c: CosmeticDef): HTMLElement => {
      const mine = own(c);
      // (A Supporter item says "Supporter", as the Loadout's tiles do; the way to it is the link beside the card.)
      const lock = mine ? null : supporterItem(c) ? { ...lockOf(c), goal: "Supporter" } : lockOf(c);
      // A secret item (progression.ts secretCosmetic) stays "???" until it is earned: no name, no preview.
      const veiled = !mine && secretCosmetic(c);
      const line = mine ? earnedLine(c, p, false) : null;
      return add(
        pickItem(slot === "title" || veiled ? null : cosmeticSwatch(c, slot), veiled ? "???" : c.name, {
          id: c.id,
          isNew: news.isNew(c.id),
          lock,
          tryable: !veiled,
          // The fallback background, said once while a map is on.
          state: () => ({ on: lo.choice[slot] === c.id, trying: tries.at(slot) === c.id, sub: slot === "background" && lo.choice[slot] === c.id && mapOn() ? "Under the map" : line }),
          pick: () => {
            if (pickAction(lo.isOwned(c)) === "save") {
              tries.drop(slot);
              lo.equip(slot, c.id);
            } else tries.toggle({ key: slot, id: c.id, name: `${c.name} ${TRY_NOUN[slot]}`, supporter: supporterItem(c), goal: c.unlock.kind === "level" || c.unlock.kind === "rank" || (c.unlock.kind === "achievement" && !supporterItem(c)) ? lock!.goal : null }, { cosmetics: { [slot]: c.id } });
            show();
            refresh();
          },
          preview: veiled ? undefined : () => hover({ [slot]: c.id }),
        }),
      );
    };
    const els: HTMLElement[] = [];
    if (slot === "title")
      els.push(add(pickItem(null, p.rank.group.name, { id: "", state: () => ({ on: lo.choice.title === null, sub: "Your rank" }), pick: () => (tries.drop("title"), lo.equip("title", null), show(), refresh()), preview: () => hover({ title: null }) })));
    els.push(...sec.earned.filter(own).map(make), ...sec.earned.filter((c) => !own(c)).sort((a, b) => (lockOf(b).fraction ?? 0) - (lockOf(a).fraction ?? 0)).map(make));
    if (sec.supporter.length) els.push(h("h4.lo-set-h", null, h("span", null, "Supporter")), ...sec.supporter.map((x) => make(x.c)));
    if (sec.contributor.length) els.push(h("h4.lo-set-h", null, h("span", null, "Contributor"), sec.contributor.some((x) => own(x.c)) ? "" : h("span.lo-set-note", null, "For players who worked on the game")), ...sec.contributor.map((x) => make(x.c)));
    if (sec.staff.length) els.push(h("h4.lo-set-h", null, h("span", null, "Staff")), ...sec.staff.map((x) => make(x.c)));
    return listOf(`ce-grid-${slot}`, els);
  }

  /** Edit card → Badges: the three on the card (picked, or automatic), then every badge still to earn, closest first. */
  function badgesPart(): HTMLElement {
    const earned = [...lo.earned].map(achievement).filter((a): a is NonNullable<typeof a> => !!a).sort((a, b) => b.ring - a.ring || a.name.localeCompare(b.name));
    return listOf("ce-grid-badges", [
      add(pickItem(h("span.pf-sw.pf-sw-auto", { "aria-hidden": "true" }, "Auto"), "Automatic", { id: "", state: () => ({ on: !lo.badges.length, sub: "Your three rarest" }), pick: () => lo.setBadges([]) })),
      ...earned.map((a) => {
        const at = () => lo.badges.indexOf(a.id);
        const line = pastGoal(a);
        return add(pickItem(badgeToken(a, { size: "sm" }), a.name, { id: a.id, isNew: news.isNew(a.id), state: () => ({ on: at() >= 0, sub: line, tag: at() >= 0 ? String(at() + 1) : null }), pick: () => lo.toggleBadge(a.id) }));
      }),
      // Then every achievement still to earn, closest first: the goal and how far along you are (hidden ones stay
      // "???" until earned; ones that can't be earned right now aren't listed: ui/community.ts availableNow; nor is
      // Supporter, which isn't a goal to chase).
      ...toEarn()
        .map((a) => ({ a, prog: p.progress?.[a.id] ?? null }))
        .map((x) => ({ ...x, f: x.prog && x.prog[1] > 1 ? Math.min(1, x.prog[0] / x.prog[1]) : null }))
        .sort((x, y) => (y.f ?? 0) - (x.f ?? 0))
        .map(({ a, prog, f }) => {
          const goal = a.hidden ? "Hidden achievement" : shortGoal(a);
          const t = a.hidden ? null : progressText(a, prog);
          return add(pickItem(badgeToken(a, { got: false, size: "sm", progress: prog }), a.hidden ? "???" : a.name, { id: a.id, state: () => ({ on: false }), lock: { hint: `${goal}${t ? ` · ${t}` : ""}`, goal: t ? `${goal} · ${t}` : goal, fraction: f }, pick: () => {} }));
        }),
    ]);
  }

  /**
   * Edit card → Flag: the flag before your name (a country or region, or one of the two pride flags after them:
   * ui/country-picker.ts flagList). A click saves it (POST /me/country), like the card's other parts; the card shows
   * the one under the pointer meanwhile.
   */
  let flags: FlagList | null = null;
  let flagBusy = false;
  async function saveFlag(code: string | null): Promise<void> {
    if (flagBusy || countryCode(p.player.country) === code) return;
    flagBusy = true;
    flags?.mark(code);
    say({ kind: "saving", text: "Saving…" });
    try {
      const r = await api.setCountry(code);
      p.player.country = r.country;
      o.onFlag?.(r.country);
      say({ kind: "saved", text: "Saved" });
    } catch (e) {
      say({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't save your flag" });
    }
    flagBusy = false;
    flags?.mark(countryCode(p.player.country));
    syncRail();
  }
  function flagPart(): HTMLElement[] {
    flags ??= flagList({ selected: countryCode(p.player.country), rows: true, choose: (code) => void saveFlag(code), preview: flagPreview });
    return [h("p.ce-label.ce-flag-note", null, "Shown before your name on leaderboards, your card and the server scoreboard."), flags.el];
  }

  const shapeOf = (): string => {
    if (part === "background") return JSON.stringify([lo.mapBgsOn() && lo.mapBgs ? [lo.mapBgs.maps.length, lo.mapBgs.choice?.map, lo.mapBgs.choice?.held, lo.choice.mapBg === lo.mapBgs.choice?.map] : 0, mapQuery, mapsAll]);
    // The Name part's samples are drawn in the saved look, and its rows depend on the effect and the font.
    if (part === "name") return JSON.stringify(savedLook());
    if (part === "title") return String(!!rankColorOf(lo.choice.rankColor));
    return "";
  };

  function drawBody(): void {
    const scroll = body.scrollTop;
    // Keep focus on the item that was clicked across a redraw.
    const active = document.activeElement as HTMLElement | null;
    const idx = active && body.contains(active) && active.matches(".ce-item") ? [...body.querySelectorAll(".ce-item")].indexOf(active) : -1;
    items = [];
    body.dataset.part = part;
    body.setAttribute("aria-labelledby", `ce-tab-${part}`);
    if (part === "links") body.replaceChildren(linksEd.el);
    else if (part === "flag") {
      body.replaceChildren(...flagPart());
      flags!.reveal();
    }
    else if (part === "name" || part === "avatar" || part === "effects") body.replaceChildren(...supporterPart(part));
    else if (part === "badges")
      body.replaceChildren(
        ...(p.nameBadgeSettings ? [nameBadgeEditor(p, () => show()), h("div.ce-showcase-heading", null, h("h4", null, "Profile showcase"), h("p.dim", null, "Shown on your profile card"))] : []),
        badgesPart(),
        !p.nameBadgeSettings && boosterRow ? boosterRow : "",
        !p.nameBadgeSettings && supporter ? supporter.badgeRow : "",
        supporter ? supporter.boardRow : "",
      );
    else {
      const grid = cosmeticPart(part);
      body.replaceChildren(part === "title" ? (rankColorRow(p, lo, o) ?? "") : "", ...(part === "background" ? mapBgSection(grid) : []), grid);
    }
    shape = shapeOf();
    body.scrollTop = scroll;
    if (idx >= 0) body.querySelectorAll<HTMLElement>(".ce-item")[idx]?.focus({ preventScroll: true });
    news.see(partIds(part));
  }

  /** After a pick, a save or a try-on: the lists as they are, with their state carried on; a redraw only if the part's structure changed. */
  function refresh(): void {
    if (shapeOf() !== shape) drawBody();
    else for (const it of items) it.sync();
    syncRail();
    drawNote();
  }

  /** Map search and "Show all" (kept across redraws of the Background tab). */
  let mapQuery = "";
  let mapsAll = false;
  /** Rows shown before "Show all" and a search field. */
  const MAPS_SHOWN = 12;

  /**
   * Edit card → Background, v0.0.43 (map-bg.ts): the maps whose world record you hold, newest first, above the
   * backgrounds; one plain line says what happens when you lose one. A map you picked and lost stays in the list,
   * locked, until you take the record back. Past MAPS_SHOWN maps: a search field and "Show all". With none held, one
   * locked row at the end of the backgrounds says how to get one (appended to `grid`, the backgrounds). Maps keep
   * their own rule: only one you hold can be picked, and a locked one can't be tried on.
   */
  function mapBgSection(grid: HTMLElement): HTMLElement[] {
    if (!lo.mapBgsOn()) return [];
    lo.loadMapBgs();
    const m = lo.mapBgs;
    if (!m) return [];
    const lost = m.choice && !m.choice.held && m.choice.map === (lo.choice.mapBg ?? null) ? m.choice : null;
    const swatch = (src: string | null) => h("span.pf-sw.pf-sw-card.pf-sw-map", { "aria-hidden": "true", style: src ? `background-image:url("${src}")` : undefined });
    if (!m.maps.length && !lost) {
      const goal = `Hold a world record on a map ${MAP_BG_MIN_FINISHERS} players have finished`;
      // With the backgrounds earned by playing (before the Supporter heading), across the row so its line reads whole.
      const teaser = add(pickItem(swatch(null), "Map backgrounds", { id: "map-bg-teaser", state: () => ({ on: false }), lock: { hint: goal, goal, fraction: null }, pick: () => {} }));
      teaser.classList.add("ce-item-wide");
      teaser.tabIndex = -1;
      grid.insertBefore(teaser, grid.querySelector(".lo-set-h"));
      return [];
    }
    const q = mapQuery.trim().toLowerCase();
    const found = q ? m.maps.filter((x) => x.map.toLowerCase().includes(q)) : m.maps;
    const shown = q || mapsAll ? found : found.slice(0, MAPS_SHOWN);
    const rows = shown.map((x) => {
      const line = `${styleLabel(x.style)}, ${formatTime(x.time)}`;
      return add(
        pickItem(swatch(x.card ?? x.hero), x.map, {
          id: `map:${x.map}`,
          state: () => ({ on: (lo.choice.mapBg ?? null) === x.map, sub: line }),
          pick: () => ((lo.choice.mapBg ?? null) === x.map ? undefined : (tries.drop("background"), lo.apply({ mapBg: x.map }), show())),
          preview: () => hover({ mapBg: x.map }),
        }),
      );
    });
    if (lost) {
      const goal = "Someone beat it. Yours again if you retake it.";
      rows.push(add(pickItem(swatch(lost.card ?? lost.hero), lost.map, { id: `map:${lost.map}`, state: () => ({ on: false }), lock: { hint: goal, goal, fraction: null }, pick: () => {} })));
    }
    const mapGrid = listOf("ce-grid-background.ce-grid-maps", rows);
    const out: HTMLElement[] = [h("p.ce-label.ce-maps-note", null, "Maps where you hold the world record. Lose the record and your card goes back to the background below.")];
    if (m.maps.length > MAPS_SHOWN) {
      const input = h("input.nf-input.ce-map-q", { type: "search", value: mapQuery, placeholder: `Find a map (${m.maps.length})`, "aria-label": "Find a map", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => e.stopPropagation()); // typing is not game input
      input.addEventListener("input", () => {
        mapQuery = input.value;
        drawBody();
        const again = body.querySelector<HTMLInputElement>(".ce-map-q");
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      });
      out.push(input);
    }
    out.push(mapGrid);
    if (!q && !mapsAll && m.maps.length > MAPS_SHOWN) out.push(h("button.link-btn.ce-maps-all", { type: "button", onclick: () => ((mapsAll = true), drawBody()) }, `Show all ${m.maps.length}`));
    if (q && !found.length) out.push(h("p.ce-label", null, "No map of yours matches."));
    out.push(h("p.ce-label", null, "Backgrounds"));
    return out;
  }

  function select(x: CardPart): void {
    if (x === part) return;
    const inList = tabs.contains(document.activeElement);
    part = lastPart = x;
    if (inList) rail.get(x)!.el.focus();
    hover(null);
    flagPreview(undefined);
    body.scrollTop = 0;
    drawBody();
    syncRail();
    drawNote();
    // Across the top (a narrow window), the picked part comes into view (the row's own scroll, never the page's).
    const r = rail.get(x)!.el.getBoundingClientRect(), box = tabs.getBoundingClientRect();
    if (r.left < box.left) tabs.scrollLeft -= box.left - r.left + 24;
    else if (r.right > box.right) tabs.scrollLeft += r.right - box.right + 24;
  }

  // The Loadout model reports a pick, its save and the echo (and the map list arriving): the same lists, updated.
  const off = lo.on(() => {
    if (!el.isConnected) return void off();
    said = null;
    refresh();
  });
  drawBody();
  syncRail();
  drawNote();
  return { el, part: () => part, select, step, close };
}

// ---------------------------------------------------------------------------------------------
// Server Booster (Edit card → Badges, under the grid): "Show booster badge", on by default. Only while the player
// boosts the Discord server (the API sends boosterSettings then); the server decides who has the badge.

function boosterSwitch(p: Profile, onBooster?: (show: boolean) => void): HTMLElement | null {
  const writes=profileWriteGuard(p.player.id);
  if (!p.boosterSettings) return null;
  let show = p.boosterSettings.show;
  const toggle = h("input.switch", { type: "checkbox", checked: show }) as HTMLInputElement;
  const status = h("span.pf-status", { role: "status", "aria-live": "polite" });
  toggle.onchange = async () => {
    toggle.disabled = true;
    status.className = "pf-status saving";
    status.textContent = "Saving…";
    try {
      show = (await api.saveBooster(toggle.checked,writes)).show;
      if(!writes.current())return;
      p.boosterSettings = { show };
      status.className = "pf-status saved";
      status.replaceChildren(h("span.pf-status-ok", { html: CHECK_SVG }), "Saved");
      onBooster?.(show);
    } catch {
      toggle.checked = show;
      status.className = "pf-status error";
      status.textContent = "Not saved";
    }
    toggle.disabled = false;
  };
  return h("div.ce-booster", null, h("label.acct-toggle", null, toggle, h("span", null, "Show booster badge")), status);
}

// ---------------------------------------------------------------------------------------------
// Supporter (Edit card → Name, and Badges): the name colour and effect, "Show supporter badge" and "Show me in Top
// supporters" (both on by default; the second also covers the About page's thank-you list). Only for supporters (the API sends supporterSettings then); the server decides who is.

type SupporterPatch = {
  nameColor?: NameColorId | null;
  nameEffect?: NameEffect | null;
  nameColor2?: NameColorId | null;
  nameFont?: NameFontId | null;
  nameStyle?: NameStyle | null;
  avatarDeco?: AvatarDecoId | null;
  cardBorder?: CardBorderId | null;
  cardEffect?: CardEffectId | null;
  hoverFx?: HoverFxId | null;
  showBadge?: boolean;
  showOnBoard?: boolean;
};

interface SupporterEditor {
  save(patch: SupporterPatch): Promise<void>;
  badgeRow: HTMLElement;
  boardRow: HTMLElement;
}

function supporterEditor(p: Profile, onSaved?: (s: SupporterSettings) => void): SupporterEditor | null {
  const writes=profileWriteGuard(p.player.id);
  if (!p.supporterSettings) return null;
  const status = () => h("span.pf-status", { role: "status", "aria-live": "polite" });
  const badgeStatus = status();
  const boardStatus = status();
  const badge = h("input.switch", { type: "checkbox", checked: p.supporterSettings.showBadge }) as HTMLInputElement;
  const board = h("input.switch", { type: "checkbox", checked: p.supporterSettings.showOnBoard }) as HTMLInputElement;
  const say = (el: HTMLElement, kind: "saving" | "saved" | "error", text: string) => {
    el.className = `pf-status ${kind}`;
    el.replaceChildren(kind === "saved" ? h("span.pf-status-ok", { html: CHECK_SVG }) : "", text);
  };
  const save = async (patch: SupporterPatch, el: HTMLElement | null = null): Promise<void> => {
    if (el) say(el, "saving", "Saving…");
    try {
      const s = await api.saveSupporter(patch,writes);
      if(!writes.current())return;
      p.supporterSettings = s;
      badge.checked = s.showBadge;
      board.checked = s.showOnBoard;
      if (el) say(el, "saved", "Saved");
      onSaved?.(s);
    } catch {
      badge.checked = p.supporterSettings!.showBadge;
      board.checked = p.supporterSettings!.showOnBoard;
      if (el) say(el, "error", "Not saved");
    }
  };
  badge.onchange = async () => {
    badge.disabled = true;
    await save({ showBadge: badge.checked }, badgeStatus);
    badge.disabled = false;
  };
  board.onchange = async () => {
    board.disabled = true;
    await save({ showOnBoard: board.checked }, boardStatus);
    board.disabled = false;
  };
  return {
    save,
    badgeRow: h("div.ce-booster", null, h("label.acct-toggle", null, badge, h("span", null, "Show supporter badge")), badgeStatus),
    boardRow: h("div.ce-booster", null, h("label.acct-toggle", null, board, h("span", null, "Show me in Top supporters")), boardStatus),
  };
}

// ---------------------------------------------------------------------------------------------
// Links (Edit card → Links): a handle per platform + "Show on my profile" (off by default). The server validates again
// (allowlisted domains, the name filter) and builds the URLs; nothing here is trusted.

const LINK_PLACEHOLDER: Record<LinkPlatform, string> = { youtube: "@yourchannel", twitch: "yourchannel", x: "@yourhandle", tiktok: "@yourhandle" };

function linksEditor(p: Profile, onLinks?: (links: ProfileLinks, show: boolean) => void): { el: HTMLElement; count: () => string; onCount: () => void } {
  const writes=profileWriteGuard(p.player.id);
  let saved: ProfileLinks = { ...(p.linkSettings?.links ?? {}) };
  let show = p.linkSettings?.show ?? false;
  const out = { el: h("div.lk-editor"), count: () => (Object.keys(saved).length ? `${Object.keys(saved).length}${show ? "" : " · off"}` : "none"), onCount: () => {} };
  const status = h("span.pf-status", { role: "status", "aria-live": "polite" });
  const say = (kind: "saving" | "saved" | "error" | "idle", text: string) => {
    status.className = `pf-status ${kind}`;
    status.replaceChildren(kind === "saved" ? h("span.pf-status-ok", { html: CHECK_SVG }) : "", text);
  };
  const rows = new Map<LinkPlatform, { input: HTMLInputElement; err: HTMLElement }>();
  const toggle = h("input.switch", { type: "checkbox", checked: show }) as HTMLInputElement;
  const saveBtn = h("button.btn.primary.btn-sm", { type: "button" }, "Save links") as HTMLButtonElement;

  const commit = async (body: { links?: ProfileLinks; show?: boolean }, done: string): Promise<boolean> => {
    say("saving", "Saving…");
    for (const r of rows.values()) r.err.textContent = "";
    try {
      const r = await api.saveLinks(body,writes);
      if(!writes.current())return false;
      saved = { ...r.links };
      show = r.show;
      toggle.checked = show;
      for (const pl of LINK_PLATFORMS) rows.get(pl)!.input.value = saved[pl] ?? "";
      say("saved", done);
      onLinks?.(saved, show);
      out.onCount();
      return true;
    } catch (e) {
      const pl = e instanceof ApiError ? (e.body.platform as LinkPlatform | undefined) : undefined;
      const msg = e instanceof ApiError ? e.message.replace(/^\w+: /, "") : "Couldn't reach the server.";
      if (pl && rows.has(pl)) {
        rows.get(pl)!.err.textContent = msg;
        rows.get(pl)!.input.focus();
        say("error", "Not saved");
      } else say("error", msg);
      return false;
    }
  };

  const saveLinks = async () => {
    const links: ProfileLinks = {};
    let bad = false;
    for (const [pl, r] of rows) {
      const v = parseHandle(pl, r.input.value);
      r.err.textContent = "error" in v ? v.error : "";
      if ("error" in v) bad = true;
      else if (v.handle) links[pl] = v.handle;
    }
    if (bad) return say("error", "Not saved");
    saveBtn.disabled = true;
    await commit({ links }, "Links saved");
    saveBtn.disabled = false;
  };
  saveBtn.onclick = () => void saveLinks();
  toggle.onchange = async () => {
    toggle.disabled = true;
    if (!(await commit({ show: toggle.checked }, toggle.checked ? "Shown on your profile" : "Hidden from your profile"))) toggle.checked = show;
    toggle.disabled = false;
  };

  const list = h(
    "div.lk-rows",
    null,
    ...LINK_PLATFORMS.map((pl) => {
      const input = h("input.lk-input", { type: "text", value: saved[pl] ?? "", placeholder: LINK_PLACEHOLDER[pl], maxlength: 120, autocomplete: "off", spellcheck: false, "aria-label": `${PLATFORM_NAME[pl]} handle` }) as HTMLInputElement;
      const err = h("small.lk-err", { role: "alert" });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // typing is not game input
        if (e.key === "Enter") void saveLinks();
      });
      input.addEventListener("input", () => (err.textContent = ""));
      rows.set(pl, { input, err });
      input.title = linkHint(pl);
      return h("label.lk-row", null, h("span.lk-name", null, linkIcon(pl), PLATFORM_NAME[pl]), h("span.lk-field", null, input, err));
    }),
  );
  out.el.append(
    list,
    h("div.lk-actions", null, saveBtn, status),
    h("label.acct-toggle.lk-show", null, toggle, h("span", null, "Show on my profile")),
  );
  return out;
}

/** The badges after your name (Edit card → Badges): Verified, Creator, Server Booster, Supporter, your Gifter tier. */
function nameBadgeEditor(p: Profile, changed: () => void): HTMLElement {
  const writes=profileWriteGuard(p.player.id);
  const root = h("section.ce-name-badges", { "aria-label": "Badges after your name" });
  let busy = false;
  let feedback = "";
  let failed = false;

  const label = (id: string) =>
    GIFTER_TIERS.find((t) => t.id === id)?.name ??
    ({ verified: "Verified", creator: "Creator", booster: "Server Booster", supporter: "Supporter" } as Record<string, string>)[id] ??
    SPECIAL_BADGES[id]?.name ??
    id;

  function icon(id: string): HTMLElement {
    const s = p.nameBadgeSettings!;
    return h(
      "span.ce-name-icon",
      { "aria-hidden": "true" },
      nameMarks({
        ...p.player,
        staff: id === "staff" ? p.player.staff : null,
        verified: s.owned.includes("verified"),
        supporter: s.owned.includes("supporter"),
        booster: s.owned.includes("booster"),
        nameBadges: id === "staff" ? [] : [id],
        giftsSent: s.giftsSent,
        gifterColors: s.gifterColors,
        gifterAnimated: s.gifterAnimated,
      }),
    );
  }

  async function save(nameBadges: string[], extra: { gifterColors?: string[]; gifterAnimated?: boolean } = {}, focusBadge?: string) {
    if (busy) return;
    busy = true;
    root.inert = true;
    root.setAttribute("aria-busy", "true");
    feedback = "Saving…";
    const status = root.querySelector(".ce-name-status");
    if (status) status.textContent = feedback;
    try {
      const next = await api.saveNameBadges({ nameBadges, ...extra },writes);
      if(!writes.current())return;
      p.nameBadgeSettings = next;
      Object.assign(p.player, next, {
        supporter: next.nameBadges.includes("supporter") && next.owned.includes("supporter"),
        booster: next.nameBadges.includes("booster") && next.owned.includes("booster"),
      });
      feedback = "Saved";
      failed = false;
      refreshMyProfile();
      changed();
    } catch (e) {
      feedback = e instanceof Error ? e.message : "Could not save badges";
      failed = true;
    } finally {
      busy = false;
      root.inert = false;
      root.removeAttribute("aria-busy");
      render();
      if (focusBadge)
        [...root.querySelectorAll<HTMLButtonElement>("[data-badge-pick]")]
          .find((button) => button.dataset.badgePick === focusBadge)
          ?.focus({ preventScroll: true });
    }
  }

  // One row of the badges you hold: click to wear or take off. They show after your name in the order you pick them
  // (a staff badge always first, and it takes one of the three places; a moderator wearing Contributor wears it there).
  function render() {
    const s = p.nameBadgeSettings!;
    const selected = s.nameBadges;
    const swap = !!s.contributorForStaff && selected.includes("contributor");
    const shield = !!p.player.staff && !swap;
    const capacity = 3 - (shield ? 1 : 0);
    const full = selected.length >= capacity;
    const order = swap ? ["contributor", ...selected.filter((x) => x !== "contributor")] : selected;
    const tier = GIFTER_TIERS.filter((t) => s.giftsSent >= t.goal).at(-1)?.id;
    const available = s.owned.filter((id) => !id.startsWith("gifter-") || id === tier);
    const chips = h(
      "div.ce-badges",
      { role: "group", "aria-label": "Your badges" },
      ...available.map((id) => {
        const at = order.indexOf(id);
        // Picking Contributor frees the shield's place, so it never counts as over the limit.
        const blocked = at < 0 && full && !(id === "contributor" && s.contributorForStaff);
        return h(
          `button.ce-badge${at >= 0 ? ".on" : ""}`,
          {
            type: "button",
            "data-badge-pick": id,
            "aria-pressed": String(at >= 0),
            disabled: blocked,
            title: blocked ? `You can wear ${capacity} at once` : undefined,
            onclick: () => void save(at >= 0 ? selected.filter((x) => x !== id) : [...selected, id], {}, id),
          },
          icon(id),
          h("span", null, label(id)),
          at >= 0 ? h("span.ce-badge-n", { "aria-hidden": "true" }, String(at + 1 + (shield ? 1 : 0))) : null,
        );
      }),
    );
    arrowNav(chips, ".ce-badge", { grid: true });
    const next = GIFTER_TIERS.find((t) => s.giftsSent < t.goal);
    root.replaceChildren(
      h("div.ce-name-heading", null, h("h3", null, "Badges after your name"), h(`span.ce-name-status${failed ? ".error" : ""}`, { role: failed ? "alert" : "status", "aria-live": "polite" }, feedback)),
      h("div.ce-name-preview", null, h("b", nameAttrs(p.player), p.player.name), nameMarks(p.player) ?? ""),
      available.length ? chips : h("p.dim", null, "Supporter, Server Booster and Gifter badges show up here."),
      h(
        "p.ce-name-help.dim",
        null,
        swap
          ? "Contributor shows in place of your Moderator badge. Wear up to three, in the order you pick them."
          : p.player.staff
            ? `Your staff badge comes first. Wear ${capacity} more, in the order you pick them.${s.contributorForStaff ? " Pick Contributor to show it instead of your Moderator badge." : ""}`
            : "Wear up to three, in the order you pick them.",
      ),
      s.giftsSent > 0 || s.owned.includes("supporter") ? h("p.ce-name-help.dim", null, next ? `${s.giftsSent} of ${next.goal} gifts to ${next.name}` : `${s.giftsSent} gifts sent. Prism Gifter`) : "",
      ...(s.giftsSent >= 100 ? [prismControls(s, selected)] : []),
    );
  }

  function prismControls(s: NonNullable<Profile["nameBadgeSettings"]>, selected: string[]): HTMLElement {
    const defaults = ["#b98cff", "#7fcfff", "#ffb9db"];
    // Never saved: start from the default three (an empty list would leave nothing to edit).
    let colors = s.gifterColors.length ? [...s.gifterColors] : [...defaults];
    const preview = h("div.ce-gifter-preview");
    const inputs = h("div.ce-gifter-inputs");
    const animation = h("input.switch", { type: "checkbox", checked: s.gifterAnimated }) as HTMLInputElement;
    const updatePreview = () =>
      preview.replaceChildren(
        nameMarks({ giftsSent: s.giftsSent, nameBadges: ["gifter-prism"], gifterColors: colors, gifterAnimated: animation.checked })!,
      );
    function drawColors() {
      inputs.replaceChildren(
        ...colors.map((color, i) => {
          const input = h("input", { type: "color", value: color, "aria-label": `Prism colour ${i + 1}` }) as HTMLInputElement;
          input.oninput = () => {
            colors[i] = input.value;
            updatePreview();
          };
          return h("label.ce-gifter-swatch", null, input, h("span", null, String(i + 1)));
        }),
      );
      animation.disabled = colors.length === 1;
      for (const b of count.querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.n) === colors.length);
      updatePreview();
    }
    const count = h(
      "div.segmented.ce-gifter-count",
      { role: "group", "aria-label": "Number of Prism colours" },
      ...[1, 2, 3].map((n) =>
        h("button", { type: "button", "data-n": String(n), onclick: () => {
          colors = Array.from({ length: n }, (_, i) => colors[i] ?? defaults[i]);
          drawColors();
        } }, n === 1 ? "1 colour" : `${n} colours`),
      ),
    );
    animation.onchange = updatePreview;
    const presets = [
      { name: "Prism", colors: ["#b98cff", "#7fcfff", "#ffb9db"] },
      { name: "Sunset", colors: ["#ff9e73", "#e28aff", "#ffd17a"] },
      { name: "Aurora", colors: ["#74efc0", "#91c7ff", "#b98cff"] },
    ];
    const controls = h(
      "section.ce-gifter-colors",
      { "aria-label": "Prism Gifter colours" },
      h(
        "div.ce-gifter-heading",
        null,
        preview,
        h("h4", null, "Prism colours"),
      ),
      h("div.ce-gifter-custom", null, count, inputs),
      h(
        "div.ce-gifter-presets",
        null,
        ...presets.map((preset) =>
          h(
            "button.btn",
            {
              type: "button",
              onclick: () => {
                colors = [...preset.colors];
                drawColors();
              },
            },
            h(
              "span.ce-gifter-preset-swatches",
              { "aria-hidden": "true" },
              ...preset.colors.map((color) => h("i", { style: `background:${color}` })),
            ),
            preset.name,
          ),
        ),
      ),
      h(
        "div.ce-gifter-actions",
        null,
        h("label.acct-toggle", null, animation, h("span", null, "Slow colour shift")),
        h(
          "button.btn",
          {
            type: "button",
            onclick: () => void save(selected, { gifterColors: colors, gifterAnimated: colors.length > 1 && animation.checked }),
          },
          "Save colours",
        ),
      ),
    );
    drawColors();
    return controls;
  }
  render();
  return root;
}
