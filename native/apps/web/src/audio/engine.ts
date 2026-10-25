// WebAudio engine: buses, preloaded buffers, pooled voices (flat and positional), loops and ducking.
//
//   master ── music (── duck)   streamed tracks (audio/music.ts)
//          ├─ sfx                gameplay, run feedback, viewmodel; positional voices (other players, ghosts) too
//          ├─ ui                 menus, rooms, progression
//          └─ ambience           wind, water loops
//
// Autoplay: the AudioContext is created at startup. Where the browser lets the page play sound without a gesture
// (Chrome's media engagement, a site setting, Firefox's policy) it runs at once; otherwise it starts suspended and the
// first user gesture anywhere (pointer / click / key / touch) resumes it. Either way everything waiting on audio
// (onUnlock: music, levels) starts the moment the context runs, whatever started it: a page opened straight onto
// something that plays by itself (a /replay/<id> link) is not silent until a menu click. Buffers are fetched and
// decoded through an OfflineAudioContext (no gesture needed), so the first sound after the click is instant. Voices are pre-built gain (+ panner) chains per bus; a play is one AudioBufferSourceNode (the only
// per-sound allocation WebAudio allows), no closures. Per-tick callers pass plain numbers.
//
// Coordinates for positional sounds are Source units (x, y, z with z up), the same as the sim: the listener is set
// from the render camera every frame (setListenerFromCamera).

import { supporterGiftWave } from "./gift";
import { UnlockPress } from "./unlock-press";
import { SFX, SFX_IDS, type SfxId } from "./catalog";
import { assetUrl, manifest, otherFormat, preferredFormat, sfxPath, type AudioFormat } from "./assets";

export type BusId = "music" | "sfx" | "ui" | "ambience";
export const BUSES: BusId[] = ["music", "sfx", "ui", "ambience"];

interface Voice {
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  panner: PannerNode | null;
  id: string;
  started: number;
  ends: number;
}

/** A looping sound whose level / rate / brightness is driven every frame (wind, swimming). */
export interface LoopHandle {
  /** Target gain (0 = silent), playback rate and low-pass cutoff in Hz; smoothed over `tau` seconds. */
  set(gain: number, rate?: number, cutoff?: number, tau?: number): void;
}

/** Linear slider value (0..1) to gain: a gentle curve so the lower half of a slider is usable. */
export const sliderGain = (v: number) => (v <= 0 ? 0 : Math.pow(Math.min(1, v), 1.7));

const POOL = { sfx: 20, ui: 8, ambience: 4 } as const;
const GESTURES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "keydown", "keyup", "touchend"];
const SPATIAL_POOL = 14;

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;
const OfflineCtx = (globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor }).OfflineAudioContext ??
  (globalThis as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
type CtxCtor = new (o?: AudioContextOptions) => AudioContext;
const LiveCtx = (globalThis as unknown as { AudioContext?: CtxCtor; webkitAudioContext?: CtxCtor }).AudioContext ??
  (globalThis as unknown as { webkitAudioContext?: CtxCtor }).webkitAudioContext;

/** Decodes encoded audio without a live context (works before any user gesture). */
export function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
  if (!OfflineCtx) return Promise.reject(new Error("no WebAudio"));
  const ctx = new OfflineCtx(1, 1, 48000);
  return new Promise((resolve, reject) => {
    // Callback form too: older Safari has no promise-returning decodeAudioData.
    const p = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
    p?.then(resolve, reject);
  });
}

