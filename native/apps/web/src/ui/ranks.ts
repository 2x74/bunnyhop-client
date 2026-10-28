// Rank board: overall points (Normal-weighted, all styles) and one board per style, with rank titles
// (SurfTimer-style skill groups). A paged board (ui/board-pager.ts) sized to the window: no scrolling, numbered pages,
// ← / → paging, "jump to me" and a player search. The page and style live in the URL (/ranks?style=wonly&page=3) so a
// page can be shared; the Worker serves the same URL with a crawlable list (apps/api/src/seo/pages.ts ranksPage).
// Formula: ranking.ts, research/RANKS.md.

import { appLocation } from "../platform/navigation";
import { api, ApiUnavailable, type RankBoard, type RankEntry } from "../api";
import { BONUS_TRACK_FACTOR, fmtPoints, isRankedStyle, PLACEMENT, RANK_GROUPS, RECORD_WEIGHTING, STYLE_WEIGHT, TIER_BASE, topPercent } from "../ranking";
import { tierLabel } from "../tiers";
import { STYLE_DEFS, styleLabel } from "../styles";
import { h } from "./dom";
import { icon } from "./icons";
import { navigate } from "./nav";
import { pagedBoard, playerCell, type BoardPage, type BoardSource } from "./board-pager";
import { dismissOutside } from "./dismiss";

const SCOPES = ["all", ...STYLE_DEFS.filter((s) => isRankedStyle(s.id)).map((s) => s.id)];
const scopeName = (s: string) => (s === "all" ? "Overall" : styleLabel(s));

/** Shareable address of a rank board page (also what the Worker renders for crawlers). */
export function ranksPath(scope: string, page = 1): string {
  const q = new URLSearchParams();
  if (scope !== "all") q.set("style", scope);
  if (page > 1) q.set("page", String(page));
  return `/ranks${q.size ? `?${q}` : ""}`;
}

/** The board wrote the address (so leaving it should put "/" back; a deep link on boot is left for the router). */
let ownsUrl = false;

/** Leaving the rank board: put the address back to the home screen's (menu.ts render). */
export function leaveRanksUrl(): void {
  if (!ownsUrl) return;
  ownsUrl = false;
  if (appLocation().pathname === "/ranks") history.replaceState(history.state, "", "/");
}

/** Points rounded for the table; small gaps keep a decimal so a 0.4-point race doesn't read "0". */
const pts = (p: number) => (Math.abs(p) < 10 ? (Math.round(p * 10) / 10).toLocaleString("en-US") : fmtPoints(p));

function howItWorks(): void {
  const tiers = Object.entries(TIER_BASE).map(([t, v]) => `${tierLabel(Number(t))} ${v}`).join(" · ");
  const styles = Object.entries(STYLE_WEIGHT).filter(([, w]) => w > 0).map(([s, w]) => `${styleLabel(s)} ×${w}`).join(" · ");
  // Weight-0 styles (Auto-strafe): a ranking of their own, nothing towards Overall.
  const separate = Object.entries(STYLE_WEIGHT).filter(([, w]) => w === 0).map(([s]) => styleLabel(s)).join(" and ");
  const d = h("dialog.acct-dialog.rk-how-dialog", { "aria-label": "How points work" }) as HTMLDialogElement;
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), d.close());
  });
  dismissOutside(d, () => d.close());
  d.addEventListener("close", () => d.remove());
  d.append(
    h("header.acct-head", null, h("h2", null, "How points work"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, icon("close"))),
    h(
      "div.acct-body.rk-how-body",
      null,
      h(
        "ul",
        null,
        h("li", null, "Every verified personal best on a tiered map scores ", h("b", null, "base × (1 + WR time ÷ your time + placement)"), "."),
        h("li", null, `Base by tier: ${tiers}. Bonus tracks: ×${BONUS_TRACK_FACTOR}. Maps without a tier (T?) give no points.`),
        h("li", null, `Placement bonus: WR +${PLACEMENT[0]}, #2 +${PLACEMENT[1]}, #3 +${PLACEMENT[2]}, down to #10 +${PLACEMENT[9]}.`),
        h("li", null, `Overall rank weights styles: ${styles}. Each style also has its own board.${separate ? ` ${separate} is ranked on its own board only and doesn't count towards Overall.` : ""}`),
        h("li", null, `Your total adds your records best first, each worth ${RECORD_WEIGHTING}× the one before, so a strong set of records beats grinding easy maps.`),
        h("li", null, "Points update the moment a run is verified, for everyone on that board, and again when a map's tier changes."),
      ),
      h(
        "div.rk-how-groups",
        null,
        ...RANK_GROUPS.map((g) =>
          h(
            "div",
            null,
            h("span.rb-group", { style: `--rank:${g.color}` }, g.name),
            h("small", null, `${g.maxRank ? `top ${g.maxRank}` : g.top! < 1 ? `top ${Math.round(g.top! * 100)}%` : "everyone else"}${g.minPoints >= 1 ? ` · ${g.minPoints}+ pts` : ""}`),
          ),
        ),
      ),
    ),
  );
  document.body.append(d);
  d.showModal();
}

