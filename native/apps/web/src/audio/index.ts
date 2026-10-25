// Audio for bunnyhop.lol: one engine (engine.ts), music (music.ts), movement sounds (movement.ts), UI sounds (ui.ts),
// Classic CS:S sounds (classic.ts). The rest of the game talks to this module only:
//
//   initAudio()                            once at startup (main.ts): preloads, arms the first-gesture unlock
//   sfx(id, gain?, rate?)                  any one-shot (UI, rooms, progression)
//   new PlayerAudio()                      the local player: tick(state, events) per sim tick, frame(...) per frame
//   new SpatialMover()                     another player / ghost: positional, update(...) per rendered frame
//   runSounds.start() / split(d) / finish(kind)      run feedback (session.ts)
//   setListenerFromCamera(camera)          per rendered frame
//   toggleMute(), nextTrack(), duckMusic()            (music controls: music.next() / previous() / toggle(), now-playing.ts)
//
// Nothing here touches the simulation.

import "./audio.css";
import type * as THREE from "three";
import { keyLabel, prefs, type Prefs } from "../ui/settings";
import { isTextField } from "../input";
import { BUSES, AudioEngine, sliderGain } from "./engine";
import { MusicPlayer, type MusicScene } from "./music";
import { ClassicSounds } from "./classic";
import { MoveSounds, windFor, type SoundSink } from "./movement";
import { installUiSounds, mountAudioChrome, type AudioChrome } from "./ui";
import { mountNowPlaying, trackName, type NowPlaying } from "./now-playing";
export { toggleSound, uiOpen, uiClose, uiSound } from "./ui";
import { viewmodelEvents } from "./events";
import type { SfxId } from "./catalog";
import { manifest } from "./assets";
import { setNotifySound, whisper } from "../notify";

export type { SfxId } from "./catalog";
export { viewmodelEvents } from "./events";

export const engine = new AudioEngine();
export const music = new MusicPlayer(engine);
export const classic = new ClassicSounds(engine);

const trackers = new Set<MoveSounds>();
let chrome: AudioChrome | null = null;
let nowPlaying: NowPlaying | null = null;
let started = false;

/** One-shot sound (no-op until audio is unlocked or when the file is missing). */
export function sfx(id: SfxId, gain = 1, rate = 1): void {
  engine.play(id, gain, rate);
}

function muteKey(): string | null {
  const c = prefs.get().binds.mute?.[0];
  return c ? keyLabel(c) : null;
}

function applyPrefs(p: Prefs): void {
  const a = p.audio;
  const off = a.muted || (document.hidden && a.muteInBackground);
  engine.setLevels({
    master: off ? 0 : sliderGain(p.volume),
    music: a.mute.music ? 0 : sliderGain(a.music),
    sfx: a.mute.sfx ? 0 : sliderGain(a.sfx),
    ui: a.mute.ui ? 0 : sliderGain(a.ui),
    ambience: a.mute.ambience ? 0 : sliderGain(a.ambience),
  });
  music.setOptions(a.musicMode, a.shuffle);
  classic.set(a.classic);
  for (const t of trackers) t.footsteps = a.footsteps;
  chrome?.setMuted(a.muted, muteKey());
  nowPlaying?.setEnabled(musicAudible(p));
}

/** Music is on and can be heard (the now-playing control shows only then). */
export function musicAudible(p: Prefs): boolean {
  const a = p.audio;
  return a.musicMode !== "off" && !a.muted && !a.mute.music && p.volume > 0 && a.music > 0;
}

export function toggleMute(): boolean {
  let m = false;
  prefs.update((p) => (m = p.audio.muted = !p.audio.muted));
  // Out of the speaker button when it's on screen (menus), else where whispers go.
  const btn = document.getElementById("audio-btn");
  whisper(m ? "Muted" : "Sound on", { key: "audio", at: btn && getComputedStyle(btn).display !== "none" && !document.body.classList.contains("in-game") ? btn : null });
  return m;
}

export function nextTrack(): void {
  const t = music.next();
  if (!t) whisper(prefs.get().audio.musicMode === "off" ? "Music is off." : "No music here", { key: "audio" });
}

/** Pulls the music down under an announcement / fanfare. */
export function duckMusic(depth = 0.35, hold = 2.5): void {
  engine.duck(depth, hold);
}

