import { withReplayViews } from "./replay-views";
// Per-map leaderboard (pause menu Leaderboard tab, the map browser's board dialog): Main | Bonus N and style switches
// over a paged board (ui/board-pager.ts) sized to its panel. The WR stays pinned above every page and your row below
// it when it's elsewhere; Watch / Race on every row. Offline / empty / error states included.

import { api, ApiUnavailable, type Leaderboard, type LeaderboardEntry } from "../api";
import { getPB } from "../pb";
import { formatTime } from "../timer";
import { h } from "./dom";
import { requestRace } from "../player/race";
import { openReplayViewer } from "../viewer/request";
import { navigate } from "./nav";
import { BONUS_STYLE, STYLE_DEFS, styleForTrack, styleLabel, type StyleId } from "../styles";
import { trackName } from "../zones";
import { fullDate, gapTime, pagedBoard, playerCell, relDate, type BoardPage, type BoardSource } from "./board-pager";
import { adminLink } from "../staff-lens";
import { dismissOutside } from "./dismiss";
import { bindRunStats } from "./run-stats";

export interface BoardOptions {
  /** Timed tracks of the map (0 = main, N = bonus N); bonus tabs appear only when the map has bonuses. */
  tracks?: number[];
  /** Initially selected track (default 0). */
  track?: number;
  /** Race a row's run (default: hand it to the running session, ui race bus). */
  onRace?: (e: LeaderboardEntry, track: number) => void;
  /** Keyboard paging: "local" (default; pause menu: PageUp / PageDown) or "global" (a dialog of its own). */
  keys?: "global" | "local";
  /** Names for tracks instead of "Main" / "Bonus N" (the tutorial's bonus 1 is its "Final course"). */
  trackNames?: Record<number, string>;
  /** The dialog's subtitle (openLeaderboardDialog; default: the map name). */
  subtitle?: string;
  /** The main-track style switch was used (the map list keeps one selected style for its board and the run). */
  onStyle?: (id: StyleId) => void;
}

const physicsNote = (e: LeaderboardEntry) => (e.physics ? `Physics v${e.physics}` : "");

const toPage = (lb: Leaderboard, offset: number): BoardPage<LeaderboardEntry> => ({
  total: lb.total,
  offset: lb.offset ?? offset,
  entries: lb.entries,
  me: lb.me,
  pinned: lb.wr ? [lb.wr] : [],
  above: null,
});

/**
 * Leaderboard with Main | Bonus N track switches and, on the main track, style switches (every style by its plain
 * name). Bonus boards are Normal only. `style` is the initially selected main-track style.
 */
