// A run row's ⋯ (leaderboards everywhere: the pause menu, the map browser's board, the tutorial's, a profile's records).
// Watch and Race stay on the row; the rest is here, each only where it applies: Copy start (the map you're playing:
// copy-start-request.ts), Copy link (the run's /replay/<id> page, the link Discord's Watch replay button uses),
// Report (not your own run), Open in admin (staff), plus what the caller adds first (a profile's Pin). It's the profile's
// ⋯ menu (social/menu.ts withMenu): Enter / Space / ↓ open it, arrows move, Esc closes and returns focus here, a click
// outside closes it, and a controller drives it through ui/gamepad.ts. Custom CSS hook: [data-part="row-menu"].

import { api } from "../api";
import { canCopyStart, requestCopyStart } from "../copy-start-request";
import { openFeedback } from "../feedback/state";
import { toast } from "../notify";
import { DOTS } from "../social/dock";
import { withMenu, type MenuItem } from "../social/menu";
import "../social/dock.css";
import "./boards.css";
import { staffRole } from "../staff-lens";
import { h } from "./dom";
import { hideRunStats } from "./run-stats";
import { runUrl } from "./share";

export interface RowRun {
  runId: string;
  map: string;
  /** Seconds (the report form shows it). */
  time: number | null;
  player: { id: string; name: string };
  /** The run's style (the report form explains Infinite's noclip start). */
  style?: string;
}

/** Staff see "Open in admin"; asked once, read when a menu opens. */
let staff = false;
let asked = false;
const askStaff = () => {
  if (asked) return;
  asked = true;
  void staffRole().then((r) => (staff = !!r), () => {});
};

/** Copies the run's link, answered with the toast Copy start's answer uses (the link itself when the clipboard is blocked). */
async function copyLink(runId: string): Promise<void> {
  const url = runUrl(runId);
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied", { ms: 3000, key: "row-menu" });
  } catch {
    toast(url, { ms: 6000, key: "row-menu", tone: "info" });
  }
}

/** The ⋯ items for `run`; `mine`: your own run (no Report). `extra` go first. */
export function rowMenuItems(run: RowRun, o: { mine?: boolean; extra?: MenuItem[] } = {}): MenuItem[] {
  return [
    ...(o.extra ?? []),
    canCopyStart(run.map) ? { label: "Copy start", run: () => requestCopyStart(run.map, run.runId, run.player.name) } : null,
    { label: "Copy link", run: () => copyLink(run.runId) },
    api.available() && !o.mine ? { label: "Report", run: () => openFeedback({ category: "report", report: { id: run.player.id, name: run.player.name, run: { id: run.runId, map: run.map, time: run.time }, style: run.style } }) } : null,
    staff && !o.mine ? { label: "Open in admin", run: () => void window.open(`/admin#/player/${encodeURIComponent(run.player.id)}`, "_blank", "noopener") } : null,
  ];
}

/** The row's ⋯ button (quiet until the row is hovered or it has focus: boards.css). */
export function rowMenu(run: RowRun, o: { mine?: boolean; extra?: () => MenuItem[] } = {}): HTMLButtonElement {
  askStaff();
  const label = `More for ${run.player.name}'s run`;
  const b = h("button.link-btn.rb-more", { type: "button", "data-part": "row-menu", title: "More", "aria-label": label, html: DOTS }) as HTMLButtonElement;
  // The row's stats card steps aside for the menu (run-stats.ts doesn't show one while a menu is open).
  b.addEventListener("click", () => hideRunStats());
  return withMenu(b, () => rowMenuItems(run, { mine: o.mine, extra: o.extra?.() }), { align: "right", label });
}
