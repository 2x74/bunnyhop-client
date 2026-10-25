// The inbox button's unread badge (home screen + pause menu) and its polling. The panel itself (inbox/panel.ts) loads
// on demand through openInbox().
//
// Polling is deliberately light (apps/api src/inbox.ts allows 240 reads / hour / player): the count is fetched when a
// menu with an inbox button is shown (at most once a minute), then once a minute while a menu stays open and the tab
// is visible. Never while playing: no request goes out while the pointer is locked or the overlay is hidden.

import { api } from "../api";
import { h } from "../ui/dom";
import "./inbox.css";
import { nudge, ring, toast } from "../notify";

const POLL_MS = 60_000;

let unread = 0;
/** The count has been fetched once (the first fetch is the baseline: no "new message" toast for old mail). */
let known = false;
let lastFetch = 0;
let inflight: Promise<void> | null = null;
let timer = 0;
const listeners = new Set<(n: number) => void>();

export const inboxUnread = (): number => unread;

/** The panel reports the server's count after a read; every badge follows. */
export function setInboxUnread(n: number): void {
  unread = Math.max(0, Math.floor(n) || 0);
  for (const l of [...listeners]) l(unread);
}

/** A menu is on screen and the player isn't playing. */
function menuShowing(): boolean {
  const o = document.getElementById("overlay");
  return !!o && !o.classList.contains("hidden") && !document.pointerLockElement && document.visibilityState === "visible";
}

/** Fetches the unread count unless it was fetched in the last minute (`force`: always). Never throws. */
export function refreshInbox(force = false): Promise<void> {
  if (!api.available()) return Promise.resolve();
  if (inflight) return inflight;
  // A little slack so the one-minute timer doesn't skip every other tick.
  if (!force && Date.now() - lastFetch < POLL_MS - 2000) return Promise.resolve();
  lastFetch = Date.now();
  inflight = (async () => {
    try {
      // The guest identity comes from the first api.me() (startup); without one the count is just 0.
      await api.me();
      const n = await api.inboxUnread();
      const more = known && n > unread;
      known = true;
      setInboxUnread(n);
      if (more) toast(n === 1 ? "New message in your Inbox" : `${n} unread messages in your Inbox`, { key: "inbox", action: { label: "Open", run: () => openInbox() } });
    } catch {
      /* the badge keeps its last value */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function ensureTimer(): void {
  if (timer) return;
  timer = window.setInterval(() => {
    if (listeners.size && menuShowing()) void refreshInbox();
  }, POLL_MS);
}

/**
 * Adds the unread badge to a menu button (home item or pause rail item) and keeps it current. Creating one counts as
 * "a menu opened": it triggers a refresh (throttled to once a minute).
 */
export function withInboxBadge(button: HTMLElement, label = "Inbox"): HTMLElement {
  const badge = h("span.ib-badge", { "aria-hidden": "true", hidden: true });
  (button.querySelector(".mb-title, .ri-label") ?? button).append(badge);
  let attached = false;
  let first = true;
  const show = (n: number) => {
    if (!button.isConnected) {
      if (attached) listeners.delete(show);
      return;
    }
    attached = true;
    // Went up while on screen: the number pops once (the toast is the announcement; no ring on top of it).
    const was = badge.hidden ? 0 : Number(badge.dataset.n ?? 0);
    badge.dataset.n = String(n);
    if (n > was && was >= 0 && attached && badge.isConnected && !first) requestAnimationFrame(() => nudge(badge));
    first = false;
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    button.setAttribute("aria-label", n > 0 ? `${label}, ${n} unread` : label);
  };
  listeners.add(show);
  // After the screen is attached.
  requestAnimationFrame(() => show(unread));
  ensureTimer();
  void refreshInbox();
  return button;
}

/** Opens the inbox panel (loads it on first use). */
export function openInbox(): void {
  void import("./panel").then((m) => m.showInbox());
}
