// Gauntlets (research/GAUNTLETS.md; API: apps/api src/gauntlets.ts): menu screens.
//   /gauntlets      the hub: this week's weekly (its maps, time left, top 3, Start), the permanent gauntlets and events
//                   (record, your best), past weeks (dates, winner, finishers).
//   /g/<slug>       the maps in order with their tiers, Start (or Resume), then the board; a board row opens into its
//                   per-map splits with the gap to the record's splits.
//   /g/<slug>?attempt=<id>   your attempt's result: total, real time, splits; "waiting for verification" until the
//                   server has verified every split (polled), then the way to the board.
// Same parts as the leaderboards (ui/board-pager.ts rows and cells, boards.css). The Worker serves both paths with
// per-page meta (apps/api src/seo/pages.ts); the screen keeps the address in sync like the rank board (ui/ranks.ts).

import { appLocation } from "../platform/navigation";
import "./gauntlets.css";
import { api, ApiError, ApiUnavailable, type ApiPlayer, type GauntletAttempt, type GauntletDetail, type GauntletEntry, type GauntletHub, type GauntletListItem, type GauntletSplit } from "../api";
import { formatDelta } from "../hud/time-face";
import { clampTier, tierLabel, tierName } from "../tiers";
import { allowLeave } from "../play-lock";
import { formatCountdown, formatReal, gauntletPath, gauntletUrl, rememberAttempt, rememberedAttempt, shortTime, gauntletTime } from "../gauntlet/state";
import { openReplayViewer, viewerUrl } from "../viewer/request";
import { watchPath } from "../gauntlet/watch";
import { gauntletHub } from "../shared-reads";
import { fullDate, playerCell, relDate } from "./board-pager";
import { h } from "./dom";
import { icon } from "./icons";
import { navigate } from "./nav";

export interface GauntletScreens {
  /** A gauntlet's page; with `attempt`, that attempt's result. */
  open(slug: string, attempt?: string | null): void;
}

const BOARD_PAGE = 50;
const POLL_MS = 3000;

// --- the address (shareable), except over a running game (its URL carries the map)

let ownsUrl = false;

function syncUrl(path: string): void {
  if (appLocation().searchParams.has("map")) return;
  history.replaceState(history.state, "", path);
  ownsUrl = true;
}

/** Leaving the gauntlet screens: the address goes back to the home screen's (menu.ts render). */
export function leaveGauntletUrl(): void {
  if (!ownsUrl) return;
  ownsUrl = false;
  if (/^\/(gauntlets|g\/)/.test(appLocation().pathname)) history.replaceState(history.state, "", "/");
}

const iso = (ms: number) => new Date(ms).toISOString();
const state = (title: string, text: string | null, cls = "empty") => h(`div.rb-state.${cls}`, null, h("strong", null, title), text ? h("span", null, text) : null);
const failed = (e: unknown) =>
  e instanceof ApiUnavailable ? state("Gauntlets are offline", "The server can't be reached right now.", "offline") : state("Couldn't load this", String((e as Error)?.message ?? e), "error");
const tierCell = (t: number | null) => {
  const c = clampTier(t);
  return h(`td.gx-tier`, null, h(`span.hud-tier${c ? `.t${c}` : ".tx"}`, { title: c ? `Tier ${c}, ${tierName(c)}` : "Unrated" }, tierLabel(c)));
};
const chevron = () => h("span.gx-chev", { "aria-hidden": "true" }, icon("chevronRight"));

/** A day in UTC, the way gauntlet titles name them ("Oct 31"): every date here is the same day everywhere. */
const utcDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });

/** "until Oct 31" (the last day: the end minus 1 ms), "ended", "from Nov 1" for dated ones; null otherwise. */
function windowText(g: { startsAt: number | null; endsAt: number | null }, now = Date.now()): string | null {
  if (g.startsAt !== null && now < g.startsAt) return `from ${utcDay(g.startsAt)}`;
  if (g.endsAt !== null) return now < g.endsAt ? `until ${utcDay(g.endsAt - 1)}` : "ended";
  return null;
}

