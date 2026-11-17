// The Support page's cards (ui/support.ts): the look the Player card section's card wears, the card on the first tab
// and the Player card section.
//
// The first tab's card (cardShowcase): your own card (a fresh card under "Your name" without a profile) fading slowly
// from one design to the next. The designs are put together from the catalogue (support-page.ts cardDesign): over one
// lap every card border and effect has been on screen. No names, no buttons, nothing to pick: it rests while the
// pointer or the focus is on it, while it is off screen, and under reduced motion (the first design, still).
//
// Player card (the page's third tab): your own card, large, in a Supporter frame, background and title, with a row of
// choices for each thing a Supporter can put on a card. What the rows are comes from the catalogue (support-page.ts):
// the frame, background and title rows list progression.ts' Supporter items for those slots, and there is one row per
// supporter look (supporter-looks.ts: card border, card effect, mini profile effect, avatar decoration; creators.ts:
// the name's colour and effect; then its font and bold / italic). An effect added to CARD_EFFECTS shows up here with
// no change to this file.
//
//   ┌ your card, live ──────────────────┬ Card ────────────────────────────────────────────┐
//   │ (ui/card.ts playerCard, drawn and │ Frame        ▭ ▭ ▭ ▭                              │
//   │  changed by drawCard, below)      │ Background   ▭ ▭ ▭ ▭                              │
//   │                                   │ Title        Supporter  …                         │
//   │ a line about saving               │ Border       ▭ ▭ ▭ …        Effect, Mini profile  │
//   │ Support from $5 / Edit card       │ Avatar: Decoration    Name: Colour, Effect, Font  │
//   └───────────────────────────────────┴──────────────────────────────────────────────────┘
//
// Everyone can try every look (a preview; nothing is saved). A supporter's look picks are their real look: saved a
// moment after the last pick (ui/support.ts lookSaver). The frame, background and title are worn from Edit card.
// A choice under the pointer (or with the keyboard's focus) shows on the card while it is there, as hovering an item
// does on the Loadout's stage: running the pointer along Border or Effect goes over each on the real card.
//
// Nothing here is rebuilt on a pick: the rows are made once and only their marks move, the swatches and the cards are
// updated in place, and a section that is not on screen redraws when it is next shown.

import { api, type Profile } from "../api";
import { NAME_COLORS, peakOf, type NameColorId } from "../creators";
import { cosmetic, DEFAULT_COSMETICS } from "../progression";
import { UNRANKED } from "../ranking";
import { PREVIEW_LOOK, type LookPicks } from "../support-look";
import { cardDesign, looksIn, startCard, SUPPORT_LOOKS, supportCardItems, type CardItemPart, type LookGroup } from "../support-page";
import { nameStyleShown } from "../supporter-looks";
import { myProfile } from "./account-state";
import { playerCard, updatePlayerCard, type CardOverrides, type SupporterLook } from "./card";
import { cosmeticSwatch } from "./card-editor";
import { arrowNav, h } from "./dom";
import { scrollCue } from "./scroll-cue";
import { morph } from "./support-morph";
import { borderChoices, cardEffectChoices, cardFxSwatch, COLOUR_CHOICES, DECO_CHOICES, decoSwatch, EFFECT_CHOICES, FONT_CHOICES, HOVER_FX_CHOICES, hoverFxSwatch, nameSample, styleChoices } from "./supporter-pickers";

// ---------------------------------------------------------------------------------------------
// The look the cards and the rows share: the name's colour, effect and font, the avatar decoration and the card's
// border and effect (support-look.ts). For everyone else a preview; for a supporter their real look.

export interface Look extends LookPicks {
  /** A supporter's own look: the saved gradient colour (null = the automatic paler shade), not the preview's pick. */
  own: { color2: NameColorId | null } | null;
  /** The player's own name ("Your name" until we know it). */
  name: string;
  on(fn: () => void): void;
  set(p: Partial<LookPicks & Pick<Look, "name">>): void;
}

export function lookState(): Look {
  const fns: (() => void)[] = [];
  const l: Look = {
    ...PREVIEW_LOOK,
    own: null,
    name: "Your name",
    on: (fn) => void fns.push(fn),
    set: (p) => (Object.assign(l, p), fns.forEach((f) => f())),
  };
  return l;
}

