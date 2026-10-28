// A board row's stats card: hover a leaderboard row (about a quarter second) or move keyboard focus into it, or press
// and hold it on a touch screen, and a small card shows what the row doesn't say about the run: when and where it was
// played, the client and its frame rate, the mouse, and the player's attempts on the map (GET /runs/:id/stats, apps/api
// src/run-stats.ts). Rows opt in with data-run (the run id) and data-run-title (the card's heading); bindRunStats on a
// board's root does the rest. Clicks on the row are untouched (a hold that opened the card eats its own click).
//
// One card at a time, in the top layer (a manual popover, so it shows above the board's modal dialog), placed under
// the row or above it, never off-screen. It never takes the pointer. Cards are fetched on first show and kept per run
// for the page's life; a run without one (old, not public, offline) shows nothing.

import { api, type RunStats } from "../api";
import { styleLabel } from "../styles";
import { trackName } from "../zones";
import { h } from "./dom";
import "./run-stats.css";

/** Hover / focus time before the card shows. */
const SHOW_MS = 250;
/** Press-and-hold time on a touch screen. */
const HOLD_MS = 500;
/** A hold that moves this far (px) is a scroll, not a hold. */
const HOLD_SLOP = 10;
/** Gap between the row and the card, and the card and the viewport's edge (px). */
const GAP = 6;
const EDGE = 8;

/** Cards by run id: the answer, or null for a run without one. Failed requests are forgotten (tried again later). */
const cache = new Map<string, Promise<RunStats | null>>();

function load(id: string): Promise<RunStats | null> {
  let p = cache.get(id);
  if (!p) {
    p = api.runStats(id).catch((e: unknown) => {
      if ((e as { status?: number })?.status !== 404) cache.delete(id);
      return null;
    });
    cache.set(id, p);
  }
  return p;
}

/** Common mouse polling rates: an estimate near one of them is shown as it. */
const POLL_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

/** "Browser · Chrome 156", "Desktop app 0.2.2", "Native client 804eac9" from the server's label. */
export function clientText(c: NonNullable<RunStats["client"]>): string {
  if (c.kind === "native") return c.label.replace(/^Native\b/, "Native client");
  if (c.kind === "desktop") return c.label.replace(/^Desktop\b/, "Desktop app");
  return c.label === "Browser" ? "Browser" : `Browser · ${c.label}`;
}

/** An estimated polling rate: the common rate within 15 %, else to the nearest 10 Hz. */
export function pollText(hz: number): string {
  const near = POLL_RATES.find((r) => Math.abs(hz - r) <= r * 0.15);
  return `${(near ?? Math.round(hz / 10) * 10).toLocaleString("en-US")} Hz`;
}

/** Time played, to the minute: "3h 12m", "12m", "under a minute". */
export function playedFor(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return "under a minute";
  const hr = Math.floor(min / 60);
  return hr ? `${hr.toLocaleString("en-US")}h ${min % 60}m` : `${min}m`;
}

