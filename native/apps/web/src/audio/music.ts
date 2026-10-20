// Music: the menu track on the home screen (and the pause menu with "music only in menus"), a shuffled in-game
// playlist with crossfades and a next-track key, ducking under announcements (engine.duck).
//
// Tracks stream through two <audio> elements ("decks") routed into the music bus, so nothing is decoded up front and
// only the track playing is downloaded. A deck crossfades into the other a few seconds before its track ends (the
// menu track crossfades into itself, so it loops without a gap).

import { assetUrl, manifest, musicPath, type MusicEntry } from "./assets";
import type { AudioEngine } from "./engine";

export type MusicScene = "home" | "pause" | "play" | "none";
export type MusicMode = "always" | "menus" | "off";

const XFADE = 3;
const SKIP_FADE = 1.2;

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  track: MusicEntry | null;
}

export class MusicPlayer {
  private decks: Deck[] = [];
  private active = 0;
  private scene: MusicScene = "none";
  private mode: MusicMode = "always";
  private shuffle = true;
  private queue: MusicEntry[] = [];
  private qi = -1;
  private timer = 0;
  private fading = false;
  /** Track changes (now-playing toast). */
  onTrack: ((t: MusicEntry) => void) | null = null;

  constructor(private e: AudioEngine) {}

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
      this.decks.push({ el, gain, track: null });
    }
    this.timer = window.setInterval(() => this.poll(), 250);
    return true;
  }

  setOptions(mode: MusicMode, shuffle: boolean): void {
    const changed = mode !== this.mode;
    if (shuffle !== this.shuffle) {
      this.shuffle = shuffle;
      this.queue = [];
    }
    this.mode = mode;
    if (changed) this.apply();
  }

  setScene(s: MusicScene): void {
    if (s === this.scene) return;
    this.scene = s;
    this.apply();
  }

  /** What should be playing for the current scene + mode: "menu", "game" or null. */
  private want(): "menu" | "game" | null {
    if (this.mode === "off" || this.scene === "none") return null;
    if (this.scene === "home") return "menu";
    if (this.mode === "menus") return this.scene === "pause" ? "menu" : null;
    return "game";
  }

  /** Re-evaluates the scene (call after unlock and on any change). */
  apply(): void {
    const want = this.want();
    const cur = this.current;
    if (!want) return this.stop();
    if (!this.ensureDecks()) return;
    if (want === "menu") {
      const m = this.menuTrack;
      if (m && cur?.id !== m.id) this.crossfadeTo(m, XFADE);
      else if (!m) this.stop();
    } else if (!cur || cur.role !== "game") {
      const next = this.nextGame();
      if (next) this.crossfadeTo(next, XFADE);
      else this.stop();
    }
  }

  private nextGame(): MusicEntry | null {
    const all = this.gameTracks;
    if (!all.length) return null;
    if (this.qi + 1 >= this.queue.length) {
      const last = this.queue[this.queue.length - 1];
      this.queue = [...all];
      if (this.shuffle) {
        for (let i = this.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        // Never the same track twice in a row across reshuffles.
        if (this.queue.length > 1 && this.queue[0].id === last?.id) [this.queue[0], this.queue[1]] = [this.queue[1], this.queue[0]];
      }
      this.qi = -1;
    }
    return this.queue[++this.qi] ?? null;
  }

  /** Next / skip: the next game track (or restarts the menu track in menus). */
  next(): MusicEntry | null {
    const want = this.want();
    if (!want || !this.ensureDecks()) return null;
    const t = want === "menu" ? this.menuTrack : this.nextGame();
    if (t) this.crossfadeTo(t, SKIP_FADE, true);
    return t;
  }

  private advance(fade: number): void {
    const want = this.want();
    if (!want) return;
    const t = want === "menu" ? this.menuTrack : this.nextGame();
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
      const el = from.el;
      const stopAt = performance.now() + fade * 1000 + 100;
      window.setTimeout(() => {
        if (performance.now() >= stopAt - 150 && this.decks[this.active].el !== el) el.pause();
      }, fade * 1000 + 100);
    }
    to.track = track;
    if (!to.el.src.endsWith(url)) to.el.src = url;
    to.el.currentTime = 0;
    to.gain.gain.cancelScheduledValues(t);
    to.gain.gain.setValueAtTime(0, t);
    to.gain.gain.linearRampToValueAtTime(1, t + fade);
    void to.el.play().catch(() => undefined);
    this.active = 1 - this.active;
    this.fading = true;
    window.setTimeout(() => (this.fading = false), fade * 1000);
    this.onTrack?.(track);
  }

  private poll(): void {
    const d = this.decks[this.active];
    if (!d?.track || d.el.paused || this.fading) return;
    const dur = isFinite(d.el.duration) ? d.el.duration : d.track.duration;
    // Crossfade into the next track (the menu track into itself) before this one ends.
    if (dur > XFADE * 2 && d.el.currentTime >= dur - XFADE) this.advance(XFADE);
  }

  stop(fade = 1.5): void {
    const ctx = this.e.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const d of this.decks) {
      if (!d.track) continue;
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d.gain.gain.value, t);
      d.gain.gain.linearRampToValueAtTime(0, t + fade);
      const el = d.el;
      const track = d.track;
      d.track = null;
      window.setTimeout(() => {
        if (!d.track || d.track === track) el.pause();
      }, fade * 1000 + 100);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const d of this.decks) d.el.pause();
  }
}
