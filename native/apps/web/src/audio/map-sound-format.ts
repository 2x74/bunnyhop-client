// What a map's sound file is, read from its bytes: the WAV chunks and the MP3 frames that Source itself goes by. Used in
// game (loop points) and by the scan that decides which files may play (tools/map-sounds/). No DOM, no WebAudio.
//
// Source loops a WAV only when the file says so: a `cue ` chunk (or a `smpl` loop), read by CAudioSource::ParseChunk /
// GetStartupData. The looped flag on ambient_generic is something else: it only says whether the entity counts as on.
// An MP3 has nowhere to put a loop point and never loops.

export type SoundFormat = "wav" | "mp3" | "other";

/** c_soundscape.cpp interval_t: start and range, a value drawn from start .. start + range. */
export type Interval = [number, number];

/** A soundscript entry (`scripts/game_sounds*.txt`, `maps/<map>_level_sounds.txt`). */
export interface SoundscriptEntry {
  waves: string[];
  volume: Interval;
  pitch: Interval;
  level?: Interval;
}

/** One soundscape script, in the terms of C_SoundscapeSystem (scripts/soundscapes_*.txt). Paths are `sound/...`. */
export interface Soundscape {
  loops: { wave: string; volume: Interval; pitch: Interval; position?: number; level?: Interval }[];
  randoms: { waves: string[]; time: Interval; volume: Interval; pitch: Interval; level?: Interval; position?: number | "random" }[];
  subs: { name: string; volume: Interval; position?: number; positionOverride?: number; ambientOverride?: number }[];
}

export interface SoundInfo {
  format: SoundFormat;
  /** WAVE format tag: 1 PCM, 2 MS ADPCM, 3 float, 85 MP3-in-WAV, ... (0 when not a WAV). */
  codec: number;
  channels: number;
  rate: number;
  bits: number;
  /** Seconds (estimated from the frames for an MP3). */
  duration: number;
  /** Byte range of the audio inside the file. */
  dataStart: number;
  dataLength: number;
  /** Frames in the data (0 when not known). */
  frames: number;
  /** Loop start in frames, -1 when the file doesn't loop. */
  loopStart: number;
  /** Loop end in frames, -1 for the end of the file. */
  loopEnd: number;
  /** Block size for ADPCM. */
  blockAlign: number;
  samplesPerBlock: number;
  /** MS ADPCM coefficient table. */
  coefs?: [number, number][];
  /** Mean bit rate in kbit/s (MP3). */
  kbps: number;
  /** Metadata tags (ID3, LIST/INFO): upper-case key -> text. */
  tags: Record<string, string>;
}

const empty = (): SoundInfo => ({ format: "other", codec: 0, channels: 0, rate: 0, bits: 0, duration: 0, dataStart: 0, dataLength: 0, frames: 0, loopStart: -1, loopEnd: -1, blockAlign: 0, samplesPerBlock: 0, kbps: 0, tags: {} });

const ascii = (b: Uint8Array, at: number, n: number) => {
  let s = "";
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
};

const textOf = (b: Uint8Array) => {
  let e = b.length;
  while (e > 0 && (b[e - 1] === 0 || b[e - 1] === 32)) e--;
  return new TextDecoder("latin1").decode(b.subarray(0, e));
};

