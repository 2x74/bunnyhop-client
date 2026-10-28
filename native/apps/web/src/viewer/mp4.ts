// Minimal MP4 (ISO BMFF) muxer for one video track (H.264, HEVC or AV1) and an optional AAC / Opus audio track from
// WebCodecs.
//
// Ported from the Aimperion replay exporter (src/replay/mp4.js, incl. its audio track). WebCodecs configured with
// avc: { format: "avc" } (hevc: { format: "hevc" }) hands over chunks that already are mp4 samples (length-prefixed NAL
// units) plus the avcC (hvcC) payload as decoderConfig.description, so the muxer never parses H.264 / HEVC: it counts
// bytes, records durations and keyframes, and writes ftyp / mdat / moov (moov last: sizes are only known after
// encoding; fine for a downloaded file). AV1 chunks are OBU streams with no description: the muxer drops the temporal
// delimiters (not allowed in mp4 samples) and builds the av1C from the codec string and the first sequence header.
// One chunk per sample keeps stsc a single entry; a constant frame rate collapses stts to one entry.
//
// Memory: encoded video is rolled into Blobs every 64 MB (the browser keeps big blobs out of the JS heap and Chromium
// pages them to disk), so a long or high-bitrate export doesn't hold gigabytes of ArrayBuffers. Past 4 GB the file
// switches to a 64-bit mdat size and co64 chunk offsets.

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

/** co64: 64-bit chunk offsets (files past 4 GB). */
function table64(values: number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, values.length);
  values.forEach((v, i) => {
    dv.setUint32(4 + i * 8, Math.floor(v / 2 ** 32));
    dv.setUint32(8 + i * 8, v >>> 0);
  });
  return out;
}

export type VideoCodecFamily = "avc" | "hevc" | "av1";

/** Reads an OBU stream: [start, end, type] per OBU, or null when it doesn't parse (left untouched then). */
function obus(b: Uint8Array): [number, number, number][] | null {
  const out: [number, number, number][] = [];
  let i = 0;
  while (i < b.length) {
    const head = b[i];
    if (head & 0x80) return null;
    const type = (head >> 3) & 15;
    let j = i + 1 + ((head >> 2) & 1);
    let size: number;
    if (head & 2) {
      size = 0;
      for (let k = 0, shift = 1; ; k++, shift *= 128) {
        if (k === 8 || j >= b.length) return null;
        const byte = b[j++];
        size += (byte & 0x7f) * shift;
        if (!(byte & 0x80)) break;
      }
    } else size = b.length - j;
    const end = j + size;
    if (end > b.length) return null;
    out.push([i, end, type]);
    i = end;
  }
  return out;
}

/** OBU_TEMPORAL_DELIMITER, OBU_SEQUENCE_HEADER (AV1 spec 5.3.1). */
const OBU_TD = 2;
const OBU_SEQ = 1;

/**
 * The AV1CodecConfigurationRecord for codec string `av01.P.LLT.DD` (4:2:0, the only layout WebCodecs encodes) and the
 * sequence header OBU (configOBUs; decoders also find it in every keyframe).
 */
export function av1Config(codec: string, seqHeader: Uint8Array | null): Uint8Array {
  const [, p = "0", lt = "08M", dd = "08"] = codec.split(".");
  const profile = Number(p) & 7;
  const level = Number(lt.slice(0, 2)) & 31;
  const tier = lt[2] === "H" ? 1 : 0;
  const high = Number(dd) > 8 ? 1 : 0;
  const twelve = Number(dd) === 12 ? 1 : 0;
  const head = [0x81, (profile << 5) | level, (tier << 7) | (high << 6) | (twelve << 5) | (1 << 3) | (1 << 2), 0];
  const out = new Uint8Array(4 + (seqHeader?.length ?? 0));
  out.set(head);
  if (seqHeader) out.set(seqHeader, 4);
  return out;
}

/** Encoded bytes rolled into a Blob at this size (see the header). */
const ROLL_BYTES = 64 * 1048576;

