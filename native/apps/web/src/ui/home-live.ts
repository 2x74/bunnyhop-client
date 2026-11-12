// Live now on the home screen (ui/home.ts, right side above the recent world records): players streaming right now
// (src/live.ts, GET /live). Rows like the records': on the left the stream (the platform's mark where the records
// have a map picture, the title, LIVE and how long), on the right the player (avatar and name with the hover card,
// opening their profile). The stream opens in a new tab. Nothing at all while nobody is live.
//
// Custom CSS (the /custom-css guide promises these): #home-live, its rows' [data-part="stream"] and
// [data-part="player"], and --home-live: none on :root, which hides it.

import { api } from "../api";
import { onCssStatus } from "../custom-css";
import { LIVE_PLATFORM_NAME, liveWhere, onLive, type LiveStream } from "../live";
import { pictureOf, avatarImg } from "./avatar";
import { decorated } from "./avatar-deco";
import { hueOf } from "./board-pager";
import { h } from "./dom";
import { hoverCardFor } from "./hover-card";
import { linkIcon, nameAttrs, nameMarks } from "./marks";

/** Rows shown at most (the CSS shows fewer on short windows: style.css .home-live). */
export const LIVE_ROWS = 3;

export interface LiveActions {
  /** Open a player's profile (menu.ts openProfile). */
  profile: (id: string) => void;
}

/** One stream: where (platform mark, title, LIVE and for how long) and who. */
export function liveRow(s: LiveStream, a: LiveActions, now = Date.now()): HTMLElement {
  const where = LIVE_PLATFORM_NAME[s.platform];
  const p = s.player;
  const stream = h(
    "a.home-rec-run.home-live-stream",
    { href: s.url, target: "_blank", rel: "noopener noreferrer nofollow", "data-part": "stream", title: `Watch ${p.name} on ${where}` },
    h(`span.home-rec-art.home-live-art.${s.platform}`, { "aria-hidden": "true" }, linkIcon(s.platform)),
    h(
      "span.home-rec-text",
      null,
      h("span.home-rec-map", null, h("b", null, s.title ?? `${p.name} on ${where}`)),
      h("span.home-rec-time", null, h("span.nm-live", null, "LIVE"), h("small.home-live-for", { "data-since": String(s.startedAt), "data-platform": s.platform }, liveWhere(s, now))),
    ),
  );
  const letter = () => h("span.home-rec-av.rb-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  const who = h(
    "a.home-rec-who",
    {
      href: `/u/${encodeURIComponent(p.id)}`,
      "data-part": "player",
      title: `${p.name}'s profile`,
      onclick: (ev: Event) => {
        const e = ev as MouseEvent;
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        a.profile(p.id);
      },
    },
    hoverCardFor(decorated(pic ? avatarImg(pic, { cls: "home-rec-av", px: 28, letter }) : letter(), p), p),
    h("span.home-rec-whotext", null, h("span.home-rec-name", null, h("b", nameAttrs(p), p.name), nameMarks(p)), s.game ? h("small", null, s.game) : null),
  );
  return h("li.home-rec.home-live-row", { "data-player": p.id }, stream, who);
}

/** Custom CSS turned it off (:root { --home-live: none }). */
const hiddenByCss = () => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--home-live").trim() === "none";
  } catch {
    return false;
  }
};

/** The section: heading and rows, hidden while nobody is live (and offline, and when custom CSS hides it). */
export function liveNow(a: LiveActions, subscribe: typeof onLive = onLive): HTMLElement {
  const list = h("ol.home-recs.home-live-list");
  const box = h("section#home-live.home-live", { "aria-label": "Live now", hidden: true }, h("h2.home-recs-head", null, "Live now"), list);
  if (!api.available()) return box;
  let streams: readonly LiveStream[] = [];
  const draw = () => {
    const off = hiddenByCss();
    box.hidden = off || !streams.length;
    if (box.hidden) return void list.replaceChildren();
    const now = Date.now();
    list.replaceChildren(...streams.slice(0, LIVE_ROWS).map((s) => liveRow(s, a, now)));
  };
  // While the home screen shows it (a few seconds' grace while it's being put on the page): after that the
  // subscription ends by itself (src/live.ts), and so do the clock and the custom CSS hook.
  const born = Date.now();
  const alive = () => box.isConnected || Date.now() - born < 5000;
  const stopLive = subscribe((s) => {
    streams = s;
    draw();
  }, alive);
  // "for 1h 05m" moves on by itself; the rows are only rebuilt when who is live changes.
  const clock = setInterval(() => {
    if (!alive()) return stop();
    const now = Date.now();
    for (const el of list.querySelectorAll<HTMLElement>(".home-live-for")) {
      const since = Number(el.dataset.since);
      const platform = el.dataset.platform as LiveStream["platform"];
      if (Number.isFinite(since) && platform) el.textContent = liveWhere({ platform, startedAt: since }, now);
    }
  }, 30_000);
  const stopCss = onCssStatus(() => (alive() ? draw() : stop()));
  function stop(): void {
    clearInterval(clock);
    stopLive();
    stopCss();
  }
  return box;
}