/** Reads a WAV's chunks. Tolerant of truncated files and junk between chunks (mappers' tools write all kinds). */
export function parseWav(b: Uint8Array): SoundInfo {
  const out = empty();
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return out;
  out.format = "wav";
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  let cueFirst = -1;
  let cueId = -1;
  let ltxtLength = -1;
  let smplStart = -1;
  let smplEnd = -1;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const len = v.getUint32(p + 4, true);
    const body = p + 8;
    const end = Math.min(body + len, b.length);
    if (id === "fmt " && end - body >= 16) {
      out.codec = v.getUint16(body, true);
      out.channels = v.getUint16(body + 2, true);
      out.rate = v.getUint32(body + 4, true);
      out.blockAlign = v.getUint16(body + 12, true);
      out.bits = v.getUint16(body + 14, true);
      if (out.codec === 2 && end - body >= 22) {
        out.samplesPerBlock = v.getUint16(body + 18, true);
        const n = v.getUint16(body + 20, true);
        if (end - body >= 22 + n * 4) {
          out.coefs = [];
          for (let i = 0; i < n; i++) out.coefs.push([v.getInt16(body + 22 + i * 4, true), v.getInt16(body + 24 + i * 4, true)]);
        }
      }
    } else if (id === "data") {
      out.dataStart = body;
      out.dataLength = end - body;
    } else if (id === "cue " && end - body >= 4) {
      const n = v.getUint32(body, true);
      // CAudioSource: the first cue point is the loop start.
      if (n > 0 && end - body >= 4 + 24) {
        cueId = v.getUint32(body + 4, true);
        cueFirst = v.getUint32(body + 4 + 20, true);
      }
    } else if (id === "smpl" && end - body >= 36) {
      const n = v.getUint32(body + 28, true);
      if (n > 0 && end - body >= 36 + 24) {
        smplStart = v.getUint32(body + 36 + 8, true);
        smplEnd = v.getUint32(body + 36 + 12, true);
      }
    } else if (id === "LIST" && end - body >= 4) {
      const kind = ascii(b, body, 4);
      let q = body + 4;
      while (q + 8 <= end) {
        const sub = ascii(b, q, 4);
        const sl = v.getUint32(q + 4, true);
        const se = Math.min(q + 8 + sl, end);
        if (kind === "INFO") {
          const t = textOf(b.subarray(q + 8, se));
          if (t) out.tags[sub] = t;
        } else if (kind === "adtl" && sub === "ltxt" && se - (q + 8) >= 8) {
          if (v.getUint32(q + 8, true) === cueId) ltxtLength = v.getUint32(q + 12, true);
        }
        q = q + 8 + sl + (sl & 1);
      }
    } else if (id === "id3 " || id === "ID3 ") {
      Object.assign(out.tags, parseId3(b.subarray(body, end)));
    }
    if (len === 0 && id !== "data" && id !== "LIST" && id !== "cue ") {
      p = body;
      continue;
    }
    p = body + len + (len & 1);
  }
  if (out.dataLength && out.channels) {
    if (out.codec === 2 && out.blockAlign && out.samplesPerBlock) {
      const blocks = Math.floor(out.dataLength / out.blockAlign);
      out.frames = blocks * out.samplesPerBlock;
    } else if (out.bits) {
      out.frames = Math.floor(out.dataLength / ((out.channels * out.bits) / 8));
    } else if (out.codec === 85 && out.rate) {
      const f = mp3FrameScan(b.subarray(out.dataStart, out.dataStart + out.dataLength));
      out.duration = f.seconds;
      out.kbps = f.kbps;
      out.frames = Math.round(f.seconds * out.rate);
    }
    if (out.rate && out.frames && !out.duration) out.duration = out.frames / out.rate;
  }
  if (cueFirst >= 0) {
    out.loopStart = cueFirst;
    if (ltxtLength > 0) out.loopEnd = cueFirst + ltxtLength;
  } else if (smplStart >= 0) {
    out.loopStart = smplStart;
    out.loopEnd = smplEnd > smplStart ? smplEnd + 1 : -1;
  }
  return out;
}

function syncsafe(b: Uint8Array, at: number): number {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}

function id3Text(b: Uint8Array): string {
  if (!b.length) return "";
  const enc = b[0];
  const body = b.subarray(1);
  let s = "";
  try {
    s = new TextDecoder(enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : enc === 3 ? "utf-8" : "latin1").decode(body);
  } catch {
    s = new TextDecoder("latin1").decode(body);
  }
  return s.replace(/\0+/g, " ").trim();
}

const ID3_NAMES: Record<string, string> = { TIT2: "TITLE", TT2: "TITLE", TPE1: "ARTIST", TP1: "ARTIST", TPE2: "ALBUMARTIST", TP2: "ALBUMARTIST", TALB: "ALBUM", TAL: "ALBUM", TCON: "GENRE", TCO: "GENRE", TYER: "YEAR", TYE: "YEAR", TDRC: "YEAR", TRCK: "TRACK", TRK: "TRACK", TCOP: "COPYRIGHT", TCR: "COPYRIGHT", TSSE: "ENCODER", TEN: "ENCODER", TENC: "ENCODER", TCOM: "COMPOSER", TCM: "COMPOSER" };

/** ID3v2 text frames (v2.2 to v2.4). */
export function parseId3(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (b.length < 10 || ascii(b, 0, 3) !== "ID3") return out;
  const ver = b[3];
  const size = syncsafe(b, 6);
  let p = 10;
  if (b[5] & 0x40 && ver >= 3) p += ver === 4 ? syncsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4;
  const end = Math.min(10 + size, b.length);
  while (p + (ver === 2 ? 6 : 10) <= end) {
    if (b[p] === 0) break;
    const id = ascii(b, p, ver === 2 ? 3 : 4);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const len = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    const head = ver === 2 ? 6 : 10;
    const name = ID3_NAMES[id];
    if (name && len > 0) {
      const t = id3Text(b.subarray(p + head, Math.min(p + head + len, end)));
      if (t) out[name] = t;
    }
    if (len <= 0) break;
    p += head + len;
  }
  return out;
}

