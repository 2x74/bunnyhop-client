// Build-time only: WOFF2 to a plain TrueType font (W3C WOFF2, section 5), so resvg can draw the website's supporter
// name fonts (web assets/name-fonts/*.woff2) into the HUD's name-font atlas. It reads what those files use: one
// TrueType font with the glyf/loca transform. A collection, CFF outlines or the hmtx transform fail with an error.
import { brotliDecompressSync } from "node:zlib";

const WOFF2_SIGNATURE = 0x774f4632;
const TRUETYPE_FLAVOR = 0x00010000;
const HEADER_BYTES = 48;
const CUSTOM_TAG = 63;

/** The table tags a WOFF2 directory names by index (spec 4.1 "Known Table Tags"). */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
  "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
  "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
  "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
]; // prettier-ignore

interface TableEntry {
  tag: string;
  transformed: boolean;
  length: number;
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private need(count: number): void {
    if (this.offset + count > this.bytes.length) throw Error("WOFF2 data ends early");
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  i16(): number {
    const value = this.u16();
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }

  take(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** UIntBase128 (spec 6.1.1). */
  base128(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) throw Error("WOFF2 number has a leading zero");
      if (value & 0xfe000000) throw Error("WOFF2 number overflows");
      value = ((value << 7) | (byte & 0x7f)) >>> 0;
      if (!(byte & 0x80)) return value;
    }
    throw Error("WOFF2 number is too long");
  }

  /** 255UInt16 (spec 6.1.1). */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

class Writer {
  private bytes = new Uint8Array(1024);
  length = 0;

  private grow(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + count));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  u8(value: number): void {
    this.grow(1);
    this.bytes[this.length++] = value & 0xff;
  }

  u16(value: number): void {
    this.u8(value >> 8);
    this.u8(value);
  }

  u32(value: number): void {
    this.u16(value >>> 16);
    this.u16(value);
  }

