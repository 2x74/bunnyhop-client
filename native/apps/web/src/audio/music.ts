// Music: one rotation of every track (rotation.ts) in menus (home, and the pause menu with "music only in menus"); in
// game the same rotation skips the menu track. Crossfades, a next / previous / restart / pause control (now-playing.ts,
// the next-track key, media keys), ducking under announcements (engine.duck).
//
// Tracks stream through two <audio> elements ("decks") routed into the music bus, so nothing is decoded up front and
// only the track playing is downloaded. A deck crossfades into the other a few seconds before its track ends.

import { assetUrl, manifest, musicPath, type MusicEntry } from "./assets";
import type { AudioEngine } from "./engine";
import { Rotation } from "./rotation";

export type MusicScene = "home" | "pause" | "play" | "none";
export type MusicMode = "always" | "menus" | "off";

const XFADE = 3;
const SKIP_FADE = 1.2;
const RESTART_FADE = 0.5;
const PAUSE_FADE = 0.3;
/** Previous restarts the track instead once it has played this long (seconds), like any media player. */
const PREV_RESTARTS_AFTER = 4;

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  track: MusicEntry | null;
  /** Invalidates delayed cleanup whenever the deck is reused or resumed. */
  revision: number;
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

export class MusicPlayer {
  private decks: Deck[] = [];
  private active = 0;
  private scene: MusicScene = "none";
  private mode: MusicMode = "always";
  private timer = 0;
  private fading = false;
  /** Paused by the player (pause button / media key); scenes don't start music until play, next or previous. */
  private held = false;
  /**
   * The browser refused to start the track (media autoplay blocked even though WebAudio runs: WebKit). Not playing
   * until a user gesture retries it (retryBlocked).
   */
  private blocked = false;
  private rotation: Rotation;
  private listeners = new Set<() => void>();
  /** Track changes (now-playing toast). */
  onTrack: ((t: MusicEntry) => void) | null = null;

  constructor(private e: AudioEngine) {
    this.rotation = new Rotation(manifest.music.map((m) => m.id), storage(), Math.random, this.menuTrack?.id ?? null);
  }

  get menuTrack(): MusicEntry | null {
    return manifest.music.find((m) => m.role === "menu") ?? null;
  }

  get gameTracks(): MusicEntry[] {
    return manifest.music.filter((m) => m.role === "game");
  }

  /** The track playing (or fading in), if any. */
  get current(): MusicEntry | null {
    return this.decks[this.active]?.track ?? null;
  }

  /** What a now-playing display shows: the track playing or paused, else the last one played (also across reloads). */
  get shown(): MusicEntry | null {
    return this.current ?? entry(this.rotation.current);
  }

  /** True while music is playing (not paused by the player, not stopped by the scene). */
  get playing(): boolean {
    return !this.held && !this.blocked && !!this.current;
  }

  /** True when the current scene and mode want music at all. */
  get wanted(): boolean {
    return this.want() !== null;
  }

  /** Calls fn on any change of track or play state; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const f of this.listeners) f();
  }

  private ensureDecks(): boolean {
    if (this.decks.length) return true;
    const ctx = this.e.ctx;
    if (!ctx || !this.e.unlocked) return false;
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      try {
        ctx.createMediaElementSource(el).connect(gain);
      } catch (err) {
        console.warn("music:", err);
        return false;
      }
      gain.connect(this.e.buses.music);
      el.addEventListener("ended", () => this.decks[this.active]?.el === el && this.advance(0.2));
      this.decks.push({ el, gain, track: null, revision: 0 });
    }
    this.timer = window.setInterval(() => this.poll(), 250);
    return true;
  }

  setOptions(mode: MusicMode, shuffle: boolean): void {
    const changed = mode !== this.mode;
    this.rotation.setShuffle(shuffle);
    this.mode = mode;
    if (changed) this.apply();
  }

  setScene(s: MusicScene): void {
    if (s === this.scene) return;
    this.scene = s;
    this.apply();
  }

  /** What should be playing for the current scene + mode: "menu" (any track), "game" (game tracks) or null. */
  private want(): "menu" | "game" | null {
    if (this.mode === "off" || this.scene === "none") return null;
    if (this.scene === "home") return "menu";
    if (this.mode === "menus") return this.scene === "pause" ? "menu" : null;
    return "game";
  }

  private accept(want: "menu" | "game"): (id: string) => boolean {
    return want === "menu" ? () => true : (id) => entry(id)?.role === "game";
  }

  /** Re-evaluates the scene (call after unlock and on any change). The track playing carries on if the scene allows it. */
  apply(): void {
    const want = this.want();
    if (!want) return this.stop();
    if (this.held || !this.ensureDecks()) return;
    const cur = this.current;
    if (cur && this.accept(want)(cur.id) && !this.decks[this.active].el.paused) return;
    const next = entry(this.rotation.next(this.accept(want)));
    if (next) this.crossfadeTo(next, XFADE);
    else this.stop();
  }

  /** Next / skip: the next track of the rotation the scene allows. */
  next(): MusicEntry | null {
    const want = this.want();
    if (!want || !this.ensureDecks()) return null;
    this.held = false;
    const t = entry(this.rotation.next(this.accept(want)));
    if (t) this.crossfadeTo(t, SKIP_FADE, true);
    else this.emit();
    return t;
  }

  /** Previous: restarts the track if it has played a few seconds (or is the first), else the one before it. */
  previous(): MusicEntry | null {
    const want = this.want();
    if (!want || !this.ensureDecks()) return null;
    const d = this.decks[this.active];
    if (d.track && d.el.currentTime > PREV_RESTARTS_AFTER) return this.restart();
    const t = entry(this.rotation.prev(this.accept(want)));
    if (!t) return this.restart();
    this.held = false;
    this.crossfadeTo(t, SKIP_FADE, true);
    return t;
  }

