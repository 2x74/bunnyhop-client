// Minimal MP4 (ISO BMFF) muxer for one H.264 video track and an optional AAC / Opus audio track from WebCodecs.
//
// Ported from the Aimperion replay exporter (src/replay/mp4.js, incl. its audio track). WebCodecs configured with
// avc: { format: "avc" } hands over chunks that already are mp4 samples (length-prefixed NAL units) plus the avcC
// payload (SPS/PPS) as decoderConfig.description, so the muxer never parses H.264: it counts bytes, records
// durations and keyframes, and writes ftyp / mdat / moov (moov last: sizes are only known after encoding; fine for a
// downloaded file). One chunk per sample keeps stsc a single entry; a constant frame rate collapses stts to one entry.

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 255);

function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  let len = 8;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(ascii(type), 4);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const full = (type: string, version: number, flags: number, ...parts: (Uint8Array | number[])[]) =>
  box(type, [version & 255, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

/** Big tables (stsz / stco) without spreading huge arrays into a literal. */
function table(count: number, values: number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, count);
  values.forEach((v, i) => dv.setUint32(4 + i * 4, v));
  return out;
}

export class Mp4Muxer {
  private samples: Uint8Array<ArrayBuffer>[] = [];
  private sizes: number[] = [];
  private durations: number[] = [];
  private syncs: number[] = [];
  private description: Uint8Array | null = null;
  private bytes = 0;
  /** Optional audio track (viewer/audio-track.ts): its own clock (the sample rate), video first then audio in mdat. */
  private audio = {
    samples: [] as Uint8Array<ArrayBuffer>[],
    sizes: [] as number[],
    durations: [] as number[],
    bytes: 0,
    description: null as Uint8Array | null,
    sampleRate: 48000,
    channels: 2,
    codec: "aac" as "aac" | "opus",
  };

  constructor(
    readonly width: number,
    readonly height: number,
    /** Ticks per second; 90000 divides 30/60/120 fps exactly. */
    readonly timescale = 90000,
  ) {}

  setDescription(desc: AllowSharedBufferSource): void {
    this.description = desc instanceof Uint8Array ? desc.slice() : new Uint8Array(desc as ArrayBuffer).slice();
  }

  get hasDescription(): boolean {
    return this.description !== null;
  }

  addSample(data: Uint8Array<ArrayBuffer>, duration: number, key: boolean): void {
    this.samples.push(data);
    this.sizes.push(data.length);
    this.durations.push(Math.max(1, Math.round(duration)));
    if (key) this.syncs.push(this.samples.length);
    this.bytes += data.length;
  }

  get frameCount(): number {
    return this.samples.length;
  }

  /** One encoded audio frame; `duration` in samples (the audio track's timescale is its sample rate). */
  addAudioSample(data: Uint8Array<ArrayBuffer>, duration: number): void {
    const a = this.audio;
    a.samples.push(data);
    a.sizes.push(data.length);
    a.durations.push(Math.max(1, Math.round(duration)));
    a.bytes += data.length;
  }

  /**
   * Decoder config from the first audio chunk: the AudioSpecificConfig for AAC (required: the esds can't be written
   * without it), the OpusHead (or nothing: defaults) for Opus.
   */
  setAudioDescription(desc: Uint8Array | null, o: { sampleRate: number; channels: number; codec: "aac" | "opus" }): void {
    this.audio.description = desc;
    this.audio.sampleRate = o.sampleRate | 0;
    this.audio.channels = o.channels | 0;
    this.audio.codec = o.codec;
  }

  get hasAudio(): boolean {
    const a = this.audio;
    return a.samples.length > 0 && (a.description !== null || a.codec === "opus");
  }

  /** Drops a partial audio track (encoder failure): the video ships silent rather than out of sync. */
  clearAudio(): void {
    const a = this.audio;
    a.samples = [];
    a.sizes = [];
    a.durations = [];
    a.bytes = 0;
    a.description = null;
  }

  finalize(): Blob {
    if (!this.description) throw new Error("mp4: the encoder never reported a decoder description");
    if (!this.samples.length) throw new Error("mp4: no frames");
    const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    const withAudio = this.hasAudio;
    const mdatHeader = new Uint8Array([...u32(8 + this.bytes + (withAudio ? this.audio.bytes : 0)), ...ascii("mdat")]);
    const first = ftyp.length + mdatHeader.length;
    const total = this.durations.reduce((a, b) => a + b, 0);
    // Video first, then audio: one contiguous run each (a downloaded file, not a stream).
    const moov = this.moov(first, total, withAudio ? first + this.bytes : null);
    const parts = [ftyp, mdatHeader, ...this.samples, ...(withAudio ? this.audio.samples : []), moov] as Uint8Array<ArrayBuffer>[];
    return new Blob(parts, { type: "video/mp4" });
  }

  private moov(first: number, total: number, firstAudio: number | null): Uint8Array {
    const ts = this.timescale;
    const offsets: number[] = [];
    let at = first;
    for (const s of this.sizes) offsets.push(at), (at += s);
    const stts: [number, number][] = [];
    for (const d of this.durations) {
      const last = stts[stts.length - 1];
      if (last && last[1] === d) last[0]++;
      else stts.push([1, d]);
    }
    const unity = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    const mvhd = full("mvhd", 0, 0, [...u32(0), ...u32(0), ...u32(ts), ...u32(total), ...u32(0x00010000), ...u16(0x0100), ...u16(0), ...u32(0), ...u32(0), ...unity, ...new Array(24).fill(0), ...u32(firstAudio !== null ? 3 : 2)]);
    const tkhd = full("tkhd", 0, 3, [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(total), ...u32(0), ...u32(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...unity, ...u32(this.width << 16), ...u32(this.height << 16)]);
    const mdhd = full("mdhd", 0, 0, [...u32(0), ...u32(0), ...u32(ts), ...u32(total), ...u16(0x55c4), ...u16(0)]);
    const hdlr = full("hdlr", 0, 0, [...u32(0), ...ascii("vide"), ...u32(0), ...u32(0), ...u32(0), ...ascii("VideoHandler"), 0]);
    const avc1 = box(
      "avc1",
      [
        ...new Array(6).fill(0), ...u16(1),
        ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0),
        ...u16(this.width), ...u16(this.height),
        ...u32(0x00480000), ...u32(0x00480000),
        ...u32(0), ...u16(1),
        ...new Array(32).fill(0),
        ...u16(0x0018), ...u16(0xffff),
      ],
      box("avcC", this.description!),
    );
    const stsd = full("stsd", 0, 0, u32(1), avc1);
    const sttsBox = full("stts", 0, 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)]));
    const stsc = full("stsc", 0, 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]);
    const stsz = full("stsz", 0, 0, u32(0), table(this.sizes.length, this.sizes));
    const stco = full("stco", 0, 0, table(offsets.length, offsets));
    const allKey = this.syncs.length === this.samples.length;
    const stss = allKey ? null : full("stss", 0, 0, table(this.syncs.length, this.syncs));
    const stbl = box("stbl", stsd, sttsBox, stsc, stsz, stco, ...(stss ? [stss] : []));
    const dinf = box("dinf", box("dref", [...u32(0), ...u32(1)], full("url ", 0, 1)));
    const vmhd = full("vmhd", 0, 1, [...u16(0), ...u16(0), ...u16(0), ...u16(0)]);
    const minf = box("minf", vmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const trak = box("trak", tkhd, mdia);
    return firstAudio !== null ? box("moov", mvhd, trak, this.audioTrak(firstAudio)) : box("moov", mvhd, trak);
  }

  /**
   * The audio track: AAC described by an `esds`, or Opus by a `dOps`. The esds is a nest of MPEG-4 descriptors (tag,
   * 7-bit-per-byte length, payload); a wrong length leaves a file whose video plays and whose audio is silently
   * ignored. The DecoderSpecificInfo is the AudioSpecificConfig WebCodecs reported, never parsed here.
   */
  private audioTrak(firstAudio: number): Uint8Array {
    const a = this.audio;
    const ts = a.sampleRate;
    const total = a.durations.reduce((x, y) => x + y, 0);
    const offsets: number[] = [];
    let at = firstAudio;
    for (const sz of a.sizes) offsets.push(at), (at += sz);
    const stts: [number, number][] = [];
    for (const d of a.durations) {
      const last = stts[stts.length - 1];
      if (last && last[1] === d) last[0]++;
      else stts.push([1, d]);
    }
    const descLen = (n: number) => {
      const out: number[] = [];
      do {
        out.unshift(n & 0x7f);
        n >>>= 7;
      } while (n > 0);
      for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
      return out;
    };
    const descriptor = (tag: number, payload: number[]) => [tag, ...descLen(payload.length), ...payload];
    const esds = () => {
      const dsi = descriptor(0x05, [...a.description!]);
      // objectTypeIndication 0x40 (MPEG-4 audio), streamType 5 (audio) << 2 | 1, buffer size, max / avg bitrate.
      const dcd = descriptor(0x04, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi]);
      const sl = descriptor(0x06, [0x02]);
      return full("esds", 0, 0, descriptor(0x03, [...u16(1), 0x00, ...dcd, ...sl]));
    };
    // OpusSpecificBox: the OpusHead without its magic, big-endian; defaults (pre-skip 312) when none was reported.
    const dOps = () => {
      const d = a.description;
      const isHead = !!d && d.length >= 19 && String.fromCharCode(...d.subarray(0, 8)) === "OpusHead";
      const channels = isHead ? d![9] : a.channels;
      const preSkip = isHead ? d![10] | (d![11] << 8) : 312;
      const inputRate = isHead ? (d![12] | (d![13] << 8) | (d![14] << 16) | (d![15] << 24)) >>> 0 : ts;
      const gain = isHead ? d![16] | (d![17] << 8) : 0;
      return box("dOps", [0, channels, ...u16(preSkip), ...u32(inputRate), ...u16(gain), 0]);
    };
    const entryHeader = [...new Array(6).fill(0), ...u16(1), ...u32(0), ...u32(0), ...u16(a.channels), ...u16(16), ...u16(0), ...u16(0), ...u16(ts), ...u16(0)];
    const entry = a.codec === "opus" ? box("Opus", entryHeader, dOps()) : box("mp4a", entryHeader, esds());
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), entry),
      full("stts", 0, 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)])),
      full("stsc", 0, 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]),
      full("stsz", 0, 0, u32(0), table(a.sizes.length, a.sizes)),
      full("stco", 0, 0, table(offsets.length, offsets)),
    );
    const smhd = full("smhd", 0, 0, [...u16(0), ...u16(0)]);
    const dinf = box("dinf", box("dref", [...u32(0), ...u32(1)], full("url ", 0, 1)));
    const minf = box("minf", smhd, dinf, stbl);
    const mdhd = full("mdhd", 0, 0, [...u32(0), ...u32(0), ...u32(ts), ...u32(total), ...u16(0x55c4), ...u16(0)]);
    const hdlr = full("hdlr", 0, 0, [...u32(0), ...ascii("soun"), ...u32(0), ...u32(0), ...u32(0), ...ascii("SoundHandler"), 0]);
    const unity = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    // Track 2; duration in the movie timescale; full volume; no width / height.
    const tkhd = full("tkhd", 0, 3, [...u32(0), ...u32(0), ...u32(2), ...u32(0), ...u32(Math.round((total / ts) * this.timescale)), ...u32(0), ...u32(0), ...u16(0), ...u16(1), ...u16(0x0100), ...u16(0), ...unity, ...u32(0), ...u32(0)]);
    return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  }
}