/** A weekly's days, "Oct 19 – Oct 25" (its start, or its week's Monday, to its last day). */
function weekDays(g: { startsAt: number | null; endsAt: number | null; week?: string | null }): string {
  const start = g.startsAt ?? (g.week ? Date.parse(`${g.week}T00:00:00Z`) : null);
  const end = g.endsAt ?? (start !== null ? start + 7 * 86_400_000 : null);
  return start !== null && end !== null ? `${utcDay(start)} – ${utcDay(end - 1)}` : "";
}

/** Text that follows the time left to `end` ("Ends in 2d 4h"), redrawn each minute while on screen. */
function countdown(end: number, text: (left: string | null) => string): HTMLElement {
  const el = h("span.gx-left");
  let shown = false;
  const draw = () => void (el.textContent = text(formatCountdown(end)));
  draw();
  const t = window.setInterval(() => {
    if (el.isConnected) shown = true;
    else if (shown) return window.clearInterval(t);
    draw();
  }, 60_000);
  return el;
}

const profileHref = (id: string) => `/u/${encodeURIComponent(id)}`;
const playerLink = (p: ApiPlayer, sub: string[] = []) => playerCell(p, () => navigate({ screen: "profile", id: p.id }), sub, profileHref(p.id));

/** A map name linking its page (/maps/<name>); a plain click opens it in place. */
function mapLink(map: string): HTMLElement {
  return h("a.gx-map", { href: `/maps/${encodeURIComponent(map)}`, onclick: (e: Event) => plainClick(e, () => navigate({ screen: "maps", focus: map })) }, map);
}

/** A plain left click runs `f` instead of following the link (modified clicks open a tab as usual). */
function plainClick(e: Event, f: () => void): void {
  const m = e as MouseEvent;
  if (m.ctrlKey || m.metaKey || m.shiftKey || m.altKey || m.button) return;
  e.preventDefault();
  e.stopPropagation();
  f();
}

const tierTag = (t: number | null) => {
  const c = clampTier(t);
  return h(`span.hud-tier${c ? `.t${c}` : ".tx"}`, { title: c ? `Tier ${c}, ${tierName(c)}` : "Unrated" }, tierLabel(c));
};

/** A row that opens a gauntlet (links and buttons inside it do their own thing). */
function linkRow(slug: string, a: GauntletScreens, ...cells: HTMLElement[]): HTMLTableRowElement {
  return h(
    "tr.rb-row.gx-link",
    {
      tabindex: "0",
      role: "link",
      "data-slug": slug,
      onclick: (e: Event) => !(e.target as HTMLElement).closest("a, button") && a.open(slug),
      onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && e.target === e.currentTarget && a.open(slug),
    },
    ...cells,
  );
}

const section = (title: string, ...body: (HTMLElement | null)[]) => h("section.gx-sec", { "aria-label": title }, h("h2.gx-h", null, title), ...body);

// ---------------------------------------------------------------------------------------------
// /gauntlets

export function gauntletsScreen(a: GauntletScreens): HTMLElement {
  syncUrl("/gauntlets");
  const root = h("div.gx.gx-hub", null, h("div.gx-skel", { "aria-hidden": "true" }));
  if (!api.available()) {
    root.replaceChildren(state("Gauntlets are offline", "The server can't be reached right now.", "offline"));
    return root;
  }
  // The home screen's weekly line may have just read it (a minute, nothing written since: shared-reads.ts).
  void gauntletHub(60_000, { sinceWrites: true }).then(
    (hub) => {
      const parts = [
        hub.weekly ? section("This week", weeklyBlock(hub.weekly, a)) : null,
        hub.gauntlets.length ? section("Gauntlets", listTable(hub.gauntlets, a)) : null,
        hub.past.length ? section("Past weeks", pastTable(hub.past, a)) : null,
      ].filter((x): x is HTMLElement => x !== null);
      root.replaceChildren(...(parts.length ? parts : [state("No gauntlets yet", null)]));
    },
    (e) => root.replaceChildren(failed(e)),
  );
  return root;
}

