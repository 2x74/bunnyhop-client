import { countryFlag } from "./country-flag";
// Paged boards (ui/ranks.ts, ui/leaderboard.ts): a table whose pages are sized to the space it has, so a page never
// scrolls. Numbered page controls, keyboard paging, "jump to me", a player search, rows pinned above every page (the
// WR on map boards) and your own row pinned below when it isn't on the page. Only the page on screen is fetched; the
// pages either side are prefetched, and a page that isn't cached yet shows skeleton rows of the final size.
//
// Page grid: `base` rows are pinned above every page (map boards: 1, the WR), the rest is cut into pages of `per` rows,
// so page n starts at base + (n - 1) × per. The API's ?around=<id> answers on that same grid (offset = base).

import "./boards.css";
import { avatarImg, pictureOf } from "./avatar";
import { h } from "./dom";
import { landRows } from "./land";
import { icon } from "./icons";
import { nameAttrs, nameMarks } from "./marks";
import type { PlayerMarks } from "../creators";

export interface BoardPage<E> {
  /** Rows on the whole board. */
  total: number;
  /** Board position of entries[0]. */
  offset: number;
  entries: E[];
  /** The viewer's own row, wherever it is (null: not on this board / signed out). */
  me: E | null;
  /** Rows pinned above every page (`base` of them; map boards: the WR). */
  pinned: E[];
  /** The row just above entries[0], if the source knows it (ranks: for the gap to the next place). */
  above: E | null;
}

export interface BoardSource<E> {
  /** Cache identity: changes with the board (map + style + track, or rank scope). */
  key: string;
  load(o: { offset: number; limit: number; around?: string }, signal?: AbortSignal): Promise<BoardPage<E>>;
  search(q: string, signal: AbortSignal): Promise<{ entries: E[]; matches: number }>;
}

export interface RowContext<E> {
  /** The row drawn just above this one (the pinned / `above` row for a page's first row). */
  prev: E | null;
  /** The board's first row (the WR / #1), when known. */
  first: E | null;
  mine: boolean;
  /** Just jumped to (search pick / jump to me): flashes once. */
  found: boolean;
  pinned: boolean;
}

export interface BoardView<E> {
  /** Rows pinned above every page (see the header). */
  base: number;
  /** Column count (skeleton rows, colspans). */
  cols: number;
  /** Accessible name of the table. */
  label: string;
  head(): HTMLTableRowElement;
  row(e: E, ctx: RowContext<E>): HTMLTableRowElement;
  /** The bottom strip when your row is on the page or you have none: a short summary (or null for nothing). */
  you(page: BoardPage<E> | null, onPage: boolean): Node | null;
  /** Above the table: "282 runners" etc. (null: no line). */
  meta(page: BoardPage<E>): Node | null;
  /** The footer's right end (e.g. "How points work"); the page keys work without a hint. */
  foot?(): Node | null;
  /** Rows of room the page keeps free besides the pinned rows and your strip (the rank board's taller top three). */
  spare?: number;
  empty(): HTMLElement;
  /** Title + text for a failed load (e.g. "offline" for an unreachable server). */
  error?(e: unknown): { cls: string; title: string; text: string };
  idOf(e: E): string;
  rankOf(e: E): number;
  nameOf(e: E): string;
  /** Search suggestions: the time / points shown beside a match. */
  valueOf(e: E): string;
  /**
   * "global": ← / → / Home / End / PageUp / PageDown page the board while it is on screen (a full screen: /ranks).
   * "local": PageUp / PageDown anywhere, arrows only inside the page controls (the pause menu uses ← / → itself).
   */
  keys: "global" | "local";
  /** The page changed (URL sync). */
  onPage?(page: number): void;
}

export interface PagedBoard<E> {
  root: HTMLElement;
  /** Left side of the toolbar (style / track switches). */
  controls: HTMLElement;
  /** Show a board; `page` (1-based) or `around` (a player id) picks where it opens. */
  show(src: BoardSource<E>, at?: { page?: number; around?: string }): void;
  /** Current page (1-based). */
  page(): number;
}

