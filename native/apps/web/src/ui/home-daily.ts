// The Daily Challenge on the home screen (ui/home.ts, top right, where the maps to try were): today's map as a tile
// like theirs (the picture plays it), the three fastest times beside it, your own line, the time left, and yesterday's
// winner as one quiet line that opens the daily screen (ui/daily.ts). GET /daily, shared with the menu line and the
// daily screen (daily/state.ts).
//
// Custom CSS (the /custom-css guide promises these): #home-daily, its [data-part] pieces ("left", "map", "top", "you",
// "room", "yesterday"; a top row's "player" and "watch") and --home-daily: none on :root, which hides it (the maps to try come back).

import "./daily.css";
import type { DailyEntry, DailyView } from "../api";
import { DAILY_STYLE, dailyStyle, guestPlace, placeOf, styleNote, timeLeft } from "../daily/state";
import { styleLabel } from "../styles";
import { clampTier, tierLabel, tierName, tierNum } from "../tiers";
import { formatTime } from "../timer";
import { avatarImg, pictureOf } from "./avatar";
import { decorated } from "./avatar-deco";
import { hueOf, playerChip } from "./board-pager";
import { h } from "./dom";
import { hoverCardFor } from "./hover-card";
import { icon } from "./icons";
import { nameAttrs, nameMarks } from "./marks";
import { mapArt } from "./thumbs";
import { openReplayViewer } from "../viewer/request";
import { dailyRoomLink } from "./daily-room-link";

export interface HomeDailyActions {
  /** Play the day's map from the Daily entry, in the day's style. */
  play: (day: string, map: string, style?: string) => void;
  /** Open the daily screen (on a day's board). */
  open: (day?: string) => void;
  profile: (id: string) => void;
  /** The home screen's "Save progress" (ui/account.ts): the account panel at its sign-in methods. */
  save: () => void;
}

/** Whether the last answer had a daily: the home screen then holds the block's place while it asks again. */
const SEEN_KEY = "bunnyhop:daily-on";
export const dailySeen = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
};
export const noteDaily = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(SEEN_KEY, "1");
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    /* private mode */
  }
};

/** Custom CSS turned the block off (:root { --home-daily: none }). */
export const dailyHiddenByCss = (): boolean => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--home-daily").trim() === "none";
  } catch {
    return false;
  }
};

/** Watch a run of the day in the replay viewer (the board's Watch, ui/daily.ts). */
const watch = (e: DailyEntry) => openReplayViewer({ runId: e.runId, name: `#${e.rank} · ${e.player.name} · Daily` });

/**
 * One of the three fastest: the place, the player (avatar and name open their profile), and under the name the time,
 * which is the way to watch that run. The leader's says "Watch" beside it; the others' say it on hover.
 */