export function leaderboardPanel(map: string, style: string, opts: BoardOptions = {}): HTMLElement {
  const tracks = (opts.tracks ?? [0]).length ? (opts.tracks ?? [0]) : [0];
  let track = tracks.includes(opts.track ?? 0) ? (opts.track ?? 0) : 0;
  let mainStyle = style;
  // Everyone, or only the players you follow (and you): apps/api boards.ts ?scope=following.
  let following = false;
  const boardStyle = () => styleForTrack(mainStyle as StyleId, track);
  const nameOf = (t: number) => opts.trackNames?.[t] ?? trackName(t);
  const label = () => `${track || opts.trackNames?.[track] ? nameOf(track) + " · " : ""}${styleLabel(boardStyle())}`;
  const race =
    opts.onRace ??
    ((e: LeaderboardEntry, t: number) => requestRace({ kind: "run", runId: e.runId, name: `#${e.rank} · ${e.player.name}`, track: t, time: e.time }));

  const localPb = (): Node => {
    const pb = getPB(map, boardStyle(), track);
    return pb
      ? h("span", null, "Your local PB ", h("b", null, formatTime(pb.time)), ` · ${pb.jumps} jumps · ${pb.sync.toFixed(1)}% sync`)
      : h("span", null, `No local ${label()} PB on this map yet`);
  };

  const board = pagedBoard<LeaderboardEntry>({
    base: 1,
    cols: 10,
    label: `${map} leaderboard`,
    keys: opts.keys ?? "local",
    head: () =>
      h(
        "tr",
        null,
        h("th.rb-rank", { scope: "col" }, "#"),
        h("th", { scope: "col" }, "Player"),
        h("th.num", { scope: "col" }, "Time"),
        h("th.num.rb-opt3", { scope: "col" }, "Gap"),
        h("th.num.rb-opt", { scope: "col" }, "Jumps"),
        h("th.num.rb-opt", { scope: "col" }, "Strafes"),
        h("th.num.rb-opt.lb-perf", { scope: "col", title: "Perfect hops: jumped on the first grounded tick. Only hops within 0.1 s of landing count." }, "Perf%"),
        h("th.num.rb-opt", { scope: "col" }, "Sync"),
        h("th.rb-opt2", { scope: "col" }, "Date"),
        h("th.rb-opt3", { scope: "col" }, h("span.sr-only", null, "Watch or race")),
      ),
    row: (e, c) => {
      const t = track;
      const name = `#${e.rank} · ${e.player.name}`;
      const gap = c.first && e.runId !== c.first.runId ? h("span.rb-gap", { title: `${gapTime(e.time - c.first.time).slice(1)} behind the world record` }, gapTime(e.time - c.first.time)) : e.rank === 1 ? h("span.rb-wr", null, "WR") : null;
      return h(
        "tr",
        { class: [e.rank <= 3 ? `top${e.rank}` : "", c.mine ? "me" : "", c.found ? "found" : ""].filter(Boolean).join(" ") || null, "data-run": e.runId, "data-run-title": name },
        h("td.rb-rank", null, String(e.rank)),
        playerCell(e.player, () => navigate({ screen: "profile", id: e.player.id })),
        h("td.num.rb-strong", { title: [`${e.ticks.toLocaleString("en-US")} ticks`, physicsNote(e)].filter(Boolean).join(" · ") }, formatTime(e.time)),
        h("td.num.rb-opt3", null, gap),
        h("td.num.dim.rb-opt", null, String(e.jumps)),
        h("td.num.dim.rb-opt", null, e.strafes == null ? "—" : String(e.strafes)),
        h("td.num.dim.rb-opt.lb-perf", { title: e.perf == null ? "Not recorded for this run" : "Perfectly timed measured hops" }, e.perf == null ? "—" : `${e.perf.toFixed(1)}%`),
        h("td.num.dim.rb-opt", null, `${e.sync.toFixed(1)}%`),
        h("td.dim.rb-opt2", { title: fullDate(e.date) }, relDate(e.date)),
        h(
          "td.rb-acts.rb-opt3",
          null,
          withReplayViews(h("button.link-btn", { type: "button", title: `Watch ${e.player.name}'s run in the replay viewer`, "aria-label": `Watch ${e.player.name}'s run`, onclick: () => openReplayViewer({ runId: e.runId, name }) }, "Watch"), e.runId),
          h("button.link-btn", { type: "button", title: `Race ${e.player.name}'s run as a ghost`, "aria-label": `Race ${e.player.name}'s run as a ghost`, onclick: () => race(e, t) }, "Race"),
          adminLink(e.player.id, "rb-admin", "Admin"),
        ),
      );
    },
    you: (p, onPage) => {
      if (onPage && p?.me) return h("span", null, `You're `, h("b", null, `#${p.me.rank}`), ` on this page · `, localPb());
      return localPb();
    },
    meta: (p) =>
      h(
        "span",
        null,
        h("b", null, p.total.toLocaleString("en-US")),
        ` ${p.total === 1 ? "runner" : "runners"} · ${label()}`,
      ),
    empty: () =>
      following
        ? h("div.rb-state.empty", null, h("strong", null, "Nobody you follow has a time here"), h("span", null, "Follow players from their profile or a leaderboard row."))
        : h("div.rb-state.empty", null, h("strong", null, "No records yet"), h("span", null, `Finish a ${label()} run to set the first world record.`)),
    error: (e) =>
      e instanceof ApiUnavailable
        ? { cls: "offline", title: "Leaderboards offline", text: "Your runs are saved on this device until the server is back." }
        : { cls: "error", title: "Couldn't load the leaderboard", text: String((e as Error)?.message ?? e) },
    idOf: (e) => e.player.id,
    rankOf: (e) => e.rank,
    nameOf: (e) => e.player.name,
    valueOf: (e) => formatTime(e.time),
  });

  const seg = (aria: string, items: [string, string, string, boolean, () => void][]) =>
    h(
      "div.seg",
      { role: "radiogroup", "aria-label": aria },
      ...items.map(([text, title, key, on, fn]) => h(`button${on ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(on), title, "data-key": key, onclick: fn }, text)),
    );

  function renderControls(): void {
    const parts: HTMLElement[] = [];
    if (tracks.length > 1) parts.push(seg("Track", tracks.map((t) => [nameOf(t), t ? `${nameOf(t)} (Normal style only)` : "Main track", String(t), t === track, () => ((track = t), refresh())])));
    if (api.available()) parts.push(seg("Players", [["All", "Everyone", "all", !following, () => ((following = false), refresh())], ["Following", "Players you follow, and you", "following", following, () => ((following = true), refresh())]]));
    if (track === 0) parts.push(seg("Style", STYLE_DEFS.map((d) => [d.name, d.rule, d.id, d.id === mainStyle, () => ((mainStyle = d.id), opts.onStyle?.(d.id), refresh())])));
    else if (!opts.trackNames?.[track]) parts.push(h("span.rb-only", null, `${styleLabel(BONUS_STYLE)} only on bonus tracks`));
    // Keep keyboard focus on the switch that was just used (the buttons are rebuilt).
    const key = (document.activeElement as HTMLElement | null)?.closest(".rb-controls") ? (document.activeElement as HTMLElement).dataset.key : undefined;
    board.controls.replaceChildren(...parts);
    if (key !== undefined) board.controls.querySelector<HTMLElement>(`button.on[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  function source(): BoardSource<LeaderboardEntry> {
    const s = boardStyle();
    const t = track;
    return {
      key: `${map}|${s}|${t}|${following ? "f" : ""}`,
      load: async (o, signal) => toPage(await api.leaderboard(map, s, { ...o, track: t, ...(following ? { scope: "following" as const } : {}) }, { signal }), o.offset),
      search: async (q, signal) => {
        const lb = await api.leaderboard(map, s, { q, limit: 8, track: t }, { signal });
        return { entries: lb.entries, matches: lb.matches ?? lb.entries.length };
      },
    };
  }

  const root = h("div.leaderboard");
  // Hover / focus / hold a row: its stats card (ui/run-stats.ts).
  bindRunStats(root);
  function refresh(): void {
    root.classList.toggle("show-perf", boardStyle() === "scroll");
    renderControls();
    if (!api.available()) {
      root.replaceChildren(h("div.rb-state.offline", null, h("strong", null, "Leaderboards offline"), h("span", null, "Your runs are saved on this device until the server is back."), h("span.dim", null, localPb())));
      return;
    }
    if (board.root.parentElement !== root) root.replaceChildren(board.root);
    board.show(source());
  }
  refresh();
  return root;
}

/** The board of one map in a dialog (map browser: "Leaderboard" in the preview). */
export function openLeaderboardDialog(map: string, style: string, opts: BoardOptions = {}): void {
  openBoardDialog({ title: "Leaderboard", subtitle: opts.subtitle ?? map, label: `${map} leaderboard`, body: () => leaderboardPanel(map, style, { ...opts, keys: "global" }) });
}

/** Shared full leaderboard shell: focus, dismissal and table space match map boards. */
export function openBoardDialog(o: { title: string; subtitle: string; label: string; body: (close: () => void) => HTMLElement }): void {
  const d = h("dialog.acct-dialog.rb-dialog", { "aria-label": o.label }) as HTMLDialogElement;
  const dismiss = () => d.close();
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), dismiss());
  });
  dismissOutside(d, dismiss);
  d.addEventListener("close", () => d.remove());
  const close = h("button.acct-close", { type: "button", "aria-label": "Close", onclick: dismiss }, "×");
  d.append(h("header.acct-head", null, h("h2", null, o.title, h("small", null, o.subtitle)), close), h("div.rb-dialog-body", null, o.body(dismiss)));
  document.body.append(d);
  d.showModal();
}
