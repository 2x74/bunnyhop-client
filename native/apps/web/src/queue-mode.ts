// Playing a set in order, in game (rules and storage: map-queue.ts). main.ts calls startQueueMode() once the session
// exists, on every solo map: the queue is read at each finish, so one started on the map being played (the map list's
// "Play … in order" on the current map) works without a reload.
//   - arriving on a queued map says where the player is in one toast ("Warmups · 3 of 8");
//   - a finish that moves the queue on (map-queue.ts finishMoves) says so in one line under the result, then the next map
//     loads after NEXT_MAP_MS (Enter goes at once), or once the player is back from a menu or the chat. A restart
//     meanwhile stays on this map: the next finish moves it on. The last map's finish ends the queue.

import { allowLeave } from "./play-lock";
import { appHref } from "./platform/navigation";
import { currentRace } from "./net/presence";
import { isTextField } from "./input";
import { h } from "./ui/dom";
import { advanceQueue, doneLine, finishMoves, NEXT_MAP_MS, queueLine, readQueue, type MapQueue } from "./map-queue";
import type { RunSession } from "./session";
import type { SubmissionView } from "./hud";

export function startQueueMode(o: { session: RunSession; map: string; arrived: MapQueue | null; gauntlet: boolean }): void {
  const s = o.session;
  if (o.arrived) s.hud.toast(queueLine(o.arrived), 4000, "map-queue");
  /** The finished run the queue last answered (each finish moves it once, on its first settled status). */
  let handled: unknown = null;
  let timer = 0;
  let unlisten: (() => void) | null = null;
  const cancel = () => {
    clearTimeout(timer);
    unlisten?.();
    unlisten = null;
  };

  const prev = s.onSubmission;
  s.onSubmission = (st: SubmissionView) => {
    prev?.(st);
    const q = readQueue();
    const run = s.lastRun;
    if (!q || q.maps[q.at] !== o.map || !run || run === handled || s.timer.status !== "finished") return;
    const t = s.timer;
    const moves = finishMoves({
      track: t.track,
      practice: s.unranked,
      multiplayer: s.multiplayer,
      racing: currentRace({ map: o.map, style: s.runStyle, track: t.track }) !== null,
      gauntlet: o.gauntlet,
      status: st.status,
      code: "code" in st ? st.code : undefined,
    });
    if (moves === "wait") return;
    handled = run;
    if (moves === "no") return;
    cancel();
    const line = doneLine(q);
    if (s.hud.cardShown) s.hud.setCardExtra(h("div.endcard-sub.ok", null, line));
    else s.hud.toast(line, NEXT_MAP_MS + 1000, "map-queue");
    const next = q.maps[q.at + 1] ?? null;
    if (!next) return void advanceQueue();
    const go = (now: boolean) => {
      // Restarted meanwhile (staying on this map), or stopped from the map list: nothing to do.
      const q2 = readQueue();
      if (s.timer.status !== "finished" || s.lastRun !== run || !q2 || q2.maps[q2.at] !== o.map) return cancel();
      // In a menu or typing in the chat: when they're back.
      if (!now && (document.body.classList.contains("menu-open") || isTextField(document.activeElement))) return void (timer = window.setTimeout(() => go(false), 500));
      cancel();
      advanceQueue();
      allowLeave();
      const url = new URL(appHref());
      url.searchParams.set("map", next);
      url.searchParams.delete("replay");
      location.href = url.toString();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.code === "Enter" || e.code === "NumpadEnter") && !isTextField(e.target) && !document.body.classList.contains("menu-open")) (e.preventDefault(), go(true));
    };
    addEventListener("keydown", onKey, true);
    unlisten = () => removeEventListener("keydown", onKey, true);
    timer = window.setTimeout(() => go(false), NEXT_MAP_MS);
  };
}