const toPage = (b: RankBoard, offset: number): BoardPage<RankEntry> => ({ total: b.total, offset: b.offset ?? offset, entries: b.entries, me: b.me, pinned: [], above: b.above ?? null });

export interface RanksOptions {
  page?: number;
  /** Style tab or page changed (the menu keeps them for Back from a profile). */
  onChange?(scope: string, page: number): void;
}

export function ranksScreen(initial = "all", o: RanksOptions = {}): HTMLElement {
  let scope = SCOPES.includes(initial) ? initial : "all";
  let total = 0;

  const board = pagedBoard<RankEntry>({
    base: 0,
    cols: 9,
    label: "Rank board",
    keys: "global",
    // The top three rows stand a third taller (boards.css): keep a row of room for them on every page.
    spare: 1,
    head: () =>
      h(
        "tr",
        null,
        h("th.rb-rank", { scope: "col" }, "#"),
        h("th", { scope: "col" }, "Player"),
        h("th.rb-opt2.rk-wide", { scope: "col" }, "Title"),
        h("th.num.rb-opt2", { scope: "col", title: "Level" }, "Lv"),
        h("th.num.rb-opt.rk-wide", { scope: "col", title: "Ranked personal bests" }, "Records"),
        h("th.num.rb-opt", { scope: "col", title: "World records" }, "WRs"),
        h("th.num.rb-opt.rk-wide", { scope: "col", title: "Top 10 placings" }, "Top 10"),
        h("th.num", { scope: "col" }, "Points"),
        h("th.num.rb-opt3", { scope: "col", title: "Points behind the player above" }, "Gap"),
      ),
    row: (e, c) => {
      const prev = c.prev;
      const behind = prev && e.rank ? prev.points - e.points : null;
      const gap =
        behind === null
          ? null
          : prev!.rank === e.rank
            ? h("span.rb-gap", { title: `Tied with #${prev!.rank} ${prev!.player.name}` }, "tied")
            : h("span.rb-gap", { title: `${behind.toFixed(2)} points behind #${prev!.rank} ${prev!.player.name}` }, behind < 0.05 ? "<0.1" : `−${pts(behind)}`);
      return h(
        "tr",
        { class: [e.rank && e.rank <= 3 ? `top${e.rank}` : "", c.mine ? "me" : "", c.found ? "found" : ""].filter(Boolean).join(" ") || null, style: `--rank:${e.group.color}` },
        h("td.rb-rank", null, e.rank ? String(e.rank) : "–"),
        playerCell(e.player, () => navigate({ screen: "profile", id: e.player.id }), e.title ? [e.title] : []),
        h("td.rb-opt2.rk-wide", null, h("span.rb-group", { title: e.rank ? `${topPercent(e.rank, total || e.ranked)} of ${(total || e.ranked).toLocaleString("en-US")} ranked players` : "" }, e.group.name)),
        h("td.num.dim.rb-opt2", null, String(e.level)),
        h("td.num.dim.rb-opt.rk-wide", null, String(e.records)),
        h("td.num.dim.rb-opt", null, String(e.wrs)),
        h("td.num.dim.rb-opt.rk-wide", null, String(e.top10s)),
        h("td.num.rb-strong.rk-pts", { title: `${e.points.toFixed(1)} points` }, fmtPoints(e.points)),
        h("td.num.rb-opt3", null, gap),
      );
    },
    you: (p, onPage) => {
      if (p?.me && onPage) {
        const m = p.me;
        return h("span", null, "You're ", h("b", null, `#${m.rank}`), ` of ${p.total.toLocaleString("en-US")}, ${m.group.name}${m.rank ? `, ${topPercent(m.rank, p.total)}` : ""}.`);
      }
      return h("span", null, scope === "all" ? "Finish a run on a tiered map to get ranked." : `Finish a ${styleLabel(scope)} run on a tiered map to get a ${styleLabel(scope)} rank.`);
    },
    // (No caption line under the tabs: the range at the pager says how many; How points work sits by the pager.)
    meta: () => null,
    foot: () => h("button.link-btn.rk-how", { type: "button", onclick: howItWorks }, "How points work"),
    empty: () => h("div.rb-state.empty", null, h("strong", null, "Nobody ranked yet"), h("span", null, "Finish a run on a tiered map to earn the first points.")),
    error: (e) =>
      e instanceof ApiUnavailable
        ? { cls: "offline", title: "Ranks offline", text: "The leaderboard server can't be reached right now." }
        : { cls: "error", title: "Couldn't load ranks", text: String((e as Error)?.message ?? e) },
    idOf: (e) => e.player.id,
    rankOf: (e) => e.rank ?? 0,
    nameOf: (e) => e.player.name,
    valueOf: (e) => `${fmtPoints(e.points)} pts`,
    onPage: (page) => {
      o.onChange?.(scope, page);
      // The address follows the board (shareable), except over a running game (its URL carries the map).
      if (board.root.isConnected && !appLocation().searchParams.has("map")) {
        history.replaceState(history.state, "", ranksPath(scope, page));
        ownsUrl = true;
      }
    },
  });

  const tabs = h("div.seg.rk-tabs", { role: "radiogroup", "aria-label": "Ranking" });
  const drawTabs = () => {
    const had = tabs.contains(document.activeElement);
    tabs.replaceChildren(
      ...SCOPES.map((s) =>
        h(`button${s === scope ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(s === scope), onclick: () => s !== scope && ((scope = s), drawTabs(), show(1)) }, scopeName(s)),
      ),
    );
    if (had) tabs.querySelector<HTMLElement>("button.on")?.focus();
  };
  board.controls.append(tabs);

  const source = (): BoardSource<RankEntry> => {
    const s = scope;
    return {
      key: `ranks|${s}`,
      load: async (q, signal) => {
        const b = await api.ranks(s, q, { signal });
        total = b.total;
        return toPage(b, q.offset);
      },
      search: async (q, signal) => {
        const b = await api.ranks(s, { q, limit: 8 }, { signal });
        return { entries: b.entries, matches: b.matches ?? b.entries.length };
      },
    };
  };

  const root = h("div.ranks");
  function show(page: number): void {
    if (!api.available()) {
      root.replaceChildren(h("div.rb-state.offline", null, h("strong", null, "Ranks offline"), h("span", null, "The leaderboard server can't be reached right now.")));
      return;
    }
    board.show(source(), { page });
  }
  drawTabs();
  root.append(board.root);
  show(Math.max(1, o.page ?? 1));
  return root;
}