/** Fetches and decodes one shipped file, trying the other format if this browser can't decode the first. */
export async function loadAsset(path: string, format: AudioFormat = preferredFormat()): Promise<AudioBuffer | null> {
  for (const f of [format, otherFormat(format)]) {
    const url = assetUrl(path, f);
    if (!url) continue;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      return await decodeAudio(await r.arrayBuffer());
    } catch {
      /* try the other format */
    }
  }
  return null;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  readonly buses = {} as Record<BusId, GainNode>;
  /** Music ducking stage (announcements, fanfares). */
  duckNode: GainNode | null = null;
  /** Shipped sounds: id -> decoded variants. */
  private bank = new Map<string, AudioBuffer[]>();
  /** Replacements (Classic CS:S sounds): id -> variants. */
  private override = new Map<string, AudioBuffer[]>();
  private pools = {} as Record<"sfx" | "ui" | "ambience", Voice[]>;
  private spatial: Voice[] = [];
  private lastStart: Record<string, number> = {};
  private lastVariant: Record<string, number> = {};
  private unlockFns: (() => void)[] = [];
  private stateFns: (() => void)[] = [];
  /** The gesture that got the context running (the speaker button doesn't also mute on that press). */
  readonly unlockPress = new UnlockPress();
  private levels = { master: 1, music: 1, sfx: 1, ui: 1, ambience: 1 };
  /** Sounds loaded (shipped bank). */
  loaded: Promise<void> = Promise.resolve();
  /** Optional random source (offline renders use a seeded one). */
  random: () => number = Math.random;

  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  /** Starts fetching + decoding every shipped SFX, creates the context and arms the first-gesture unlock. Call once. */
  init(): void {
    if (!LiveCtx) return;
    this.loaded = this.loadBank();
    // Every event that counts as a user activation somewhere (Safari wants click / touchend; Chrome takes
    // pointerdown / keydown). Capture phase on window: nothing a screen does (stopPropagation) can swallow it. The
    // listeners stay: a context the system suspends later (Safari, a device change) is resumed by the next gesture.
    const gesture = (e: Event) => {
      if (!e.isTrusted || this.unlocked) return;
      this.unlockPress.record(e.target, performance.now());
      this.unlock();
    };
    for (const t of GESTURES) addEventListener(t, gesture, true);
    // Try now: browsers that allow it play straight away, the rest wait (suspended) for the listeners above.
    this.unlock();
  }

  /** True once, for the click whose press on `el` turned sound on (that click shouldn't also act). */
  consumeUnlockPress(el: Element): boolean {
    return this.unlockPress.consume((t) => t instanceof Node && el.contains(t), performance.now());
  }

  /** Calls fn whenever the context starts or stops running. */
  onState(fn: () => void): void {
    this.stateFns.push(fn);
  }

  /** Calls fn once audio is running (now, if it already is). */
  onUnlock(fn: () => void): void {
    if (this.unlocked) fn();
    else this.unlockFns.push(fn);
  }

  private unlock(): void {
    if (!LiveCtx) return;
    if (!this.ctx) {
      try {
        this.ctx = new LiveCtx({ latencyHint: "interactive" });
      } catch {
        return;
      }
      this.build();
      // However it gets to "running" (a gesture's resume, the browser allowing autoplay a moment later), flush.
      this.ctx.addEventListener("statechange", () => this.ran());
    }
    const ctx = this.ctx;
    if (ctx.state !== "running") void ctx.resume().then(() => this.ran(), () => undefined);
    else this.ran();
  }

  /** The context's state changed: run what waited for audio once it's running. */
  private ran(): void {
    if (this.ctx?.state === "running") {
      const fns = this.unlockFns.splice(0);
      for (const f of fns) f();
    }
    for (const f of this.stateFns) f();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    for (const b of BUSES) {
      const g = ctx.createGain();
      this.buses[b] = g;
    }
    this.duckNode = ctx.createGain();
    this.buses.music.connect(this.duckNode);
    this.duckNode.connect(this.master);
    for (const b of ["sfx", "ui", "ambience"] as const) this.buses[b].connect(this.master);
    for (const b of ["sfx", "ui", "ambience"] as const) {
      this.pools[b] = [];
      for (let i = 0; i < POOL[b]; i++) {
        const gain = ctx.createGain();
        gain.connect(this.buses[b]);
        this.pools[b].push({ src: null, gain, panner: null, id: "", started: 0, ends: 0 });
      }
    }
    for (let i = 0; i < SPATIAL_POOL; i++) {
      const gain = ctx.createGain();
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 96;
      panner.maxDistance = 6000;
      panner.rolloffFactor = 1.3;
      panner.connect(gain);
      gain.connect(this.buses.sfx);
      this.spatial.push({ src: null, gain, panner, id: "", started: 0, ends: 0 });
    }
    this.applyLevels(0);
  }

  private async loadBank(): Promise<void> {
    const jobs: (() => Promise<void>)[] = [];
    for (const id of SFX_IDS) {
      const e = manifest.sfx[id];
      if (!e?.variants) continue;
      jobs.push(async () => {
        const out: AudioBuffer[] = [];
        for (let v = 0; v < e.variants; v++) {
          const b = await loadAsset(sfxPath(id, v));
          if (b) out.push(b);
        }
        if (out.length) this.bank.set(id, out);
      });
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) await jobs[next++]();
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  /** Variants used for `id` right now (Classic CS:S replacements first). */
  buffers(id: string): AudioBuffer[] | null {
    return this.override.get(id) ?? this.bank.get(id) ?? null;
  }

  /** Shipped variants only. */
  shipped(id: string): AudioBuffer[] | null {
    return this.bank.get(id) ?? null;
  }

  setOverride(id: string, buffers: AudioBuffer[] | null): void {
    if (buffers?.length) this.override.set(id, buffers);
    else this.override.delete(id);
  }

  clearOverrides(): void {
    this.override.clear();
  }

  /** Picks a variant index (never the same one twice in a row when there are several). */
  pickVariant(id: string, count: number): number {
    if (count <= 1) return 0;
    const last = this.lastVariant[id] ?? -1;
    let v = Math.floor(this.random() * (count - 1));
    if (v >= last && last >= 0) v++;
    this.lastVariant[id] = v;
    return v;
  }

  // ---------------------------------------------------------------------------------------------
  // Levels

  /** Master / bus levels (already curved gains) and mutes; smoothed. */
  setLevels(l: { master: number; music: number; sfx: number; ui: number; ambience: number }): void {
    this.levels = l;
    this.applyLevels(0.03);
  }

  private applyLevels(tau: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number) => {
      p.cancelScheduledValues(t);
      if (tau > 0) p.setTargetAtTime(v, t, tau);
      else p.value = v;
    };
    set(this.master.gain, this.levels.master);
    for (const b of BUSES) set(this.buses[b].gain, this.levels[b]);
  }

  /** Pulls the music down to `depth` for `hold` seconds (announcements, fanfares). */
  duck(depth = 0.35, hold = 2): void {
    const ctx = this.ctx;
    const g = this.duckNode?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(depth, t, 0.06);
    g.setTargetAtTime(1, t + hold, 0.5);
  }

  // ---------------------------------------------------------------------------------------------
  // Playback

  private voice(pool: Voice[], id: string, max: number, now: number): Voice {
    let free: Voice | null = null;
    let oldest: Voice = pool[0];
    let sameCount = 0;
    let oldestSame: Voice | null = null;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      const busy = v.ends > now;
      if (!busy) {
        if (!free) free = v;
        continue;
      }
      if (v.started < oldest.started) oldest = v;
      if (v.id === id) {
        sameCount++;
        if (!oldestSame || v.started < oldestSame.started) oldestSame = v;
      }
    }
    if (sameCount >= max && oldestSame) return oldestSame;
    return free ?? oldest;
  }

  private start(v: Voice, id: string, buf: AudioBuffer, gain: number, rate: number, now: number): void {
    const ctx = this.ctx!;
    const old = v.src;
    if (old) {
      if (v.ends > now) {
        try {
          old.stop();
        } catch {
          /* already stopped */
        }
      }
      old.disconnect();
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(v.panner ?? v.gain);
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.value = gain;
    src.start(now);
    v.src = src;
    v.id = id;
    v.started = now;
    v.ends = now + buf.duration / rate + 0.02;
  }

  /** True if `id` may start now (debounce gap); records the start. */
  private gate(id: SfxId, now: number): boolean {
    const gap = SFX[id].gap ?? 0;
    if (gap > 0 && now - (this.lastStart[id] ?? -1) < gap) return false;
    this.lastStart[id] = now;
    return true;
  }

  /** Stop only announcer voices when a higher-priority cue replaces one. */
  stopAnnouncements(): void {
    for (const v of this.pools.sfx ?? []) {
      if (!v.id?.startsWith("announcer_") || !v.src) continue;
      try { v.src.stop(); } catch { /* already ended */ }
      v.ends = 0;
    }
  }

  /** Plays a non-positional sound. `gain` scales the catalogue level; `rate` multiplies the pitch. */
  play(id: SfxId, gain = 1, rate = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || gain <= 0) return;
    if (id === "supporter_gift" && !this.bank.has(id)) {
      // Original short crystal arpeggio, synthesized once and mixed through the normal UI bus.
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.72), ctx.sampleRate);
      buffer.copyToChannel(supporterGiftWave(ctx.sampleRate), 0);
      this.bank.set(id, [buffer]);
    }
    const bufs = this.buffers(id);
    if (!bufs) return;
    const def = SFX[id];
    const now = ctx.currentTime;
    if (!this.gate(id, now)) return;
    const pool = this.pools[def.bus === "music" ? "ui" : def.bus];
    const buf = bufs[this.pickVariant(id, bufs.length)];
    const r = rate * (1 + (this.random() * 2 - 1) * def.jitter);
    this.start(this.voice(pool, id, def.max, now), id, buf, def.gain * gain, r, now);
    if (def.layer && def.layer !== id) this.play(def.layer, gain, rate);
  }

  /** Plays a positional sound at Source coordinates (other players, ghosts). */
  playAt(id: SfxId, x: number, y: number, z: number, gain = 1, rate = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || gain <= 0) return;
    const bufs = this.buffers(id);
    if (!bufs) return;
    const def = SFX[id];
    const now = ctx.currentTime;
    const v = this.voice(this.spatial, id, def.max + 2, now);
    const p = v.panner!;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    const buf = bufs[this.pickVariant(id, bufs.length)];
    this.start(v, id, buf, def.gain * gain, rate * (1 + (this.random() * 2 - 1) * def.jitter), now);
  }

  /** Listener at Source coordinates with forward / up vectors (Source axes). */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = px;
      l.positionY.value = py;
      l.positionZ.value = pz;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = ux;
      l.upY.value = uy;
      l.upZ.value = uz;
    } else {
      const ll = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      ll.setPosition(px, py, pz);
      ll.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /** A loop on its bus (created lazily once audio runs and the buffer is loaded). */
  loop(id: SfxId): LoopHandle {
    return new LoopImpl(this, id);
  }

  /** Current context time (0 before unlock). */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }
}

