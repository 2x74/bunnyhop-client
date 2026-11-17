// The Daily Challenge screen (/daily, /daily/<day>; API: apps/api src/daily.ts). Left: today's map, the time left,
// your place and Play, then the earlier days, one line a day (the map and who won): the last two weeks to begin with,
// and every month before them one page at a time (any day there ever was has its own address, /daily/<day>). Right:
// the board of the day picked on the left (today's to begin with); a closed day's is final, with its podium marked. Same parts as the gauntlet screens and the leaderboards (gauntlets.css,
// boards.css, ui/board-pager.ts), on a plain page. A board row is a leaderboard row: resting the pointer on it (or
// focusing it, or a press and hold on a touch screen) shows the run's stats card (ui/run-stats.ts, GET /runs/:id/stats,
// fetched once per run), and its Watch button opens the run in the replay viewer.

import { appLocation } from "../platform/navigation";
import "./gauntlets.css";
import "./daily.css";
import { api, ApiError, type ApiPlayer, type DailyBoard, type DailyDays, type DailyEntry, type DailyMonth, type DailyView } from "../api";
import { DAILY_STYLE, dailyNow, dailyPath, dailyStyle, guestPlace, isDay, placeOf, progressLine, styleNote, timeLeft } from "../daily/state";
import { dailyGuestLine } from "./daily-guest";
import { styleDef, styleLabel } from "../styles";
import { clampTier, tierLabel, tierName } from "../tiers";
import { formatTime } from "../timer";
import { openReplayViewer } from "../viewer/request";
import { withReplayViews } from "./replay-views";
import { bindRunStats } from "./run-stats";
import { mountDailyPodium } from "./daily-podium";
import { fullDate, playerCell, relDate } from "./board-pager";
import { h } from "./dom";
import { icon } from "./icons";
import { loadFailed } from "./load-failed";
import { navigate } from "./nav";
import { mapArt } from "./thumbs";

export interface DailyScreens {
  /** Show a day's board (null: today's). */
  open(day: string | null): void;
  /** Play the day's map from the Daily entry, in the day's style. */
  play(day: string, map: string, style?: string): void;
}

const BOARD_PAGE = 50;
/** The page's one-line rule; a day that isn't Normal names its style. */
const rule = (style: string) => `One map a day, the same for everyone. Your best ${styleLabel(dailyStyle(style))} run of the day counts, and the fastest three accounts get the day's medals.`;

// --- the address (shareable), except over a running game (its URL carries the map)

let ownsUrl = false;
function syncUrl(path: string): void {
  if (appLocation().searchParams.has("map")) return;
  history.replaceState(history.state, "", path);
  ownsUrl = true;
}
/** Leaving the daily screen: the address goes back to the home screen's (menu.ts render). */
export function leaveDailyUrl(): void {
  if (!ownsUrl) return;
  ownsUrl = false;
  if (/^\/daily(\/|$)/.test(appLocation().pathname)) history.replaceState(history.state, "", "/");
}

const iso = (ms: number) => new Date(ms).toISOString();
const state = (title: string, text: string | null, cls = "empty") => h(`div.rb-state.${cls}`, null, h("strong", null, title), text ? h("span", null, text) : null);
const tierTag = (t: number | null) => {
  const c = clampTier(t);
  return h(`span.hud-tier${c ? `.t${c}` : ".tx"}`, { title: c ? `Tier ${c}, ${tierName(c)}` : "Unrated" }, tierLabel(c));
};
const profileHref = (id: string) => `/u/${encodeURIComponent(id)}`;
const playerLink = (p: ApiPlayer) => playerCell(p, () => navigate({ screen: "profile", id: p.id }), [], profileHref(p.id));
/** The leaderboards' Watch control (ui/leaderboard.ts): one click opens the run in the replay viewer. */
export function watchButton(e: { runId: string }, who: string, title: string): HTMLElement {
  return withReplayViews(
    h("button.link-btn", { type: "button", "data-part": "watch", title: `Watch ${who} run in the replay viewer`, "aria-label": `Watch ${who} run`, onclick: () => openReplayViewer({ runId: e.runId, name: title }) }, "Watch"),
    e.runId,
  );
}

