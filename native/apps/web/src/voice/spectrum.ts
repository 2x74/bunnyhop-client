// Frequency bands of one 20 ms voice frame, for the talker list's meter (voice/hud.ts). Computed on demand: the HUD
// asks for the frame playing now (voice/playback.ts) or your latest microphone frame, at most once per frame, so a talker
// nobody draws costs nothing. A 1024-point FFT (the 960-sample frame, Hann window, zero padded), its power summed into
// log-spaced bands between BAND_LO and BAND_HI, each mapped to 0..1 on the same dB scale as codec.ts levelOf.

import { VOICE_SAMPLE_RATE } from "../net/voice-wire";

const N = 1024;
const BAND_LO = 80;
const BAND_HI = 8000;
/** dB range mapped to 0..1 (a band's power relative to a full-scale sine filling it). */
const FLOOR_DB = -70;
const TOP_DB = -10;

const re = new Float32Array(N);
const im = new Float32Array(N);
const win = new Float32Array(N);
const rev = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  rev[i] = r;
}
let winLen = 0;
const edges = new Map<number, Uint16Array>();

/** Bin edges for `n` bands, log spaced. */
function bandEdges(n: number): Uint16Array {
  let e = edges.get(n);
  if (e) return e;
  e = new Uint16Array(n + 1);
  const hz = VOICE_SAMPLE_RATE / N;
  for (let i = 0; i <= n; i++) e[i] = Math.max(1, Math.round((BAND_LO * Math.pow(BAND_HI / BAND_LO, i / n)) / hz));
  for (let i = 1; i <= n; i++) if (e[i] <= e[i - 1]) e[i] = e[i - 1] + 1;
  edges.set(n, e);
  return e;
}

function fft(): void {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      const t = re[i];
      re[i] = re[j];
      re[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k);
      const wi = Math.sin(step * k);
      for (let i = k; i < N; i += size) {
        const j = i + half;
        const tr = wr * re[j] - wi * im[j];
        const ti = wr * im[j] + wi * re[j];
        re[j] = re[i] - tr;
        im[j] = im[i] - ti;
        re[i] += tr;
        im[i] += ti;
      }
    }
  }
}

/** Fills `out` (8 to 16 bands, low to high) from `pcm` (one frame, -1..1). */
export function bandsOf(pcm: Float32Array, out: Float32Array): void {
  const len = Math.min(pcm.length, N);
  if (winLen !== len) {
    for (let i = 0; i < len; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    winLen = len;
  }
  for (let i = 0; i < N; i++) {
    re[i] = i < len ? pcm[i] * win[i] : 0;
    im[i] = 0;
  }
  fft();
  const e = bandEdges(out.length);
  // A full-scale sine through the Hann window peaks at (len / 4)^2 power in its bin.
  const ref = (len / 4) * (len / 4);
  for (let b = 0; b < out.length; b++) {
    let p = 0;
    for (let k = e[b]; k < e[b + 1]; k++) p += re[k] * re[k] + im[k] * im[k];
    const db = 10 * Math.log10(p / ref + 1e-12);
    out[b] = Math.max(0, Math.min(1, (db - FLOOR_DB) / (TOP_DB - FLOOR_DB)));
  }
}
