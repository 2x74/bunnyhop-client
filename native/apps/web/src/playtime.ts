// Time played (the player card's "12.4h played"; apps/api src/playtime.ts stores and clamps it).
//
// Counts while you're actually playing: on a map with the game running (pointer locked, so not in a menu or the
// pause screen), the tab visible and focused, and some input (key, mouse, wheel) in the last AFK_MS. Practice, the
// tutorial and multiplayer count; the replay viewer and spectating don't (main.ts decides with `playing`).
// Reports the seconds since the last report to POST /me/playtime about once a minute, and with sendBeacon when the
// page is hidden or closed. The server only ever adds what a report says, clamped to real time. The same seconds go to
// `credit` as they're counted (main.ts: the map's own time played on this device, map-time.ts), with or without the API.

import { API_URL, api } from "./api";

/** No input for this long = away: time stops counting. */
const AFK_MS = 30_000;
/** How often counted time is reported. */
const SYNC_MS = 60_000;
/** The server refuses reports closer together than this (apps/api src/playtime.ts MIN_GAP_MS). */
const MIN_GAP_MS = 10_000;
/** The server credits at most this much per report; anything above it is dropped here too. */
const MAX_PENDING_S = 120;
/** Seconds counted but not reported when the page went away (sent on the next visit). */
const STORE_KEY = "bunnyhop:playtime-pending";

let started = false;

export function startPlaytime(playing: () => boolean, credit?: (seconds: number) => void): void {
  const report = api.available();
  if (started || (!report && !credit)) return;
  started = true;
  let pending = 0;
  let lastInput = performance.now();
  let lastCount = performance.now();
  let lastSent = 0;
  let sending = false;
  if (report) {
    try {
      pending = Math.min(MAX_PENDING_S, Math.max(0, Number(localStorage.getItem(STORE_KEY)) || 0));
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage blocked */
    }
  }

  const touch = () => (lastInput = performance.now());
  for (const ev of ["keydown", "mousedown", "mousemove", "wheel", "pointerdown", "touchstart"]) addEventListener(ev, touch, { capture: true, passive: true });

  const count = () => {
    const now = performance.now();
    // At most a couple of seconds per step: a throttled timer (background tab, sleep) never adds a gap.
    const dt = Math.min(2_000, now - lastCount) / 1000;
    lastCount = now;
    if (document.visibilityState === "visible" && document.hasFocus() && now - lastInput < AFK_MS && playing()) {
      pending = Math.min(MAX_PENDING_S, pending + dt);
      credit?.(dt);
    }
  };

  const flush = async () => {
    const seconds = Math.floor(pending);
    if (sending || seconds < 1 || Date.now() - lastSent < MIN_GAP_MS) return;
    sending = true;
    try {
      await api.me(); // a session exists (guest-first); the endpoint never creates one
      const res = await fetch(`${API_URL}/me/playtime`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ seconds }), keepalive: true });
      // Sent and answered: drop what was reported (a clamp means the server didn't believe it). 429 / 5xx / offline:
      // keep it for the next report.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) pending = Math.max(0, pending - seconds);
      if (res.ok) lastSent = Date.now();
    } catch {
      /* offline: retried with the next report */
    } finally {
      sending = false;
    }
  };

  /** Page hidden or closing: one beacon if the server would take it now, else keep the seconds for the next visit. */
  const leave = (unloading: boolean) => {
    count();
    const seconds = Math.floor(pending);
    if (seconds < 1) return;
    if (!sending && Date.now() - lastSent >= MIN_GAP_MS) {
      // text/plain keeps the beacon a simple (no preflight) request; the API reads the body as JSON either way.
      const ok = navigator.sendBeacon?.(`${API_URL}/me/playtime`, new Blob([JSON.stringify({ seconds })], { type: "text/plain" }));
      if (ok) {
        pending -= seconds;
        lastSent = Date.now();
        return;
      }
    }
    if (unloading) {
      try {
        localStorage.setItem(STORE_KEY, String(pending));
      } catch {
        /* storage blocked */
      }
    }
  };

  setInterval(count, 1_000);
  if (!report) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") lastCount = performance.now();
    });
    return;
  }
  setInterval(() => void flush(), SYNC_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave(false);
    else lastCount = performance.now();
  });
  addEventListener("pagehide", () => leave(true));
  // Back from the back/forward cache: this page's own count is still in memory, so the stored copy goes.
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage blocked */
    }
  });
}