const num = (n: number, digits = 0) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Up to two decimals, without trailing zeros (sensitivity 1.2, 0.85). */
const plain = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The card's rows, [label, value], only for what the run recorded. */
export function statsRows(s: RunStats): { run: [string, string][]; setup: [string, string][]; play: [string, string][] } {
  const run: [string, string][] = [];
  const t = Date.parse(s.date);
  if (Number.isFinite(t)) run.push(["Played", new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })]);
  run.push(["Board", `${styleLabel(s.style)}${s.track ? ` · ${trackName(s.track)}` : ""}`]);
  if (s.jumps != null) run.push(["Jumps", num(s.jumps)]);
  if (s.strafes != null) run.push(["Strafes", num(s.strafes)]);
  if (s.sync != null) run.push(["Sync", `${num(s.sync, 1)}%`]);
  if (s.perf != null) run.push(["Perfect hops", `${num(s.perf, 1)}%`]);
  run.push(["Replay views", num(s.views ?? 0)]);

  const setup: [string, string][] = [];
  if (s.client) setup.push(["Client", clientText(s.client)]);
  if (s.version) setup.push(["Game version", `v${s.version}`]);
  if (s.fps !== undefined) setup.push(["Average FPS", num(s.fps)]);
  const m = s.mouse ?? {};
  if (m.sensitivity !== undefined) setup.push(["Sensitivity", `${plain(m.sensitivity)}${m.dpi !== undefined ? ` · ${num(m.dpi)} DPI` : ""}`]);
  else if (m.dpi !== undefined) setup.push(["DPI", num(m.dpi)]);
  if (m.sensitivity !== undefined && m.dpi !== undefined) setup.push(["eDPI", plain(Math.round(m.sensitivity * m.dpi * 100) / 100)]);
  if (m.pollHz !== undefined) setup.push(["Polling rate", pollText(m.pollHz)]);
  if (m.raw !== undefined) setup.push(["Raw input", m.raw ? "On" : "Off"]);
  if (s.turn) setup.push(["Turn speed", `${plain(s.turn.yawSpeed)}°/s · fast ×${plain(s.turn.angleSpeedKey)}`]);

  const play: [string, string][] = [];
  const p = s.play ?? {};
  if (p.attempt !== undefined) play.push(["On this map", `Attempt #${num(p.attempt)}${p.seconds !== undefined ? ` · ${playedFor(p.seconds)} played` : ""}`]);
  if (p.session !== undefined) play.push(["This session", `Attempt ${num(p.session)}${p.sessionSeconds ? ` · ${playedFor(p.sessionSeconds)} in` : ""}`]);
  return { run, setup, play };
}

const list = (rows: [string, string][]) => h("dl.rs-list", null, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));

function cardBody(title: string, s: RunStats): Node[] {
  const { run, setup, play } = statsRows(s);
  return [
    h("p.rs-head", null, title),
    list(run),
    setup.length ? list(setup) : null,
    play.length ? list(play) : null,
  ].filter((n): n is HTMLDListElement | HTMLParagraphElement => !!n);
}

const skeleton = (title: string): Node[] => [h("p.rs-head", null, title), h("div.rs-skel", { "aria-hidden": "true" }, ...Array.from({ length: 6 }, () => h("span.rb-sk")))];

/** The one card on the page. */
let card: HTMLElement | null = null;
const canPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

function cardEl(): HTMLElement {
  if (!card) {
    card = h("div.rs-card", { role: "tooltip", id: "run-stats-card", ...(canPopover ? { popover: "manual" } : {}) });
    card.hidden = true;
  }
  if (!card.isConnected) document.body.append(card);
  return card;
}

/** Under the anchor rect, or above it when there's no room below; x near `x`; always inside the viewport. */
function place(el: HTMLElement, anchor: DOMRect, x: number): void {
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - ht;
  const top = below + ht <= vh - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, vh - EDGE - ht);
  const left = Math.min(Math.max(EDGE, x - w / 2), Math.max(EDGE, vw - EDGE - w));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** What's shown or about to be: the row, where to put the card, and a token so a stale load doesn't draw. */
let current: { row: HTMLElement; x: number; seq: number } | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The row whose card was closed with Escape: it stays closed until the pointer leaves the row. */
let muted: HTMLElement | null = null;

export function hideRunStats(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  current?.row.removeAttribute("aria-describedby");
  current = null;
  if (card && !card.hidden) {
    card.hidden = true;
    if (canPopover && card.matches(":popover-open")) card.hidePopover();
  }
}

function show(row: HTMLElement, x: number): void {
  const id = row.dataset.run;
  if (!id || !row.isConnected) return;
  const title = row.dataset.runTitle ?? "";
  const my = ++seq;
  current = { row, x, seq: my };
  const el = cardEl();
  const draw = (nodes: Node[]) => {
    if (current?.seq !== my || !row.isConnected) return;
    el.replaceChildren(...nodes);
    el.hidden = false;
    if (canPopover && !el.matches(":popover-open")) el.showPopover();
    row.setAttribute("aria-describedby", el.id);
    place(el, row.getBoundingClientRect(), current.x);
  };
  let settled = false;
  void load(id).then((s) => {
    settled = true;
    if (current?.seq !== my) return;
    if (s) draw(cardBody(title, s));
    else hideRunStats();
  });
  // A card not cached yet: a skeleton until it arrives (a cached one draws in the next microtask, no flash).
  queueMicrotask(() => {
    if (!settled) draw(skeleton(title));
  });
}

