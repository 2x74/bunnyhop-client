// "I have the site open", for the Online count in the Discord server (apps/api src/presence.ts). A random tab id
// (sessionStorage) travels with the session cookie; the server stores a salted network hash, client kind and optional
// account id in SitePresence, plus 24-hour account-count history and a persistent peak. Aggregate online samples go
// to D1 through the agent Worker. POST /presence when the page opens, every 10 minutes while the tab is
// visible, and when it comes back after being away that long; a beacon to /presence/leave when the page goes away.
// Fire and forget: nothing waits on it and failures are ignored.

import { API_URL, api } from "./api";

const PING_MS = 10 * 60_000;
const KEY = "bh_tab";

function tabId(): string {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) sessionStorage.setItem(KEY, (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

let started = false;

/** main.ts, once at startup. */
export function initPresence(): void {
  if (started || !API_URL) return;
  started = true;
  const id = tabId();
  let last = -Infinity;
  const ping = () => {
    if (document.hidden) return;
    last = performance.now();
    void fetch(`${API_URL}/presence`, { method: "POST", body: id, keepalive: true, credentials: "include" }).catch(() => {});
  };
  ping();
  void api.me().then(() => ping()).catch(() => {});
  setInterval(() => performance.now() - last >= PING_MS - 5000 && ping(), 60_000);
  addEventListener("visibilitychange", () => !document.hidden && performance.now() - last >= PING_MS && ping());
  addEventListener("pagehide", () => {
    try {
      navigator.sendBeacon(`${API_URL}/presence/leave`, id);
    } catch {
      /* ignore */
    }
    last = -Infinity; // back from the bfcache: ping again
  });
  addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && ping());
}