/** This week: title and time left, the maps with their tiers, Start (or Resume); the top 3 beside it. */
function weeklyBlock(w: NonNullable<GauntletHub["weekly"]>, a: GauntletScreens): HTMLElement {
  const open = (w.startsAt === null || Date.now() >= w.startsAt) && (w.endsAt === null || Date.now() < w.endsAt);
  const note = h("p.gx-note", { hidden: true });
  const start = h("button.btn.primary", { type: "button", disabled: !open }, "Start");
  start.addEventListener("click", () => void tryStart(start, note, () => startAttempt(w.slug)));
  const buttons = h("div.btn-row.gx-buttons", null, start, h("button.btn", { type: "button", onclick: () => a.open(w.slug) }, "Leaderboard"));
  if (open) resumeButton(w.slug, start, buttons);
  const info = h(
    "div.gx-week-info",
    null,
    h(
      "p.gx-week-title",
      null,
      h("a.gx-title-link", { href: gauntletPath(w.slug), onclick: (e: Event) => plainClick(e, () => a.open(w.slug)) }, w.title),
      w.endsAt !== null ? countdown(w.endsAt, (left) => (left ? `Ends in ${left}` : "Ended")) : null,
    ),
    h("ol.gx-week-maps", { "aria-label": "Maps in order" }, ...w.mapList.map((m) => h("li", null, tierTag(m.tier), mapLink(m.map)))),
    w.me ? h("p.gx-you", null, `You're #${w.me.rank} with ${gauntletTime(w.me.time)}.`) : null,
    buttons,
    note,
  );
  const top = w.top.length
    ? h(
        "table.rb-table.gx-table.gx-top",
        { "aria-label": "Top 3 this week" },
        h("tbody", null, ...w.top.map((e) => h("tr.rb-row", { class: `top${e.rank}` }, h("td.rb-rank", null, String(e.rank)), playerLink(e.player), h("td.num.rb-strong", null, gauntletTime(e.time))))),
      )
    : h("p.gx-empty", null, "No one has cleared it yet.");
  return h("div.gx-week", null, info, h("div.gx-week-top", null, top));
}

function listTable(list: GauntletListItem[], a: GauntletScreens): HTMLElement {
  const row = (g: GauntletListItem) => {
    const when = g.kind === "event" || g.startsAt !== null || g.endsAt !== null ? windowText(g) : null;
    return linkRow(
      g.slug,
      a,
      h("td.gx-title", null, h("b", null, g.title), when ? h("span.rb-sub", null, when) : null),
      h("td.num", null, String(g.maps)),
      h("td.num.dim.rb-opt", null, g.finishers.toLocaleString("en-US")),
      h("td.num", null, g.wrTime != null ? h("b", null, gauntletTime(g.wrTime)) : h("span.faint", null, "—")),
      h("td.num.gx-mine", null, g.me ? h("span", null, h("span.gx-rank", null, `#${g.me.rank}`), gauntletTime(g.me.time)) : h("span.faint", null, "—")),
      h("td.gx-go", null, chevron()),
    );
  };
  return h(
    "table.rb-table.gx-table.gx-list",
    { "aria-label": "Gauntlets" },
    h("thead", null, h("tr", null, h("th", { scope: "col" }, "Gauntlet"), h("th.num", { scope: "col" }, "Maps"), h("th.num.rb-opt", { scope: "col" }, "Finishers"), h("th.num", { scope: "col" }, "Record"), h("th.num", { scope: "col" }, "Your best"), h("th.gx-go", { scope: "col" }, h("span.sr-only", null, "Open")))),
    h("tbody", null, ...list.map(row)),
  );
}

