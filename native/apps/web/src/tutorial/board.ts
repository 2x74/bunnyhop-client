// The final course's leaderboard at the finish (mode.ts puts it on the end-of-run card): the top 10, your row, rank and
// best, the next time to beat and the gold line. It's the map's bonus 1 board (Esc → Leaderboard shows the same one,
// paged), read through the same API; drawn small, in the end card's own type, the way the in-game scoreboard marks
// your row.

import { api, type LeaderboardEntry } from "../api";
import { BONUS_STYLE } from "../styles";
import { formatTime } from "../timer";
import { h } from "../ui/dom";
import { nameAttrs, nameMarks } from "../ui/marks";
import { TUTORIAL_MAP } from "./data";
import { FINAL_TRACK, goldSlot, nextToBeat } from "./flow";

const TOP = 10;

interface BoardData {
  top: LeaderboardEntry[];
  total: number;
  me: LeaderboardEntry | null;
  /** The run just faster than yours (null: you're first, or you have no time). */
  next: LeaderboardEntry | null;
}

async function load(best: number | null, signal: AbortSignal): Promise<BoardData> {
  const lb = await api.leaderboard(TUTORIAL_MAP, BONUS_STYLE, { offset: 0, limit: TOP, track: FINAL_TRACK }, { signal });
  const top = lb.entries;
  const mine = lb.me ?? (best !== null ? { time: best } : null);
  let next = nextToBeat(top, mine);
  // Your row is below the top 10: the run just above it is at board position rank - 2 (RANK counts strictly faster).
  if (!next && lb.me && lb.me.rank > top.length + 1) {
    const above = await api.leaderboard(TUTORIAL_MAP, BONUS_STYLE, { offset: lb.me.rank - 2, limit: 1, track: FINAL_TRACK }, { signal });
    next = nextToBeat(above.entries, lb.me);
  }
  return { top, total: lb.total, me: lb.me, next };
}

const row = (e: LeaderboardEntry, me: boolean) =>
  h(
    `tr${me ? ".me" : ""}`,
    null,
    h("td.tb-rank", null, String(e.rank)),
    h("td.tb-name", null, h("span.tb-pname", nameAttrs(e.player), e.player.name), nameMarks(e.player)),
    h("td.tb-time", null, formatTime(e.time)),
  );

function render(d: BoardData, best: number | null, gold: number): HTMLElement {
  const myId = d.me?.player.id;
  const rows: HTMLElement[] = d.top.map((e) => row(e, e.player.id === myId));
  const g = goldSlot(d.top, gold, TOP, d.total);
  if (g !== null && d.top.length) rows.splice(g, 0, h("tr.gold", null, h("td.tb-rank"), h("td.tb-name", null, "Gold"), h("td.tb-time", null, `under ${formatTime(gold)}`)));
  if (d.me && !d.top.some((e) => e.player.id === myId)) rows.push(h("tr.gap", { "aria-hidden": "true" }, h("td", { colspan: 3 }, "…")), row(d.me, true));
  const time = d.me?.time ?? best;
  const you: (string | Node)[] = [];
  if (d.me) you.push("You're ", h("b", null, `#${d.me.rank}`), ` of ${d.total.toLocaleString("en-US")}`);
  else if (time !== null) you.push("Your best ", h("b", null, formatTime(time)));
  if (d.me?.rank === 1) you.push(". The record is yours.");
  else if (d.next) you.push(`${you.length ? ". " : ""}Next to beat: ${d.next.player.name}, `, h("b", null, formatTime(d.next.time)));
  else if (time !== null && d.top.length >= TOP && d.total > TOP) you.push(`. The top ${TOP} is under `, h("b", null, formatTime(d.top[TOP - 1].time)));
  return h(
    "div.tut-board",
    null,
    h("div.tb-head", null, "Final course leaderboard"),
    d.top.length ? h("table.tb-table", { "aria-label": "Final course leaderboard, top 10" }, h("tbody", null, ...rows)) : h("div.tb-line", null, "No records yet."),
    you.length ? h("div.tb-line", null, ...you) : null,
  );
}

/** The finish's board: `show()` loads (again) and redraws it in `el`. Nothing at all when the leaderboards are offline. */
export class FinaleBoard {
  readonly el = h("div.tut-board-slot");
  private ctl: AbortController | null = null;

  /** Shown at all (the API is configured). */
  get available(): boolean {
    return api.available();
  }

  /** `best`: your best time on this device (seconds), for when your run isn't on the board (yet). `gold`: seconds. */
  async show(best: number | null, gold: number): Promise<void> {
    if (!this.available) return;
    this.ctl?.abort();
    const ctl = (this.ctl = new AbortController());
    if (!this.el.firstChild) this.el.replaceChildren(h("div.tb-line.dim", null, "Loading the leaderboard…"));
    try {
      const d = await load(best, ctl.signal);
      if (!ctl.signal.aborted) this.el.replaceChildren(render(d, best, gold));
    } catch (e) {
      if (!ctl.signal.aborted && (e as Error)?.name !== "AbortError") this.el.replaceChildren(h("div.tb-line.dim", null, "The leaderboard is offline right now."));
    }
  }

  dispose(): void {
    this.ctl?.abort();
  }
}
