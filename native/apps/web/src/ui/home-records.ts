// Recent world records on the home screen (ui/home.ts, right side above the maps to try): the newest WRs that still
// stand, every style (GET /records/wrs, apps/api/src/recent-wrs.ts). A row: the map's picture, name and tier, the style
// and the time, then the holder (avatar and name, with the hover card the boards use) and how long ago. The picture and
// map open the run in the replay viewer; the holder opens their profile.
//
// The list is one saved answer on the server, so the client asks once a minute at most, however often the home screen
// is rebuilt. While it loads, rows of empty pictures hold its place; with nothing to show it says so. Offline (no API)
// or when the request fails, there is no list at all.

import { api, type RecentWr } from "../api";
import { styleLabel } from "../styles";
import { clampTier, tierLabel, tierName, tierNum } from "../tiers";
import { formatTime } from "../timer";
import { openReplayViewer } from "../viewer/request";
import { pictureOf, avatarImg } from "./avatar";
import { decorated } from "./avatar-deco";
import { hueOf, relDate, fullDate } from "./board-pager";
import { h } from "./dom";
import { hoverCardFor } from "./hover-card";
import { nameAttrs, nameMarks } from "./marks";
import { mapArt, observeThumbs } from "./thumbs";

/** Rows asked for; the CSS shows fewer on short windows (style.css .home-recs). */
export const RECORD_ROWS = 6;
const TTL_MS = 60_000;
let cached: { at: number; list: Promise<RecentWr[]> } | null = null;

/** The list, shared for TTL_MS (a failed answer isn't kept). */
export function recentWrs(): Promise<RecentWr[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.list;
  const list = api.recentWrs(RECORD_ROWS).then((r) => r.records);
  const entry = { at: now, list };
  cached = entry;
  list.catch(() => cached === entry && (cached = null));
  return list;
}
/** Tests: forget the shared answer. */
export const forgetRecentWrs = () => void (cached = null);

export interface RecordsActions {
  /** Open a player's profile (menu.ts openProfile). */
  profile: (id: string) => void;
  /** Watch a run (default: the replay viewer). */
  watch?: (r: RecentWr) => void;
}

const watchRun = (r: RecentWr) => openReplayViewer({ runId: r.runId, name: `WR · ${r.player.name}` });

/** One record: the run (picture, map, style, time) and the holder (avatar, name, when). */
export function recordRow(r: RecentWr, a: RecordsActions, now = Date.now()): HTMLElement {
  const t = clampTier(r.tier);
  const style = styleLabel(r.style);
  const watch = () => (a.watch ?? watchRun)(r);
  const run = h(
    "button.home-rec-run",
    { type: "button", title: `Watch the ${style} world record on ${r.map}`, onclick: watch },
    mapArt(r.map, r.thumbnailUrl, { className: "home-rec-art" }),
    h(
      "span.home-rec-text",
      null,
      h("span.home-rec-map", null, h("b", null, r.map), h(`span.home-tile-tier.${t ? `t${t}` : "tx"}`, { title: t ? `Tier ${tierNum(t)}, ${tierName(t)}` : "Unrated" }, tierLabel(t))),
      h("span.home-rec-time", null, h("small", null, style), h("b.wr", { title: `${r.ticks.toLocaleString("en-US")} ticks` }, formatTime(r.time))),
    ),
  );
  const p = r.player;
  const letter = () => h("span.home-rec-av.rb-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  const href = `/u/${encodeURIComponent(p.id)}`;
  const who = h(
    "a.home-rec-who",
    {
      href,
      title: `${p.name}'s profile`,
      onclick: (ev: Event) => {
        const e = ev as MouseEvent;
        // A real link: middle-click / Ctrl-click open it in a new tab; a plain click opens it in place.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        a.profile(p.id);
      },
    },
    hoverCardFor(decorated(pic ? avatarImg(pic, { cls: "home-rec-av", px: 28, letter }) : letter(), p), p),
    h(
      "span.home-rec-whotext",
      null,
      h("span.home-rec-name", null, h("b", nameAttrs(p), p.name), nameMarks(p)),
      h("small", { title: fullDate(r.date) }, relDate(r.date, now)),
    ),
  );
  return h("li.home-rec", { "data-run": r.runId }, run, who);
}

/** Rows of empty pictures while the list loads (the list's own height, so nothing moves when it lands). */
function placeholder(): HTMLElement[] {
  return Array.from({ length: RECORD_ROWS }, () =>
    h(
      "li.home-rec.home-rec-wait",
      { "aria-hidden": "true" },
      h("span.home-rec-run", null, h("span.card-art.home-rec-art"), h("span.home-rec-text", null, h("span.home-rec-bar"), h("span.home-rec-bar.short"))),
      h("span.home-rec-who", null, h("span.home-rec-av"), h("span.home-rec-whotext", null, h("span.home-rec-bar"))),
    ),
  );
}

/** The section: heading, then the rows (or the wait, or "nothing lately"). Hidden offline and on errors. */
export function recentRecords(a: RecordsActions, load: () => Promise<RecentWr[]> = recentWrs): HTMLElement {
  const list = h("ol.home-recs", { "aria-busy": "true" }, ...placeholder());
  const box = h("section.home-records", { "aria-label": "Recent world records" }, h("h2.home-recs-head", null, "Recent world records"), list);
  if (!api.available()) {
    box.hidden = true;
    return box;
  }
  void load().then(
    (records) => {
      list.removeAttribute("aria-busy");
      if (!records.length) {
        list.replaceChildren(h("li.home-rec-none", null, "No new world records lately"));
        return;
      }
      const now = Date.now();
      list.replaceChildren(...records.map((r) => recordRow(r, a, now)));
      observeThumbs(list);
    },
    () => (box.hidden = true),
  );
  return box;
}