/** The look as the card reads it: a gradient's second colour is the next colour along (never the same one). */
export function lookAttrs(l: LookPicks & Partial<Pick<Look, "own">>): SupporterLook {
  const more = { nameFont: l.font, nameStyle: l.style, avatarDeco: l.deco, cardBorder: l.border, cardEffect: l.cardEffect, hoverFx: l.hoverFx };
  if (l.own) return { nameColor: l.color, nameEffect: l.effect, nameColor2: l.own.color2, ...more };
  const i = NAME_COLORS.findIndex((c) => c.id === l.color);
  const color2 = NAME_COLORS[(i + 2) % NAME_COLORS.length].id;
  return { nameColor: l.color, nameEffect: l.effect, nameColor2: color2, ...more };
}

// ---------------------------------------------------------------------------------------------
// Whose card it is: the player's own profile when there is one, else a fresh card under their name.

/** A card for someone with no profile to show (a guest the API doesn't know, offline): their name, a fresh start. */
function freshProfile(name: string, provider: string | null): Profile {
  const zeros = [0, 0, 0, 0, 0, 0];
  return {
    player: { id: "", name, avatarUrl: null, provider: provider ?? "", since: new Date().toISOString(), supporter: true },
    mine: true,
    level: { level: 1, xp: 0, into: 0, need: 100, fraction: 0 },
    rank: { scope: "all", points: 0, rank: null, ranked: 0, records: 0, wrs: 0, top10s: 0, group: { id: UNRANKED.id, name: UNRANKED.name, color: UNRANKED.color } },
    styles: [],
    stats: { clearsByTier: zeros, rankedByTier: zeros, maps: 0, pbs: 0, wrs: 0, top10s: 0, bonuses: 0, runs: 0, jumps: 0, seconds: 0, playtime: 0, replayViews: 0, styleMaps: {}, clearedMaps: [] },
    cosmetics: { ...DEFAULT_COSMETICS } as Profile["cosmetics"],
    badges: [],
    achievements: [],
    progress: null,
    featured: [],
  } as unknown as Profile;
}

export interface CardOwner {
  /** The profile the cards draw, as a supporter's (the heart shows). */
  profile(): Profile;
  /** Whether we know whose card it is yet (the profile answered, there is none, or it is taking too long). */
  settled(): boolean;
  on(fn: () => void): void;
  /** The account changed: read the profile again. */
  reload(): void;
}

export function cardOwner(l: Look, who: () => { provider: string } | null): CardOwner {
  let profile: Profile | null = null;
  let loads = 0;
  let settled = !api.available();
  const fns: (() => void)[] = [];
  const tell = () => fns.forEach((f) => f());
  const load = () => {
    const n = ++loads;
    if (!api.available()) return;
    settled = false;
    const done = (p: Profile | null) => {
      if (n !== loads || settled) return;
      settled = true;
      if (p) profile = p;
      // (A new name redraws through the look, which the cards follow too; the rest through tell.)
      if (p && l.name !== p.player.name) l.set({ name: p.player.name });
      tell();
    };
    void myProfile().then(done, () => done(null));
    // A slow profile doesn't hold the card back for long: a fresh card under their name meanwhile.
    setTimeout(() => {
      if (n !== loads || settled) return;
      settled = true;
      tell();
      void myProfile().then((p) => {
        if (!p || n !== loads) return;
        profile = p;
        if (l.name !== p.player.name) l.set({ name: p.player.name });
        tell();
      }, () => {});
    }, 2500);
  };
  load();
  return {
    profile: () => {
      const p = profile ?? freshProfile(l.name, who()?.provider ?? null);
      return { ...p, player: { ...p.player, supporter: true } };
    },
    settled: () => settled,
    on: (fn) => void fns.push(fn),
    reload: () => {
      profile = null;
      load();
      tell();
    },
  };
}

/**
 * What a card on this page wears over the profile's own: a frame, background and title, and a look. Never a map
 * background (v0.0.43, ui/card-mapbg.ts): a world record holder's map would lie over every Supporter background this
 * page is here to show, and it is not something supporting gives.
 */
function cardOverrides(p: Profile, part: Partial<Record<CardItemPart, string | null>>, l: LookPicks & Partial<Pick<Look, "own">>): CardOverrides {
  return { cosmetics: { ...p.cosmetics, ...part } as Profile["cosmetics"], nameLook: lookAttrs(l), mapBg: null };
}

