import { replayAudioTicks, replayAudioWindTick } from "./replay-timing";
// Replay sounds: the viewer's live playback (ReplayAudio) and the MP4 export's offline soundtrack
// (renderReplayAudio). Both read the viewer's per-tick cache (viewer/player.ts RunData) through the same movement
// tracker the live game uses, so a replay sounds exactly like the run did.
//
// Offline rendering mixes into an OfflineAudioContext at 48 kHz: every sound lands on the sample of its tick
// (intro offset + (tick - from) / tickrate), never on a wall clock, so the track is as deterministic as the video
// (variants and pitch jitter come from a seeded PRNG).

import { EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED } from "../core";
import { F_CROUCHED, F_GROUNDED, F_JUMPED, F_LANDED, F_RESTARTED, F_TELEPORTED, STATUS_FINISHED, STATUS_IDLE, STATUS_RUNNING, type RunData } from "../viewer/player";
import { prefs } from "../ui/settings";
import { SFX, type SfxId } from "./catalog";
import { loadAsset } from "./engine";
import { musicPath, manifest, type MusicEntry } from "./assets";
import { MoveSounds, windFor, type SoundSink } from "./movement";
import { classic, engine, PlayerAudio, runSounds, spatialSink, tracker } from "./index";

const eventsOf = (f: number) => (f & F_JUMPED ? EVENT_JUMPED : 0) | (f & F_LANDED ? EVENT_LANDED : 0) | (f & F_TELEPORTED ? EVENT_TELEPORTED : 0);

/** Feeds tick k of a replay to a tracker; run feedback (timer start / split / finish) goes to `run`. */
function feed(d: RunData, k: number, moves: MoveSounds, run: (id: SfxId) => void): void {
  const f = d.flags[k];
  if (f & F_RESTARTED) moves.reset();
  const o = k * 3;
  moves.update(d.interval, d.pos[o], d.pos[o + 1], d.pos[o + 2], d.vel[o], d.vel[o + 1], d.vel[o + 2], (f & F_GROUNDED) !== 0, (f & F_CROUCHED) !== 0, false, eventsOf(f));
  if (k > 0) {
    const a = d.status[k - 1];
    const b = d.status[k];
    if (a === STATUS_IDLE && b === STATUS_RUNNING) run("start_beep");
    else if (a === STATUS_RUNNING && b === STATUS_FINISHED) run("finish");
    else if (b === STATUS_RUNNING && d.splitCount[k] > d.splitCount[k - 1]) run("split");
  }
}

const speed3 = (d: RunData, k: number) => Math.hypot(d.vel[k * 3], d.vel[k * 3 + 1], d.vel[k * 3 + 2]);

/** Live playback in the replay viewer: positional movement sounds (the listener is the viewer camera) + wind. */
export class ReplayAudio {
  private moves = tracker(spatialSink);
  private wind = new PlayerAudio();
  private last = -1;

  /** Per viewer frame. Sounds play only while playing at up to 2× (faster is a blur); seeks re-prime silently. */
  frame(d: RunData | null, t: number, playing: boolean, speed: number): void {
    if (!d) return this.stop();
    const tick = Math.max(0, Math.min(d.n, Math.floor(t)));
    if (!playing) {
      this.wind.frame(0, true, false);
      this.last = tick;
      this.moves.reset();
      return;
    }
    if (this.last < 0 || tick < this.last || tick - this.last > 40 || speed > 2.01) {
      this.moves.reset();
      this.last = tick;
    }
    for (let k = this.last + 1; k <= tick; k++) feed(d, k, this.moves, (id) => (id === "finish" ? runSounds.finish("normal") : engine.play(id)));
    this.last = tick;
    this.wind.frame(speed3(d, tick), (d.flags[tick] & F_GROUNDED) !== 0, true);
  }

  stop(): void {
    this.wind.frame(0, true, false);
    this.moves.reset();
    this.last = -1;
  }
}

// -------------------------------------------------------------------------------------------------
// Offline (MP4 export)

export const EXPORT_RATE = 48000;

export interface ReplayMixOptions {
  /** Replay ticks rendered (video frame i shows tick from + i * tickrate / fps). */
  from: number;
  to: number;
  /** Seconds of title card before tick `from`, and the whole video's length. */
  lead: number;
  seconds: number;
  sfx: boolean;
  /** Export wind is opt-in, independent of the live playback preference. */
  wind?: boolean;
  /** A music track id (manifest), or null. */
  music: string | null;
}

/** The game tracks a montage can use (manifest order). */
export function exportTracks(): MusicEntry[] {
  return manifest.music.filter((m) => m.role === "game");
}

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

/**
 * Mixes a replay's soundtrack: movement sounds, run chimes, wind, and optionally a music bed (faded in/out, dipped
 * under the finish). Resolves null when WebAudio is missing or there's nothing to play.
 */