function schedule(row: HTMLElement, x: number, ms: number): void {
  if (current?.row === row || muted === row) return;
  hideRunStats();
  current = { row, x, seq: ++seq };
  timer = setTimeout(() => {
    timer = null;
    if (current?.row === row) show(row, current.x);
  }, ms);
}

let globalBound = false;
function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;
  // Escape closes the card first (not the dialog or menu under it).
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !card || card.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      muted = current?.row ?? null;
      hideRunStats();
    },
    true,
  );
  // Any other key (paging the board, typing in its search) or a press anywhere closes it too; Tab moves focus, which
  // moves the card itself (focusin / focusout).
  window.addEventListener("keydown", (e) => {
    if (card && !card.hidden && !["Escape", "Tab", "Shift", "Control", "Alt", "Meta"].includes(e.key)) hideRunStats();
  });
  window.addEventListener("pointerdown", () => card && !card.hidden && hideRunStats(), true);
  window.addEventListener("scroll", hideRunStats, { capture: true, passive: true });
  window.addEventListener("resize", hideRunStats, { passive: true });
  window.addEventListener("blur", hideRunStats);
}

const rowOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>("tr[data-run]") : null);

/** Stats cards for the rows under `root` that carry data-run (delegated: rows may be replaced freely). */
export function bindRunStats(root: HTMLElement): void {
  bindGlobal();
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const row = rowOf(e.target);
    if (row) schedule(row, e.clientX, SHOW_MS);
    else if (current) hideRunStats(); // a header, a gap, or the rows were replaced under the pointer
  });
  root.addEventListener("pointermove", (e) => {
    // Until it shows, the card follows the pointer along the row.
    if (current && timer !== null && current.row === rowOf(e.target)) current.x = e.clientX;
  });
  root.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const row = rowOf(e.target);
    if (!row || row.contains(e.relatedTarget as Node | null)) return;
    if (muted === row) muted = null;
    if (current?.row === row) hideRunStats();
  });
  root.addEventListener("focusin", (e) => {
    const row = rowOf(e.target);
    if (!row || !(e.target as Element).matches(":focus-visible")) return;
    const r = (e.target as Element).getBoundingClientRect();
    schedule(row, r.left + r.width / 2, SHOW_MS);
  });
  root.addEventListener("focusout", (e) => {
    const row = rowOf(e.target);
    if (row && current?.row === row && !row.contains(e.relatedTarget as Node | null)) hideRunStats();
  });

  // Touch: press and hold a row. The click that ends a hold that opened the card is eaten; the next press anywhere
  // closes it (bindGlobal).
  let hold: { id: number; x: number; y: number; row: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
  let eat: HTMLElement | null = null;
  const cancelHold = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  root.addEventListener("pointerdown", (e) => {
    cancelHold();
    eat = null; // a hold whose click never came (a long press often ends without one)
    if (e.pointerType !== "touch") return;
    const row = rowOf(e.target);
    if (!row) return;
    const { clientX: x, clientY: y } = e;
    hold = {
      id: e.pointerId, x, y, row,
      timer: setTimeout(() => {
        hold = null;
        eat = row;
        hideRunStats();
        show(row, x);
      }, HOLD_MS),
    };
  });
  root.addEventListener("pointermove", (e) => {
    if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancelHold();
  });
  root.addEventListener("pointerup", cancelHold);
  root.addEventListener("pointercancel", cancelHold);
  root.addEventListener(
    "click",
    (e) => {
      if (eat && rowOf(e.target) === eat) {
        e.preventDefault();
        e.stopPropagation();
      }
      eat = null;
    },
    true,
  );
  // The long press's own context menu (Android) and text selection callout would cover the card.
  root.addEventListener("contextmenu", (e) => {
    if (eat || (card && !card.hidden && current?.row === rowOf(e.target))) e.preventDefault();
  });
}
