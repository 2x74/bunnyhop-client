// Build-time only: the website's supporter name fonts (web supporter-looks.ts NAME_FONTS, assets/name-fonts/*.woff2)
// as one small alpha atlas per font, for the names the host draws (Tab board, name tags, chat, the spectator bar).
// Each printable ASCII letter is drawn by resvg at `EM` pixels in its own cell and cropped to its ink; its advance
// comes from the font's hmtx. src/name_fonts.hpp reads name-fonts.json and lays names out letter by letter.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { NAME_FONTS, nameFontFamily } from "../../web/src/supporter-looks";
import { woff2ToTtf } from "./woff2";

/** The pixel size letters are drawn at (the HUD font's atlas uses the same). */
const EM = 40;
const FIRST = 32;
const LAST = 126;
/** Each letter's canvas: room for swashes either side of the pen and above and below the baseline. */
const CANVAS_WIDTH = 4 * EM;
const CANVAS_HEIGHT = 3 * EM;
const PEN_X = EM;
const BASELINE_Y = 2 * EM;
const ATLAS_WIDTH = 512;
const GAP = 1;

interface Rendered {
  pixels: Uint8Array;
  free(): void;
}
interface Rasterizer {
  render(): Rendered;
  free(): void;
}
type ResvgClass = new (svg: string, options: object) => Rasterizer;

/** [advance, x, y, width, height, left, top] in atlas pixels; left / top from the pen on the baseline. */
type GlyphRecord = [number, number, number, number, number, number, number];

interface FontTables {
  unitsPerEm: number;
  glyphOf(code: number): number;
  advanceOf(glyph: number): number;
}

function tableAt(font: Uint8Array, tag: string): DataView {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    if (String.fromCharCode(...font.subarray(record, record + 4)) !== tag) continue;
    return new DataView(font.buffer, font.byteOffset + view.getUint32(record + 8), view.getUint32(record + 12));
  }
  throw Error(`Name font has no ${tag} table`);
}