const CACHE_MS = 30_000;
const MIN_ROWS = 3;
/** Rows on every page of every board. */
export const PAGE_ROWS = 20;

/** Compact page list, `room` items long: 1 … 9 10 11 … 20 (first, last, the current page and its neighbours). */
export function pageList(cur: number, pages: number, room = 7): (number | null)[] {
  if (pages <= room) return Array.from({ length: pages }, (_, i) => i + 1);
  const inner = room - 2; // between first and last, ellipses included
  const w = inner - 2;
  let lo = cur - Math.floor((w - 1) / 2);
  let hi = lo + w - 1;
  if (lo <= 3) [lo, hi] = [2, inner];
  else if (hi >= pages - 2) [lo, hi] = [pages - inner + 1, pages - 1];
  const out: (number | null)[] = [1];
  if (lo > 2) out.push(null);
  for (let n = lo; n <= hi; n++) out.push(n);
  if (hi < pages - 1) out.push(null);
  out.push(pages);
  return out;
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable);

export function pagedBoard<E>(view: BoardView<E>): PagedBoard<E> {
  const controls = h("div.rb-controls");
  const q = h("input.rb-q", { type: "search", placeholder: "Find a player", "aria-label": "Find a player on this board", spellcheck: "false", autocomplete: "off", maxlength: 32, role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list" });
  const sugg = h("ul.rb-sugg", { role: "listbox", hidden: true, "aria-label": "Matching players" });
  const searchBox = h("div.rb-search", null, h("span.rb-q-icon", { "aria-hidden": "true" }, icon("search")), q, view.keys === "global" ? h("kbd.rb-q-kbd", { "aria-hidden": "true" }, "/") : null, sugg);
  const jump = h("button.btn.btn-sm.rb-jump", { type: "button", hidden: true, title: "Go to the page with your row" }, "Jump to me", h("span.rb-jump-rank"));
  const meta = h("div.rb-meta");
  const thead = h("thead");
  const pins = h("tbody.rb-pins");
  const rows = h("tbody.rb-rows");
  const foot = h("tfoot.rb-you");
  const table = h("table.rb-table", { "aria-label": view.label }, thead, pins, rows, foot);
  const frame = h("div.rb-frame", null, table);
  const range = h("span.rb-range");
  const pager = h("nav.rb-pager", { "aria-label": "Pages" });
  // (No "← → pages" key chips: the keys work anyway, and the pager says what it is.)
  const hints = h("span.rb-keys", null, view.foot?.() ?? null);
  const root = h("div.rb", null, h("div.rb-bar", null, controls, h("div.rb-tools", null, searchBox, jump)), meta, frame, h("footer.rb-foot", null, range, pager, hints));
  thead.append(view.head());

  let src: BoardSource<E> | null = null;
  let per = 0;
  let cur = 1;
  let last: BoardPage<E> | null = null;
  let found: string | null = null;
  let seq = 0;
  let ctl: AbortController | null = null;
  let dir = 0;
  let landed = false;
  const cache = new Map<string, { at: number; p: Promise<BoardPage<E>> }>();

  const pagesOf = (total: number) => Math.max(1, Math.ceil(Math.max(0, total - view.base) / per));
  const offsetOf = (page: number) => view.base + (page - 1) * per;
  const pageOf = (offset: number) => (offset < view.base ? 1 : Math.floor((offset - view.base) / per) + 1);

  function fetchPage(page: number, signal?: AbortSignal): Promise<BoardPage<E>> {
    const s = src!;
    const k = `${s.key}|${per}|${page}`;
    const hit = cache.get(k);
    if (hit && performance.now() - hit.at < CACHE_MS) return hit.p;
    const p = s.load({ offset: offsetOf(page), limit: per }, signal);
    cache.set(k, { at: performance.now(), p });
    p.catch(() => cache.delete(k));
    return p;
  }
  function cached(page: number): boolean {
    const hit = src && cache.get(`${src.key}|${per}|${page}`);
    return !!hit && performance.now() - hit.at < CACHE_MS;
  }
  function prefetch(page: number): void {
    if (!last || page < 1 || page > pagesOf(last.total) || cached(page)) return;
    void fetchPage(page).catch(() => {});
  }

  // ---- page size: fixed (PAGE_ROWS rows counting the pinned ones), the same on every board, window size and scope.
  // (It used to be the rows that fit the frame, which changed with the scope's pinned rows and the window: 8 on one
  // tab, 11 on the next.) The frame scrolls when a page is taller than the screen.
  function measure(): number {
    return Math.max(MIN_ROWS, PAGE_ROWS - view.base);
  }

  function skeletonRow(): HTMLTableRowElement {
    return h("tr.rb-skel", { "aria-hidden": "true" }, ...Array.from({ length: view.cols }, () => h("td", null, h("span.rb-sk"))));
  }

  // ---- drawing
  const tag = (tr: HTMLTableRowElement, e: E) => {
    tr.classList.add("rb-row");
    tr.dataset.id = view.idOf(e);
    return tr;
  };

  function draw(p: BoardPage<E>): void {
    last = p;
    table.classList.remove("is-empty");
    const myId = p.me ? view.idOf(p.me) : null;
    const first = p.pinned[0] ?? (p.offset === 0 ? p.entries[0] : null) ?? null;
    const pinRows = p.pinned.map((e, i) => tag(view.row(e, { prev: p.pinned[i - 1] ?? null, first, mine: view.idOf(e) === myId, found: view.idOf(e) === found, pinned: true }), e));
    pins.replaceChildren(...pinRows);
    const lastPinned = p.pinned[p.pinned.length - 1] ?? null;
    const bodyRows = p.entries.map((e, i) => {
      const prev = i ? p.entries[i - 1] : (p.above ?? (p.offset === view.base ? lastPinned : null));
      return tag(view.row(e, { prev, first, mine: view.idOf(e) === myId, found: view.idOf(e) === found, pinned: false }), e);
    });
    rows.replaceChildren(...bodyRows);
    // A board's first paint lands row by row; page flips slide instead.
    if (!landed && bodyRows.length) (landed = true), landRows(bodyRows);
    if (dir) {
      rows.classList.remove("slide-l", "slide-r");
      void rows.offsetWidth;
      rows.classList.add(dir > 0 ? "slide-l" : "slide-r");
    }
    const onPage = !!myId && (p.entries.some((e) => view.idOf(e) === myId) || p.pinned.some((e) => view.idOf(e) === myId));
    let you: Node | null;
    if (p.me && !onPage) {
      you = tag(view.row(p.me, { prev: null, first, mine: true, found: found === myId, pinned: true }), p.me);
      (you as HTMLElement).classList.add("rb-you-row");
    } else {
      const s = view.you(p, onPage);
      you = s ? h("tr.rb-you-note", null, h("td", { colspan: view.cols }, s)) : null;
    }
    foot.replaceChildren(...(you ? [you] : []));
    meta.replaceChildren(view.meta(p) ?? "");
    meta.hidden = !meta.childNodes.length;
    drawPager(p);
    jump.hidden = !p.me;
    jump.querySelector(".rb-jump-rank")!.textContent = p.me ? `#${view.rankOf(p.me)}` : "";
    jump.setAttribute("aria-label", p.me ? `Jump to your row, rank ${view.rankOf(p.me)}` : "Jump to me");
    found = null;
  }

  function drawPager(p: BoardPage<E>): void {
    const pages = pagesOf(p.total);
    const from = p.offset <= view.base ? 1 : p.offset + 1;
    const to = Math.min(p.total, p.offset + p.entries.length);
    range.textContent = p.total ? `${from}–${to} of ${p.total.toLocaleString("en-US")}` : "";
    const btn = (label: Node | string, page: number, o: { cls?: string; aria?: string; on?: boolean; disabled?: boolean } = {}) =>
      h(`button.rb-pg${o.cls ? "." + o.cls : ""}${o.on ? ".on" : ""}`, { type: "button", disabled: o.disabled, "aria-label": o.aria, "aria-current": o.on ? "page" : null, "data-page": page, onclick: () => go(page) }, label);
    const chev = (flip: boolean, twice = false) => h(`span.rb-chev${flip ? ".flip" : ""}`, { "aria-hidden": "true" }, icon("chevronRight"), twice ? icon("chevronRight") : null);
    const room = frame.clientWidth < 560 ? 5 : 7;
    const hadFocus = pager.contains(document.activeElement);
    pager.replaceChildren(
      btn(chev(true, true), 1, { cls: "edge", aria: "First page", disabled: cur <= 1 }),
      btn(chev(true), cur - 1, { cls: "edge", aria: "Previous page", disabled: cur <= 1 }),
      ...pageList(cur, pages, room).map((n) => (n === null ? h("span.rb-ell", { "aria-hidden": "true" }, "…") : btn(String(n), n, { on: n === cur, aria: `Page ${n}` }))),
      btn(chev(false), cur + 1, { cls: "edge", aria: "Next page", disabled: cur >= pages }),
      btn(chev(false, true), pages, { cls: "edge", aria: "Last page", disabled: cur >= pages }),
    );
    pager.hidden = hints.hidden = pages <= 1;
    // The buttons are rebuilt each page: keep focus in the strip (on the current page) for keyboard users.
    if (hadFocus) pager.querySelector<HTMLElement>(".rb-pg.on")?.focus({ preventScroll: true });
  }

  function state(cls: string, title: string, text = ""): void {
    table.classList.add("is-empty");
    rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: view.cols }, h(`div.rb-state.${cls}`, null, h("strong", null, title), text ? h("span", null, text) : null))));
    pins.replaceChildren();
    foot.replaceChildren();
  }

  function skeleton(): void {
    table.classList.remove("is-empty");
    rows.replaceChildren(...Array.from({ length: per }, skeletonRow));
    if (!last) pins.replaceChildren(...Array.from({ length: view.base }, skeletonRow));
  }

  // ---- navigation
  async function go(page: number, o: { around?: string; quiet?: boolean } = {}): Promise<void> {
    if (!src) return;
    if (!per) per = measure();
    if (last && !o.around) page = Math.min(Math.max(1, page), pagesOf(last.total));
    page = Math.max(1, page);
    dir = o.quiet || !last ? 0 : Math.sign(page - cur);
    const my = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    const s = src;
    if (o.around || !cached(page)) skeleton();
    try {
      let p: BoardPage<E>;
      if (o.around) {
        p = await s.load({ offset: view.base, limit: per, around: o.around }, ctl.signal);
        cache.set(`${s.key}|${per}|${pageOf(p.offset)}`, { at: performance.now(), p: Promise.resolve(p) });
      } else p = await fetchPage(page, ctl.signal);
      if (my !== seq || s !== src) return;
      cur = pageOf(p.offset);
      if (!p.total) {
        last = p;
        table.classList.add("is-empty");
        rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: view.cols }, view.empty())));
        pins.replaceChildren();
        const you = view.you(p, false);
        foot.replaceChildren(...(you ? [h("tr.rb-you-note", null, h("td", { colspan: view.cols }, you))] : []));
        meta.replaceChildren(view.meta(p) ?? "");
        drawPager(p);
        jump.hidden = true;
      } else draw(p);
      view.onPage?.(cur);
      prefetch(cur + 1);
      prefetch(cur - 1);
      if (o.around) focusRow(o.around);
    } catch (e) {
      if (my !== seq || (e as Error)?.name === "AbortError") return;
      const m = view.error?.(e) ?? { cls: "error", title: "Couldn't load this page", text: String((e as Error)?.message ?? e) };
      state(m.cls, m.title, m.text);
    }
  }

  function focusRow(id: string): void {
    const tr = table.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`);
    tr?.querySelector<HTMLElement>("button.rb-name")?.focus({ preventScroll: true });
  }

  function jumpTo(id: string): void {
    found = id;
    void go(cur, { around: id });
  }
  jump.addEventListener("click", () => {
    if (!last?.me) return;
    const id = view.idOf(last.me);
    if (last.entries.some((e) => view.idOf(e) === id) || last.pinned.some((e) => view.idOf(e) === id)) {
      // Already here: flash the row.
      const tr = rows.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`) ?? pins.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`);
      tr?.classList.remove("found");
      void tr?.offsetWidth;
      tr?.classList.add("found");
      return;
    }
    jumpTo(id);
  });

  // ---- search
  let sseq = 0;
  let sctl: AbortController | null = null;
  let stimer = 0;
  let active = -1;
  let matches: E[] = [];
  const closeSugg = () => {
    sugg.hidden = true;
    q.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const setActive = (i: number) => {
    active = i;
    sugg.querySelectorAll("li").forEach((li, j) => li.classList.toggle("on", j === i));
    if (i >= 0) q.setAttribute("aria-activedescendant", `rb-s-${i}`);
    else q.removeAttribute("aria-activedescendant");
  };
  const pick = (e: E) => {
    q.value = "";
    closeSugg();
    jumpTo(view.idOf(e));
  };
  async function runSearch(): Promise<void> {
    const term = q.value.trim();
    const my = ++sseq;
    sctl?.abort();
    if (!term || !src) return closeSugg();
    sctl = new AbortController();
    try {
      const r = await src.search(term, sctl.signal);
      if (my !== sseq) return;
      matches = r.entries.slice(0, 8);
      sugg.replaceChildren(
        ...(matches.length
          ? matches.map((e, i) =>
              h(
                "li",
                { id: `rb-s-${i}`, role: "option", onmousedown: (ev: Event) => (ev.preventDefault(), pick(e)) },
                h("span.rb-s-rank", null, `#${view.rankOf(e)}`),
                h("span.rb-s-name", null, view.nameOf(e)),
                h("span.rb-s-val", null, view.valueOf(e)),
              ),
            )
          : [h("li.rb-s-none", { role: "presentation" }, `No player matching "${term}" on this board`)]),
        ...(r.matches > matches.length ? [h("li.rb-s-more", { role: "presentation" }, `${r.matches - matches.length} more, keep typing`)] : []),
      );
      sugg.hidden = false;
      q.setAttribute("aria-expanded", "true");
      setActive(matches.length ? 0 : -1);
    } catch {
      /* aborted / offline: leave the list as it was */
    }
  }
  q.addEventListener("input", () => {
    clearTimeout(stimer);
    stimer = window.setTimeout(() => void runSearch(), 160);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (sugg.hidden || !matches.length) return;
      e.preventDefault();
      setActive((active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active] && !sugg.hidden) pick(matches[active]);
    } else if (e.key === "Escape") {
      if (!q.value && sugg.hidden) return q.blur();
      e.preventDefault();
      e.stopPropagation();
      q.value = "";
      closeSugg();
    }
  });
  q.addEventListener("blur", () => setTimeout(closeSugg, 120));
  q.addEventListener("focus", () => {
    if (q.value.trim() && matches.length) (sugg.hidden = false), q.setAttribute("aria-expanded", "true");
  });

  // ---- keyboard paging
  const step = (e: KeyboardEvent): boolean => {
    if (!last) return false;
    const pages = pagesOf(last.total);
    const to = e.key === "ArrowLeft" || e.key === "PageUp" ? cur - 1 : e.key === "ArrowRight" || e.key === "PageDown" ? cur + 1 : e.key === "Home" ? 1 : e.key === "End" ? pages : null;
    if (to === null) return false;
    e.preventDefault();
    if (to >= 1 && to <= pages && to !== cur) void go(to);
    return true;
  };
  // Capture phase: a dialog holding the board stops keys at its own element, and the board should page there too.
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return removeEventListener("keydown", onKey, true);
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !root.offsetParent || (e.target as HTMLElement).closest?.(".rb-pager")) return;
    const dlg = document.querySelector("dialog[open]");
    if (dlg && !dlg.contains(root)) return;
    if (view.keys === "global" && e.key === "/") {
      e.preventDefault();
      q.focus();
      return;
    }
    const inGroup = (e.target as HTMLElement).closest?.("[role=tablist], .seg");
    if (e.key === "PageUp" || e.key === "PageDown") step(e);
    else if (view.keys === "global" && !inGroup && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) step(e);
  };
  addEventListener("keydown", onKey, true);
  // Inside the page controls the arrows always page (and keep focus on the control strip).
  pager.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
    e.stopPropagation();
    step(e);
  });

  // ---- resizing: keep the first row on screen. The first layout also starts a pending show().
  let pending: { page?: number; around?: string } | null = null;
  const start = () => {
    const at = pending!;
    pending = null;
    per = measure();
    void go(at.page ?? 1, { around: at.around, quiet: true });
  };
  let rtimer = 0;
  new ResizeObserver(() => {
    if (pending && frame.clientHeight > 0) return start();
    clearTimeout(rtimer);
    rtimer = window.setTimeout(() => {
      if (!src || !root.isConnected || !frame.clientHeight || pending) return;
      const n = measure();
      if (n === per) return last && drawPager(last);
      const anchor = last ? last.offset : view.base;
      per = n;
      void go(pageOf(anchor), { quiet: true });
    }, 120);
  }).observe(frame);

  return {
    root,
    controls,
    show(s, at = {}) {
      const same = src?.key === s.key;
      src = s;
      // A different board may have different columns (ui/stat-boards.ts).
      if (!same) (last = null), thead.replaceChildren(view.head());
      pending = at;
      // Not laid out yet (a screen being built): the ResizeObserver starts it once the page size can be measured.
      if (root.isConnected && frame.clientHeight > 0) start();
    },
    page: () => cur,
  };
}