/** Scene from the page state: home (main menu / loading), pause (in-game menu), play. */
function sceneFromBody(): MusicScene {
  const c = document.body.classList;
  if (c.contains("viewer-open")) return "play";
  if (!c.contains("in-game")) return "home";
  return c.contains("menu-open") ? "pause" : "play";
}

/** Once at startup. Safe to call more than once. */
export function initAudio(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  engine.init();
  chrome = mountAudioChrome(() => toggleMute(), (el) => engine.consumeUnlockPress(el));
  engine.onState(() => chrome?.setLocked(!engine.unlocked));
  chrome.setLocked(!engine.unlocked);
  nowPlaying = mountNowPlaying(music);
  prefs.watch(applyPrefs);
  engine.onUnlock(() => {
    applyPrefs(prefs.get());
    music.setScene(sceneFromBody());
    music.apply();
  });
  new MutationObserver(() => music.setScene(sceneFromBody())).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  music.setScene(sceneFromBody());
  let lastToast = "";
  music.onTrack = (t) => {
    // The now-playing control says it in the menus; in game (and the viewer) a toast does.
    const shown = document.getElementById("music-now")?.classList.contains("on");
    if (!shown && t.role === "game" && t.id !== lastToast) whisper(`♪ ${trackName(t)}`, { key: "audio", ms: 2600 });
    lastToast = t.id;
  };
  // Media autoplay can be refused even with WebAudio running (WebKit): any later gesture retries the track.
  for (const t of ["pointerdown", "keydown", "touchend", "click"]) addEventListener(t, (e) => e.isTrusted && music.retryBlocked(), true);
  document.addEventListener("visibilitychange", () => {
    applyPrefs(prefs.get());
  });
  // Mute / next track work everywhere (menus, game, replay viewer); capture phase so the viewer's key handler
  // (registered later, stops propagation) doesn't swallow them. In game the Input dispatch for them is ignored.
  addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target) || document.querySelector(".bind.capturing")) return;
      const b = prefs.get().binds;
      if (b.mute?.includes(e.code)) toggleMute();
      else if (b.nextTrack?.includes(e.code)) nextTrack();
    },
    true,
  );
  installUiSounds(sfx);
  // Notifications (notify/index.ts) play their sound as the reward lands; fanfares pull the music down under them.
  setNotifySound((id, gain = 1, rate = 1) => {
    sfx(id as SfxId, gain, rate);
    if (id === "finish_wr") duckMusic(0.25, 3);
    else if (id === "achievement" || id === "level_up" || id === "rank_up") duckMusic(0.3, 2.5);
  });
  viewmodelEvents.on((ev, d) => {
    const g = d?.strength ?? 1;
    if (ev === "swing") sfx("carrot_swing", g);
    else if (ev === "stab") sfx("carrot_stab", g * (d?.hit ? 1.1 : 1), d?.hit ? 0.95 : 1);
    else if (ev === "draw") sfx("carrot_draw", g);
  });
  classic.onChange = (on) => {
    for (const t of trackers) t.classic = on;
  };
  if (import.meta.env.DEV) Object.assign(window, { __audio: { engine, music, classic, sfx, manifest } });
}

// -------------------------------------------------------------------------------------------------
// Listener

const fwd = { x: 0, y: 0, z: 0 };
/** Places the WebAudio listener at the render camera (three.js Y-up -> Source Z-up). */
export function setListenerFromCamera(camera: THREE.Camera): void {
  if (!engine.unlocked) return;
  const e = camera.matrixWorld.elements;
  // Camera looks down -Z; up is +Y (columns 2 and 1 of the world matrix). three (x, y, z) -> Source (x, -z, y).
  fwd.x = -e[8];
  fwd.y = e[10];
  fwd.z = -e[9];
  engine.setListener(e[12], -e[14], e[13], fwd.x, fwd.y, fwd.z, e[4], -e[6], e[5]);
}

// -------------------------------------------------------------------------------------------------
// Movers

export const flatSink: SoundSink = { play: (id, g, r) => engine.play(id, g, r) };
export const spatialSink: SoundSink = { play: (id, g, r, x, y, z) => engine.playAt(id, x, y, z + 8, g, r) };

/** A movement tracker that follows the Footsteps setting and Classic CS:S sounds. */
export function tracker(sink: SoundSink): MoveSounds {
  const t = new MoveSounds(sink);
  t.footsteps = prefs.get().audio.footsteps;
  t.classic = classic.active;
  trackers.add(t);
  return t;
}

