// The home screen's line when a newer signed release is on the update channel: one press downloads it (the same
// action as Settings → Updates' Update), the next restarts into it. "Not now" hides it until a newer version.
import { h } from "../../web/src/ui/dom";
import { send } from "./bridge";
import { readUpdateStatus, updatePromptView, type UpdatePromptView, type UpdateStatus } from "./update-status";

const DISMISSED_KEY = "bh-native-update-dismissed";
/** The version this line started downloading, kept across home screens so a failed download is reported. */
let attempted: string | null = null;

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function dismiss(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Without storage the line only hides until the home screen is drawn again.
  }
}

/** Whether the home screen shows the line now, so the new-version toast isn't shown over it. */
export function updatePromptShown(): boolean {
  return !!document.querySelector(".home-update:not([hidden])");
}

export function updatePrompt(): HTMLElement {
  const text = h("span.home-update-text");
  const go = h("button.home-link.home-update-go", { type: "button" });
  const later = h("button.home-link", { type: "button" }, "Not now");
  const row = h("div.home-update", { role: "status", hidden: true }, text, go, later);
  let status: UpdateStatus | null = null;
  let view: UpdatePromptView | null = null;
  let hiddenNow = false;
  const paint = (): void => {
    view = hiddenNow ? null : updatePromptView(status, dismissedVersion(), attempted);
    row.hidden = !view;
    if (!view) return;
    text.textContent = view.text;
    go.textContent = view.label;
    go.hidden = !view.action;
    later.hidden = !view.dismissible;
  };
  go.addEventListener("click", () => {
    const action = view?.action;
    if (!action) return;
    if (action === "download") attempted = status?.version ?? null;
    if (action === "check") attempted = null;
    send({ type: "update", action });
  });
  later.addEventListener("click", () => {
    if (status?.version) dismiss(status.version);
    // A failed download's line has nothing to remember: it just goes until the next status.
    hiddenNow = !status?.version;
    attempted = null;
    paint();
  });
  let seen = false;
  const onStatus = (event: Event): void => {
    if (!row.isConnected && seen) return void removeEventListener("bunnyhop:update", onStatus);
    seen ||= row.isConnected;
    const next = readUpdateStatus((event as CustomEvent).detail);
    if (!next) return;
    if (next.status !== status?.status) hiddenNow = false;
    status = next;
    if (status.status === "staged" || status.status === "ready") attempted = null;
    paint();
  };
  addEventListener("bunnyhop:update", onStatus);
  queueMicrotask(() => send({ type: "update", action: "status" }));
  return row;
}