export async function renderReplayAudio(d: RunData, o: ReplayMixOptions): Promise<AudioBuffer | null> {
  const OAC = (globalThis as unknown as { OfflineAudioContext?: OfflineCtor }).OfflineAudioContext ?? (globalThis as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
  if (!OAC || (!o.sfx && !o.music)) return null;
  await engine.loaded;
  const len = Math.max(1, Math.ceil(o.seconds * EXPORT_RATE));
  const ctx = new OAC(2, len, EXPORT_RATE);
  const a = prefs.get().audio;
  // A fixed video mix (not the player's sliders or mutes: an export shouldn't come out silent or lopsided), music
  // under the effects; the whole mix is then brought to a video-ish loudness (normalise() below).
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const bus = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    g.connect(master);
    return g;
  };
  const sfxBus = bus(1);
  const ambBus = bus(0.85);
  const musicBus = bus(0.5);
  let seed = (d.n * 2654435761 + 977) >>> 0;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const timeOf = (k: number) => o.lead + (k - o.from) / d.tickrate;
  let now = 0;
  let finishAt = -1;
  const schedule = (id: SfxId, gain: number, rate: number) => {
    const bufs = engine.buffers(id);
    if (!bufs || gain <= 0 || now < 0 || now >= o.seconds) return;
    const def = SFX[id];
    const src = ctx.createBufferSource();
    src.buffer = bufs[Math.floor(rng() * bufs.length)];
    src.playbackRate.value = rate * (1 + (rng() * 2 - 1) * def.jitter);
    const g = ctx.createGain();
    g.gain.value = def.gain * gain;
    src.connect(g);
    g.connect(def.bus === "ambience" ? ambBus : sfxBus);
    src.start(now);
  };
  if (o.sfx) {
    const sink: SoundSink = { play: (id, g, r) => schedule(id, g, r) };
    const moves = new MoveSounds(sink);
    moves.footsteps = a.footsteps;
    moves.classic = classic.active;
    moves.reset();
    const ticks = replayAudioTicks(o.from, o.to);
    for (let k = ticks.first; k <= ticks.last; k++) {
      now = timeOf(k);
      feed(d, k, moves, (id) => {
        if (id === "finish") finishAt = now;
        schedule(id, 1, 1);
      });
    }
    // Wind: one loop with its gain / rate / brightness automated from the speed every 1/30 s.
    const windBuf = engine.buffers("wind")?.[0];
    if (windBuf && o.wind) {
      const src = ctx.createBufferSource();
      src.buffer = windBuf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp);
      lp.connect(g);
      g.connect(ambBus);
      const start = timeOf(o.from);
      const end = timeOf(o.to);
      for (let s = start; s <= end; s += 1 / 30) {
        const k = replayAudioWindTick(o.from, o.to, s - o.lead, d.tickrate);
        const w = windFor(speed3(d, k), (d.flags[k] & F_GROUNDED) !== 0);
        g.gain.linearRampToValueAtTime(SFX.wind.gain * w.gain, s);
        lp.frequency.linearRampToValueAtTime(w.cutoff, s);
        src.playbackRate.linearRampToValueAtTime(w.rate, s);
      }
      g.gain.linearRampToValueAtTime(0, Math.min(o.seconds, end + 0.6));
      src.start(Math.max(0, start - 0.05), windBuf.duration * rng());
    }
  }
  // Music bed.
  if (o.music) {
    const buf = await loadAsset(musicPath(o.music));
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = buf.duration < o.seconds;
      const g = ctx.createGain();
      const p = g.gain;
      // Gain envelope (time, value), linear between points: fade in, dip under the finish sting, fade out.
      const env: [number, number][] = [
        [0, 0],
        [Math.min(1.5, o.seconds / 4), 0.85],
      ];
      if (finishAt > 0) env.push([finishAt, 0.85], [finishAt + 0.1, 0.4], [finishAt + 1.4, 0.4], [finishAt + 2.4, 0.85]);
      const fadeAt = Math.max(env[1][0], o.seconds - 2.5);
      const keep = env.filter(([t]) => t < fadeAt);
      keep.push([fadeAt, keep[keep.length - 1][1]], [o.seconds, 0]);
      p.setValueAtTime(0, 0);
      for (const [t, v] of keep.slice(1)) p.linearRampToValueAtTime(v, t);
      src.connect(g);
      g.connect(musicBus);
      src.start(0);
    }
  }
  return normalise(await ctx.startRendering());
}

/**
 * Brings the mix to about -16 dBFS RMS over its loud parts (a rough stand-in for -16 LUFS: quiet stretches are
 * ignored so a long silent intro doesn't pump the rest), gain limited to 0.5..6. The encoder's peak ceiling
 * (viewer/audio-track.ts) scales down if that pushes a transient over.
 */
function normalise(buf: AudioBuffer): AudioBuffer {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const block = 4800;
  let sum = 0;
  let blocks = 0;
  for (let o = 0; o < buf.length; o += block) {
    let e = 0;
    let n = 0;
    for (const ch of chans) for (let i = o; i < Math.min(buf.length, o + block); i++) (e += ch[i] * ch[i]), n++;
    const ms = e / Math.max(1, n);
    if (ms > 1e-6) (sum += ms), blocks++;
  }
  if (!blocks) return buf;
  const rmsDb = 10 * Math.log10(sum / blocks);
  const k = Math.min(6, Math.max(0.5, Math.pow(10, (-16 - rmsDb) / 20)));
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
  return buf;
}