/** The local player (and the replay viewer's run): non-positional movement sounds + wind. */
export class PlayerAudio {
  readonly moves = tracker(flatSink);
  private wind = engine.loop("wind");
  private windHigh = engine.loop("wind_high");
  private silent = true;

  /** One sim tick (dt = tick interval). `events` are core EVENT_* bits. */
  tick(dt: number, s: { position: number[]; velocity: number[]; grounded: boolean; crouched: boolean; onLadder?: boolean }, events: number): void {
    const p = s.position;
    const v = s.velocity;
    this.moves.update(dt, p[0], p[1], p[2], v[0], v[1], v[2], s.grounded, s.crouched, !!s.onLadder, events);
  }

  /** Per rendered frame: wind from speed. `active` false (paused, menus) fades it out. */
  frame(speed: number, grounded: boolean, active: boolean): void {
    if (!active || !prefs.get().audio.wind) {
      if (!this.silent) {
        this.wind.set(0, 1, 500, 0.25);
        this.windHigh.set(0, 1, 2000, 0.25);
        this.silent = true;
      }
      return;
    }
    const w = windFor(speed, grounded);
    this.wind.set(w.gain, w.rate, w.cutoff);
    this.windHigh.set(w.high, 0.9 + 0.3 * w.high, 3000 + 9000 * w.high);
    this.silent = false;
  }

  reset(): void {
    this.moves.reset();
  }

  dispose(): void {
    this.frame(0, true, false);
    trackers.delete(this.moves);
  }
}

/** Another player or a ghost: positional sounds from per-frame state (landings derived from grounded changes). */
export class SpatialMover {
  readonly moves = tracker(spatialSink);

  constructor(gain = 1) {
    this.moves.gain = gain;
  }

  update(dt: number, pos: ArrayLike<number>, vel: ArrayLike<number>, grounded: boolean, crouched: boolean, jumped: boolean, snapped: boolean): void {
    if (snapped) {
      this.moves.reset();
      return;
    }
    this.moves.update(dt, pos[0], pos[1], pos[2], vel[0], vel[1], vel[2], grounded, crouched, false, jumped ? 2 : 0, true);
  }

  dispose(): void {
    trackers.delete(this.moves);
  }
}

// -------------------------------------------------------------------------------------------------
// Run feedback + progression

export const runSounds = {
  /** Timer started (left the start zone). */
  start(): void {
    sfx("start_beep");
  },
  /** Split reached; `delta` seconds vs the PB's split (negative = ahead), null without a PB. */
  split(delta: number | null): void {
    // Ahead: up a whole tone; behind: down one; no PB: neutral.
    sfx("split", 1, delta === null ? 1 : delta <= 0 ? 1.1225 : 0.8909);
  },
  finish(kind: "normal" | "pb" | "wr"): void {
    sfx(kind === "wr" ? "finish_wr" : kind === "pb" ? "finish_pb" : "finish");
    duckMusic(0.3, kind === "normal" ? 1.2 : 2.5);
  },
  /** Auto restart set to a sound (auto-restart.ts): the run can no longer beat its target. A low countdown beep. */
  pastTarget(): void {
    sfx("countdown_tick", 1, 0.75);
  },
};

/** Per account: one browser can hold several (a guest, then a sign-in), and one's group says nothing about another's. */
const GROUP_KEY = (uid: string) => `bunnyhop:audio-rank-group:${uid}`;

/**
 * The account's overall rank group changed for the better (groups are ordered best first): true once per improvement
 * (the caller celebrates it; the celebration plays rank_up). The first reading for an account on a device is its
 * baseline. A verified run's other rewards (WR, level-up, achievements) are sounded by their notifications (online.ts,
 * ui/unlocks.ts), in step with what's on screen.
 */
export function rankGroupImproved(uid: string, groupIndex: number): boolean {
  try {
    const prev = localStorage.getItem(GROUP_KEY(uid));
    localStorage.setItem(GROUP_KEY(uid), String(groupIndex));
    return prev !== null && groupIndex >= 0 && groupIndex < Number(prev);
  } catch {
    return false;
  }
}

/** Credits for the Controls screen. */
export function audioCredits(): string[] {
  return [...manifest.credits, "Classic CS:S sounds (optional, Settings → Audio): © Valve Corporation, from Counter-Strike: Source, served from the hosted game content."];
}

export { BUSES };

export { announce, announcerPolicy, announcerAvailable } from "./announcer";
