// The player hover card (v0.0.37): rest the pointer on a player's name or picture on a leaderboard or the ranks (about
// a third of a second), or move keyboard focus onto the name, and a small player card shows: their card frame and
// background, name and marks, title and level, overall rank, and their top 3 records with the points each gives. Players
// whose hardest clear is T7+ get the card's peak layers (ui/card.ts peakLayers), same as the profile card.
//
// Never while mouse look holds the pointer (pointer lock): it hides the moment the lock is taken. Chat and the friends
// dock use the compact size and keep out of the way of typing: any key hides the card, while a text field has focus it
// waits longer before showing, and in chat it opens above the line, away from the input.
//
// Names opt in through playerCell (ui/board-pager.ts), which calls hoverCardFor(el, player): the row already carries the
// name, picture and marks, so only the rest is fetched (GET /players/:id/card, apps/api src/profile.ts playerCardView;
// cached a minute at the edge, and here per player for the page's life). One card at a time, a manual popover in the
// top layer like the run stats card (ui/run-stats.ts), which steps aside while this one is up. It never takes the
// pointer; a click on the name still opens the profile.

import { api, lastKnownMe, type PlayerCardView } from "../api";
import { accountGeneration } from "./account-state";
import { peakOf, type PlayerMarks } from "../creators";
import { cosmetic } from "../progression";
import { fmtPoints, topPercent } from "../ranking";
import { tierLabel } from "../tiers";
import { formatTime } from "../timer";
import { avatarEl } from "./card";
import { cardLayers, watchCardFx } from "./card-fx";
import { decorated } from "./avatar-deco";
import { h } from "./dom";
import { nameAttrs, nameMarks } from "./marks";
import { hideRunStats } from "./run-stats";
import "./hover-card.css";

type Who = { id: string; name: string; avatarUrl: string | null } & PlayerMarks;

const SHOW_MS = 320;
const GAP = 8;
const EDGE = 8;

/**
 * compact: the smaller card (chat, the friends dock). quietWhileTyping: a longer wait while a text field has focus.
 * above: open above the name when there's room (chat, whose input is below its lines).
 */
export interface HoverCardOpts {
  compact?: boolean;
  quietWhileTyping?: boolean;
  above?: boolean;
}
/** The wait while typing (quietWhileTyping). */
const TYPING_SHOW_MS = 800;

const who = new WeakMap<Element, Who>();
const optsOf = new WeakMap<Element, HoverCardOpts>();

/**
 * Cards per viewer (Sol's re-check R5): keyed by the signed-in account and its generation (account-state.ts), kept a
 * minute, all dropped when the account changes (sign-in, sign-out, a switch); an answer that arrives after a change is
 * thrown away. A live roster change to a player (net/mp.ts: a shadow, new marks) drops theirs (forgetHoverCard).
 */
const CACHE_MS = 60_000;
const viewerKey = () => `${lastKnownMe()?.id ?? "-"}:${accountGeneration()}`;

const typing = (): boolean => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.isContentEditable || (a instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(a.type)) || a instanceof HTMLTextAreaElement);
};
/** Never under a locked pointer (mouse look). */
const blocked = (_el: Element): boolean => !!document.pointerLockElement;
const cache = new Map<string, { at: number; value: Promise<PlayerCardView | null> }>();

function load(id: string): Promise<PlayerCardView | null> {
  const key = `${viewerKey()}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (cache.size > 200) cache.clear();
  const value = api.playerCard(id).then(
    (v) => (key.startsWith(`${viewerKey()}:`) ? v : null), // the account changed meanwhile: not this viewer's answer
    () => {
      cache.delete(key);
      return null;
    },
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drops the cached card of player `id` (a live roster change) and hides it if it's showing. */
export function forgetHoverCard(id: string): void {
  for (const k of cache.keys()) if (k.endsWith(`:${id}`)) cache.delete(k);
  if (current && who.get(current.el)?.id === id) hideHoverCard();
}

let card: HTMLElement | null = null;
const canPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
function cardEl(): HTMLElement {
  if (!card) {
    card = h("div.hc-pop", { role: "tooltip", id: "player-hover-card", ...(canPopover ? { popover: "manual" } : {}) });
    card.hidden = true;
  }
  if (!card.isConnected) document.body.append(card);
  return card;
}

/** The card itself (exported for the screenshot tools and the card editor's preview). */
export function hoverCardBody(p: Who, v: PlayerCardView): HTMLElement {
  const frame = (v.cosmetics.frame ?? "frame-plain").replace(/^frame-/, "");
  const bg = (v.cosmetics.background ?? "bg-night").replace(/^bg-/, "");
  // The peak's layers plus a supporter's border and effect (ui/card-fx.ts), as on the profile card.
  const peak = cardLayers(peakOf(p.special), { cardBorder: v.cardBorder, cardEffect: v.cardEffect, nameColor: p.nameColor });
  const title = cosmetic(v.cosmetics.title)?.name ?? v.rank.group.name;
  const r = v.rank;
  const card = h(
    `div.hc.pc-frame-${frame}.pc-bg-${bg}${peak.cls}`,
    { style: `--rank:${r.group.color}${peak.style ? `;${peak.style}` : ""}` },
    peak.aura,
    h(
      "div.hc-inner",
      null,
      ...peak.inner,
      h(
        "div.hc-id",
        null,
        decorated(avatarEl(p, "hc-avatar"), p, { animate: true, watch: false }),
        h(
          "div.hc-who",
          null,
          h("div.hc-nameline", null, h("b.hc-name", nameAttrs(p), p.name), nameMarks(p)),
          h("div.hc-line", null, h("span.hc-title", null, title), h("span.hc-level", null, "Level ", h("b", null, String(v.level.level)))),
        ),
      ),
      h(
        "div.hc-rank",
        null,
        h("b.hc-group", null, r.group.name),
        // No place when the server has no rank ladder to place them on (it never counts the table for a card): the points alone.
        r.rank ? h("span", null, `#${r.rank} · ${topPercent(r.rank, r.ranked)}`) : r.points > 0 ? null : h("span", null, "no points yet"),
        h("span.hc-pts", null, `${fmtPoints(r.points)} pts`),
      ),
      v.top.length
        ? h(
            "ol.hc-top",
            { "aria-label": "Top records by points" },
            ...v.top.map((t) =>
              h(
                `li.t${t.tier ?? "x"}`,
                null,
                h("span.hc-tier", null, tierLabel(t.tier)),
                h("span.hc-map", null, t.map.replace(/^bhop_/, "")),
                h("span.hc-time", null, formatTime(t.time)),
                h("span.hc-rp", null, t.points ? fmtPoints(t.points) : "", t.points ? h("small", null, " pts") : null),
              ),
            ),
          )
        : h("p.hc-empty", null, "No ranked runs yet"),
    ),
  );
  // Its moving layers (peak, supporter) pause off screen; let go when the card is replaced (ui/avatar-deco.ts).
  watchCardFx(card);
  return card;
}

