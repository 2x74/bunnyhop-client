// Hide UI (the Hide UI key, F1 by default): just the game, for recording clips. One look everywhere: the speed and
// keys overlay stay or go together (Settings → HUD → Hide UI, prefs.hud.hiddenKeeps), and so does everything else.
//
//   In game (playing and spectating): prefs.hud.hidden, saved, so you can play with the UI hidden. It applies only
//   while the game has the mouse: the pause menu and Settings open as usual, with the HUD behind them.
//   Replays (viewer/viewer.ts): for this visit only. A replay always opens with its controls.
//
// Whoever hides the UI calls setUiHidden(source, on); this sets body.ui-hidden (hide-ui.css hides the HUD, chat,
// notifications, crosshair), body.ui-keep for the speed / keys, holds celebrations until the UI is back, whispers one
// hint line that fades out by itself, and hides the mouse cursor once it stops moving. What can't go stays: the pause
// menu, a chat you're typing in, menus that want an answer. Practice attempts get no mark (the owner's call): they are
// never submitted or ranked whatever the screen shows.

import "./hide-ui.css";
import { holdCelebrations, whisper } from "../notify";
import { keyLabel, prefs } from "./settings";

export type HideSource = "game" | "viewer";

/** The cursor hides after this long without moving. */
const IDLE_MS = 1500;

const active: Record<HideSource, boolean> = { game: false, viewer: false };
let on = false;
let idle = 0;

/** Label of the first key bound to Hide UI ("F1"), or null when it's unbound. */
export function hideUiKey(): string | null {
  const c = prefs.get().binds.hideUi?.[0];
  return c ? keyLabel(c) : null;
}

/** True if `code` (KeyboardEvent.code) is bound to Hide UI. */
export const isHideUiKey = (code: string): boolean => prefs.get().binds.hideUi?.includes(code) ?? false;

/** The UI is hidden right now (in game or in the replay viewer). */
export const uiHidden = (): boolean => on;

function wake(): void {
  document.body.classList.remove("ui-idle");
  clearTimeout(idle);
  if (on) idle = window.setTimeout(() => document.body.classList.add("ui-idle"), IDLE_MS);
}

/** One quiet line (a whisper, notify/) that fades out by itself, and stays visible with the UI hidden. */
export function hideUiHint(text: string): void {
  whisper(text, { always: true, ms: 2600, key: "hide-ui" });
}

/** "Press F1 to show the UI" (or how to get it back without the key). */
function backHint(source: HideSource): string {
  const key = hideUiKey();
  if (key) return `Press ${key} to show the UI`;
  return source === "viewer" ? "Press Esc to show the UI" : "The UI is hidden. Turn it back on in Settings, HUD";
}

/** Hides (or shows) the UI for `source`. `hint`: say how to get it back. */
export function setUiHidden(source: HideSource, hidden: boolean, hint = true): void {
  if (active[source] === hidden) return;
  active[source] = hidden;
  const next = active.game || active.viewer;
  if (hidden && hint) hideUiHint(backHint(source));
  if (next === on) return;
  on = next;
  document.body.classList.toggle("ui-hidden", on);
  holdCelebrations(on);
  if (on) {
    addEventListener("mousemove", wake, { passive: true });
    wake();
  } else {
    removeEventListener("mousemove", wake);
    clearTimeout(idle);
    document.body.classList.remove("ui-idle");
  }
}

prefs.watch((p) => document.body.classList.toggle("ui-keep", p.hud.hiddenKeeps === "speedKeys"));