function pastTable(past: GauntletHub["past"], a: GauntletScreens): HTMLElement {
  const row = (g: GauntletHub["past"][number]) => {
    const live = g.endsAt !== null && Date.now() < g.endsAt;
    return linkRow(
      g.slug,
      a,
      h("td.gx-title", null, h("b", null, weekDays(g) || g.title)),
      g.winner
        ? playerLink(g.winner.player)
        : h("td.dim", null, live && g.endsAt !== null ? countdown(g.endsAt, (left) => (left ? `Ends in ${left}` : "Ended")) : "—"),
      h("td.num", null, g.winner ? gauntletTime(g.winner.time) : ""),
      h("td.num.dim", null, g.finishers.toLocaleString("en-US")),
      h("td.gx-go", null, chevron()),
    );
  };
  return h(
    "table.rb-table.gx-table.gx-past",
    { "aria-label": "Past weeks" },
    h("thead", null, h("tr", null, h("th", { scope: "col" }, "Week"), h("th", { scope: "col" }, "Winner"), h("th.num", { scope: "col" }, "Time"), h("th.num", { scope: "col" }, "Finishers"), h("th.gx-go", { scope: "col" }, h("span.sr-only", null, "Open")))),
    h("tbody", null, ...past.map(row)),
  );
}

/** Runs a start: the button off while it goes, the reason under it if refused. */
async function tryStart(b: HTMLButtonElement, note: HTMLElement, f: () => Promise<void>): Promise<void> {
  b.disabled = true;
  note.hidden = true;
  try {
    await f();
  } catch (e) {
    b.disabled = false;
    note.textContent = startError(e);
    note.hidden = false;
  }
}

/** An attempt this browser is still in: Resume (to its current map) goes first; Start becomes Start over. */
function resumeButton(slug: string, start: HTMLButtonElement, buttons: HTMLElement): void {
  const mine = rememberedAttempt(slug);
  if (!mine) return;
  void api.gauntletAttempt(mine).then(
    (at) => {
      if (at.state !== "open" || !at.next) return;
      const resume = h("button.btn.primary", { type: "button" }, "Resume", h("small.gx-btn-sub", null, `map ${at.next.idx + 1} of ${at.maps.length}`));
      resume.addEventListener("click", () => go(gauntletUrl(at.next!.map, at.id)));
      start.classList.remove("primary");
      start.textContent = "Start over";
      buttons.prepend(resume);
    },
    () => {},
  );
}

// ---------------------------------------------------------------------------------------------
// /g/<slug>

/** Opens an attempt and goes to its first map (full page load into gauntlet mode). Throws on refusal. */
async function startAttempt(slug: string): Promise<void> {
  await api.me(); // a guest identity first: attempts need a session
  const at = await api.startGauntlet(slug);
  rememberAttempt(slug, at.id);
  go(gauntletUrl(at.next?.map ?? at.maps[0].map, at.id));
}

function go(url: string): void {
  allowLeave();
  location.href = url;
}

function startError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "gauntlet_closed") return "This gauntlet isn't open right now.";
    if (e.code === "banned") return "This account can't submit runs.";
    if (e.status === 401) return "You aren't signed in, even as a guest. Reload and try again.";
    return e.message;
  }
  return e instanceof ApiUnavailable ? "The server can't be reached right now." : String((e as Error)?.message ?? e);
}

export function gauntletScreen(slug: string, a: GauntletScreens, o: { title: (t: string) => void }): HTMLElement {
  syncUrl(gauntletPath(slug));
  const left = h("div.gx-side");
  const right = h("div.gx-main");
  const root = h("div.gx.gx-page", null, left, right);
  if (!api.available()) {
    root.replaceChildren(state("Gauntlets are offline", "The server can't be reached right now.", "offline"));
    return root;
  }
  left.append(h("div.gx-skel", { "aria-hidden": "true" }));
  void api.gauntlet(slug).then(
    (d) => {
      o.title(d.title);
      left.replaceChildren(...sidePanel(d));
      right.replaceChildren(board(d));
    },
    (e) => root.replaceChildren(e instanceof ApiError && e.status === 404 ? state("No such gauntlet", "It may have been taken down.") : failed(e)),
  );
  return root;
}

