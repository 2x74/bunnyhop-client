// Opus for voice chat: 48 kHz mono, 20 ms frames, ~24 kbit/s VBR (net/voice-wire.ts). WebCodecs' AudioEncoder /
// AudioDecoder where the browser has them (Chrome, Edge, Firefox, Safari 26), else libopus built to WebAssembly
// (libopus-wasm, loaded on first use: a separate chunk nobody downloads until their browser needs it). Both sides make
// raw Opus packets (no Ogg), so a WebCodecs talker and a WASM listener understand each other, and so does native
// libopus (docs/client/voice.md).

import { VOICE_BITRATE, VOICE_FRAME_MS, VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from "../net/voice-wire";

export interface VoiceEncoder {
  readonly kind: "webcodecs" | "wasm";
  /** One frame: VOICE_FRAME_SAMPLES samples at 48 kHz. Packets come out through onPacket, in order. */
  encode(pcm: Float32Array): void;
  /** Pushes out whatever the encoder still holds (the last frame before a release). */
  flush(): Promise<void>;
  close(): void;
  onPacket: (bytes: Uint8Array) => void;
}

export interface VoiceDecoder {
  readonly kind: "webcodecs" | "wasm";
  /** One packet; null = a lost packet (concealment where the decoder can). PCM comes out through onPcm, in order. */
  decode(bytes: Uint8Array | null): void;
  close(): void;
  onPcm: (pcm: Float32Array) => void;
}

type G = typeof globalThis & { AudioEncoder?: typeof AudioEncoder; AudioDecoder?: typeof AudioDecoder; AudioData?: typeof AudioData; EncodedAudioChunk?: typeof EncodedAudioChunk };
const g = globalThis as G;

const ENC_CONFIG = (): AudioEncoderConfig => ({
  codec: "opus",
  sampleRate: VOICE_SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: VOICE_BITRATE,
  bitrateMode: "variable",
  opus: { format: "opus", frameDuration: VOICE_FRAME_MS * 1000, complexity: 5, usedtx: false, useinbandfec: false },
} as AudioEncoderConfig);
const DEC_CONFIG: AudioDecoderConfig = { codec: "opus", sampleRate: VOICE_SAMPLE_RATE, numberOfChannels: 1 };

let encOk: Promise<boolean> | null = null;
let decOk: Promise<boolean> | null = null;
/** Tests / the local proof can force the WASM path (?voicecodec=wasm). */
const forceWasm = () => typeof location !== "undefined" && new URLSearchParams(location.search).get("voicecodec") === "wasm";

function webEncoderOk(): Promise<boolean> {
  return (encOk ??= (async () => {
    if (forceWasm() || !g.AudioEncoder || !g.AudioData) return false;
    try {
      return !!(await g.AudioEncoder.isConfigSupported(ENC_CONFIG())).supported;
    } catch {
      return false;
    }
  })());
}

function webDecoderOk(): Promise<boolean> {
  return (decOk ??= (async () => {
    if (forceWasm() || !g.AudioDecoder || !g.EncodedAudioChunk) return false;
    try {
      return !!(await g.AudioDecoder.isConfigSupported(DEC_CONFIG)).supported;
    } catch {
      return false;
    }
  })());
}

let wasm: Promise<typeof import("libopus-wasm")> | null = null;
const loadWasm = () => (wasm ??= import("libopus-wasm"));

export async function createEncoder(): Promise<VoiceEncoder> {
  if (await webEncoderOk()) return webEncoder();
  return wasmEncoder();
}

export async function createDecoder(): Promise<VoiceDecoder> {
  if (await webDecoderOk()) return webDecoder();
  return wasmDecoder();
}

/** Which codec path this browser takes (settings readout, the proof's report). */
export async function codecPath(): Promise<{ encode: "webcodecs" | "wasm"; decode: "webcodecs" | "wasm" }> {
  return { encode: (await webEncoderOk()) ? "webcodecs" : "wasm", decode: (await webDecoderOk()) ? "webcodecs" : "wasm" };
}

function webEncoder(): VoiceEncoder {
  let ts = 0;
  const e: VoiceEncoder = {
    kind: "webcodecs",
    onPacket: () => {},
    encode(pcm) {
      const data = new g.AudioData!({ format: "f32-planar", sampleRate: VOICE_SAMPLE_RATE, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: ts, data: pcm as Float32Array<ArrayBuffer> });
      ts += (pcm.length / VOICE_SAMPLE_RATE) * 1e6;
      try {
        enc.encode(data);
      } finally {
        data.close();
      }
    },
    flush: () => (enc.state === "configured" ? enc.flush().catch(() => undefined) : Promise.resolve()),
    close: () => {
      if (enc.state !== "closed") enc.close();
    },
  };
  const enc = new g.AudioEncoder!({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      e.onPacket(b);
    },
    error: (err) => console.warn("[voice] encoder:", err),
  });
  enc.configure(ENC_CONFIG());
  return e;
}