export class Mp4Muxer {
  /** Video samples not yet rolled into `parts`. */
  private samples: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private parts: Blob[] = [];
  private count = 0;
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
    /** Ticks per second; 90000 divides 30/60/120/240 fps exactly. */
    readonly timescale = 90000,
    readonly family: VideoCodecFamily = "avc",
    /** The encoder's codec string (AV1: the av1C fields come from it). */
    readonly codec = "",
  ) {}

  setDescription(desc: AllowSharedBufferSource): void {
    this.description = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice() : new Uint8Array(desc as ArrayBuffer).slice();
  }

  /** AV1 never reports one: the first sample's sequence header stands in (needsDescription stays false for it). */
  get hasDescription(): boolean {
    return this.description !== null || this.family === "av1";
  }

  addSample(data: Uint8Array<ArrayBuffer>, duration: number, key: boolean): void {
    if (this.family === "av1") data = this.av1Sample(data);
    this.samples.push(data);
    this.pendingBytes += data.length;
    this.count++;
    this.sizes.push(data.length);
    this.durations.push(Math.max(1, Math.round(duration)));
    if (key) this.syncs.push(this.count);
    this.bytes += data.length;
    if (this.pendingBytes >= ROLL_BYTES) this.roll();
  }

  /** Moves the pending samples into a Blob (out of the JS heap). */
  private roll(): void {
    if (!this.samples.length) return;
    this.parts.push(new Blob(this.samples));
    this.samples = [];
    this.pendingBytes = 0;
  }

  /** AV1: keeps the first sequence header for the av1C and drops temporal delimiters (ISO/IEC 14496-12 AV1 binding 2.4). */
  private av1Sample(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const list = obus(data);
    if (!list) return data;
    if (!this.description) {
      const seq = list.find((o) => o[2] === OBU_SEQ);
      if (seq) this.description = av1Config(this.codec, data.slice(seq[0], seq[1]));
    }
    if (!list.some((o) => o[2] === OBU_TD)) return data;
    const keep = list.filter((o) => o[2] !== OBU_TD);
    const out = new Uint8Array(keep.reduce((n, o) => n + o[1] - o[0], 0));
    let at = 0;
    for (const [a, b] of keep) out.set(data.subarray(a, b), at), (at += b - a);
    return out;
  }

  get frameCount(): number {
    return this.count;
  }

  /** Encoded video bytes so far (the file is about this plus the sound track). */
  get videoBytes(): number {
    return this.bytes;
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
    if (!this.count) throw new Error("mp4: no frames");
    const brand = this.family === "av1" ? "av01" : this.family === "hevc" ? "hvc1" : "avc1";
    const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii(brand), ascii("mp41"));
    const withAudio = this.hasAudio;
    const payload = this.bytes + (withAudio ? this.audio.bytes : 0);
    // Past 4 GB: a 64-bit mdat size (size field 1, then the real size) and co64 offsets.
    this.large = ftyp.length + 16 + payload > 0xffffffff;
    const mdatHeader = this.large
      ? new Uint8Array([...u32(1), ...ascii("mdat"), ...u32(Math.floor((16 + payload) / 2 ** 32)), ...u32((16 + payload) >>> 0)])
      : new Uint8Array([...u32(8 + payload), ...ascii("mdat")]);
    const first = ftyp.length + mdatHeader.length;
    const total = this.durations.reduce((a, b) => a + b, 0);
    // Video first, then audio: one contiguous run each (a downloaded file, not a stream).
    const moov = this.moov(first, total, withAudio ? first + this.bytes : null);
    this.roll();
    const parts = [ftyp, mdatHeader, ...this.parts, ...(withAudio ? this.audio.samples : []), moov] as BlobPart[];
    return new Blob(parts, { type: "video/mp4" });
  }

  /** Set by finalize: offsets need 64 bits. */
  private large = false;

  private offsets(entries: number[]): Uint8Array {
    return this.large ? full("co64", 0, 0, table64(entries)) : full("stco", 0, 0, table(entries.length, entries));
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
    const sampleEntry = box(
      this.family === "av1" ? "av01" : this.family === "hevc" ? "hvc1" : "avc1",
      [
        ...new Array(6).fill(0), ...u16(1),
        ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0),
        ...u16(this.width), ...u16(this.height),
        ...u32(0x00480000), ...u32(0x00480000),
        ...u32(0), ...u16(1),
        ...new Array(32).fill(0),
        ...u16(0x0018), ...u16(0xffff),
      ],
      box(this.family === "av1" ? "av1C" : this.family === "hevc" ? "hvcC" : "avcC", this.description!),
    );
    const stsd = full("stsd", 0, 0, u32(1), sampleEntry);
    const sttsBox = full("stts", 0, 0, u32(stts.length), stts.flatMap(([c, d]) => [...u32(c), ...u32(d)]));
    const stsc = full("stsc", 0, 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]);
    const stsz = full("stsz", 0, 0, u32(0), table(this.sizes.length, this.sizes));
    const stco = this.offsets(offsets);
    const allKey = this.syncs.length === this.count;
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
      this.offsets(offsets),
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
 * Codec strings to probe per family, with the level limits used to skip rungs that can't hold the format: frame size
 * and rate (H.264: macroblocks and MB/s; HEVC / AV1: luma samples and samples/s) and the level's max bitrate (kbit/s;
 * H.264 High and HEVC Main get the 1.25x / 1.1x NAL factor). Encoders mostly ignore the level, but players don't.
 */
