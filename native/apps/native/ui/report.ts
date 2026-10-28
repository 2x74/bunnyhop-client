// "Report a player" (web feedback form, category "report"; apps/api src/player-reports.ts) from the native screens,
// where the web has it: a player's profile (⋯ → Report), a room's player list (!report), the replay viewer (its Report
// chip, about that run). The form, its reasons and its submit are the web's own; this only opens it.
import { api, lastKnownMe } from "../../web/src/api";
import { openFeedback, type ReportTarget } from "../../web/src/feedback/state";
import { h } from "../../web/src/ui/dom";

/** A run being watched in native playback that came from the server (a leaderboard / profile Watch). */
let watched: { runId: string; name: string; map: string; time: number | null } | null = null;
export function setWatchedRun(run: typeof watched): void {
  watched = run;
}
export function watchedRun(): typeof watched {
  return watched;
}

/** Reports are an account action on the live service: never offline, never about yourself. */
export function canReport(target: { id?: string; name?: string }): boolean {
  if (!api.available()) return false;
  const me = lastKnownMe();
  return !me || (target.id ? target.id !== me.id : target.name !== me.name);
}

/** No target: the form asks for a name (web social/commands.ts). */
export function openReport(target?: ReportTarget): void {
  openFeedback({ category: "report", ...(target ? { report: target } : {}) });
}

/** The quiet "Report" button the native screens put next to a player. Null where reporting isn't possible. */
export function reportButton(target: ReportTarget, label = "Report"): HTMLButtonElement | null {
  if (!canReport(target)) return null;
  return h(
    "button.btn.native-report",
    { type: "button", title: `Report ${target.name}`, onclick: () => openReport(target) },
    label,
  ) as HTMLButtonElement;
}
