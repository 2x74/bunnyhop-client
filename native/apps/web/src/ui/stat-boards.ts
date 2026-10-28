// The player leaderboards on Stats → Game stats (apps/api src/stat-boards.ts): world records, hardest clears, maps
// cleared, finishes, time played, most watched and top gifters. The section shows one board's top ten with the boards as tabs; "See all" opens the whole
// board in the leaderboard dialog (ui/leaderboard.ts), with the same tabs in its toolbar.

import "./stat-boards.css";
import { api, type StatBoardEntry, type StatBoardId, type StatBoardPage } from "../api";
import { h } from "./dom";
import { clampTier, tierLabel } from "../tiers";
import { pagedBoard, playerCell, type BoardPage } from "./board-pager";
import { openBoardDialog } from "./leaderboard";
import { navigate } from "./nav";

const n = (x: number) => x.toLocaleString();
const count = (one: string, many = `${one}s`) => (e: StatBoardEntry) => `${n(e.value)} ${e.value === 1 ? one : many}`;
const BOARDS: { id: StatBoardId; tab: string; column: string; value: (e: StatBoardEntry) => string | Node; unit: (e: StatBoardEntry) => string }[] = [
  { id: "wrs", tab: "World records", column: "WRs", value: (e) => n(e.value), unit: count("world record") },
  {
    id: "hardest",
    tab: "Hardest clears",
    column: "Hardest",
    // The tier in its colour, then how many maps of it.
    value: (e) => h("span.sb-hard", null, h("b", { style: `color:var(--tier-${clampTier(e.tier) ?? "x"})` }, tierLabel(e.tier)), ` × ${n(e.value)}`),
    unit: (e) => `${n(e.value)} ${tierLabel(e.tier)} ${e.value === 1 ? "map" : "maps"}`,
  },
  { id: "maps", tab: "Maps cleared", column: "Maps", value: (e) => n(e.value), unit: count("map") },
  { id: "finishes", tab: "Finishes", column: "Finishes", value: (e) => n(e.value), unit: count("finish", "finishes") },
  { id: "playtime", tab: "Time played", column: "Hours", value: (e) => (e.value / 3600).toLocaleString(undefined, { maximumFractionDigits: e.value < 36_000 ? 1 : 0 }), unit: (e) => `${(e.value / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })}h played` },
  { id: "views", tab: "Most watched", column: "Replay views", value: (e) => n(e.value), unit: count("view") },
  { id: "gifts", tab: "Top gifters", column: "Gifts", value: (e) => n(e.value), unit: count("gift") },
];
const boardOf = (id: StatBoardId) => BOARDS.find((b) => b.id === id)!;

