// The web's now-playing control (audio/now-playing.ts: the track's name and previous / play-pause / next on the bottom
// line of the home and pause screens) over the native soundtrack. The host plays the music (SDL); this file hands the
// web control a player that reads state.music and sends {type:"music", action} back. No browser audio is created.

import "../../web/src/audio/audio.css";
import type { MusicEntry } from "../../web/src/audio/assets";
import type { MusicPlayer } from "../../web/src/audio/music";
import { mountNowPlaying, type NowPlaying } from "../../web/src/audio/now-playing";
import { send, state, type MusicState } from "./bridge";

/** The track the control shows, as the web's catalog entry (only what now-playing reads). */
export function musicEntry(music: MusicState | null): MusicEntry | null {
  if (!music?.id || !music.title) return null;
  return { id: music.id, title: music.title, role: music.role === "menu" ? "menu" : "game", duration: 0, credit: "" };
}

/** Music can be heard (web audio/index.ts musicAudible): the control shows only then. */
export function musicAudible(): boolean {
  return !!state.music?.available && !state.settings.muted && state.settings.volume > 0;
}

/** The part of MusicPlayer the now-playing control uses, backed by the host. */
export function hostMusicPlayer(): MusicPlayer {
  const listeners = new Set<() => void>();
  const action = (name: "previous" | "toggle" | "next") => () => send({ type: "music", action: name });
  const player = {
    get shown() { return musicEntry(state.music); },
    get playing() { return !!state.music?.playing; },
    get wanted() { return !!state.music?.available && !!state.music.id; },
    previous: action("previous"),
    next: action("next"),
    toggle: action("toggle"),
    play: () => { if (!state.music?.playing) send({ type: "music", action: "toggle" }); },
    pause: () => { if (state.music?.playing) send({ type: "music", action: "toggle" }); },
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  let last = "";
  window.addEventListener("bunnyhop:host-state", () => {
    const key = JSON.stringify(state.music);
    if (key === last) return;
    last = key;
    for (const fn of listeners) fn();
  });
  return player as unknown as MusicPlayer;
}

let mounted: NowPlaying | null = null;
export function installNowPlaying(): void {
  if (mounted) return;
  // The web control also registers OS media keys (Media Session). The menu plays no audio of its own (SDL does), so
  // those handlers could only ever claim keys meant for another app: the native menu has no Media Session at all.
  try { Object.defineProperty(navigator, "mediaSession", { value: undefined, configurable: true }); } catch { /* not configurable: no handlers set below either way */ }
  mounted = mountNowPlaying(hostMusicPlayer());
  const sync = () => mounted?.setEnabled(musicAudible());
  window.addEventListener("bunnyhop:host-state", sync);
  sync();
}