  append(data: Uint8Array): void {
    this.grow(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  padTo(multiple: number): void {
    while (this.length % multiple) this.u8(0);
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function readDirectory(reader: Reader, count: number): TableEntry[] {
  const tables: TableEntry[] = [];
  for (let i = 0; i < count; i++) {
    const flags = reader.u8();
    const index = flags & 0x3f;
    const tag = index === CUSTOM_TAG ? String.fromCharCode(...reader.take(4)) : KNOWN_TAGS[index];
    const version = flags >> 6;
    const original = reader.base128();
    // glyf and loca are transformed at version 0; every other table is at any version but 0.
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    if (transformed && tag !== "glyf" && tag !== "loca") throw Error(`WOFF2 ${tag} transform is not supported`);
    const length = transformed ? reader.base128() : original;
    tables.push({ tag, transformed, length });
  }
  return tables;
}

/** One coordinate change of a simple glyph's point (spec 5.2, the triplet encoding). */
function tripletDelta(flag: number, glyphs: Reader): [number, number] {
  const sign = (bit: number, value: number) => (bit & 1 ? value : -value);
  if (flag < 10) return [0, sign(flag, ((flag & 14) << 7) + glyphs.u8())];
  if (flag < 20) return [sign(flag, (((flag - 10) & 14) << 7) + glyphs.u8()), 0];
  if (flag < 84) {
    const high = flag - 20;
    const low = glyphs.u8();
    return [sign(flag, 1 + (high & 0x30) + (low >> 4)), sign(flag >> 1, 1 + ((high & 0x0c) << 2) + (low & 0x0f))];
  }
  if (flag < 120) {
    const high = flag - 84;
    const x = glyphs.u8();
    const y = glyphs.u8();
    return [sign(flag, 1 + (Math.floor(high / 12) << 8) + x), sign(flag >> 1, 1 + (((high % 12) >> 2) << 8) + y)];
  }
  if (flag < 124) {
    const first = glyphs.u8();
    const middle = glyphs.u8();
    const last = glyphs.u8();
    return [sign(flag, (first << 4) + (middle >> 4)), sign(flag >> 1, ((middle & 0x0f) << 8) + last)];
  }
  return [sign(flag, glyphs.u16()), sign(flag >> 1, glyphs.u16())];
}

interface GlyfStreams {
  contours: Reader;
  points: Reader;
  flags: Reader;
  glyphs: Reader;
  composites: Reader;
  boxes: Reader;
  boxBitmap: Uint8Array;
  instructions: Reader;
  overlapBitmap: Uint8Array | null;
}

function readGlyfStreams(data: Uint8Array): { glyphCount: number; longLoca: boolean; streams: GlyfStreams } {
  const header = new Reader(data);
  header.u16();
  const options = header.u16();
  const glyphCount = header.u16();
  const longLoca = header.u16() === 1;
  const sizes = Array.from({ length: 7 }, () => header.u32());
  const [contours, points, flags, glyphs, composites, boxes, instructions] = sizes.map(
    (size) => new Reader(header.take(size)),
  );
  const boxBitmapBytes = 4 * Math.floor((glyphCount + 31) / 32);
  const boxBitmap = boxes.take(boxBitmapBytes);
  const overlapBitmap = options & 1 ? header.take(Math.floor((glyphCount + 7) / 8)) : null;
  return {
    glyphCount,
    longLoca,
    streams: { contours, points, flags, glyphs, composites, boxes, boxBitmap, instructions, overlapBitmap },
  };
}

const bitSet = (bitmap: Uint8Array, index: number) => (bitmap[index >> 3] & (0x80 >> (index & 7))) !== 0;

function writeSimpleGlyph(out: Writer, contourCount: number, index: number, streams: GlyfStreams): void {
  const ends: number[] = [];
  let total = 0;
  for (let i = 0; i < contourCount; i++) {
    total += streams.points.u255();
    ends.push(total - 1);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const onCurve: boolean[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < total; i++) {
    const flag = streams.flags.u8();
    const [dx, dy] = tripletDelta(flag & 0x7f, streams.glyphs);
    x += dx;
    y += dy;
    xs.push(x);
    ys.push(y);
    onCurve.push(!(flag & 0x80));
  }
  const instructionLength = streams.glyphs.u255();
  const instructions = streams.instructions.take(instructionLength);
  const box = bitSet(streams.boxBitmap, index)
    ? [streams.boxes.i16(), streams.boxes.i16(), streams.boxes.i16(), streams.boxes.i16()]
    : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  out.u16(contourCount);
  for (const value of box) out.u16(value & 0xffff);
  for (const end of ends) out.u16(end);
  out.u16(instructionLength);
  out.append(instructions);
  writePoints(out, xs, ys, onCurve, !!streams.overlapBitmap && bitSet(streams.overlapBitmap, index));
}

/** A simple glyph's flags and coordinates, one flag per point (no repeats), deltas in the short forms that fit. */
function writePoints(out: Writer, xs: number[], ys: number[], onCurve: boolean[], overlap: boolean): void {
  const ON_CURVE = 0x01;
  const X_SHORT = 0x02;
  const Y_SHORT = 0x04;
  const X_SAME_OR_POSITIVE = 0x10;
  const Y_SAME_OR_POSITIVE = 0x20;
  const OVERLAP_SIMPLE = 0x40;
  const flags = new Writer();
  const xBytes = new Writer();
  const yBytes = new Writer();
  const axis = (delta: number, bytes: Writer, short: number, same: number) => {
    if (delta === 0) return same;
    if (Math.abs(delta) < 256) {
      bytes.u8(Math.abs(delta));
      return short | (delta > 0 ? same : 0);
    }
    bytes.u16(delta & 0xffff);
    return 0;
  };
  for (let i = 0; i < xs.length; i++) {
    let flag = onCurve[i] ? ON_CURVE : 0;
    if (i === 0 && overlap) flag |= OVERLAP_SIMPLE;
    flag |= axis(xs[i] - (i ? xs[i - 1] : 0), xBytes, X_SHORT, X_SAME_OR_POSITIVE);
    flag |= axis(ys[i] - (i ? ys[i - 1] : 0), yBytes, Y_SHORT, Y_SAME_OR_POSITIVE);
    flags.u8(flag);
  }
  out.append(flags.result());
  out.append(xBytes.result());
  out.append(yBytes.result());
}

function writeCompositeGlyph(out: Writer, index: number, streams: GlyfStreams): void {
  const ARG_1_AND_2_ARE_WORDS = 0x0001;
  const WE_HAVE_A_SCALE = 0x0008;
  const MORE_COMPONENTS = 0x0020;
  const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
  const WE_HAVE_A_TWO_BY_TWO = 0x0080;
  const WE_HAVE_INSTRUCTIONS = 0x0100;
  if (!bitSet(streams.boxBitmap, index)) throw Error("WOFF2 composite glyph has no bounding box");
  out.u16(0xffff);
  for (let i = 0; i < 4; i++) out.u16(streams.boxes.i16() & 0xffff);
  let flags = MORE_COMPONENTS;
  let instructed = false;
  while (flags & MORE_COMPONENTS) {
    flags = streams.composites.u16();
    instructed ||= (flags & WE_HAVE_INSTRUCTIONS) !== 0;
    let bytes = 2 + (flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
    if (flags & WE_HAVE_A_SCALE) bytes += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) bytes += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) bytes += 8;
    out.u16(flags);
    out.append(streams.composites.take(bytes));
  }
  if (!instructed) return;
  const instructionLength = streams.glyphs.u255();
  out.u16(instructionLength);
  out.append(streams.instructions.take(instructionLength));
}

/** The glyf and loca tables from the transformed glyf data (spec 5.1 to 5.3). */
function rebuildGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array } {
  const { glyphCount, longLoca, streams } = readGlyfStreams(data);
  const glyf = new Writer();
  const offsets: number[] = [];
  for (let index = 0; index < glyphCount; index++) {
    offsets.push(glyf.length);
    const contourCount = streams.contours.i16();
    if (contourCount > 0) writeSimpleGlyph(glyf, contourCount, index, streams);
    else if (contourCount === -1) writeCompositeGlyph(glyf, index, streams);
    else if (contourCount !== 0) throw Error("WOFF2 glyph has a negative contour count");
    glyf.padTo(4);
  }
  offsets.push(glyf.length);
  const loca = new Writer();
  for (const offset of offsets) {
    if (longLoca) loca.u32(offset);
    else loca.u16(offset / 2);
  }
  return { glyf: glyf.result(), loca: loca.result() };
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word = ((data[i] << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

/** An sfnt file of these tables (head's adjustment at 0): the directory sorted by tag, tables 4-byte aligned. */
function writeSfnt(flavor: number, tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const out = new Writer();
  const count = tags.length;
  const power = 2 ** Math.floor(Math.log2(count));
  out.u32(flavor);
  out.u16(count);
  out.u16(power * 16);
  out.u16(Math.log2(power));
  out.u16(count * 16 - power * 16);
  let offset = 12 + count * 16;
  for (const tag of tags) {
    const data = tables.get(tag)!;
    for (const character of tag) out.u8(character.charCodeAt(0));
    out.u32(checksum(data));
    out.u32(offset);
    out.u32(data.length);
    offset += Math.ceil(data.length / 4) * 4;
  }
  let headAt = 0;
  for (const tag of tags) {
    if (tag === "head") headAt = out.length;
    out.append(tables.get(tag)!);
    out.padTo(4);
  }
  const font = out.result();
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  new DataView(font.buffer).setUint32(headAt + 8, adjustment);
  return font;
}

/** The TrueType font inside a WOFF2 file. */
export function woff2ToTtf(file: Uint8Array): Uint8Array {
  const reader = new Reader(file);
  if (reader.u32() !== WOFF2_SIGNATURE) throw Error("Not a WOFF2 file");
  const flavor = reader.u32();
  if (flavor !== TRUETYPE_FLAVOR) throw Error("Only TrueType WOFF2 fonts are supported");
  reader.u32();
  const tableCount = reader.u16();
  reader.offset = 20;
  const compressedSize = reader.u32();
  reader.offset = HEADER_BYTES;
  const directory = readDirectory(reader, tableCount);
  const stream = new Uint8Array(brotliDecompressSync(reader.take(compressedSize)));
  const tables = new Map<string, Uint8Array>();
  let at = 0;
  for (const entry of directory) {
    if (at + entry.length > stream.length) throw Error("WOFF2 table runs past the data");
    tables.set(entry.tag, stream.subarray(at, at + entry.length));
    at += entry.length;
  }
  const head = tables.get("head");
  if (!head || head.length < 12) throw Error("WOFF2 font has no head table");
  // The checksum adjustment is worked out again for the new file, from a head that reads 0 there.
  const zeroedHead = head.slice();
  zeroedHead.fill(0, 8, 12);
  tables.set("head", zeroedHead);
  const glyf = directory.find((entry) => entry.tag === "glyf");
  if (glyf?.transformed) {
    const rebuilt = rebuildGlyf(tables.get("glyf")!);
    tables.set("glyf", rebuilt.glyf);
    tables.set("loca", rebuilt.loca);
  }
  return writeSfnt(flavor, tables);
}