/** A row of board tabs; `pick` is called with the new board. */
function boardTabs(cur: () => StatBoardId, pick: (id: StatBoardId) => void): HTMLElement {
  const bar = h("div.sb-tabs", { role: "tablist", "aria-label": "Leaderboard" });
  const draw = () =>
    bar.replaceChildren(
      ...BOARDS.map((b) =>
        h(
          `button.sb-tab${b.id === cur() ? ".on" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(b.id === cur()), tabindex: b.id === cur() ? "0" : "-1", onclick: () => b.id !== cur() && (pick(b.id), draw()) },
          b.tab,
        ),
      ),
    );
  bar.addEventListener("keydown", (e) => {
    const i = BOARDS.findIndex((b) => b.id === cur());
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    pick(BOARDS[(j + BOARDS.length) % BOARDS.length].id);
    draw();
    bar.querySelector<HTMLElement>(".sb-tab.on")?.focus();
  });
  draw();
  return bar;
}

const head = (b: StatBoardId) => h("tr", null, h("th.rb-rank", { scope: "col" }, "#"), h("th", { scope: "col" }, "Player"), h("th.num", { scope: "col" }, boardOf(b).column));

function row(b: StatBoardId, e: StatBoardEntry, open: () => void, cls = ""): HTMLTableRowElement {
  return h(
    "tr.rb-row",
    { class: [e.rank <= 3 ? `top${e.rank}` : "", cls].filter(Boolean).join(" ") || null },
    h("td.rb-rank", null, String(e.rank)),
    playerCell(e.player, open),
    h("td.num.rb-strong", null, boardOf(b).value(e)),
  ) as HTMLTableRowElement;
}

/** The whole board in the leaderboard dialog, opened on `start`. */
export function openStatBoardDialog(start: StatBoardId): void {
  let cur = start;
  openBoardDialog({
    title: "Leaderboards",
    subtitle: "",
    label: "Player leaderboards",
    body: (close) => {
      const open = (e: StatBoardEntry) => () => (close(), navigate({ screen: "profile", id: e.player.id }));
      const board = pagedBoard<StatBoardEntry>({
        base: 0,
        cols: 3,
        label: "Player leaderboard",
        keys: "global",
        head: () => head(cur) as HTMLTableRowElement,
        row: (e, ctx) => row(cur, e, open(e), [ctx.mine ? "me" : "", ctx.found ? "found" : ""].filter(Boolean).join(" ")),
        you: (data, onPage) => (data?.me && !onPage ? h("span", null, "You're ", h("b", null, `#${data.me.rank}`), ` with ${boardOf(cur).unit(data.me)}`) : null),
        meta: (data) => h("span", null, h("b", null, n(data.total)), ` ${data.total === 1 ? "player" : "players"}`),
        empty: () => h("div.rb-state.empty", null, h("strong", null, "Nobody here yet")),
        error: () => ({ cls: "error", title: "Couldn’t load the leaderboard", text: "Try again in a moment." }),
        idOf: (e) => e.player.id,
        rankOf: (e) => e.rank,
        nameOf: (e) => e.player.name,
        valueOf: (e) => boardOf(cur).unit(e),
      });
      const source = (id: StatBoardId) => ({
        key: `stat-board-${id}`,
        load: async (o: { offset: number; limit: number; around?: string }, signal?: AbortSignal): Promise<BoardPage<StatBoardEntry>> => ({
          ...(await api.statBoard(id, o, { signal })),
          pinned: [],
          above: null,
        }),
        search: async (q: string, signal: AbortSignal) => {
          const d = await api.statBoard(id, { q, limit: 8 }, { signal });
          return { entries: d.entries, matches: d.matches ?? d.entries.length };
        },
      });
      board.controls.append(boardTabs(() => cur, (id) => ((cur = id), board.show(source(id)))));
      board.show(source(cur));
      return h("div.leaderboard", null, board.root);
    },
  });
}

/** Game stats' section: the boards as tabs over one board's top ten. Loaded when shown, kept for five minutes. */
const top = new Map<StatBoardId, { at: number; data: Promise<StatBoardPage> }>();
let lastBoard: StatBoardId = "wrs";

export function statBoardsSection(): HTMLElement {
  const table = h("div.sb-top");
  const load = () => {
    const id = lastBoard;
    let hit = top.get(id);
    if (!hit || Date.now() - hit.at > 300_000) top.set(id, (hit = { at: Date.now(), data: api.statBoard(id, { limit: 10 }) }));
    table.setAttribute("aria-busy", "true");
    hit.data.then(
      (d) => {
        if (id !== lastBoard) return;
        table.replaceChildren(
          d.entries.length
            ? h(
                "table.rb-table",
                { "aria-label": `${boardOf(id).tab}, top ten` },
                h("thead", null, head(id)),
                h("tbody", null, ...d.entries.map((e) => row(id, e, () => navigate({ screen: "profile", id: e.player.id })))),
              )
            : h("p.st-empty", null, "Nobody here yet."),
          d.me && !d.entries.some((e) => e.player.id === d.me!.player.id) ? h("p.sb-you", null, "You're ", h("b", null, `#${d.me.rank}`), ` with ${boardOf(id).unit(d.me)}`) : "",
        );
      },
      () => {
        top.delete(id);
        if (id === lastBoard) table.replaceChildren(h("p.st-empty", null, "Couldn't load this leaderboard."));
      },
    ).finally(() => table.removeAttribute("aria-busy"));
  };
  load();
  return h(
    "section.st-block.sb",
    null,
    h("div.st-h-row", null, h("h3.st-h", null, "Leaderboards"), h("button.link-btn", { type: "button", onclick: () => openStatBoardDialog(lastBoard) }, "See all ›")),
    boardTabs(() => lastBoard, (id) => ((lastBoard = id), load())),
    table,
  );
}