/** ID3v1 trailer. */
function parseId3v1(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (b.length < 128 || ascii(b, b.length - 128, 3) !== "TAG") return out;
  const at = b.length - 128;
  const f = (o: number, n: number) => textOf(b.subarray(at + o, at + o + n));
  if (f(3, 30)) out.TITLE = f(3, 30);
  if (f(33, 30)) out.ARTIST = f(33, 30);
  if (f(63, 30)) out.ALBUM = f(63, 30);
  if (f(93, 4)) out.YEAR = f(93, 4);
  return out;
}

const MP3_BITRATE = [
  // MPEG1 layer 3, MPEG2 layer 3
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
];
const MP3_RATE = [
  [44100, 48000, 32000, 0],
  [22050, 24000, 16000, 0],
  [11025, 12000, 8000, 0],
];

function mp3FrameScan(b: Uint8Array): { seconds: number; kbps: number; rate: number; channels: number } {
  let p = 0;
  let frames = 0;
  let bits = 0;
  let seconds = 0;
  let rate = 0;
  let channels = 0;
  const limit = b.length - 4;
  while (p < limit) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) {
      p++;
      continue;
    }
    const verBits = (b[p + 1] >> 3) & 3;
    const layer = (b[p + 1] >> 1) & 3;
    const brI = b[p + 2] >> 4;
    const srI = (b[p + 2] >> 2) & 3;
    const pad = (b[p + 2] >> 1) & 1;
    if (verBits === 1 || layer !== 1 || brI === 0 || brI === 15 || srI === 3) {
      p++;
      continue;
    }
    const mpeg1 = verBits === 3;
    const kb = MP3_BITRATE[mpeg1 ? 0 : 1][brI];
    const r = MP3_RATE[verBits === 3 ? 0 : verBits === 2 ? 1 : 2][srI];
    const samples = mpeg1 ? 1152 : 576;
    const size = Math.floor(((samples / 8) * kb * 1000) / r) + pad;
    if (size < 4) {
      p++;
      continue;
    }
    if (!rate) {
      rate = r;
      channels = (b[p + 3] >> 6) === 3 ? 1 : 2;
    }
    frames++;
    bits += kb;
    seconds += samples / r;
    p += size;
  }
  return { seconds, kbps: frames ? bits / frames : 0, rate, channels };
}

export function parseMp3(b: Uint8Array): SoundInfo {
  const out = empty();
  out.format = "mp3";
  out.tags = { ...parseId3v1(b), ...parseId3(b) };
  let start = 0;
  if (ascii(b, 0, 3) === "ID3") start = 10 + syncsafe(b, 6);
  const scan = mp3FrameScan(b.subarray(start));
  out.duration = scan.seconds;
  out.kbps = scan.kbps;
  out.rate = scan.rate;
  out.channels = scan.channels;
  out.dataStart = start;
  out.dataLength = b.length - start;
  out.frames = Math.round(scan.seconds * scan.rate);
  return out;
}