  /** The current track from the start (or the scene's next one if nothing is loaded). */
  restart(): MusicEntry | null {
    const want = this.want();
    if (!want || !this.ensureDecks()) return null;
    this.held = false;
    const cur = this.current ?? entry(this.rotation.current);
    if (!cur || !this.accept(want)(cur.id)) {
      this.apply();
      return this.current;
    }
    this.crossfadeTo(cur, RESTART_FADE, true);
    return cur;
  }

  /** Pauses where it is (a short fade); play() picks up from there. */
  pause(): void {
    if (this.held) return;
    this.held = true;
    const ctx = this.e.ctx;
    if (ctx) {
      const t = ctx.currentTime;
      for (const d of this.decks) {
        if (!d.track) continue;
        d.gain.gain.cancelScheduledValues(t);
        d.gain.gain.setValueAtTime(d.gain.gain.value, t);
        d.gain.gain.linearRampToValueAtTime(0, t + PAUSE_FADE);
        this.pauseLater(d, PAUSE_FADE * 1000 + 50);
      }
      // A deck that was fading out is done with.
      const other = this.decks[1 - this.active];
      if (other?.track) other.track = null;
    }
    this.emit();
  }

  /** Plays again after pause() (or starts the scene's music). */
  play(): void {
    if (this.blocked && !this.held) return this.retryBlocked();
    const was = this.held;
    this.held = false;
    const want = this.want();
    const d = this.decks[this.active];
    const ctx = this.e.ctx;
    if (was && want && d?.track && ctx && this.accept(want)(d.track.id)) {
      d.revision++;
      const t = ctx.currentTime;
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d.gain.gain.value, t);
      d.gain.gain.linearRampToValueAtTime(1, t + PAUSE_FADE * 2);
      this.start(d);
      this.emit();
      return;
    }
    this.apply();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private advance(fade: number): void {
    const want = this.want();
    if (!want || this.held) return;
    const t = entry(this.rotation.next(this.accept(want)));
    if (t) this.crossfadeTo(t, fade, true);
  }

  private crossfadeTo(track: MusicEntry, fade: number, force = false): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const url = assetUrl(musicPath(track.id));
    if (!url) return;
    const from = this.decks[this.active];
    if (!force && from.track?.id === track.id && !from.el.paused) return;
    const to = this.decks[1 - this.active];
    const t = ctx.currentTime;
    // Fade out the old deck, then pause it.
    if (from.track) {
      from.gain.gain.cancelScheduledValues(t);
      from.gain.gain.setValueAtTime(from.gain.gain.value, t);
      from.gain.gain.linearRampToValueAtTime(0, t + fade);
      this.pauseLater(from, fade * 1000 + 100);
    }
    to.revision++;
    to.track = track;
    if (!to.el.src.endsWith(url)) to.el.src = url;
    to.el.currentTime = 0;
    to.gain.gain.cancelScheduledValues(t);
    to.gain.gain.setValueAtTime(0, t);
    to.gain.gain.linearRampToValueAtTime(1, t + fade);
    this.start(to);
    this.active = 1 - this.active;
    this.fading = true;
    window.setTimeout(() => (this.fading = false), fade * 1000);
    this.onTrack?.(track);
    this.emit();
  }

  private poll(): void {
    const d = this.decks[this.active];
    if (!d?.track || d.el.paused || this.fading || this.held) return;
    const dur = isFinite(d.el.duration) ? d.el.duration : d.track.duration;
    // Crossfade into the next track before this one ends.
    if (dur > XFADE * 2 && d.el.currentTime >= dur - XFADE) this.advance(XFADE);
  }

  /**
   * Starts a deck's element. A refusal (NotAllowedError: the browser wants a gesture for media) marks the music
   * blocked, so the control and the Media Session say it isn't playing, until retryBlocked succeeds. Other rejections
   * (AbortError when the source changes mid-load) say nothing about the policy and are ignored.
   */
  private start(d: Deck): void {
    const revision = d.revision;
    let p: Promise<void> | undefined;
    try {
      p = d.el.play();
    } catch {
      return;
    }
    void p?.then(
      () => {
        if (this.blocked && d.revision === revision) {
          this.blocked = false;
          this.emit();
        }
      },
      (err: unknown) => {
        if ((err as { name?: string } | null)?.name !== "NotAllowedError") return;
        if (d.revision !== revision || this.decks[this.active] !== d || !d.track) return;
        if (!this.blocked) {
          this.blocked = true;
          this.emit();
        }
      },
    );
  }

  /** On a user gesture (index.ts): plays the track the browser refused to start, from where it is. */
  retryBlocked(): void {
    if (!this.blocked || this.held) return;
    const d = this.decks[this.active];
    if (!d?.track) {
      this.blocked = false;
      this.apply();
      this.emit();
      return;
    }
    this.start(d);
  }

  private pauseLater(d: Deck, ms: number): void {
    const revision = ++d.revision;
    window.setTimeout(() => {
      if (d.revision === revision) d.el.pause();
    }, ms);
  }

  stop(fade = 1.5): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    let any = false;
    for (const d of this.decks) {
      if (!d.track) continue;
      any = true;
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d.gain.gain.value, t);
      d.gain.gain.linearRampToValueAtTime(0, t + fade);
      d.track = null;
      this.pauseLater(d, fade * 1000 + 100);
    }
    if (any) this.emit();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const d of this.decks) d.el.pause();
  }
}

function entry(id: string | null): MusicEntry | null {
  return id ? (manifest.music.find((m) => m.id === id) ?? null) : null;
}
