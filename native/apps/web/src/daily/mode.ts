// The Daily Challenge in game (apps/api src/daily.ts). Runs count wherever the day's map is played: the server marks
// them. This module is what the player sees of it:
//   - playing the day's map solo, the HUD shows one line under the map line: "Daily Challenge, 5h 12m left" (then
//     "Daily Challenge ended"; a run already going still counts for the day it started in). A day has one style
//     (Normal unless staff set another): in any other style the line says those runs don't count;
//   - opened from the Daily entry (?daily=<day>), the session runs the day's style (main.ts) and its runs carry
//     ?daily=<day>; a link to a day that is over says so once and the map is played on its own;
//   - a verified run that counted gets one line under its result: your place on the day's board (state.ts resultLine);
//     a guest's run is kept and not shown, so theirs says where it would be and how to put it there (ui/daily-guest.ts);
//     a verified main-track run on the day's map in another style gets one line saying why it didn't count.

import { appHref } from "../platform/navigation";
import type { RunSession } from "../session";
import { h } from "../ui/dom";
import { offerDailyGuest } from "../ui/daily-guest";
import { dailyNow, dailyStyle, forgetDaily, guestResultLine, hudLine, isDay, resultLine, setDailySession, wrongStyleLine } from "./state";

export interface DailyStart {
  session: RunSession;
  map: string;
  /** The page's ?daily=<day> (null: the map was opened some other way). */
  entry: string | null;
  /** In a multiplayer room: no HUD line (the room has its own), the result line still shows. */
  inRoom: boolean;
}

function dropParam(): void {
  const url = new URL(appHref());
  if (!url.searchParams.has("daily")) return;
  url.searchParams.delete("daily");
  history.replaceState(history.state, "", url);
}

export function startDailyMode(o: DailyStart): void {
  const s = o.session;
  // The day's place under the result of any run the server counted.
  const prev = s.onSubmission;
  let shown = "";
  /** The day while this page is on its map (set below once GET /daily answers). */
  let day: { style: string; endsAt: number; skew: number } | null = null;
  s.onSubmission = (st) => {
    prev?.(st);
    if (st.status !== "verified" || !("id" in st) || st.id === shown) return;
    // A guest's run: kept, and not on the board. One line says where it would be; the offer is in the pause menu.
    const g = st.daily;
    if (g?.guest && g.rank !== undefined) {
      shown = st.id;
      forgetDaily();
      const asked = offerDailyGuest({ day: g.day, rank: g.rank, of: g.of ?? g.rank, time: g.time ?? st.time ?? 0 });
      const text = guestResultLine({ rank: g.rank, of: g.of }, asked);
      if (s.hud.cardShown) s.hud.setCardExtra(h("div.endcard-sub.ec-daily.ec-daily-guest", null, text));
      else s.hud.toast(text, 6000, "daily");
      return;
    }
    const line = resultLine(st.daily);
    if (!line) {
      // The day's map, main track, the day still going, another style: say why this one isn't on the day's board.
      const played = s.runStyle;
      if (st.daily || !day || played === day.style || s.timer.track !== 0 || Date.now() + day.skew >= day.endsAt) return;
      shown = st.id;
      const why = wrongStyleLine(day.style, played);
      if (s.hud.cardShown) s.hud.setCardExtra(h("div.endcard-sub.ec-daily.ec-daily-off", null, why));
      else s.hud.toast(why, 6000, "daily");
      return;
    }
    shown = st.id;
    forgetDaily();
    if (s.hud.cardShown) s.hud.setCardExtra(h("div.endcard-sub.ok.ec-daily", null, line));
    else s.hud.toast(line, 5000, "daily");
  };
  const entry = isDay(o.entry) ? o.entry : null;
  if (o.entry && !entry) dropParam();
  void dailyNow().then(
    (v) => {
      const today = v.enabled && v.today.map.name === o.map ? v.today : null;
      if (!today) {
        if (entry) {
          dropParam();
          s.hud.toast("That Daily Challenge has ended, so this map is played on its own.", 6000, "daily");
        }
        return;
      }
      const style = dailyStyle(today.style);
      // The server's clock decides the day; the line counts down against it.
      const skew = v.enabled ? v.now - Date.now() : 0;
      day = { style, endsAt: today.endsAt, skew };
      if (entry) setDailySession({ day: today.day, map: o.map, style, endsAt: today.endsAt });
      if (o.inRoom) return;
      // Repainted often enough to follow a style change in the start zone (the text is only written when it differs).
      const paint = () => s.hud.setDaily(hudLine(today.endsAt, Date.now() + skew, style, s.runStyle));
      paint();
      window.setInterval(paint, 2_000);
    },
    () => {},
  );
}
