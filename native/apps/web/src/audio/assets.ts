// The shipped audio files (src/assets/audio, written by tools/audio/process.ts) and their manifest.
//
// Every file exists twice: Opus in WebM (Chrome, Firefox, Edge, recent Safari) and AAC in M4A (older Safari). The
// browser picks one format (canPlayType) and only downloads that; a file that fails to decode is retried in the other.
// Globbed (not imported by name) so a missing manifest or file is a silent gap, never a build error.

export interface SfxEntry {
  variants: number;
  durations: number[];
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
}

export interface MusicEntry {
  id: string;
  title: string;
  role: "menu" | "game";
  duration: number;
  bpm?: number;
  loopStart?: number;
  loopEnd?: number;
  credit: string;
}

export interface AudioManifest {
  sfx: Record<string, SfxEntry>;
  music: MusicEntry[];
  credits: string[];
}

const manifests = import.meta.glob("../assets/audio/manifest.json", { eager: true, import: "default" }) as Record<string, AudioManifest>;
const urls = import.meta.glob("../assets/audio/**/*.{webm,m4a}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export const manifest: AudioManifest = Object.values(manifests)[0] ?? { sfx: {}, music: [], credits: [] };

export type AudioFormat = "webm" | "m4a";

let preferred: AudioFormat | null = null;
/** WebM/Opus where the browser says it can play it, else M4A/AAC. */
export function preferredFormat(): AudioFormat {
  if (preferred) return preferred;
  let ok = "";
  try {
    ok = typeof Audio !== "undefined" ? new Audio().canPlayType('audio/webm; codecs="opus"') : "";
  } catch {
    /* no media element (workers, tests) */
  }
  preferred = ok === "probably" || ok === "maybe" ? "webm" : "m4a";
  return preferred;
}

export const otherFormat = (f: AudioFormat): AudioFormat => (f === "webm" ? "m4a" : "webm");

/** URL of `sfx/<id>-<n>` or `music/<id>` in a format, or null if it isn't shipped. */
export function assetUrl(path: string, format: AudioFormat = preferredFormat()): string | null {
  return urls[`../assets/audio/${path}.${format}`] ?? urls[`../assets/audio/${path}.${otherFormat(format)}`] ?? null;
}

export function sfxPath(id: string, variant: number): string {
  return `sfx/${id}-${variant + 1}`;
}

export function musicPath(id: string): string {
  return `music/${id}`;
}
