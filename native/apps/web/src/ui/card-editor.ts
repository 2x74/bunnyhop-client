import {profileWriteGuard} from "./profile-write";
import { NewTracker as IndicatorTracker } from "./new-tracker";
// Your profile card, edited in place (v0.0.9: no Customise tab). cardEditor() is the small editor under the card in
// ui/profile.ts's "Edit card" mode: background, frame, title, name (supporters), badges and links; one click equips and
// autosaves (POST /me/cosmetics, /me/badges, /me/links, /me/supporter; strict server-side validation). Everything you look like in the game
// (knife, finish, gloves, colourway, hat, ghost, trail) is the Loadout (ui/loadout-view.ts).
//
// Also here, shared with the Loadout: the Loadout model (draft + saved choice, autosave) and the NewTracker ("new since
// last seen" dots).

import { api, ApiError, type CosmeticChoice, type Profile, type SupporterSettings } from "../api";
import { getGhostCosmetics, getLoadout, getOutfit, rememberUnlocks, setGhostCosmetics, setLoadout, setOutfit } from "../player/cosmetics";
import { loadoutFor, sameLoadout } from "../loadout";
import { colourway } from "../player/bunny/palettes";
import { achievement, ACHIEVEMENTS, COSMETICS, crownOf, DEFAULT_COSMETICS, type CosmeticDef, type CosmeticSlot } from "../progression";
import { badgeToken } from "./badges";
import { arrowNav, h } from "./dom";
import { isLoadoutSlot, listedCosmetic, loadoutSwatch, shownCosmetic } from "./loadout-ui";
import { availableNow } from "./community";
import { CARD_PARTS, type CardPart } from "./cosmetic-slots";
import { accountGeneration, refreshMyProfile } from "./account-state";
import { nameMarks } from "./marks";
import { SPECIAL_BADGES, GIFTER_TIERS } from "../creators";
import { linkIcon } from "./marks";
import { LINK_PLATFORMS, linkHint, NAME_COLORS, NAME_EFFECTS, parseHandle, PLATFORM_NAME, usesColor2, type LinkPlatform, type NameColorId, type NameEffect, type NameLook, type ProfileLinks } from "../creators";
import { goalText } from "./loadout-view";
import { nameAttrs } from "./marks";
import { autoBadges, earnedLine, lockInfo, profileRanks, progressText, newDot, ownedCosmetics, shortGoal, ownedIds, type LockInfo } from "./unlocks";
import { pastGoal } from "./unlock-text";

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

  constructor(readonly p: Profile) {
    this.writes=profileWriteGuard(p.player.id);
    this.choice = { ...DEFAULT_COSMETICS, ...p.cosmetics };
    this.saved = { ...this.choice };
    this.badges = [...p.badges];
    this.owned = ownedCosmetics(p);
    this.earned = new Set(p.achievements.map((a) => a.id));
    if (p.mine) {
      // Keep this device's ghost colours / colourway in step with the account (another device may have changed them).
      rememberUnlocks([...this.owned]);
      if (this.choice.outfit && this.choice.outfit !== getOutfit()) setOutfit(this.choice.outfit);
      const g = getGhostCosmetics();
      if (g.ghostId !== this.choice.ghost || g.trailId !== this.choice.trail) setGhostCosmetics(this.choice.ghost, this.choice.trail);
      this.syncLoadout();
    }
  }

  /** Your equipped knife / finish / gloves -> the viewmodel, your bunny, replays. */
  private syncLoadout(): void {
    if (!this.p.mine || !this.current()) return;
    const l = loadoutFor(this.choice, crownOf(profileRanks(this.p)));
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
    if (this.choice[slot] === id) return;
    this.apply({ [slot]: id });
  }

  /** Changes several slots at once (Randomise / Reset); `label` + undo in the status line. */
  apply(patch: Partial<CosmeticChoice>, label?: string): void {
    if (!this.current()) return;
    const before = { ...this.choice };
    this.choice = { ...this.choice, ...patch };
    Object.assign(this.pending, patch);
    // Loadout items show at once (the preview stage and the game follow it); a refused save puts it back.
    if (Object.keys(patch).some((k) => isLoadoutSlot(k) || k === "hat" || k === "body")) this.syncLoadout();
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
        setGhostCosmetics(this.choice.ghost, this.choice.trail);
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
// The card editor: your own profile's card in edit mode (ui/profile.ts "Edit card"). The card stays where it is and
// its parts are picked under it: one row of parts, one small picker. Hover previews on the card, a click equips and
// autosaves; a locked item says how to get it in one short line.

export interface CardEditor {
  el: HTMLElement;
  part(): CardPart;
  select(part: CardPart): void;
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
  /** A name look to show on the card while hovered, over the saved one (undefined: back to the saved one). */
  onNamePreview?: (look: NameLook | undefined) => void;
  done: () => void;
}

let lastPart: CardPart = "background";

/** A picker item: look, name, one line. */
function pickItem(look: HTMLElement | null, name: string, o: { id: string; on: boolean; isNew?: boolean; lock?: LockInfo | null; sub?: string | null; tag?: string | null; pick: () => void; preview?: () => void; item?: CosmeticDef | null }): HTMLElement {
  const lock = o.lock ?? null;
  const el = h(
    `button.ce-item${o.on ? ".on" : ""}${lock ? ".locked" : ""}`,
    {
      type: "button",
      "data-id": o.id,
      "aria-pressed": lock ? undefined : String(o.on),
      "aria-disabled": lock ? "true" : undefined,
      "aria-label": `${name}${o.on ? ", on your card" : ""}${lock ? `, locked: ${lock.goal}` : ""}${o.isNew ? ", new" : ""}`,
      title: lock ? lock.hint : (o.sub ?? undefined),
      onclick: () => (lock ? undefined : o.pick()),
    },
    look,
    h("span.ce-text", null, h("b", null, name, o.isNew ? newDot("new") : null), lock ? h("small", null, h("span.pf-tile-lock", { html: LOCK_SVG }), goalText(o.item ?? null, lock.goal, true)) : o.sub ? h("small", null, o.sub) : null),
    o.tag ? h("span.ce-tag", null, o.tag) : o.on ? h("span.ce-on", { html: CHECK_SVG }) : null,
    lock && lock.fraction !== null ? h("span.pf-tile-prog", { style: `--f:${lock.fraction}`, "aria-hidden": "true" }) : null,
  );
  if (o.preview) {
    el.addEventListener("pointerenter", o.preview);
    el.addEventListener("focus", o.preview);
  }
  return el;
}

export function cardEditor(p: Profile, lo: Loadout, news: NewTracker, o: CardEditorOpts): CardEditor {
  let part: CardPart = o.part ?? lastPart;
  const linksEd = linksEditor(p, o.onLinks);
  const boosterRow = boosterSwitch(p, o.onBooster);
  const supporter = supporterEditor(p, (s) => {
    o.onSupporter?.(s);
    if (part === "name") drawBody();
  });
  // The Name part is for supporters only.
  const parts = CARD_PARTS.filter((x) => x.part !== "name" || !!p.supporterSettings);
  if (part === "name" && !p.supporterSettings) part = "background";
  const tabs = h("div.ce-parts", { role: "tablist", "aria-label": "Card parts" });
  const status = h("span.pf-status", { role: "status", "aria-live": "polite" });
  const body = h("div.ce-body", { role: "tabpanel", tabindex: "-1" });
  const doneBtn = h("button.btn.primary.ce-done", { type: "button", onclick: () => o.done() }, "Done");
  const el = h("section.ce", { "aria-label": "Edit your card" }, h("div.ce-head", null, tabs, status), body, h("div.ce-foot", null, doneBtn));

  const partIds = (x: CardPart) => (x === "badges" ? [...lo.earned] : x === "links" || x === "name" ? [] : COSMETICS.filter((c) => c.slot === x && shownCosmetic(c, lo.owned)).map((c) => c.id));

  function drawTabs(): void {
    tabs.replaceChildren(
      ...parts.map(({ part: x, label }) =>
        h(
          `button.ce-part${x === part ? ".on" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(x === part), tabindex: x === part ? "0" : "-1", "data-part": x, onclick: () => select(x) },
          label,
          x !== part && news.pendingIn(partIds(x)) > 0 ? newDot("new unlocks") : null,
        ),
      ),
    );
  }
  tabs.addEventListener("keydown", (e) => {
    const i = parts.findIndex((x) => x.part === part);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -9;
    if (j === -9) return;
    e.preventDefault();
    select(parts[(j + parts.length) % parts.length].part);
    tabs.querySelector<HTMLElement>(".ce-part.on")?.focus();
  });

  let statusTimer = 0;
  function drawStatus(): void {
    const st = lo.status;
    status.className = `pf-status ${st.kind}`;
    status.replaceChildren(st.kind === "saved" ? h("span.pf-status-ok", { html: CHECK_SVG }) : "", st.kind === "idle" ? "" : st.text);
    clearTimeout(statusTimer);
    if (st.kind === "saved") statusTimer = window.setTimeout(() => status.classList.add("fade"), 2200);
  }

  const lockOf = (c: CosmeticDef) => lockInfo(c, p.level, p.progress, profileRanks(p), p.role);

  function drawBody(): void {
    const scroll = body.scrollTop;
    if (part === "links") {
      body.replaceChildren(linksEd.el);
      body.scrollTop = scroll;
      return;
    }
    let items: HTMLElement[];
    if (part === "name") {
      if (!supporter) return void body.replaceChildren();
      // A supporter's name look: the colour (white unless picked), the effect (plain unless picked) and, for the
      // gradients, the second colour. Each shows on the card while hovered.
      const s = p.supporterSettings!;
      const cur: NameLook = { nameColor: s.nameColor, nameEffect: s.nameEffect, nameColor2: s.nameColor2 };
      const grid = (cls: string, list: HTMLElement[]) => {
        const g = h(`div.ce-grid.${cls}`, null, ...list);
        g.addEventListener("pointerleave", () => o.onNamePreview?.(undefined));
        g.addEventListener("focusout", (e) => !g.contains(e.relatedTarget as Node | null) && o.onNamePreview?.(undefined));
        arrowNav(g, ".ce-item", { grid: true });
        return g;
      };
      const dot = (hex: string) => h("span.pf-sw.pf-sw-dot", { "aria-hidden": "true", style: `--sw:${hex}` });
      const colours: { id: NameColorId | null; name: string; hex: string }[] = [{ id: null, name: "White", hex: "#eef1f6" }, ...NAME_COLORS];
      const colourGrid = grid(
        "ce-grid-name",
        colours.map((c) =>
          pickItem(dot(c.hex), c.name, { id: c.id ?? "", on: (cur.nameColor ?? null) === c.id, pick: () => void supporter.save({ nameColor: c.id }), preview: () => o.onNamePreview?.({ nameColor: c.id }) }),
        ),
      );
      const effects: { id: NameEffect | null; name: string }[] = [{ id: null, name: "Plain" }, ...NAME_EFFECTS];
      const sample = (look: NameLook) => {
        const a = nameAttrs(look, "#eef1f6");
        return h("span.pf-sw.pf-sw-name", { "aria-hidden": "true", style: a.style, class: a.class }, "Aa");
      };
      const fxGrid = grid(
        "ce-grid-name",
        effects.map((e) =>
          pickItem(sample({ ...cur, nameEffect: e.id }), e.name, { id: e.id ?? "plain", on: (cur.nameEffect ?? null) === e.id, pick: () => void supporter.save({ nameEffect: e.id }), preview: () => o.onNamePreview?.({ nameEffect: e.id }) }),
        ),
      );
      const second = usesColor2(cur.nameEffect)
        ? grid(
            "ce-grid-name",
            [{ id: null as NameColorId | null, name: "Automatic", hex: "" }, ...NAME_COLORS].map((c) =>
              pickItem(c.id ? dot(c.hex) : sample({ ...cur, nameColor2: null }), c.name, {
                id: c.id ?? "auto",
                on: (cur.nameColor2 ?? null) === c.id,
                pick: () => void supporter.save({ nameColor2: c.id }),
                preview: () => o.onNamePreview?.({ nameColor2: c.id }),
              }),
            ),
          )
        : null;
      body.replaceChildren(h("p.ce-label", null, "Colour"), colourGrid, h("p.ce-label", null, "Effect"), fxGrid, ...(second ? [h("p.ce-label", null, "Second colour"), second] : []));
      body.scrollTop = scroll;
      return;
    }
    if (part === "badges") {
      const picked = lo.badges;
      const earned = [...lo.earned].map(achievement).filter((a): a is NonNullable<typeof a> => !!a).sort((a, b) => b.ring - a.ring || a.name.localeCompare(b.name));
      items = [
        pickItem(h("span.pf-sw.pf-sw-auto", { "aria-hidden": "true" }, "Auto"), "Automatic", { id: "", on: !picked.length, sub: "Your three rarest", pick: () => lo.setBadges([]) }),
        ...earned.map((a) => {
          const at = picked.indexOf(a.id);
          return pickItem(badgeToken(a, { size: "sm" }), a.name, { id: a.id, on: at >= 0, isNew: news.isNew(a.id), sub: pastGoal(a), tag: at >= 0 ? String(at + 1) : null, pick: () => lo.toggleBadge(a.id) });
        }),
        // Then every achievement still to earn, closest first: the goal and how far along you are (hidden ones stay
        // "???" until earned; ones that can't be earned right now aren't listed: ui/community.ts availableNow; nor is
        // Supporter, which isn't a goal to chase).
        ...ACHIEVEMENTS.filter((a) => !lo.earned.has(a.id) && availableNow(a) && a.availability !== "support")
          .map((a) => ({ a, prog: p.progress?.[a.id] ?? null }))
          .map((x) => ({ ...x, f: x.prog && x.prog[1] > 1 ? Math.min(1, x.prog[0] / x.prog[1]) : null }))
          .sort((x, y) => (y.f ?? 0) - (x.f ?? 0))
          .map(({ a, prog, f }) => {
            const goal = a.hidden ? "Hidden achievement" : shortGoal(a);
            const t = a.hidden ? null : progressText(a, prog);
            return pickItem(badgeToken(a, { got: false, size: "sm", progress: prog }), a.hidden ? "???" : a.name, { id: a.id, on: false, lock: { hint: `${goal}${t ? ` · ${t}` : ""}`, goal: t ? `${goal} · ${t}` : goal, fraction: f }, pick: () => {} });
          }),
      ];
    } else {
      const slot = part;
      const list = COSMETICS.filter((c) => c.slot === slot && shownCosmetic(c, lo.owned));
      const mine = list.filter((c) => lo.owned.has(c.id));
      const locked = list.filter((c) => !lo.owned.has(c.id)).sort((a, b) => (lockOf(b).fraction ?? 0) - (lockOf(a).fraction ?? 0));
      const look = (c: CosmeticDef) => (slot === "title" ? null : cosmeticSwatch(c, slot));
      items = [...mine, ...locked].map((c) =>
        pickItem(look(c), c.name, {
          id: c.id,
          on: lo.choice[slot] === c.id,
          isNew: news.isNew(c.id),
          lock: lo.owned.has(c.id) ? null : lockOf(c),
          sub: lo.owned.has(c.id) ? earnedLine(c, p, false) : null,
          item: c,
          pick: () => lo.equip(slot, c.id),
          preview: () => o.onPreview({ [slot]: c.id }),
        }),
      );
      if (slot === "title") items.unshift(pickItem(null, p.rank.group.name, { id: "", on: lo.choice.title === null, sub: "Your rank", pick: () => lo.equip("title", null), preview: () => o.onPreview({ title: null }) }));
    }
    const grid = h(`div.ce-grid.ce-grid-${part}`, null, ...items);
    grid.addEventListener("pointerleave", () => o.onPreview(null));
    grid.addEventListener("focusout", (e) => !grid.contains(e.relatedTarget as Node | null) && o.onPreview(null));
    arrowNav(grid, ".ce-item", { grid: true });
    body.replaceChildren(...(part === "badges" && p.nameBadgeSettings ? [nameBadgeEditor(p, () => o.onPreview(null)), h("div.ce-showcase-heading", null, h("h4", null, "Profile showcase"), h("p.dim", null, "Shown on your profile card"))] : []), grid, part === "badges" && !p.nameBadgeSettings && boosterRow ? boosterRow : "", part === "badges" && !p.nameBadgeSettings && supporter ? supporter.badgeRow : "", part === "badges" && supporter ? supporter.boardRow : "");
    body.scrollTop = scroll;
    news.see(partIds(part));
  }

  function select(x: CardPart): void {
    if (x === part) return;
    part = lastPart = x;
    o.onPreview(null);
    body.scrollTop = 0;
    drawTabs();
    drawBody();
  }

  const off = lo.on(() => {
    if (!el.isConnected) return void off();
    drawStatus();
    drawTabs();
    // Keep focus on the item that was clicked across the redraw.
    const active = document.activeElement as HTMLElement | null;
    const idx = active && body.contains(active) && active.matches(".ce-item") ? [...body.querySelectorAll(".ce-item")].indexOf(active) : -1;
    if (part !== "links") drawBody();
    if (idx >= 0) body.querySelectorAll<HTMLElement>(".ce-item")[idx]?.focus({ preventScroll: true });
  });
  drawTabs();
  drawBody();
  drawStatus();
  return { el, part: () => part, select };
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

type SupporterPatch = { nameColor?: NameColorId | null; nameEffect?: NameEffect | null; nameColor2?: NameColorId | null; showBadge?: boolean; showOnBoard?: boolean };

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
