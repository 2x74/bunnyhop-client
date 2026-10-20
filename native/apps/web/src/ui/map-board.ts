// The map list's board (ui/maps.ts, tutorial/learn.ts): the selected map's top runs in the selected style, the WR
// first and your row pinned under them when it's further down, from the same GET /leaderboards read as the full board
// (ui/leaderboard.ts). One request per map the player settles on (callers debounce), aborted when they move on, cached
// for 30 s. Rows that don't fit the panel are left out rather than scrolled.

import { api, ApiUnavailable, type Leaderboard, type LeaderboardEntry } from "../api";
import { getPB } from "../pb";
import { formatTime } from "../timer";
import { gapTime, playerCell } from "./board-pager";
import { h } from "./dom";
import { icon } from "./icons";
import { navigate } from "./nav";

const LIMIT = 10;
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<Leaderboard> }>();
let inflight: AbortController | null = null;

function load(map: string, style: string, track: number): Promise<Leaderboard> {
  const key = `${map}|${style}|${track}`;
  const hit = cache.get(key);
  if (hit && performance.now() - hit.at < CACHE_MS) return hit.p;
  inflight?.abort();
  const ctl = (inflight = new AbortController());
  const p = api.leaderboard(map, style, { limit: LIMIT, track }, { signal: ctl.signal });
  cache.set(key, { at: performance.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export interface MapBoardOptions {
  map: string;
  style: string;
  /** 0 = main (default), N = bonus N. */
  track?: number;
  /** false: an unranked map (no board at all); null: not known (offline API answer). */
  ranked: boolean | null;
  /** Heading (default "Leaderboard"). */
  title?: string;
  /** Next to the heading, e.g. the style's name. */
  label?: string;
  /** "Full leaderboard": the paged board in a dialog. */
  onFull?: (() => void) | null;
}

type FitBoard = HTMLElement & { fit?: () => void };

/** Re-fits a board's rows to its panel (after the panel resized). */
export function refitBoard(el: Element | null): void {
  (el as FitBoard | null)?.fit?.();
}

const state = (title: string, text: string | null, cls = "") => h(`div.mbd-state${cls ? "." + cls : ""}`, null, h("b", null, title), text ? h("span", null, text) : null);

export function mapBoard(o: MapBoardOptions): HTMLElement {
  const track = o.track ?? 0;
  const meta = h("span.mbd-count");
  const full = o.onFull && o.ranked !== false && api.available() ? h("button.link-btn.mbd-full", { type: "button", onclick: o.onFull }, "Full leaderboard", icon("chevronRight")) : null;
  const body = h("div.mbd-body");
  const local = getPB(o.map, o.style, track);
  const localLine = (prefix: string) => (local ? h("p.mbd-local", null, prefix, h("b", null, formatTime(local.time))) : "");
  const root = h("section.mbd-board", { "aria-label": o.title ?? "Leaderboard" }, h("header.mbd-head", null, h("h4", null, o.title ?? "Leaderboard"), meta, full), body);
  if (o.label) meta.textContent = o.label;

  if (o.ranked === false) {
    body.append(state("Unranked", "Runs on this map aren't submitted, so it has no leaderboard. Your PBs are kept in this browser.", "unranked"), localLine("Your PB "));
    return root;
  }
  if (!api.available()) {
    body.append(state("Leaderboards are offline", "Your runs are saved in this browser until the server is back.", "offline"), localLine("Your PB "));
    return root;
  }

  const table = h("table.rb-table.mbd-table", { "aria-label": `${o.map} leaderboard` });
  const rows = h("tbody");
  const you = h("tfoot");
  table.append(rows, you);
  // Skeleton rows of the final size while the board loads (nothing jumps when it arrives).
  rows.append(...Array.from({ length: 5 }, () => h("tr.rb-skel", { "aria-hidden": "true" }, h("td", null, h("span.rb-sk")), h("td", null, h("span.rb-sk")), h("td", null, h("span.rb-sk")))));
  body.append(table);

  const row = (e: LeaderboardEntry, first: LeaderboardEntry | null, mine: boolean) => {
    const gap = first && e.runId !== first.runId ? gapTime(e.time - first.time) : null;
    return h(
      "tr.rb-row",
      { class: [e.rank <= 3 ? `top${e.rank}` : "", mine ? "me" : ""].filter(Boolean).join(" ") || null },
      h("td.rb-rank", null, String(e.rank)),
      playerCell(e.player, () => navigate({ screen: "profile", id: e.player.id })),
      h("td.num.mbd-time", { title: gap ? `${gap.slice(1)} behind the world record` : e.rank === 1 ? "World record" : null }, h("b", null, formatTime(e.time)), gap ? h("small", null, gap) : null),
    );
  };

  void load(o.map, o.style, track).then(
    (lb) => {
      meta.textContent = [o.label, lb.total ? `${lb.total.toLocaleString("en-US")} ${lb.total === 1 ? "runner" : "runners"}` : null].filter(Boolean).join(" · ");
      if (!lb.entries.length) {
        body.replaceChildren(state("No records yet", `Finish a run to set the first ${o.label ? o.label + " " : ""}record.`, "empty"), localLine("Your PB "));
        return;
      }
      const first = lb.wr ?? lb.entries[0];
      const meId = lb.me?.player.id;
      rows.replaceChildren(...lb.entries.map((e) => row(e, first, e.player.id === meId)));
      if (lb.me && !lb.entries.some((e) => e.player.id === meId)) you.replaceChildren(row(lb.me, first, true));
      else you.replaceChildren();
      const line = !lb.me && local ? localLine("Your PB in this browser ") : null;
      if (line) body.append(line);
      requestAnimationFrame(fit);
    },
    (e: unknown) => {
      if (!root.isConnected) return; // replaced (and its request aborted) before it answered
      body.replaceChildren(
        e instanceof ApiUnavailable ? state("Leaderboards are offline", "Your runs are saved in this browser until the server is back.", "offline") : state("Couldn't load the leaderboard", null, "error"),
        localLine("Your PB "),
      );
    },
  );

  // Rows past the panel's height are hidden (your pinned row always stays). Only when the panel bounds the board
  // (desktop); on a phone the sheet scrolls and every row shows. The map list calls it again when its panel resizes.
  function fit(): void {
    const list = [...rows.rows];
    for (const r of list) r.hidden = false;
    if (!body.isConnected || getComputedStyle(body).overflowY !== "hidden") return;
    const avail = body.clientHeight - you.getBoundingClientRect().height - ((body.querySelector(".mbd-local") as HTMLElement | null)?.offsetHeight ?? 0);
    const rh = (list[0]?.getBoundingClientRect().height ?? 0) + 2;
    if (!rh) return;
    const n = Math.max(1, Math.floor(avail / rh));
    list.forEach((r, i) => (r.hidden = i >= n));
  }
  (root as FitBoard).fit = fit;
  return root;
}