/**
 * THE one place a card on this page is drawn or changed: the first call puts a card in `host`, every later one makes
 * the card already there show `p` with `o` (ui/card.ts updatePlayerCard: only what differs is touched, so the avatar
 * is not loaded again, the running layers keep their place on the page clock, and the tilt and the pointer's light
 * stay where they are).
 */
export function drawCard(host: HTMLElement, p: Profile, o: CardOverrides): void {
  const live = host.firstElementChild as HTMLElement | null;
  if (!live) return void host.append(playerCard(p, o));
  updatePlayerCard(live, p, o);
}

const quietMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

// ---------------------------------------------------------------------------------------------
// The first tab's card: one design fading into the next.
//
// Two card hosts on top of each other and never more (two live cards at the most): the one showing, and under or over
// it the one the next design is drawn into. A change is the upper card's opacity going from 0 to 1 over the lower one,
// which stays fully there until the fade is done and is then switched off: opacity is all that ever changes, both
// cards are in the same box from the start, so nothing moves, resizes or flashes. The card that is not showing rests
// (.fx-off) and is not painted.

/** How long a design stays (ms), and how long the next takes to come in over it (support.css .sp-show-card). */
export const SHOWCASE_HOLD_MS = 5200;
export const SHOWCASE_FADE_MS = 1600;

export interface Showcase {
  el: HTMLElement;
}

export function cardShowcase(l: Pick<Look, "on">, owner: CardOwner, signal: AbortSignal): Showcase {
  const hosts = [h("div.sp-show-card.on"), h("div.sp-show-card.fx-off")];
  // (Focusable, so the keyboard can stop it on a design as the pointer can.)
  const el = h("div.sp-show", { role: "img", "aria-label": "Your player card in Supporter frames, borders and effects", tabindex: "0" }, h("div.sp-show-stack", null, ...hosts));
  let front = 0;
  let n = 0;
  let timer = 0;
  let settle = 0;
  let onScreen = false;
  let held = false;
  let stale = false;
  const draw = (host: HTMLElement, i: number) => {
    stale = false;
    const d = cardDesign(i);
    const p = owner.profile();
    drawCard(host, p, cardOverrides(p, { frame: d.frame, background: d.background, title: d.title }, d.look));
  };
  const next = () => {
    timer = 0;
    const from = hosts[front];
    const to = hosts[1 - front];
    front = 1 - front;
    draw(to, ++n);
    // The incoming card goes on top, wakes, and fades in over the one showing.
    to.classList.remove("fx-off", "under");
    from.classList.add("under");
    // (A frame for the card just drawn to be styled at opacity 0 before the fade starts.)
    requestAnimationFrame(() => to.classList.add("on"));
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      // Covered now: the old card goes out at once (no fade of its own) and rests.
      from.classList.remove("on");
      from.classList.add("fx-off");
    }, SHOWCASE_FADE_MS + 80);
    plan();
  };
  /** Runs only while it can be seen and nobody is looking closely; a still card under reduced motion and Potato. */
  const plan = () => {
    const run = onScreen && !held && owner.settled() && document.visibilityState === "visible" && !quietMotion() && !signal.aborted;
    if (!run) {
      clearTimeout(timer);
      timer = 0;
    } else if (!timer) timer = window.setTimeout(next, SHOWCASE_HOLD_MS + SHOWCASE_FADE_MS);
  };
  const hold = (on: boolean) => {
    held = on;
    plan();
  };
  el.addEventListener("pointerenter", () => hold(true));
  el.addEventListener("pointerleave", () => hold(el.matches(":focus-visible")));
  el.addEventListener("focus", () => hold(el.matches(":focus-visible") || el.matches(":hover")));
  el.addEventListener("blur", () => hold(el.matches(":hover")));
  document.addEventListener("visibilitychange", plan, { signal });
  // Off screen also means its tab is not the one showing (the panel is display: none).
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    if (onScreen && stale && owner.settled()) draw(hosts[front], n);
    plan();
  });
  io.observe(el);
  signal.addEventListener("abort", () => {
    io.disconnect();
    clearTimeout(timer);
    clearTimeout(settle);
  });
  // Whose card it is isn't known for the first moments (the profile is on its way): the card's place is held, unseen,
  // and it comes in once, as theirs, instead of showing a stand-in and swapping every line of it.
  const settle2 = () => {
    el.classList.toggle("pending", !owner.settled());
    if (owner.settled()) draw(hosts[front], n);
    plan();
  };
  owner.on(settle2);
  // (Only the name matters here: the look being picked on Player card is that section's. While another tab shows,
  // the redraw waits until this one is back.)
  l.on(() => {
    if (!owner.settled()) return;
    if (onScreen) draw(hosts[front], n);
    else stale = true;
  });
  settle2();
  return { el };
}