export function parseSound(name: string, b: Uint8Array): SoundInfo {
  if (ascii(b, 0, 4) === "RIFF") return parseWav(b);
  if (name.endsWith(".mp3") || ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return parseMp3(b);
  return empty();
}

/**
 * Source's sound-character prefixes on a sound name: `*` stream, `#` no DSP, `@` omni, `)` `(` `^` `<` `>` `!` `?` `&`
 * `~` `$` `+` routing. They aren't part of the file's name.
 */
export function stripSoundChars(name: string): string {
  let i = 0;
  while (i < name.length && "*#@)(^<>!?&~$+%}".includes(name[i])) i++;
  return name.slice(i);
}

/** `sound/<lower/case/forward/slash>`. */
export function soundPath(name: string): string {
  const n = stripSoundChars(name.trim()).replaceAll("\\", "/").toLowerCase().replace(/^\/+/, "");
  return n.startsWith("sound/") ? n : `sound/${n}`;
}

/** A file name rather than a soundscript entry (scripted names have no extension). */
export function isSoundFileName(name: string): boolean {
  return /\.(wav|mp3|ogg|flac)$/i.test(name.trim());
}

// -------------------------------------------------------------------------------------------------
// The pakfile (a zip, stored entries)

export interface PakEntry {
  /** Lower-case, forward slashes. */
  name: string;
  method: number;
  size: number;
  offset: number;
}

/** The zip's central directory. */
export function zipEntries(zip: Uint8Array): PakEntry[] {
  if (zip.length < 22) return [];
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: PakEntry[] = [];
  const dec = new TextDecoder("latin1");
  for (let i = 0; i < count && p + 46 <= zip.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    out.push({ name: dec.decode(zip.subarray(p + 46, p + 46 + nameLen)).replaceAll("\\", "/").toLowerCase(), method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Entry bytes (a view of `zip`), or null for a compressed or broken entry. */
export function zipStored(zip: Uint8Array, e: PakEntry): Uint8Array | null {
  if (e.method !== 0) return null;
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (e.offset + 30 > zip.length || v.getUint32(e.offset, true) !== 0x04034b50) return null;
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  if (start + e.size > zip.length) return null;
  return zip.subarray(start, start + e.size);
}

// -------------------------------------------------------------------------------------------------
// Samples

/** MS ADPCM adaptation table (the WAVE format 2 spec). */
const ADPCM_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const ADPCM_COEFS: [number, number][] = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];

/**
 * Decodes the PCM, float and MS ADPCM WAVs Source plays into one Float32Array per channel. Browsers' own WAV decoders
 * don't all take ADPCM and fail on mappers' odd chunks, so an MP3 is the only thing that goes through decodeAudioData.
 */
export function decodeWavSamples(b: Uint8Array, i: SoundInfo): Float32Array[] | null {
  const ch = i.channels;
  if (!ch || ch > 2 || !i.dataLength) return null;
  const v = new DataView(b.buffer, b.byteOffset + i.dataStart, i.dataLength);
  if (i.codec === 2) return decodeAdpcm(v, i);
  const bytes = i.bits >> 3;
  if (!bytes) return null;
  const frames = Math.floor(i.dataLength / (bytes * ch));
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  let p = 0;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++, p += bytes) {
      let s: number;
      if (i.codec === 3) s = i.bits === 32 ? v.getFloat32(p, true) : i.bits === 64 ? v.getFloat64(p, true) : 0;
      else if (i.bits === 8) s = (v.getUint8(p) - 128) / 128;
      else if (i.bits === 16) s = v.getInt16(p, true) / 32768;
      else if (i.bits === 24) s = ((v.getInt8(p + 2) << 16) | v.getUint16(p, true)) / 8388608;
      else if (i.bits === 32) s = v.getInt32(p, true) / 2147483648;
      else return null;
      out[c][f] = s;
    }
  }
  return out;
}

function decodeAdpcm(v: DataView, i: SoundInfo): Float32Array[] | null {
  const ch = i.channels;
  const block = i.blockAlign;
  const per = i.samplesPerBlock;
  if (!block || !per) return null;
  const coefs = i.coefs?.length ? i.coefs : ADPCM_COEFS;
  const blocks = Math.floor(v.byteLength / block);
  const out = Array.from({ length: ch }, () => new Float32Array(blocks * per));
  const pred = new Int32Array(ch);
  const delta = new Int32Array(ch);
  const s1 = new Int32Array(ch);
  const s2 = new Int32Array(ch);
  for (let n = 0; n < blocks; n++) {
    let p = n * block;
    for (let c = 0; c < ch; c++) pred[c] = Math.min(v.getUint8(p++), coefs.length - 1);
    for (let c = 0; c < ch; c++, p += 2) delta[c] = v.getInt16(p, true);
    for (let c = 0; c < ch; c++, p += 2) s1[c] = v.getInt16(p, true);
    for (let c = 0; c < ch; c++, p += 2) s2[c] = v.getInt16(p, true);
    const base = n * per;
    for (let c = 0; c < ch; c++) {
      out[c][base] = s2[c] / 32768;
      if (per > 1) out[c][base + 1] = s1[c] / 32768;
    }
    let nib = 0;
    const end = (n + 1) * block;
    for (let f = 2; f < per; f++) {
      for (let c = 0; c < ch; c++) {
        if (p >= end) return out;
        const byte = v.getUint8(p);
        const raw = nib === 0 ? byte >> 4 : byte & 15;
        if (nib === 1) p++;
        nib ^= 1;
        const signed = raw >= 8 ? raw - 16 : raw;
        const [c1, c2] = coefs[pred[c]];
        let sample = ((s1[c] * c1 + s2[c] * c2) >> 8) + signed * delta[c];
        sample = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
        s2[c] = s1[c];
        s1[c] = sample;
        delta[c] = Math.max(16, (ADPCM_ADAPT[raw] * delta[c]) >> 8);
        out[c][base + f] = sample / 32768;
      }
    }
  }
  return out;
}