function sidePanel(d: GauntletDetail): HTMLElement[] {
  const wr = d.wr;
  // Your PB beside the record, per map, with the gap (when you have one and it isn't the record).
  const mine = d.me && d.me.attemptId !== wr?.attemptId ? d.me : null;
  const maps = h(
    "table.rb-table.gx-table.gx-maps",
    { "aria-label": "Maps in order" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th.rb-rank", { scope: "col" }, "#"),
        h("th", { scope: "col" }, "Map"),
        h("th", { scope: "col" }, "Tier"),
        h("th.num", { scope: "col" }, "Record"),
        mine ? h("th.num", { scope: "col" }, "You") : null,
      ),
    ),
    h(
      "tbody",
      null,
      ...d.maps.map((m) => {
        const split = wr?.splits.find((s) => s.idx === m.idx);
        const own = mine?.splits.find((s) => s.idx === m.idx);
        const gap = own && split ? own.time - split.time : null;
        return h(
          "tr.rb-row",
          null,
          h("td.rb-rank", null, String(m.idx + 1)),
          h("td.gx-title", null, mapLink(m.map)),
          tierCell(m.tier),
          h("td.num.dim", null, split ? splitLink(split) : "—"),
          mine
            ? h(
                "td.num.gx-you",
                null,
                own ? splitLink(own) : "—",
                gap !== null ? h(`span.gx-delta${gap < 0 ? ".ahead" : gap > 0 ? ".behind" : ""}`, { title: "Against the record's split" }, gap === 0 ? "±0.000" : formatDelta(gap)) : null,
              )
            : null,
        );
      }),
    ),
  );
  const note = h("p.gx-note", { hidden: true });
  const when = windowText(d);
  const closed = when === "ended" || (d.startsAt !== null && Date.now() < d.startsAt);
  const start = h("button.btn.primary.gx-start", { type: "button", disabled: closed, "data-autofocus": "" }, "Start");
  const buttons = h("div.btn-row.gx-buttons", null, start);
  start.addEventListener("click", () => void tryStart(start, note, () => startAttempt(d.slug)));
  if (!closed) resumeButton(d.slug, start, buttons);
  // When it's open: a weekly counts down, an event says its dates; a finished week says who won.
  let meta: HTMLElement | null = null;
  if (d.kind === "weekly" && when === "ended")
    meta = h("p.gx-meta", null, `Ended ${utcDay(d.endsAt! - 1)}. `, wr ? h("span", null, "Won by ", h("a.gx-who", { href: profileHref(wr.player.id), onclick: (e: Event) => plainClick(e, () => navigate({ screen: "profile", id: wr.player.id })) }, wr.player.name), ".") : "Nobody finished it.");
  else if (d.kind === "weekly" && d.endsAt !== null && !closed) meta = h("p.gx-meta", null, countdown(d.endsAt, (left) => (left ? `Ends in ${left}` : "Ended")));
  else if (when) meta = h("p.gx-meta", null, `Open ${when}`);
  if (wr) buttons.append(watchLink(d.slug, wr.attemptId, "Watch the record"));
  return [meta, maps, buttons, note].filter((x) => x !== null) as HTMLElement[];
}

/** Watch a whole attempt: every map's replay in order (gauntlet/watch.ts; a page load into the viewer). */
function watchLink(slug: string, attemptId: string, label = "Watch"): HTMLElement {
  return h("a.gx-watch", { href: watchPath(slug, attemptId), onclick: () => allowLeave() }, label);
}

/** A split's time, linking its run's replay. */
function splitLink(s: GauntletSplit): HTMLElement {
  const target = { runId: s.runId };
  return h("a.gx-split", { href: viewerUrl(target), title: "Watch this run", onclick: (e: Event) => plainClick(e, () => openReplayViewer(target)) }, shortTime(s.time));
}