// ---------------------------------------------------------------------------------------------
// The rows of choices.

interface Choice {
  id: string | null;
  name: string;
}

interface Row {
  el: HTMLElement;
  sync(): void;
}

/**
 * One row: its label, the picked choice's name under it (the choice under the pointer while there is one, so every
 * swatch can be read by name), and a radio group of swatch buttons. Made once; sync() moves the mark, and redraws the
 * swatches in place only when what they are drawn from (`dep`) changed, or makes the buttons again when the choices
 * themselves did (the cuts a font has).
 */
function optionRow(o: {
  /** data-row: the look's key or the card part. */
  key: string;
  label: string;
  aria: string;
  choices: () => Choice[];
  current: () => string | null;
  swatch: (id: string | null, name: string) => HTMLElement;
  /** What the swatches depend on besides their own id. */
  dep?: () => string;
  pick: (id: string | null) => void;
  /** A choice is under the pointer or has the focus (undefined: none): the card tries it on. */
  point?: (id: string | null | undefined) => void;
  /** Extra class on the options (how this row's swatches are laid out). */
  cls?: string;
}): Row {
  const said = h("small");
  const opts = h(`div.sp-opts${o.cls ? `.${o.cls}` : ""}`, { role: "radiogroup", "aria-label": o.aria });
  const el = h("div.sp-row", { "data-row": o.key }, h("div.sp-row-label", null, h("span", null, o.label), said), opts);
  let ids = "\u0000";
  let dep = "";
  let buttons: { c: Choice; b: HTMLButtonElement }[] = [];
  let pointed: string | null = null;
  const nameOf = (id: string | null) => buttons.find((x) => x.c.id === id)?.c.name ?? "";
  const say = () => (said.textContent = pointed ?? nameOf(o.current()));
  // Only the choice under the pointer moves; the rest of the row rests (.fx-off holds a border, effect or decoration
  // at its first frame), so a row of twelve decorations isn't twelve things spinning. The picked one is moving on the
  // card beside the rows.
  const rest = () => {
    for (const { b } of buttons) b.classList.toggle("fx-off", b.title !== pointed);
  };
  const at = (b: HTMLElement | null) => {
    const next = b ? b.title : null;
    if (next === pointed) return;
    pointed = next;
    say();
    rest();
    o.point?.(b ? buttons.find((x) => x.b === b)?.c.id : undefined);
  };
  opts.addEventListener("pointerover", (e) => (e as PointerEvent).pointerType !== "touch" && at((e.target as HTMLElement).closest<HTMLElement>(".sp-opt")));
  opts.addEventListener("pointerleave", () => at(null));
  opts.addEventListener("focusin", (e) => (e.target as HTMLElement).matches(":focus-visible") && at((e.target as HTMLElement).closest<HTMLElement>(".sp-opt")));
  opts.addEventListener("focusout", () => at(null));
  arrowNav(opts, ".sp-opt", { grid: true });
  const sync = () => {
    const choices = o.choices();
    // A row with nothing to choose (bold / italic for a font with neither) keeps its place, unseen: the list never
    // changes height under the pointer or a scrolled view.
    el.classList.toggle("sp-row-off", choices.length === 0);
    el.inert = choices.length === 0;
    if (!choices.length && buttons.length) return;
    const nextIds = choices.map((c) => `${c.id}:${c.name}`).join("|");
    const nextDep = o.dep?.() ?? "";
    if (nextIds !== ids) {
      // Keep keyboard focus on the same place in the row when it is made again.
      const at = buttons.findIndex((x) => x.b === document.activeElement);
      buttons = choices.map((c) => ({
        c,
        b: h("button.sp-opt", { type: "button", role: "radio", "aria-label": c.name, title: c.name, "data-id": c.id ?? "none", onclick: () => o.pick(c.id) }, o.swatch(c.id, c.name)) as HTMLButtonElement,
      }));
      opts.replaceChildren(...buttons.map((x) => x.b));
      if (at >= 0) buttons[Math.min(at, buttons.length - 1)]?.b.focus({ preventScroll: true });
    } else if (nextDep !== dep) {
      for (const { c, b } of buttons) morph(b.firstElementChild!, o.swatch(c.id, c.name));
    }
    ids = nextIds;
    dep = nextDep;
    const cur = o.current();
    const has = buttons.some((x) => x.c.id === cur);
    buttons.forEach(({ c, b }, i) => {
      const on = c.id === cur;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on || (!has && i === 0) ? 0 : -1;
    });
    rest();
    say();
  };
  return { el, sync };
}

