import { api } from "../api";

/** Read on intent: displaying a replay button never counts as a view. */
export function withReplayViews(button: HTMLElement, runId: string): HTMLElement {
  let fetched = false;
  const load = () => {
    if (fetched) return;
    fetched = true;
    void api.replayViews(runId).then(views => {
      const label = `${views.toLocaleString()} replay ${views === 1 ? "view" : "views"}`;
      button.title = `Watch this replay · ${label}`;
      button.setAttribute("aria-description", label);
    }).catch(() => { fetched = false; });
  };
  button.addEventListener("pointerenter", load);
  button.addEventListener("focus", load);
  return button;
}