type Rung = { codec: string; frame: number; rate: number; maxKbps: number };
const AVC_LEVELS: [string, number, number, number][] = [
  ["2a", 8704, 522240, 50000], // 4.2: 1080p60
  ["33", 36864, 983040, 240000], // 5.1: 1440p60, 1080p120, 2160p30
  ["34", 36864, 2073600, 240000], // 5.2: 1440p120, 1080p240, 2160p60
  ["3c", 139264, 4177920, 240000], // 6.0: 1440p240
  ["3d", 139264, 8355840, 480000], // 6.1: 2160p120 / 240
  ["3e", 139264, 16711680, 800000], // 6.2
];
const AVC_LADDER: Rung[] = [
  ...AVC_LEVELS.flatMap(([l, frame, rate, br]) => [
    { codec: `avc1.6400${l}`, frame, rate, maxKbps: br * 1.25 },
    { codec: `avc1.4d00${l}`, frame, rate, maxKbps: br },
  ]),
  ...AVC_LEVELS.map(([l, frame, rate, br]) => ({ codec: `avc1.4200${l}`, frame, rate, maxKbps: br })),
];
const HEVC_LEVELS: [number, number, number, number, number][] = [
  [123, 2228224, 133693440, 20000, 50000], // 4.1
  [153, 8912896, 534773760, 40000, 160000], // 5.1
  [156, 8912896, 1069547520, 60000, 240000], // 5.2
  [183, 35651584, 2139095040, 120000, 480000], // 6.1
  [186, 35651584, 4278190080, 240000, 800000], // 6.2
];
const HEVC_LADDER: Rung[] = HEVC_LEVELS.flatMap(([idc, frame, rate, main, high]) => [
  { codec: `hvc1.1.6.L${idc}.B0`, frame, rate, maxKbps: main * 1.1 },
  { codec: `hvc1.1.6.H${idc}.B0`, frame, rate, maxKbps: high * 1.1 },
]);
const AV1_LEVELS: [number, number, number, number, number][] = [
  [8, 2228224, 133693440, 12000, 30000], // 4.0
  [9, 2228224, 267386880, 20000, 50000], // 4.1
  [12, 8912896, 267386880, 30000, 100000], // 5.0
  [13, 8912896, 534773760, 40000, 160000], // 5.1
  [14, 8912896, 1069547520, 60000, 240000], // 5.2
  [16, 35651584, 1069547520, 60000, 240000], // 6.0
  [17, 35651584, 2139095040, 100000, 480000], // 6.1
  [18, 35651584, 4278190080, 160000, 800000], // 6.2
];
const AV1_LADDER: Rung[] = AV1_LEVELS.flatMap(([idx, frame, rate, main, high]) => [
  { codec: `av01.0.${String(idx).padStart(2, "0")}M.08`, frame, rate, maxKbps: main },
  { codec: `av01.0.${String(idx).padStart(2, "0")}H.08`, frame, rate, maxKbps: high },
]);