let current: { el: Element; seq: number } | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function hideHoverCard(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  current?.el.removeAttribute("aria-describedby");
  current = null;
  if (card && !card.hidden) {
    card.hidden = true;
    if (canPopover && card.matches(":popover-open")) card.hidePopover();
  }
}

function place(el: HTMLElement, anchor: DOMRect, preferAbove = false): void {
  const w = el.offsetWidth, ht = el.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const below = anchor.bottom + GAP, above = anchor.top - GAP - ht;
  const top = preferAbove && above >= EDGE ? above : below + ht <= vh - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, vh - EDGE - ht);
  const left = Math.min(Math.max(EDGE, anchor.left - 12), Math.max(EDGE, vw - EDGE - w));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function show(el: Element): void {
  const p = who.get(el);
  if (!p || !el.isConnected || blocked(el)) return;
  const my = ++seq;
  current = { el, seq: my };
  void load(p.id).then((v) => {
    if (current?.seq !== my || !el.isConnected || !v || blocked(el)) return;
    hideRunStats();
    const pop = cardEl();
    pop.classList.toggle("hc-compact", !!optsOf.get(el)?.compact);
    pop.replaceChildren(hoverCardBody(p, v));
    pop.hidden = false;
    if (canPopover && !pop.matches(":popover-open")) pop.showPopover();
    el.setAttribute("aria-describedby", pop.id);
    place(pop, el.getBoundingClientRect(), !!optsOf.get(el)?.above);
  });
}

const targetOf = (t: EventTarget | null): Element | null => {
  const el = t instanceof Element ? t.closest("[data-pcard]") : null;
  return el && who.has(el) ? el : null;
};

let bound = false;
function bind(): void {
  if (bound) return;
  bound = true;
  const schedule = (el: Element) => {
    if (current?.el === el || blocked(el)) return;
    hideHoverCard();
    current = { el, seq: ++seq };
    timer = setTimeout(() => {
      timer = null;
      if (current?.el === el) show(el);
    }, optsOf.get(el)?.quietWhileTyping && typing() ? TYPING_SHOW_MS : SHOW_MS);
  };
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = targetOf(e.target);
    if (el) schedule(el);
  });
  document.addEventListener("pointerout", (e) => {
    const el = targetOf(e.target);
    if (el && current?.el === el && !targetOf(e.relatedTarget)) hideHoverCard();
  });
  document.addEventListener("focusin", (e) => {
    const el = targetOf(e.target);
    if (el && (e.target as Element).matches(":focus-visible")) schedule(el);
  });
  document.addEventListener("focusout", (e) => {
    if (current && targetOf(e.target) === current.el) hideHoverCard();
  });
  // Any key (typing in chat, paging a board), any press, or focus moving into a text field hides the card and drops one
  // still on its way: a waiting timer or a request in flight (`current` set), not just a visible card (Sol's re-check N5).
  const pending = () => timer !== null || current !== null || (!!card && !card.hidden);
  addEventListener("keydown", (e) => e.key !== "Tab" && pending() && hideHoverCard(), true);
  addEventListener("pointerdown", () => pending() && hideHoverCard(), true);
  addEventListener("focusin", () => typing() && pending() && hideHoverCard(), true);
  addEventListener("scroll", hideHoverCard, { capture: true, passive: true });
  addEventListener("resize", hideHoverCard, { passive: true });
  addEventListener("blur", hideHoverCard);
  // Mouse look took the pointer (or gave it back): never a card under a locked pointer.
  document.addEventListener("pointerlockchange", hideHoverCard);
  // Another account (or none): nothing from the last one is shown or kept.
  addEventListener("bunnyhop:account", () => {
    cache.clear();
    hideHoverCard();
  });
}

/** Gives `el` (a player's name or picture) the hover card for `p`. */
export function hoverCardFor<T extends Element>(el: T, p: Who, o: HoverCardOpts = {}): T {
  bind();
  who.set(el, p);
  if (o.compact || o.quietWhileTyping || o.above) optsOf.set(el, o);
  el.setAttribute("data-pcard", "");
  return el;
}