/** The BMP glyph lookup of a cmap format 4 subtable (Windows Unicode). */
function cmapLookup(cmap: DataView): (code: number) => number {
  for (let i = 0; i < cmap.getUint16(2); i++) {
    const record = 4 + i * 8;
    const offset = cmap.getUint32(record + 4);
    if (cmap.getUint16(record) !== 3 || cmap.getUint16(record + 2) !== 1 || cmap.getUint16(offset) !== 4) continue;
    const segments = cmap.getUint16(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    return (code) => {
      for (let s = 0; s < segments; s++) {
        if (cmap.getUint16(ends + s * 2) < code) continue;
        const start = cmap.getUint16(starts + s * 2);
        if (start > code) return 0;
        const delta = cmap.getUint16(deltas + s * 2);
        const range = cmap.getUint16(ranges + s * 2);
        if (!range) return (code + delta) & 0xffff;
        const glyph = cmap.getUint16(ranges + s * 2 + range + (code - start) * 2);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  throw Error("Name font has no Unicode BMP cmap");
}

function fontTables(font: Uint8Array): FontTables {
  const head = tableAt(font, "head");
  const metricCount = tableAt(font, "hhea").getUint16(34);
  const hmtx = tableAt(font, "hmtx");
  return {
    unitsPerEm: head.getUint16(18),
    glyphOf: cmapLookup(tableAt(font, "cmap")),
    advanceOf: (glyph) => hmtx.getUint16(Math.min(glyph, metricCount - 1) * 4),
  };
}

const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const SHEET_COLUMNS = 16;

/** Every letter of `codes` drawn by one resvg pass, each in its own canvas-sized cell of a grid. */
function sheetAlpha(Resvg: ResvgClass, font: Uint8Array, family: string, codes: number[]): Uint8Array {
  const rows = Math.ceil(codes.length / SHEET_COLUMNS);
  const width = SHEET_COLUMNS * CANVAS_WIDTH;
  const letters = codes.map((code, index) => {
    const x = (index % SHEET_COLUMNS) * CANVAS_WIDTH + PEN_X;
    const y = Math.floor(index / SHEET_COLUMNS) * CANVAS_HEIGHT + BASELINE_Y;
    return `<text x="${x}" y="${y}">${escapeText(String.fromCharCode(code))}</text>`;
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rows * CANVAS_HEIGHT}">` +
    `<g font-family="${family}" font-size="${EM}" fill="white">${letters.join("")}</g></svg>`;
  const rasterizer = new Resvg(svg, {
    font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: family },
  });
  const image = rasterizer.render();
  // `pixels` copies the image out of the WASM heap on every read.
  const pixels = image.pixels;
  const alpha = new Uint8Array(pixels.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  image.free();
  rasterizer.free();
  return alpha;
}

/** One letter's cell of the sheet, as its own canvas. */
function cellAlpha(sheet: Uint8Array, index: number): Uint8Array {
  const alpha = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
  const left = (index % SHEET_COLUMNS) * CANVAS_WIDTH;
  const top = Math.floor(index / SHEET_COLUMNS) * CANVAS_HEIGHT;
  const stride = SHEET_COLUMNS * CANVAS_WIDTH;
  for (let row = 0; row < CANVAS_HEIGHT; row++) {
    const from = (top + row) * stride + left;
    alpha.set(sheet.subarray(from, from + CANVAS_WIDTH), row * CANVAS_WIDTH);
  }
  return alpha;
}

/** The inked box of a letter's canvas, or null for a letter with no ink (the space). */
function inkBox(alpha: Uint8Array): { x: number; y: number; width: number; height: number } | null {
  let left = CANVAS_WIDTH;
  let top = CANVAS_HEIGHT;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < CANVAS_HEIGHT; y++) {
    for (let x = 0; x < CANVAS_WIDTH; x++) {
      if (!alpha[y * CANVAS_WIDTH + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  if (left === 0 || top === 0 || right === CANVAS_WIDTH - 1 || bottom === CANVAS_HEIGHT - 1)
    throw Error("A name font letter reaches its canvas edge");
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

interface Letter {
  alpha: Uint8Array;
  box: { x: number; y: number; width: number; height: number } | null;
  advance: number;
}

/** Shelf-packs the letters into an atlas `ATLAS_WIDTH` wide; returns the atlas and each letter's record. */
function packLetters(letters: (Letter | null)[]): {
  height: number;
  alpha: Uint8Array;
  glyphs: (GlyphRecord | null)[];
} {
  const places: [number, number][] = [];
  let x = GAP;
  let y = GAP;
  let shelf = 0;
  for (const letter of letters) {
    const box = letter?.box;
    if (!box) {
      places.push([0, 0]);
      continue;
    }
    if (x + box.width + GAP > ATLAS_WIDTH) {
      x = GAP;
      y += shelf + GAP;
      shelf = 0;
    }
    places.push([x, y]);
    x += box.width + GAP;
    shelf = Math.max(shelf, box.height);
  }
  const height = y + shelf + GAP;
  const alpha = new Uint8Array(ATLAS_WIDTH * height);
  const glyphs = letters.map((letter, index): GlyphRecord | null => {
    if (!letter) return null;
    const box = letter.box;
    if (!box) return [letter.advance, 0, 0, 0, 0, 0, 0];
    const [atX, atY] = places[index];
    for (let row = 0; row < box.height; row++) {
      const from = (box.y + row) * CANVAS_WIDTH + box.x;
      alpha.set(letter.alpha.subarray(from, from + box.width), (atY + row) * ATLAS_WIDTH + atX);
    }
    return [letter.advance, atX, atY, box.width, box.height, box.x - PEN_X, box.y - BASELINE_Y];
  });
  return { height, alpha, glyphs };
}

function exportFace(Resvg: ResvgClass, font: Uint8Array, family: string) {
  const tables = fontTables(font);
  const codes = Array.from({ length: LAST - FIRST + 1 }, (_, index) => FIRST + index);
  const drawn = codes.filter((code) => tables.glyphOf(code) !== 0);
  const sheet = sheetAlpha(Resvg, font, family, drawn);
  const letters = codes.map((code): Letter | null => {
    const index = drawn.indexOf(code);
    if (index < 0) return null;
    const alpha = cellAlpha(sheet, index);
    const advance = Math.round(((tables.advanceOf(tables.glyphOf(code)) * EM) / tables.unitsPerEm) * 64) / 64;
    return { alpha, box: inkBox(alpha), advance };
  });
  return packLetters(letters);
}

/**
 * Writes name-fonts.json: {em, fonts: {id: {size, width, height, alpha, glyphs}}}. `size` is the web's size-adjust,
 * `alpha` the zlib-packed 8-bit atlas, `glyphs` one record or null per printable ASCII letter (32 to 126). Returns how
 * many fonts it holds.
 */
export async function exportNameFonts(out: string, Resvg: ResvgClass, fontsDir: string): Promise<number> {
  const fonts: Record<string, object> = {};
  for (const face of NAME_FONTS) {
    const font = woff2ToTtf(new Uint8Array(await readFile(join(fontsDir, `${face.id}.woff2`))));
    const atlas = exportFace(Resvg, font, nameFontFamily(face.id));
    fonts[face.id] = {
      size: face.size,
      width: ATLAS_WIDTH,
      height: atlas.height,
      alpha: deflateSync(atlas.alpha, { level: 9 }).toString("base64"),
      glyphs: atlas.glyphs,
    };
  }
  await writeFile(join(out, "name-fonts.json"), JSON.stringify({ em: EM, fonts }));
  return NAME_FONTS.length;
}