/** Per-frame quantizer for Edit-ready (constant quality; H.264 / HEVC 0-51, AV1 0-63; lower = better). */
export const EDIT_QUANTIZER: Record<VideoCodecFamily, number> = { avc: 18, hevc: 20, av1: 28 };

export interface PickedCodec {
  config: VideoEncoderConfig;
  family: VideoCodecFamily;
  /** Constant-quality encode: pass as the per-frame quantizer (encodeOptions); null = bitrate mode. */
  quantizer: number | null;
  /** No hardware encoder took the config (the software one did). */
  software: boolean;
}

/** Per-frame encode options for a picked codec (keyframe + quantizer). */
export function encodeOptions(p: PickedCodec, keyFrame: boolean): VideoEncoderEncodeOptions {
  if (p.quantizer === null) return { keyFrame };
  return { keyFrame, [p.family]: { quantizer: p.quantizer } } as VideoEncoderEncodeOptions;
}

function ladder(family: VideoCodecFamily, width: number, height: number, framerate: number): Rung[] {
  const rungs = family === "hevc" ? HEVC_LADDER : family === "av1" ? AV1_LADDER : AVC_LADDER;
  const unit = family === "avc" ? Math.ceil(width / 16) * Math.ceil(height / 16) : width * height;
  return rungs.filter((r) => unit <= r.frame && unit * framerate <= r.rate);
}

/**
 * The first config this browser can encode for `family` at this size and rate. Rungs whose level can carry the bitrate
 * come first; otherwise the rate is lowered to the level's limit. `constantQuality` (Edit-ready) tries quantizer mode
 * first and falls back to the bitrate. Null when the family can't do it at all (callers fall back to H.264).
 */
export async function pickVideoCodec(family: VideoCodecFamily, width: number, height: number, bitrate: number, framerate: number, constantQuality = false): Promise<PickedCodec | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const rungs = ladder(family, width, height, framerate);
  const extra = family === "avc" ? { avc: { format: "avc" } } : family === "hevc" ? { hevc: { format: "hevc" } } : {};
  const ordered = [...rungs.filter((r) => r.maxKbps * 1000 >= bitrate), ...rungs.filter((r) => r.maxKbps * 1000 < bitrate)];
  for (const quantizer of constantQuality ? [true, false] : [false]) {
    for (const r of ordered) {
      const rate = Math.min(bitrate, r.maxKbps * 1000);
      for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
        const software = hardwareAcceleration !== "prefer-hardware";
        // Chromium's software H.264 encoder budgets bits per frame as if at 60 fps: 240 fps came out at 4x the asked rate
        // (measured 10-28 on macOS, Chrome 153), so ask for the per-frame share.
        const asked = software && family === "avc" && framerate > 60 ? Math.round((rate * 60) / framerate) : rate;
        const config = { codec: r.codec, width, height, bitrate: asked, framerate, hardwareAcceleration, latencyMode: "quality", ...extra, ...(quantizer ? { bitrateMode: "quantizer" } : {}) } as VideoEncoderConfig;
        try {
          const s = await VideoEncoder.isConfigSupported(config);
          if (s.supported) return { config: s.config ?? config, family, quantizer: quantizer ? EDIT_QUANTIZER[family] : null, software };
        } catch {
          /* next rung */
        }
      }
    }
  }
  return null;
}

/** H.264 at a bitrate (older callers). */
export async function pickCodec(width: number, height: number, bitrate: number, framerate: number): Promise<VideoEncoderConfig | null> {
  return (await pickVideoCodec("avc", width, height, bitrate, framerate))?.config ?? null;
}

/** WebCodecs video encoding available at all (support for a given codec and size is probed with pickVideoCodec). */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}