const GROUP_NAME: Record<LookGroup, string> = { card: "Card", avatar: "Avatar", name: "Name" };

export interface CardSection {
  el: HTMLElement;
  /** The tab came back: draw what changed while it was away. */
  shown(): void;
  /** Whether the player is a supporter changed (the note and the button under the card). */
  supporter(yes: boolean): void;
}

export function cardSection(o: {
  look: Look;
  owner: CardOwner;
  /** The look's save state, shown beside the note (a supporter's picks save). */
  status: HTMLElement;
  /** The button under the card for someone who isn't a supporter: to the ask, with its words. */
  toAsk: () => void;
  askLabel: () => string;
  editCard: () => void;
}): CardSection {
  const l = o.look;
  let stale = false;
  let supporter = false;
  // The card's own parts being tried: the first Supporter frame, background and title, then whatever is picked.
  const part: Record<CardItemPart, string | null> = startCard();
  // The choice under the pointer (or with the keyboard's focus): shown on the card while it is there, never picked or
  // saved by that. Running the pointer along a row goes over every border or effect on the real card.
  let tried: { part?: Partial<Record<CardItemPart, string | null>>; look?: Partial<LookPicks> } | null = null;
  const tryOn = (next: typeof tried) => {
    tried = next;
    drawOwn();
  };

  const host = h("div.sp-card-host");
  const note = h("p.sp-card-note");
  const action = h("div.sp-actions");
  const view = h("div.sp-card-view", null, host, h("div.sp-card-foot", null, note, o.status), action);

  const player = () => o.owner.profile().player;
  const peak = () => peakOf(player().special);
  const attrs = () => lookAttrs(l);
  // What each look row draws: its choices and swatches are Edit card's (ui/supporter-pickers.ts). Keyed like
  // support-page.ts SUPPORT_LOOKS, so a look with no row fails the typecheck.
  const LOOK_ROWS: Record<keyof LookPicks, { choices: () => Choice[]; swatch: (id: string | null) => HTMLElement; dep?: () => string; cls?: string }> = {
    border: { choices: () => borderChoices(peak()), swatch: (id) => cardFxSwatch(peak(), id as LookPicks["border"], null, l.color), dep: () => `${l.color}|${peak()}` },
    cardEffect: { choices: () => cardEffectChoices(peak()), swatch: (id) => cardFxSwatch(peak(), null, id as LookPicks["cardEffect"], l.color), dep: () => `${l.color}|${peak()}` },
    hoverFx: { choices: () => HOVER_FX_CHOICES, swatch: (id) => hoverFxSwatch(id as LookPicks["hoverFx"], l.color), dep: () => String(l.color) },
    deco: { choices: () => DECO_CHOICES, swatch: (id) => decoSwatch(player(), id as LookPicks["deco"], l.color), dep: () => `${l.color}|${player().id}|${player().avatarUrl}|${player().name}`, cls: "sp-opts-av" },
    color: { choices: () => COLOUR_CHOICES.map((c) => ({ id: c.id, name: c.name })), swatch: (id) => h("span.sp-dot", { "aria-hidden": "true", style: `--sw:${COLOUR_CHOICES.find((c) => c.id === id)?.hex ?? "#eef1f6"}` }), cls: "sp-opts-dots" },
    effect: { choices: () => EFFECT_CHOICES, swatch: (id) => nameSample({ ...attrs(), nameEffect: id as LookPicks["effect"] }), dep: () => `${l.color}|${l.font}|${l.style}`, cls: "sp-opts-aa" },
    font: { choices: () => FONT_CHOICES, swatch: (id) => nameSample({ ...attrs(), nameFont: id as LookPicks["font"] }), dep: () => `${l.color}|${l.effect}|${l.style}`, cls: "sp-opts-aa" },
    // Bold / italic in the cuts the picked font has (none: no row); a pick the font lacks shows as Plain.
    style: { choices: () => styleChoices(l.font), swatch: (id) => nameSample({ ...attrs(), nameStyle: id as LookPicks["style"] }), dep: () => `${l.color}|${l.effect}|${l.font}`, cls: "sp-opts-aa" },
  };
  const currentOf = (k: keyof LookPicks): string | null => (k === "style" ? nameStyleShown(l.font, l.style) : l[k]);

  const rows: Row[] = [];
  const itemRows = supportCardItems().map((g) => {
    const row = optionRow({
      key: g.slot,
      label: g.label,
      aria: `Card ${g.label.toLowerCase()}`,
      choices: () => g.items.map((c) => ({ id: c.id, name: c.name })),
      current: () => part[g.slot],
      swatch: (id, name) => (g.slot === "title" ? h("span.sp-title", null, name) : cosmeticSwatch(cosmetic(id), g.slot)),
      pick: (id) => {
        part[g.slot] = id;
        row.sync();
        drawOwn();
      },
      point: (id) => tryOn(id === undefined ? null : { part: { [g.slot]: id } }),
      cls: g.slot === "title" ? "sp-opts-text" : undefined,
    });
    rows.push(row);
    return row;
  });
  const lookRows = (group: LookGroup) =>
    looksIn(group).map((k) => {
      const def = LOOK_ROWS[k];
      const row = optionRow({
        key: k,
        label: SUPPORT_LOOKS[k].label,
        aria: `${GROUP_NAME[group]} ${SUPPORT_LOOKS[k].label.toLowerCase()}`,
        choices: def.choices,
        current: () => currentOf(k),
        swatch: def.swatch,
        dep: def.dep,
        pick: (id) => l.set({ [k]: id } as Partial<LookPicks>),
        point: (id) => tryOn(id === undefined ? null : { look: { [k]: id } as Partial<LookPicks> }),
        cls: def.cls,
      });
      rows.push(row);
      return row.el;
    });
  const group = (name: string, ...els: HTMLElement[]) => h("section.sp-group", { "aria-label": name }, h("h3.sp-h", null, name), ...els);
  const list = h(
    "div.sp-card-rows",
    null,
    group(GROUP_NAME.card, ...itemRows.map((r) => r.el), ...lookRows("card")),
    group(GROUP_NAME.avatar, ...lookRows("avatar")),
    group(GROUP_NAME.name, ...lookRows("name")),
  );
  // The edge fades while there are more rows below (the rows rest, so the fade is not a mask over moving things).
  scrollCue(list);
  const el = h("div.sp-card", { role: "tabpanel", "aria-labelledby": "sp-tab-card" }, view, list);

  function drawOwn(): void {
    const p = o.owner.profile();
    drawCard(host, p, cardOverrides(p, { ...part, ...tried?.part }, tried?.look ? { ...l, ...tried.look } : l));
  }
  const drawFoot = () => {
    note.textContent = supporter ? "Your name, avatar and card looks save as you pick them. The frame, background and title are worn from Edit card." : "This is your own card. Everything here is a preview until you support.";
    action.replaceChildren(
      supporter ? h("button.btn", { type: "button", onclick: o.editCard }, "Edit card") : h("button.btn.primary", { type: "button", onclick: o.toAsk }, o.askLabel()),
    );
  };
  const draw = () => {
    if (!el.offsetParent && el.isConnected) return void (stale = true);
    stale = false;
    for (const r of rows) r.sync();
    drawOwn();
  };
  l.on(draw);
  o.owner.on(draw);
  for (const r of rows) r.sync();
  drawOwn();
  drawFoot();
  return {
    el,
    shown: () => stale && draw(),
    supporter: (yes) => {
      if (yes === supporter) return;
      supporter = yes;
      drawFoot();
    },
  };
}