function topRow(e: DailyEntry, a: HomeDailyActions): HTMLElement {
  const p = e.player;
  const letter = () => h("span.home-rec-av.rb-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  const profile = (ev: Event) => {
    const m = ev as MouseEvent;
    if (m.button !== 0 || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
    ev.preventDefault();
    a.profile(p.id);
  };
  const href = `/u/${encodeURIComponent(p.id)}`;
  return h(
    "li.home-daily-row",
    { "data-run": e.runId },
    h("span.home-daily-rank", null, String(e.rank)),
    // (The name is the profile link keyboards reach; the picture is the same link for the pointer.)
    h("a.home-daily-av", { href, tabindex: "-1", "aria-hidden": "true", onclick: profile }, hoverCardFor(decorated(pic ? avatarImg(pic, { cls: "home-rec-av", px: 28, letter }) : letter(), p), p)),
    h(
      "span.home-rec-whotext",
      null,
      // (The mini profile on the name too, as on the picture.)
      hoverCardFor(h("a.home-rec-name.home-daily-name", { href, "data-part": "player", onclick: profile }, h("b", nameAttrs(p), p.name), nameMarks(p)), p),
      // (A run whose replay is gone has nothing to watch: its time is plain text.)
      e.watch === false
        ? h("span.home-daily-watch", null, h("b.home-daily-time", null, formatTime(e.time)))
        : h(
            "button.home-daily-watch",
            { type: "button", "data-part": "watch", title: `Watch ${p.name}'s run in the replay viewer`, "aria-label": `Watch ${p.name}'s run, ${formatTime(e.time)}`, onclick: () => watch(e) },
            h("b.home-daily-time", null, formatTime(e.time)),
            h(`span.home-daily-watch-word${e.rank === 1 ? ".lead" : ""}`, null, "Watch"),
          ),
    ),
  );
}

/** The block for an answer with a daily. `onArt`: the picture loaded (or can't): it is the page's largest paint. */
export function homeDaily(v: Extract<DailyView, { enabled: true }>, a: HomeDailyActions, onArt: () => void = () => {}): HTMLElement {
  const t = v.today;
  const tier = clampTier(t.map.tier);
  // The countdown runs on the server's clock.
  const skew = v.now - Date.now();
  const left = h("span.home-daily-left", { "data-part": "left" });
  const paintLeft = () => {
    const s = timeLeft(t.endsAt, Date.now() + skew);
    left.textContent = s ? `${s} left` : "Ended";
  };
  paintLeft();
  let seen = false;
  const timer = window.setInterval(() => {
    if (left.isConnected) seen = true;
    else if (seen) return window.clearInterval(timer);
    paintLeft();
  }, 30_000);

  const art = mapArt(t.map.name, t.map.thumbnailUrl, { className: "home-tile-art", eager: true, priority: true });
  art.addEventListener("load", onArt, { capture: true, once: true });
  art.addEventListener("error", onArt, { capture: true, once: true });
  if (!art.querySelector("img.full")) onArt();
  const players = t.players === 1 ? "1 player today" : `${t.players.toLocaleString("en-US")} players today`;
  // A day that isn't Normal names its style in the heading, where the eye starts ("Daily Challenge, EZ Scroll").
  const style = dailyStyle(t.style);
  const map = h(
    "button.home-tile.home-daily-map",
    { type: "button", "data-part": "map", "data-name": t.map.name, "data-style": style, title: `Play ${t.map.name}${styleNote(style)}`, onclick: () => a.play(t.day, t.map.name, style) },
    art,
    h(
      "span.home-tile-text",
      null,
      h("span.home-tile-name", null, h("b", null, t.map.name), h(`span.home-tile-tier.${tier ? `t${tier}` : "tx"}`, { title: tier ? `Tier ${tierNum(tier)}, ${tierName(tier)}` : "Unrated" }, tierLabel(tier))),
      h(
        "span.home-tile-times",
        null,
        h("span", null, h("small", null, t.players ? players : "Nobody has finished it yet")),
        h("span.home-daily-play", null, "Play", h("span.home-daily-chev", { "aria-hidden": "true" }, icon("chevronRight"))),
      ),
    ),
  );

  const top = t.top.length
    ? h("ol.home-daily-top", { "data-part": "top", "aria-label": "Fastest today" }, ...t.top.slice(0, 3).map((e) => topRow(e, a)))
    : h("p.home-daily-none", { "data-part": "top" }, "Be the first on today's board.");

  // Your line. A guest's time is kept and not on the board (it shows accounts): theirs says where it would be, and the
  // way there is the home screen's own "Save progress" (the same words and the same panel as the button by the name).
  const me = v.me;
  const you = h("p.home-daily-you", { "data-part": "you" });
  if (me?.guest) {
    you.dataset.guest = "";
    you.append(
      h("span", null, guestPlace(me.rank, t.players + 1)),
      h("b.home-daily-time", null, formatTime(me.time)),
      h("small", null, h("button.link-btn.home-daily-save", { type: "button", "data-part": "save", onclick: a.save }, "Save progress"), " to appear on the board."),
    );
  } else if (me) you.append(h("span", null, `You're ${placeOf(me.rank, t.players)}`), h("b.home-daily-time", null, formatTime(me.time)));
  else you.append(h("span", null, "You haven't played today."));

  // Yesterday in one line (the winner, or that it is still being checked); it opens the daily screen.
  const y = v.yesterday;
  const first = y?.podium[0];
  // The winner is shown as a board row shows a player (ui/board-pager.ts playerChip: picture, name in their own style,
  // marks, the mini profile on hover; the name opens their profile), so the line is not one button: the words and the
  // arrow open that day.
  const openY = () => a.open(y?.day);
  const words = (text: string) => h("button.home-daily-day", { type: "button", onclick: openY }, text);
  const yLine = y
    ? h(
        "div.home-daily-more",
        { "data-part": "yesterday" },
        ...(first
          ? [words("Yesterday"), playerChip(first.player, () => a.profile(first.player.id)), words(`won ${y.map.name}${styleNote(y.style)} in`), h("b.home-daily-time", null, formatTime(first.time))]
          : [words(`Yesterday was ${y.map.name}${styleNote(y.style)}`)]),
        h("button.home-daily-chev", { type: "button", title: "Earlier days", "aria-label": "Earlier days", onclick: openY }, icon("chevronRight")),
      )
    : h("button.home-daily-more", { type: "button", "data-part": "yesterday", onclick: () => a.open() }, h("span", null, "Leaderboard"), h("span.home-daily-chev", { "aria-hidden": "true" }, icon("chevronRight")));

  // Into the Daily room (net/daily-room.ts), the way the other lines here open things; shown while one is listed.
  const count = h("small.home-daily-room-n");
  const room = dailyRoomLink(h("button.home-daily-more.home-daily-room", { type: "button", "data-part": "room" }, h("span", null, "Play with others"), count, h("span.home-daily-chev", { "aria-hidden": "true" }, icon("chevronRight"))), count);

  return h(
    "section#home-daily.home-daily",
    { "aria-label": "Daily Challenge" },
    h("div.home-daily-head", null, h("h2.home-recs-head", null, "Daily Challenge", style === DAILY_STYLE ? null : h("span.home-daily-style", { "data-part": "style" }, styleLabel(style))), left),
    h("div.home-daily-body", null, map, h("div.home-daily-side", null, top, you)),
    room,
    yLine,
  );
}

/** The block's place while the answer is on its way (the same boxes, empty), so nothing moves when it lands. */
export function homeDailyWait(): HTMLElement {
  const row = () => h("li.home-daily-row", null, h("span.home-daily-rank"), h("span.home-daily-av", null, h("span.home-rec-av")), h("span.home-rec-whotext", null, h("span.home-rec-bar"), h("span.home-rec-bar.short")));
  return h(
    "section#home-daily.home-daily.home-daily-wait",
    { "aria-label": "Daily Challenge", "aria-busy": "true" },
    h("div.home-daily-head", null, h("h2.home-recs-head", null, "Daily Challenge")),
    h(
      "div.home-daily-body",
      null,
      h("span.home-tile.home-daily-map", null, h("span.card-art.home-tile-art"), h("span.home-tile-text", null, h("span.home-rec-bar"), h("span.home-rec-bar.short"))),
      h("div.home-daily-side", null, h("ol.home-daily-top", null, row(), row(), row()), h("p.home-daily-you", null, h("span.home-rec-bar"))),
    ),
    h("span.home-daily-more", null, h("span.home-rec-bar")),
  );
}

