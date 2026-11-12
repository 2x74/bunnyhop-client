// One talker's voice on your side: decoder -> playout (voice/jitter.ts) -> AudioBufferSourceNodes on the game's
// AudioContext -> the talker's gain (your mute / volume for them) -> the voice bus (voice/client.ts) -> master. The
// level the HUD graph shows is measured here from the decoded frames, at the moment each one plays.

import { seqAfter, VF_END, VF_START, VOICE_FRAME_MS, VOICE_FRAME_SAMPLES, VOICE_FRAMES_PER_PACKET, VOICE_SAMPLE_RATE, type VoiceDown } from "../net/voice-wire";
import { createDecoder, levelOf, type VoiceDecoder } from "./codec";
import { bandsOf } from "./spectrum";
import { Playout } from "./jitter";

/** Frames the room could have dropped between two packets that we still treat as one spurt (more: a new spurt). */
const MAX_LOST_PACKETS = 4;

export class TalkerPlayback {
  readonly gain: GainNode;
  readonly playout = new Playout();
  private dec: VoiceDecoder | null = null;
  private decoding: Promise<VoiceDecoder> | null = null;
  /** Start times (audio ms) waiting for their decoded PCM, in order (null: decode, then drop). */
  private times: (number | null)[] = [];
  /** Levels (and the frame, for bands()) by start time, for level(). */
  private levels: { at: number; level: number; pcm: Float32Array }[] = [];
  /** bands(): the frame last analysed, and its bands. */
  private bandsFor: Float32Array | null = null;
  private bandsOut: Float32Array | null = null;
  private lastSeq: number | null = null;
  /** Audio ms the last scheduled frame ends; the talker reads as talking until then. */
  endsAt = 0;
  /** Local ms of the last packet (a spurt with no VF_END ends after a pause). */
  lastPacket = 0;
  open = false;
  /** Dev only (the local proof): every decoded frame, before it's scheduled. */
  tap: ((pcm: Float32Array) => void) | null = null;

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
  ) {
    this.gain = ctx.createGain();
    this.gain.connect(out);
  }

  private nowMs(): number {
    return this.ctx.currentTime * 1000;
  }

  /** A VOICE_DOWN for this talker. */
  push(p: VoiceDown): void {
    this.lastPacket = performance.now();
    let start = (p.flags & VF_START) !== 0 || !this.open;
    let lost = 0;
    if (this.lastSeq !== null && !start) {
      const gap = (p.seq - this.lastSeq - 1) & 0xffff;
      if (!seqAfter(p.seq, this.lastSeq)) return; // a repeat (never on TCP, but cheap to refuse)
      if (gap > MAX_LOST_PACKETS) start = true;
      else lost = gap * VOICE_FRAMES_PER_PACKET;
    }
    this.lastSeq = p.seq;
    this.open = true;
    const times = this.playout.arrive(this.nowMs(), p.frames.length, start, lost);
    // (A lost stretch stays silent: the playout kept its time. WebCodecs has no concealment call to fill it.)
    const dec = this.dec;
    for (let i = 0; i < p.frames.length; i++) {
      this.times.push(times[i]);
      if (dec) dec.decode(p.frames[i]);
      else this.queueDecode(p.frames[i]);
    }
    if (p.flags & VF_END) this.finish();
  }

  /** The spurt is over (VF_END, a pause, the talker left). */
  finish(): void {
    this.open = false;
    this.lastSeq = null;
    this.playout.end();
  }

  /** The frame playing at this moment, if any. */
  private playingNow(): { at: number; level: number; pcm: Float32Array } | null {
    const now = this.nowMs();
    while (this.levels.length && this.levels[0].at + VOICE_FRAME_MS <= now) this.levels.shift();
    const f = this.levels[0];
    return f && f.at <= now ? f : null;
  }

  /** The talker's level now (0..1): the frame playing at this moment. */
  level(): number {
    return this.playingNow()?.level ?? 0;
  }

  /**
   * The frequency bands of the frame playing now into `out` (8 to 16, 0..1, low to high; voice/spectrum.ts); false and
   * zeros when nothing plays. Each frame is analysed once, when first asked for.
   */
  bands(out: Float32Array): boolean {
    const f = this.playingNow();
    if (!f) return (out.fill(0), false);
    if (this.bandsFor !== f.pcm || this.bandsOut?.length !== out.length) {
      this.bandsOut = this.bandsOut?.length === out.length ? this.bandsOut : new Float32Array(out.length);
      bandsOf(f.pcm, this.bandsOut);
      this.bandsFor = f.pcm;
    }
    out.set(this.bandsOut);
    return true;
  }

  /** Audible now or soon (queued frames left). */
  get talking(): boolean {
    return this.open || this.endsAt > this.nowMs();
  }

  setVolume(v: number): void {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  close(): void {
    this.dec?.close();
    this.dec = null;
    this.gain.disconnect();
  }

  /** The decoder is made on the first packet; frames before it's ready wait for it in order. */
  private pendingFrames: Uint8Array[] = [];
  private queueDecode(frame: Uint8Array): void {
    this.pendingFrames.push(frame.slice());
    this.decoding ??= createDecoder().then((d) => {
      d.onPcm = (pcm) => this.play(pcm);
      this.dec = d;
      for (const f of this.pendingFrames.splice(0)) d.decode(f);
      return d;
    });
  }

  private play(pcm: Float32Array): void {
    this.tap?.(pcm);
    let at = this.times.shift();
    if (at === undefined || at === null) return;
    const now = this.nowMs();
    // Decoding took longer than the margin: play it now rather than not at all.
    if (at < now + 2) at = now + 2;
    const buf = this.ctx.createBuffer(1, pcm.length || VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(at / 1000);
    this.endsAt = Math.max(this.endsAt, at + (pcm.length / VOICE_SAMPLE_RATE) * 1000);
    this.levels.push({ at, level: levelOf(pcm), pcm });
    if (this.levels.length > 64) this.levels.shift();
  }
}
