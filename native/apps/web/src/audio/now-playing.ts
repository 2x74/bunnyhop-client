// Now playing: the track's name and previous / play-pause / next, quiet text and icons on the speaker button's line
// (left of it, and left of the friends dock when that's there), on the home screen and the pause menu while music is
// on. Also the Media Session (OS media keys, the browser's media hub): title + play / pause / next / previous.

import type { MusicEntry } from "./assets";
import type { MusicPlayer } from "./music";

const SCREENS = new Set(["home", "pause"]);
const GAP = 8;

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
const ICON_PREV = svg("M6 6h2.2v12H6zM18.5 6.2v11.6L9.6 12z");
const ICON_NEXT = svg("M15.8 6H18v12h-2.2zM5.5 6.2v11.6l8.9-5.8z");
const ICON_PLAY = svg("M8 5.6v12.8L18.4 12z");
const ICON_PAUSE = svg("M7 5.8h3.4v12.4H7zM13.6 5.8H17v12.4h-3.4z");

/** The name shown for a track ("Drift (menu)" is just Drift here). */
export const trackName = (t: MusicEntry): string => t.title.replace(/\s*\((menu|game)\)\s*$/i, "");

export interface NowPlaying {
  /** Music is on (mode not off, music and master audible): the control may show. */
  setEnabled(on: boolean): void;
}

export function mountNowPlaying(player: MusicPlayer): NowPlaying {
  const root = document.createElement("div");
  root.id = "music-now";
  const title = document.createElement("span");
  title.className = "mn-title";
  const button = (cls: string, label: string, icon: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `mn-btn ${cls}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon;
    b.addEventListener("click", fn);
    return b;
  };
  const prev = button("mn-prev", "Restart / previous track", ICON_PREV, () => player.previous());
  const toggle = button("mn-toggle", "Pause music", ICON_PAUSE, () => player.toggle());
  const next = button("mn-next", "Next track", ICON_NEXT, () => player.next());
  root.append(title, prev, toggle, next);
  document.body.append(root);

  let enabled = false;
  let shownPlaying: boolean | null = null;

  const paint = () => {
    const t = player.shown;
    const playing = player.playing;
    const name = t ? trackName(t) : "";
    if (title.textContent !== name) title.textContent = name;
    title.title = t ? `${name}${t.credit ? ` · ${t.credit}` : ""}` : "";
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      toggle.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      const label = playing ? "Pause music" : "Play music";
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
    }
    root.classList.toggle("paused", !playing);
    const screen = document.body.dataset.screen ?? "";
    const c = document.body.classList;
    const on = enabled && !!t && player.wanted && c.contains("menu-open") && !c.contains("viewer-open") && SCREENS.has(screen);
    root.classList.toggle("on", on);
    if (on) place();
    media(t, playing);
  };

  // On the speaker button's line, left of it and of the friends dock (its width changes with the friend count).
  const place = () => {
    let left = window.innerWidth;
    for (const sel of ["#audio-btn", ".fdock:not([hidden]) .fd-bar"]) {
      const el = document.querySelector(sel);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0) left = Math.min(left, r.left);
    }
    root.style.right = `${Math.round(window.innerWidth - left + GAP)}px`;
  };

  // Media Session: keys on the keyboard / headset and the browser's media controls.
  const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  let mediaId = "";
  const media = (t: MusicEntry | null, playing: boolean) => {
    if (!ms) return;
    const id = enabled && t ? t.id : "";
    if (id !== mediaId) {
      mediaId = id;
      try {
        ms.metadata = t && id && typeof MediaMetadata !== "undefined" ? new MediaMetadata({ title: trackName(t), artist: "bunnyhop.lol", album: "bunnyhop.lol soundtrack" }) : null;
      } catch {
        /* no MediaMetadata */
      }
    }
    ms.playbackState = !id ? "none" : playing ? "playing" : "paused";
  };
  if (ms) {
    const on = (action: MediaSessionAction, fn: () => void) => {
      try {
        ms.setActionHandler(action, () => fn());
      } catch {
        /* action not supported here */
      }
    };
    on("play", () => player.play());
    on("pause", () => player.pause());
    on("stop", () => player.pause());
    on("nexttrack", () => player.next());
    on("previoustrack", () => player.previous());
  }

  player.subscribe(paint);
  new MutationObserver(paint).observe(document.body, { attributes: true, attributeFilter: ["class", "data-screen"] });
  addEventListener("resize", () => root.classList.contains("on") && place());
  const dockObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => root.classList.contains("on") && place()) : null;
  // The dock mounts after audio (main.ts); watch for it once.
  const watchDock = () => {
    const bar = document.querySelector(".fdock .fd-bar");
    if (bar && dockObserver) dockObserver.observe(bar);
    return !!bar;
  };
  if (!watchDock()) {
    const mo = new MutationObserver(() => watchDock() && (mo.disconnect(), paint()));
    mo.observe(document.body, { childList: true });
  }
  paint();
  return {
    setEnabled(v) {
      if (v === enabled) return;
      enabled = v;
      paint();
    },
  };
}