/** One board row and its splits row (hidden until the row is opened). */
function boardRows(slug: string, e: GauntletEntry, wr: GauntletEntry | null, mine: boolean): HTMLTableRowElement[] {
  const more = h("button.link-btn.gx-more", { type: "button", "aria-expanded": "false", "aria-label": `${e.player.name}'s splits` }, chevron());
  const row = h(
    "tr.rb-row",
    { class: [e.rank <= 3 ? `top${e.rank}` : "", mine ? "me" : ""].filter(Boolean).join(" ") || null },
    h("td.rb-rank", null, String(e.rank)),
    playerLink(e.player),
    h("td.num.rb-strong", { title: `${e.totalTicks.toLocaleString("en-US")} ticks` }, gauntletTime(e.time)),
    h("td.num.dim.rb-opt", { title: "First start to last finish. Not ranked." }, formatReal(e.realMs)),
    h("td.dim.rb-opt2", { title: fullDate(iso(e.date)) }, relDate(iso(e.date))),
    h("td.gx-go", null, more),
  );
  const splits = h(
    "tr.gx-splits",
    { hidden: true },
    h("td", { colspan: "6" }, h("div.gx-split-wrap", null, splitTable(e.splits, wr && wr.attemptId !== e.attemptId ? wr.splits : null), watchLink(slug, e.attemptId))),
  );
  const toggle = () => {
    const open = !!splits.hidden;
    splits.hidden = !open;
    row.classList.toggle("open", open);
    more.setAttribute("aria-expanded", String(open));
  };
  more.addEventListener("click", (ev) => (ev.stopPropagation(), toggle()));
  row.addEventListener("click", (ev) => !(ev.target as HTMLElement).closest("button, a") && toggle());
  return [row, splits];
}

/** Per-map splits; `vs`: the record's, for the gap on each map. */
function splitTable(splits: GauntletSplit[], vs: GauntletSplit[] | null): HTMLElement {
  return h(
    "table.gx-split-table",
    null,
    h(
      "tbody",
      null,
      ...splits.map((s) => {
        const w = vs?.find((x) => x.idx === s.idx);
        const d = w ? s.time - w.time : null;
        return h(
          "tr",
          null,
          h("td.rb-rank", null, String(s.idx + 1)),
          h("td", null, mapLink(s.map)),
          h("td.num", null, splitLink(s)),
          h(`td.num.gx-delta${d === null ? "" : d < 0 ? ".ahead" : d > 0 ? ".behind" : ""}`, { title: d === null ? null : "Against the record's split" }, d === null ? "" : d === 0 ? "±0.000" : formatDelta(d)),
        );
      }),
    ),
  );
}

function board(d: GauntletDetail): HTMLElement {
  const meta = h("div.rb-meta");
  const rows = h("tbody");
  const you = h("tfoot");
  const pager = h("div.gx-pager");
  const frame = h(
    "table.rb-table.gx-table.gx-board",
    { "aria-label": `${d.title} leaderboard` },
    h(
      "thead",
      null,
      h("tr", null, h("th.rb-rank", { scope: "col" }, "#"), h("th", { scope: "col" }, "Player"), h("th.num", { scope: "col" }, "Total"), h("th.num.rb-opt", { scope: "col" }, "Real time"), h("th.rb-opt2", { scope: "col" }, "Date"), h("th.gx-go", { scope: "col" }, h("span.sr-only", null, "Splits"))),
    ),
    rows,
    you,
  );
  const root = h("section.gx-boardwrap", { "aria-label": "Leaderboard" }, meta, h("div.rb-frame.tight", null, frame), pager);
  let offset = 0;
  const load = () => {
    rows.replaceChildren(...Array.from({ length: 6 }, () => h("tr.rb-skel", { "aria-hidden": "true" }, ...Array.from({ length: 6 }, () => h("td", null, h("span.rb-sk"))))));
    void api.gauntletBoard(d.slug, offset).then(
      (b) => {
        meta.replaceChildren(h("span", null, h("b", null, b.total.toLocaleString("en-US")), ` ${b.total === 1 ? "finisher" : "finishers"}`));
        if (!b.entries.length) {
          rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: "6" }, state("No finishers yet", "Clear every map in one attempt to set the first record."))));
          frame.classList.add("is-empty");
          return;
        }
        const meId = b.me?.player.id;
        const wr = offset === 0 ? b.entries[0] : d.wr;
        rows.replaceChildren(...b.entries.flatMap((e) => boardRows(d.slug, e, wr, e.player.id === meId)));
        you.replaceChildren(...(b.me && !b.entries.some((e) => e.player.id === meId) ? boardRows(d.slug, b.me, wr, true) : []));
        const pages = Math.ceil(b.total / BOARD_PAGE);
        pager.replaceChildren(
          ...(pages > 1
            ? [
                h("button.rb-pg.edge", { type: "button", disabled: offset === 0, "aria-label": "Previous page", onclick: () => ((offset = Math.max(0, offset - BOARD_PAGE)), load()) }, h("span.rb-chev.flip", null, icon("chevronRight"))),
                h("span.rb-range", null, `${offset + 1}–${Math.min(b.total, offset + BOARD_PAGE)} of ${b.total}`),
                h("button.rb-pg.edge", { type: "button", disabled: offset + BOARD_PAGE >= b.total, "aria-label": "Next page", onclick: () => ((offset += BOARD_PAGE), load()) }, h("span.rb-chev", null, icon("chevronRight"))),
              ]
            : []),
        );
      },
      (e) => rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: "6" }, failed(e)))),
    );
  };
  load();
  return root;
}