// ---------------------------------------------------------------------------------------------
// Cells shared by the boards

/** Stable hue per player, for the initial-letter avatar (a colour dot that tells rows apart at a glance). */
export function hueOf(id: string): number {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0;
  return x % 360;
}

/** Avatar (Discord picture when shown publicly) + name (opens the profile) + Verified / Creator marks + an optional quiet suffix. */
export function playerCell(p: { id: string; name: string; avatarUrl: string | null; provider?: string; country?: string | null } & PlayerMarks, open: () => void, sub: string[] = [], href = `/u/${encodeURIComponent(p.id)}`): HTMLTableCellElement {
  const letter = () => h("span.rb-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  const av = pic ? avatarImg(pic, { cls: "rb-av", px: 24, letter }) : letter();
  const tags = [...sub, p.provider === "guest" ? "guest" : ""].filter(Boolean);
  return h(
    "td.rb-player",
    null,
    h(
      "div.rb-pwrap",
      null,
      av,
      countryFlag(p.country),
      // A real link to the profile's address (middle-click / Ctrl-click open it in a new tab); a plain click opens it in place.
      h("a.rb-name", { href, title: `${p.name}'s profile`, onclick: (ev: Event) => {
        const e = ev as MouseEvent;
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open();
      }, ...nameAttrs(p) }, p.name),
      nameMarks(p),
      tags.length ? h("span.rb-sub", { title: p.provider === "guest" ? "Guest players haven't linked an account" : null }, tags.join(" · ")) : null,
    ),
  );
}

const MIN = 60_000;
const DAY = 86_400_000;
/** "just now", "12 min ago", "3 h ago", "yesterday", "5 d ago", then the date. */
export function relDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = now - t;
  if (d < MIN) return "just now";
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / (60 * MIN))} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 14 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** Full date + time for tooltips. */
export function fullDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** Time behind a faster run: "+0.840", "+12.300", "+1:04.250". */
export function gapTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(3);
  return m ? `+${m}:${s.padStart(6, "0")}` : `+${s}`;
}