/** Text that follows the clock while it is on screen. */
function ticking(text: () => string): HTMLElement {
  const el = h("span.gx-left");
  let seen = false;
  const draw = () => void (el.textContent = text());
  draw();
  const t = window.setInterval(() => {
    if (el.isConnected) seen = true;
    else if (seen) return window.clearInterval(t);
    draw();
  }, 30_000);
  return el;
}

export function dailyScreen(day: string | null, a: DailyScreens): HTMLElement {
  const picked = isDay(day) ? day : null;
  syncUrl(dailyPath(picked));
  const side = h("div.dy-side");
  const main = h("div.gx-main");
  const page = h("div.dy-page", null, side, main);
  const root = h("div.gx.dy", null, page);
  if (!api.available()) {
    root.replaceChildren(state("The Daily Challenge is offline", "The server can't be reached right now.", "offline"));
    return root;
  }
  const load = () => {
    side.replaceChildren(h("div.gx-skel", { "aria-hidden": "true" }));
    main.replaceChildren();
    const lead = h("p.gx-lead.dy-lead", null, rule(DAILY_STYLE));
    // For a guest: one line saying the board shows accounts, with the two ways in. Gone once they have one.
    root.replaceChildren(dailyGuestLine(load), lead, page);
    void dailyNow(10_000).then(
      (v) => {
        if (!v.enabled) return void root.replaceChildren(state("No Daily Challenge right now", "Check back soon."));
        lead.textContent = rule(v.today.style);
        const show = picked && picked <= v.today.day ? picked : v.today.day;
        side.replaceChildren(todayBlock(v, a), earlierDays(show, v.today.day, a));
        // The shown day's top three on a podium, where the map's picture is (ui/daily-podium.ts).
        mountDailyPodium(side, v, show);
        main.replaceChildren(board(show, v, a));
      },
      (e) => root.replaceChildren(loadFailed("the Daily Challenge", load, e)),
    );
  };
  load();
  return root;
}

/** Today: the map's picture, name and tier, the time left, your place, Play. */
function todayBlock(v: Extract<DailyView, { enabled: true }>, a: DailyScreens): HTMLElement {
  const t = v.today;
  const skew = v.now - Date.now();
  const me = v.me;
  const style = dailyStyle(t.style);
  const play = h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => a.play(t.day, t.map.name, style) }, me ? "Play again" : "Play");
  return h(
    "section.dy-today",
    { "aria-label": "Today" },
    mapArt(t.map.name, t.map.thumbnailUrl, { className: "dy-art", eager: true }),
    h("p.dy-map", null, h("b", null, t.map.name), tierTag(t.map.tier)),
    // A day in another style: the style and its one-line rule, where the map is named.
    style === DAILY_STYLE ? null : h("p.dy-style", { "data-style": style }, h("b", null, `${styleLabel(style)} day`), ` ${styleDef(style)?.rule ?? ""}`),
    h("p.gx-meta", null, ticking(() => {
      const left = timeLeft(t.endsAt, Date.now() + skew);
      return left ? `Ends in ${left}` : "Ended";
    })),
    // A guest's time is kept and not on the board: theirs reads as where it would be (the line at the top says why).
    h(
      "p.gx-you",
      me?.guest ? { "data-guest": "" } : null,
      ...(me?.guest ? [h("b", null, formatTime(me.time)), `. ${guestPlace(me.rank, t.players + 1)} today.`] : me ? [`You're ${placeOf(me.rank, t.players)} with `, h("b", null, formatTime(me.time)), "."] : ["You haven't played today."]),
    ),
    // Taking part: the days finished so far and what the next ones unlock, in one line.
    h("p.dy-progress", { "data-days": String(v.progress?.days ?? 0) }, progressLine(v.progress?.days ?? 0)),
    h("div.btn-row.gx-buttons", null, play),
  );
}

/**
 * The earlier days, one row a day (the date, the map, who was fastest): the last two weeks to begin with, then a month
 * a page, back to the first day there was. Opened on an older day's address, it starts on that day's month. The pager
 * is the boards' own (‹ older, › newer).
 */