/**
 * H.264 codec strings to probe, in order. Levels are picked for the frame size and rate: level 4.2 covers 1080p60,
 * 5.1 covers 1440p60 and 1080p120, 5.2 covers 1440p120.
 */
const LADDER = ["avc1.64002a", "avc1.4d002a", "avc1.640033", "avc1.4d0033", "avc1.640034", "avc1.4d0034", "avc1.42002a", "avc1.420033", "avc1.420034"];

/** Macroblock limits per level (frame size, MB/s) to skip rungs that can't hold the format, and MaxBR (kbit/s). */
const LEVELS: Record<string, [number, number, number]> = { "2a": [8704, 522240, 50000], "33": [36864, 983040, 240000], "34": [36864, 2073600, 240000] };

export async function pickCodec(width: number, height: number, bitrate: number, framerate: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const codec of LADDER) {
    const lim = LEVELS[codec.slice(-2)];
    if (lim && (mbs > lim[0] || mbs * framerate > lim[1])) continue;
    // Never ask for more than the level allows (High profile gets 1.25x): encoders and players may refuse or clamp it.
    const rate = lim ? Math.min(bitrate, lim[2] * (codec.startsWith("avc1.64") ? 1250 : 1000)) : bitrate;
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
      const config: VideoEncoderConfig = { codec, width, height, bitrate: rate, framerate, avc: { format: "avc" }, hardwareAcceleration, latencyMode: "quality" };
      try {
        const s = await VideoEncoder.isConfigSupported(config);
        if (s.supported) return s.config ?? config;
      } catch {
        /* next rung */
      }
    }
  }
  return null;
}

/** WebCodecs H.264 encoding available at all (support for a given size is probed with pickCodec). */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}
