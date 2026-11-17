// Key sounds (Settings → Audio → Key sounds, snd_keysounds, !keysounds): a short sound as a key goes down, so the strafe
// rhythm can be heard. Perfect jump sound (Settings → Audio → Perfect jump sound, snd_perfecttick, !perfsound): a
// brighter one when a scroll-style jump is perfect, stepping up with a streak. Both off by default. Which presses and
// pitches: keysound-policy.ts and perfect-policy.ts.
//
// Timing: your own presses play from the keydown / mousedown handler itself (input.ts onMovePress), never a tick or a
// frame later; a perfect jump plays from the tick that judged it (session.ts afterStep). The sounds are decoded at
// startup with every other one (engine.ts loadBank), and each file starts on its transient (tools/audio/key-sounds.ts:
// 0.5 ms of lead-in). A play is one AudioBufferSourceNode started at once on one of six pre-built voices (gain nodes)
// feeding the sound's own level into the master (VoiceRing): nothing else is allocated. The voices take turns, so a
// sound while the last one still rings layers over it instead of cutting it; only a seventh inside one sound's length
// takes a voice that still plays, faded out in 3 ms first. From the start call to the speakers is the browser's output
// path: one render quantum (128 frames, 2.7 ms at 48 kHz) plus AudioContext baseLatency + outputLatency ("interactive").
//
// The replay viewer and room spectating play the watched player's presses from their per-tick buttons (edges()), on the
// frame that shows the tick; the replay viewer also its perfect jumps (audio/replay.ts). Never other players or ghosts.

import { prefs } from "../ui/settings";
import type { StrafeKeys } from "../styles";
import { SFX, type SfxId } from "./catalog";
import { sliderGain, type AudioEngine } from "./engine";
import { keySoundId, keySoundRate } from "./keysound-policy";
import { perfectSoundId, PerfectStreak, streakRate } from "./perfect-policy";

const VOICES = 6;
/** Fade of a voice taken while it still plays (s). */
const STEAL_FADE = 0.003;

interface Voice {
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  ends: number;
}

/** Six voices taking turns on one level (`volume`: a 0..1 setting, curved like the channel sliders) into the master. */
export class VoiceRing {
  private out: GainNode | null = null;
  private voices: Voice[] = [];
  private next = 0;
  private level = -1;

  constructor(
    private e: AudioEngine,
    private volume: () => number,
  ) {}

  play(id: SfxId, rate = 1): void {
    const ctx = this.e.ctx;
    const buf = this.e.buffers(id)?.[0];
    if (!ctx || ctx.state !== "running" || !buf || !this.ready(ctx)) return;
    const now = ctx.currentTime;
    const v = this.voices[this.next];
    this.next = (this.next + 1) % VOICES;
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    let at = now;
    if (v.src && v.ends > now) {
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + STEAL_FADE);
      v.src.stop(now + STEAL_FADE);
      at = now + STEAL_FADE;
    }
    g.setValueAtTime(SFX[id].gain, at);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(v.gain);
    src.start(at);
    v.src = src;
    v.ends = at + buf.duration / rate;
  }

  /** The voices and level node (once the context exists); the level follows the setting. */
  private ready(ctx: AudioContext): boolean {
    if (!this.out) {
      if (!this.e.master) return false;
      this.out = ctx.createGain();
      this.out.connect(this.e.master);
      for (let i = 0; i < VOICES; i++) {
        const gain = ctx.createGain();
        gain.connect(this.out);
        this.voices.push({ gain, src: null, ends: 0 });
      }
    }
    const vol = this.volume();
    if (vol !== this.level) this.out.gain.value = sliderGain((this.level = vol));
    return true;
  }
}

export class KeySounds {
  private ring: VoiceRing;

  constructor(e: AudioEngine) {
    this.ring = new VoiceRing(e, () => prefs.get().audio.keySounds.volume);
  }

  /** Keys holding `bits` (IN_*) went down now: your keydown, or a watched player's tick. */
  press(bits: number, strafe: StrafeKeys): void {
    const p = prefs.get().audio.keySounds;
    if (!p.enabled) return;
    const rate = keySoundRate(bits, p.keys, strafe);
    if (rate) this.play(keySoundId(p.set), rate);
  }

  /** A watched player's buttons from one tick to the next: plays the keys that went down. */
  edges(prev: number, now: number, strafe: StrafeKeys): void {
    if (now & ~prev) this.press(now & ~prev, strafe);
  }

  /** Plays a set's sound at the key sound volume (Settings' preview too). */
  play(id: ReturnType<typeof keySoundId>, rate = 1): void {
    this.ring.play(id, rate);
  }
}

export class PerfectSounds {
  private ring: VoiceRing;
  /** Your own streak (the local player's ticks); the replay viewer keeps its own. */
  readonly streak = new PerfectStreak();

  constructor(e: AudioEngine) {
    this.ring = new VoiceRing(e, () => prefs.get().audio.perfectSound.volume);
  }

  /**
   * Your tick (session.ts afterStep): `scroll` the run's style has perfect jumps, `hop` the timer's verdict on this
   * tick's jump (true perfect, false measured and not, null none), `broken` the tick breaks a streak.
   */
  tick(scroll: boolean, hop: boolean | null, grounded: boolean, dt: number, broken: boolean): void {
    if (!scroll) return this.streak.reset();
    const n = this.streak.tick(hop, grounded, dt, broken);
    if (n) this.perfect(n);
  }

  /** The `n`th perfect jump in a row (yours, or the replay viewer's run): its sound, if the setting is on. */
  perfect(n: number): void {
    const a = prefs.get().audio;
    const s = a.perfectSound;
    if (a.perfectTick) this.play(perfectSoundId(s.set), s.streak ? streakRate(n, s.length, s.set) : 1);
  }

  /** Plays a set's sound at the perfect sound volume (Settings' preview too). */
  play(id: ReturnType<typeof perfectSoundId>, rate = 1): void {
    this.ring.play(id, rate);
  }
}
