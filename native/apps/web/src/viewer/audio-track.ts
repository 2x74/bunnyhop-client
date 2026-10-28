// The MP4 export's audio track: an offline-mixed AudioBuffer (audio/replay.ts renderReplayAudio) encoded with
// WebCodecs AudioEncoder and handed to the muxer (viewer/mp4.ts). Ported from the Aimperion exporter
// (src/replay/audio-track.js): AAC where the platform has an encoder (Windows, macOS, ChromeOS), Opus otherwise (Linux
// Chromium has no AAC encoder; MP4 with Opus plays in browsers, VLC, Discord). A browser with neither gets a silent
// video rather than no video.

import type { Mp4Muxer } from "./mp4";

const CODECS = [
  { id: "aac" as const, codec: "mp4a.40.2", frame: 1024 },
  { id: "opus" as const, codec: "opus", frame: 960 },
];

export type AudioCodecChoice = (typeof CODECS)[number];

/** The first codec this browser can encode at `rate` / `channels`, or null. */
export async function pickAudioCodec(rate: number, channels: number): Promise<AudioCodecChoice | null> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
  for (const c of CODECS) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: rate, numberOfChannels: channels, bitrate: 160_000 });
      if (s.supported) return c;
    } catch {
      /* unknown codec string in some browsers: next */
    }
  }
  return null;
}

/** Peak-normalises to a ceiling below full scale (AAC decoders overshoot samples sitting at 1.0: crackle). */
function ceiling(buf: AudioBuffer, max = 0.89): Float32Array[] {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > max) {
    const k = max / peak;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
  }
  return chans;
}

/**
 * Encodes `buf` into the muxer's audio track. Returns the codec used, or null (no encoder / failure: nothing is
 * written, the video stays silent).
 */
export async function encodeAudioTrack(buf: AudioBuffer, muxer: Mp4Muxer, cancelled: () => boolean = () => false): Promise<string | null> {
  const rate = buf.sampleRate;
  const channels = buf.numberOfChannels;
  const choice = await pickAudioCodec(rate, channels);
  if (!choice) return null;
  const pcm = ceiling(buf);
  let described = false;
  let failed: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (!described && (meta?.decoderConfig?.description || choice.id === "opus")) {
        const desc = meta?.decoderConfig?.description;
        const bytes = !desc ? null : ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice() : new Uint8Array(desc as ArrayBuffer).slice();
        muxer.setAudioDescription(bytes, { sampleRate: rate, channels, codec: choice.id });
        described = true;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addAudioSample(data, chunk.duration ? Math.round((chunk.duration * rate) / 1e6) : choice.frame);
    },
    error: (e) => (failed = e),
  });
  encoder.configure({ codec: choice.codec, sampleRate: rate, numberOfChannels: channels, bitrate: 160_000 });
  const FRAME = 1024;
  for (let off = 0; off < buf.length && !failed; off += FRAME) {
    if (cancelled()) break;
    const n = Math.min(FRAME, buf.length - off);
    // Planar: channel 0's n samples, then channel 1's.
    const planar = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) planar.set(pcm[c].subarray(off, off + n), c * n);
    const data = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((off / rate) * 1e6), data: planar });
    encoder.encode(data);
    data.close();
    if ((off / FRAME) % 64 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  try {
    await encoder.flush();
  } catch {
    /* reported through `failed` */
  }
  try {
    encoder.close();
  } catch {
    /* closed */
  }
  if (failed || !described || cancelled()) {
    muxer.clearAudio();
    return null;
  }
  return choice.id;
}