function webDecoder(): VoiceDecoder {
  let ts = 0;
  const frameUs = VOICE_FRAME_MS * 1000;
  const d: VoiceDecoder = {
    kind: "webcodecs",
    onPcm: () => {},
    decode(bytes) {
      ts += frameUs;
      // WebCodecs has no loss call: a lost frame is a gap the jitter buffer fills with silence.
      if (!bytes || dec.state !== "configured") return;
      dec.decode(new g.EncodedAudioChunk!({ type: "key", timestamp: ts, data: bytes as Uint8Array<ArrayBuffer> }));
    },
    close: () => {
      if (dec.state !== "closed") dec.close();
    },
  };
  const dec = new g.AudioDecoder!({
    output: (ad) => {
      try {
        const n = ad.numberOfFrames;
        const out = new Float32Array(n);
        try {
          ad.copyTo(out, { planeIndex: 0, format: "f32-planar" });
        } catch {
          ad.copyTo(out, { planeIndex: 0 });
        }
        d.onPcm(ad.sampleRate === VOICE_SAMPLE_RATE ? out : resample(out, ad.sampleRate, VOICE_SAMPLE_RATE));
      } finally {
        ad.close();
      }
    },
    error: (err) => console.warn("[voice] decoder:", err),
  });
  dec.configure(DEC_CONFIG);
  return d;
}

async function wasmEncoder(): Promise<VoiceEncoder> {
  const lib = await loadWasm();
  const enc = await lib.createEncoder({ sampleRate: VOICE_SAMPLE_RATE, channels: 1, application: lib.Application.Voip, bitrate: VOICE_BITRATE, frameSize: VOICE_FRAME_SAMPLES, complexity: 5, vbr: true });
  let closed = false;
  const e: VoiceEncoder = {
    kind: "wasm",
    onPacket: () => {},
    encode(pcm) {
      if (closed) return;
      // libopus copies the result out of its heap: the packet is ours to keep.
      e.onPacket(enc.encodeFloat(pcm));
    },
    flush: () => Promise.resolve(),
    close: () => {
      if (!closed) (closed = true), enc.free();
    },
  };
  return e;
}

async function wasmDecoder(): Promise<VoiceDecoder> {
  const lib = await loadWasm();
  const dec = await lib.createDecoder({ sampleRate: VOICE_SAMPLE_RATE, channels: 1 });
  let closed = false;
  const d: VoiceDecoder = {
    kind: "wasm",
    onPcm: () => {},
    decode(bytes) {
      if (closed) return;
      try {
        d.onPcm(bytes ? dec.decodeFloat(bytes) : dec.decodePacketLossFloat(VOICE_FRAME_SAMPLES));
      } catch (err) {
        console.warn("[voice] decode:", err);
      }
    },
    close: () => {
      if (!closed) (closed = true), dec.free();
    },
  };
  return d;
}

/** Linear resampling, for a decoder or microphone at another rate (voice band: the encoder band-limits anyway). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k;
    const i0 = Math.floor(x);
    const t = x - i0;
    const a = input[Math.min(i0, input.length - 1)];
    const b = input[Math.min(i0 + 1, input.length - 1)];
    out[i] = a + (b - a) * t;
  }
  return out;
}

/** RMS level of a frame mapped to 0..1 for the HUD graph (speech peaks around -12 dBFS fill it). */
export function levelOf(pcm: Float32Array): number {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  const rms = Math.sqrt(e / Math.max(1, pcm.length));
  if (rms <= 1e-5) return 0;
  const db = 20 * Math.log10(rms);
  // -54 dBFS (room hiss) -> 0, -12 dBFS (loud speech) -> 1.
  return Math.max(0, Math.min(1, (db + 54) / 42));
}