// ---------------------------------------------------------------------------------------------
// /g/<slug>?attempt=<id>

export function gauntletResult(slug: string, attemptId: string, a: GauntletScreens, o: { title: (t: string) => void }): HTMLElement {
  syncUrl(gauntletPath(slug, attemptId));
  const root = h("div.gx.gx-result");
  if (!api.available()) {
    root.replaceChildren(state("Gauntlets are offline", "The server can't be reached right now.", "offline"));
    return root;
  }
  root.append(h("div.gx-skel", { "aria-hidden": "true" }));
  let detail: GauntletDetail | null = null;
  let timer = 0;
  const draw = (at: GauntletAttempt) => {
    o.title(at.gauntlet.title);
    const total = at.splits.reduce((t, s) => t + s.time, 0);
    const pending = at.state === "finished_pending";
    const wr = detail?.wr && detail.wr.attemptId !== at.id ? detail.wr.splits : null;
    const rank = at.state === "complete" && detail?.me?.attemptId === at.id ? detail.me.rank : null;
    const status =
      pending ? h("p.gx-status.pending", null, "Waiting for verification…")
      : at.state === "complete" ? h("p.gx-status.ok", null, rank ? `Verified. You're #${rank} on the board.` : "Verified. Your best attempt is still on the board.")
      : at.state === "failed" ? h("p.gx-status.bad", null, "One of these runs didn't verify, so this attempt doesn't count.")
      : at.state === "open" ? h("p.gx-status", null, `Map ${at.step + 1} of ${at.maps.length} is next.`)
      : h("p.gx-status", null, at.state === "expired" ? "This attempt expired." : "This attempt was given up.");
    const actions = h(
      "div.btn-row.gx-buttons",
      null,
      at.state === "open" && at.next
        ? h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => go(gauntletUrl(at.next!.map, at.id)) }, "Resume")
        : h("button.btn.primary", { type: "button", "data-autofocus": "", disabled: pending, onclick: () => a.open(slug) }, "Leaderboard"),
      h("button.btn", { type: "button", onclick: (e: Event) => void startAttempt(slug).catch((err) => ((e.target as HTMLButtonElement).textContent = startError(err))) }, "Start again"),
      at.splits.length && at.state !== "open" ? h("a.btn", { href: watchPath(slug, at.id), onclick: () => allowLeave() }, "Watch") : null,
    );
    root.replaceChildren(
      h("div.gx-total", null, h("span.gx-total-time", null, gauntletTime(total)), h("span.gx-real", null, `Real time ${at.realMs !== null ? formatReal(at.realMs) : "—"}`)),
      status,
      h("div.gx-result-splits", null, splitTable(at.splits, wr)),
      actions,
    );
    if (pending) timer = window.setTimeout(() => void poll(), POLL_MS);
  };
  const poll = async () => {
    if (!root.isConnected && timer) return;
    try {
      const at = await api.gauntletAttempt(attemptId);
      if (at.state === "complete") detail = await api.gauntlet(slug).catch(() => detail);
      draw(at);
    } catch (e) {
      root.replaceChildren(e instanceof ApiError && e.status === 404 ? state("Not your attempt", "Results are shown to the player who ran them.") : failed(e));
    }
  };
  void (async () => {
    detail = await api.gauntlet(slug).catch(() => null);
    await poll();
  })();
  return root;
}