class LoopImpl implements LoopHandle {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private buf: AudioBuffer | null = null;
  private target = 0;
  private rate = 1;
  private cutoff = 2000;

  constructor(
    private e: AudioEngine,
    private id: SfxId,
  ) {}

  private ensure(): boolean {
    if (this.src) {
      // Classic sounds / reloads swapped the buffer: restart on the new one.
      const b = this.e.buffers(this.id)?.[0] ?? null;
      if (b === this.buf) return true;
      this.src.stop();
      this.src.disconnect();
      this.src = null;
    }
    const ctx = this.e.ctx;
    if (!ctx || ctx.state !== "running") return false;
    const buf = this.e.buffers(this.id)?.[0];
    if (!buf) return false;
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 2000;
      this.filter.Q.value = 0.5;
      this.filter.connect(this.gain);
      this.gain.connect(this.e.buses[SFX[this.id].bus]);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const e = manifest.sfx[this.id];
    if (e?.loopEnd && e.loopEnd > (e.loopStart ?? 0) && buf === this.e.shipped(this.id)?.[0]) {
      src.loopStart = e.loopStart ?? 0;
      src.loopEnd = e.loopEnd;
    }
    src.connect(this.filter!);
    // Random start offset so the loop's seam isn't heard at the same moment every time.
    src.start(0, buf.duration * Math.random());
    this.src = src;
    this.buf = buf;
    return true;
  }

  set(gain: number, rate = 1, cutoff = 20000, tau = 0.12): void {
    if (gain <= 0.0005 && this.target <= 0.0005 && !this.src) return;
    if (!this.ensure()) return;
    // Per-frame callers: skip changes too small to hear (keeps the AudioParam timelines short).
    if (Math.abs(gain - this.target) < 0.004 && Math.abs(rate - this.rate) < 0.004 && Math.abs(cutoff - this.cutoff) < this.cutoff * 0.02) return;
    const t = this.e.ctx!.currentTime;
    const g = SFX[this.id].gain * gain;
    this.target = gain;
    this.rate = rate;
    this.cutoff = cutoff;
    this.gain!.gain.setTargetAtTime(g, t, tau);
    this.src!.playbackRate.setTargetAtTime(rate, t, tau);
    this.filter!.frequency.setTargetAtTime(Math.max(40, Math.min(20000, cutoff)), t, tau);
  }
}
