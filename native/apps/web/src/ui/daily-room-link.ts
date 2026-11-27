// "Play with others" on the Daily card (ui/home-daily.ts) and the daily screen (ui/daily.ts): into the Daily room, the
// public room that plays the day's map all day (net/daily-room.ts), with how many are in it. Hidden while no Daily room
// is listed with a free slot. GET /servers is the one the home screen's Play online count already asks (shared).

import { listingUrl, pickDailyRoom, playingNote, serversNow } from "../net/daily-room";
import { nearRegion } from "./servers-who";
import { nearRemembered } from "./servers";
import { api } from "../api";

const REFRESH_MS = 20_000;

/**
 * Makes `el` the way into the Daily room: hidden until one is listed, a click joins it, and `note` says how many are in
 * it ("3 playing", nothing when empty). Refreshes while on screen.
 */
export function dailyRoomLink<T extends HTMLElement>(el: T, note: HTMLElement): T {
  el.hidden = true;
  if (!api.available()) return el;
  let url: string | null = null;
  el.addEventListener("click", () => url && (location.href = url));
  const load = () =>
    void serversNow().then(
      (rows) => {
        const near = nearRegion(rows.map((s) => s.region), { utcHours: -new Date().getTimezoneOffset() / 60, measured: nearRemembered() });
        const room = pickDailyRoom(rows, near);
        url = room ? listingUrl(room) : null;
        el.hidden = !room;
        note.textContent = room ? playingNote(room.players) : "";
        if (room) el.title = `Join ${room.name}`;
      },
      () => {},
    );
  load();
  // (Made before it is on the page, and sometimes into a box that never reaches it: refresh only while it is on the
  // page, and stop after two ticks off it.)
  let misses = 0;
  const timer = window.setInterval(() => {
    if (el.isConnected) {
      misses = 0;
      load();
    } else if (++misses >= 2) window.clearInterval(timer);
  }, REFRESH_MS);
  return el;
}