function earlierDays(current: string, today: string, a: DailyScreens): HTMLElement {
  const body = h("tbody");
  const label = h("span.rb-range");
  const older = h("button.rb-pg.edge", { type: "button", disabled: true, "aria-label": "Older days", title: "Older days" }, h("span.rb-chev.flip", null, icon("chevronRight"))) as HTMLButtonElement;
  const newer = h("button.rb-pg.edge", { type: "button", disabled: true, "aria-label": "Newer days", title: "Newer days" }, h("span.rb-chev", null, icon("chevronRight"))) as HTMLButtonElement;
  const pager = h("div.gx-pager.dy-months", { hidden: true }, older, label, newer);
  const root = h(
    "section.gx-sec.dy-earlier",
    { "aria-label": "Earlier days", hidden: true },
    h("h2.gx-h", null, "Earlier days"),
    h(
      "table.rb-table.gx-table.dy-days",
      null,
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Day"), h("th", { scope: "col" }, "Map"), h("th", { scope: "col" }, "Fastest"), h("th.gx-go", { scope: "col" }, h("span.sr-only", null, "Open")))),
      body,
    ),
    pager,
  );
  const row = (x: DailyDays["days"][number]) => {
    const first = x.podium[0];
    const isToday = x.day === today;
    // (The fastest player's name is their profile, not the day.)
    const open = (e?: Event) => (e?.target instanceof Element && e.target.closest("a.rb-name") ? undefined : a.open(isToday ? null : x.day));
    return h(
      "tr.rb-row.gx-link",
      { class: x.day === current ? "current" : "", tabindex: "0", role: "link", "data-day": x.day, onclick: open, onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && open(e) },
      h("td.dy-day", null, h("b", null, isToday ? "Today" : x.label)),
      h("td.gx-title", null, `${x.map.name}${styleNote(x.style)}`),
      // The fastest player as a board row shows them: picture, name in their own style, marks, the mini profile on hover.
      first ? fastest(first) : h("td.dy-names", null, x.closed ? "No winner" : isToday ? "" : "Being checked"),
      h("td.gx-go", null, h("span.gx-chev", { "aria-hidden": "true" }, icon("chevronRight"))),
    );
  };
  const fastest = (e: DailyEntry) => {
    const cell = playerLink(e.player);
    cell.classList.add("dy-fast");
    cell.title = formatTime(e.time);
    return cell;
  };
  const paint = (days: DailyDays["days"], text: string, prev: (() => void) | null, next: (() => void) | null) => {
    body.replaceChildren(...(days.length ? days.map(row) : [h("tr.rb-state-row", null, h("td", { colspan: "4" }, "No Daily Challenge that month."))]));
    label.textContent = text;
    older.disabled = !prev;
    newer.disabled = !next;
    older.onclick = prev;
    newer.onclick = next;
    pager.hidden = !prev && !next;
    root.hidden = days.length < 2 && !prev && !next;
  };
  const fail = () => void (older.disabled = newer.disabled = true);
  const recent = () =>
    void api.dailyDays().then((d) => paint(d.days, "Last two weeks", d.older ? () => month(d.older!) : null, null), fail);
  // Newer than this month is the recent list again.
  const month = (m: string) =>
    void api.dailyMonth(m).then((d: DailyMonth) => paint(d.days, d.label, d.prev ? () => month(d.prev!) : null, d.next ? () => month(d.next!) : recent), fail);
  // An older day opened by its address: its month, so the day is in the list.
  if (current < today && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`) >= 14 * 86_400_000) month(current.slice(0, 7));
  else recent();
  return root;
}

/** A day's board: its heading (the day, the map, whether it is final), the rows, your row when it isn't on the page. */
function board(day: string, v: Extract<DailyView, { enabled: true }>, a: DailyScreens): HTMLElement {
  const today = day === v.today.day;
  const head = h("div.dy-head");
  const meta = h("div.rb-meta");
  const rows = h("tbody");
  const you = h("tfoot");
  const pager = h("div.gx-pager");
  const frame = h(
    "table.rb-table.gx-table.dy-board",
    { "aria-label": "Daily Challenge leaderboard" },
    h("thead", null, h("tr", null, h("th.rb-rank", { scope: "col" }, "#"), h("th", { scope: "col" }, "Player"), h("th.num", { scope: "col" }, "Time"), h("th.num.rb-opt", { scope: "col" }, "When"), h("th", { scope: "col" }, h("span.sr-only", null, "Watch")))),
    rows,
    you,
  );
  const root = h("section.gx-boardwrap", { "aria-label": "Leaderboard" }, head, meta, h("div.rb-frame.tight", null, frame), pager);
  // Stats cards for the rows (data-run): delegated, so pages and reloads need nothing more.
  bindRunStats(root);
  let offset = 0;
  /** A guest's own time under the board: not a place on it, so no rank, no stats card and no Watch of its own. */
  const guestRow = (e: NonNullable<DailyBoard["me"]>, of: number) =>
    h(
      "tr.rb-row.me.dy-guestrow",
      null,
      h("td.rb-rank"),
      h("td", null, h("b", null, "You"), h("span.dim", null, `, not on the board. ${guestPlace(e.rank, of)}.`)),
      h("td.num.rb-strong", null, formatTime(e.time)),
      h("td.num.dim.rb-opt", { title: fullDate(iso(e.date)) }, relDate(iso(e.date))),
      h("td.rb-acts"),
    );
  /**
   * `medal`: the row's place on the day's podium (a closed day's frozen one; while the day is open, the place on the
   * board), 0 for none. A run whose replay is gone gets no Watch, and one that is gone altogether no stats card: a past
   * day never shows a control that does nothing.
   */
  const rowOf = (e: (DailyEntry | NonNullable<DailyBoard["me"]>) & { watch?: false; stats?: false }, mine: boolean, player: ApiPlayer | null, label: string, medal: number) => {
    const title = `#${e.rank} · ${player?.name ?? "You"} · Daily, ${label}`;
    return h(
      "tr.rb-row",
      { class: `${medal ? `top${medal}` : ""}${mine ? " me" : ""}`, ...(medal ? { "data-podium": String(medal) } : {}), ...(e.stats === false ? {} : { "data-run": e.runId, "data-run-title": title }) },
      h("td.rb-rank", null, String(e.rank)),
      player ? playerLink(player) : h("td", null, h("b", null, "You")),
      h("td.num.rb-strong", null, formatTime(e.time)),
      h("td.num.dim.rb-opt", { title: fullDate(iso(e.date)) }, relDate(iso(e.date))),
      h("td.rb-acts", null, e.watch === false ? null : watchButton(e, player ? `${player.name}'s` : "your", title)),
    );
  };
  const load = () => {
    rows.replaceChildren(...Array.from({ length: 6 }, () => h("tr.rb-skel", { "aria-hidden": "true" }, ...Array.from({ length: 5 }, () => h("td", null, h("span.rb-sk"))))));
    void Promise.all([api.dailyBoard(day, offset), api.me().catch(() => null)]).then(
      ([b, me]) => {
        head.replaceChildren(
          h("h2", null, today ? "Today" : b.label),
          h("span", null, today ? `${b.map.name}${styleNote(b.style)}` : `${b.map.name}${styleNote(b.style)}, ${b.closed ? "final" : "being checked"}`),
        );
        meta.replaceChildren(h("span", null, h("b", null, b.total.toLocaleString("en-US")), ` ${b.total === 1 ? "player" : "players"}`));
        const mine = b.me?.guest ? [guestRow(b.me, b.total + 1)] : null;
        if (!b.entries.length) {
          rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: "5" }, today ? state("Nobody has finished it yet", "Be the first on today's board.") : state("Nobody finished that day", null))));
          frame.classList.add("is-empty");
          you.replaceChildren(...(mine ?? []));
          pager.replaceChildren();
          return;
        }
        frame.classList.remove("is-empty");
        const meId = me?.id ?? null;
        // The podium: a closed day's frozen three by name; an open day's first three as they stand.
        const medalOf = (e: DailyEntry) => (b.podium ? b.podium.findIndex((p) => p.player.id === e.player.id) + 1 : e.rank <= 3 ? e.rank : 0);
        rows.replaceChildren(...b.entries.map((e) => rowOf(e, e.player.id === meId, e.player, b.label, medalOf(e))));
        you.replaceChildren(...(mine ?? (b.me && !b.entries.some((e) => e.player.id === meId) ? [rowOf(b.me, true, null, b.label, 0)] : [])));
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
      (e) => rows.replaceChildren(h("tr.rb-state-row", null, h("td", { colspan: "5" }, e instanceof ApiError && e.status === 404 ? state("No such day", null) : loadFailed("the leaderboard", load, e)))),
    );
  };
  load();
  // (a.open is how the left list changes the day: the screen is rebuilt on it.)
  void a;
  return root;
}
