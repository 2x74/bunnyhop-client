// The supporter name fonts the host draws (src/name_fonts.hpp, name-fonts.json from src/export-name-fonts.ts) against
// the website's NAME_FONTS and font files. When a re-sync adds or changes a font, this fails.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { NAME_FONTS } from "../../web/src/supporter-looks";
import { exportNameFonts } from "../src/export-name-fonts";
import { woff2ToTtf } from "../src/woff2";
import { startResvg } from "../src/resvg";

const fontsDir = new URL("../../web/src/assets/name-fonts/", import.meta.url).pathname;
const NAME_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.";

/** The sum of a font's 32-bit words, as the sfnt checksums count them. */
function sfntSum(font: Uint8Array): number {
  const padded = new Uint8Array(Math.ceil(font.length / 4) * 4);
  padded.set(font);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

test("name_fonts.hpp lists the website's name fonts in order", async () => {
  const header = await Bun.file(new URL("../src/name_fonts.hpp", import.meta.url)).text();
  const start = header.indexOf("name_font_ids = {");
  const list = header.slice(start, header.indexOf("};", start));
  expect([...list.matchAll(/"([a-z]+)"/g)].map((match) => match[1])).toEqual(NAME_FONTS.map((font) => font.id));
});

test("each WOFF2 name font unpacks to a well-formed TrueType font", async () => {
  for (const face of NAME_FONTS) {
    const font = woff2ToTtf(new Uint8Array(await readFile(join(fontsDir, `${face.id}.woff2`))));
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
    expect(view.getUint32(0), face.id).toBe(0x00010000);
    const tags: string[] = [];
    for (let i = 0; i < view.getUint16(4); i++) {
      const record = 12 + i * 16;
      const offset = view.getUint32(record + 8);
      const table = font.subarray(offset, offset + view.getUint32(record + 12));
      tags.push(String.fromCharCode(...font.subarray(record, record + 4)));
      if (tags.at(-1) !== "head") expect(sfntSum(table), `${face.id} ${tags.at(-1)}`).toBe(view.getUint32(record + 4));
    }
    expect(tags, face.id).toEqual([...tags].sort());
    expect(tags, face.id).toEqual(expect.arrayContaining(["cmap", "glyf", "head", "hmtx", "loca"]));
    // head's adjustment makes the whole font sum to the magic number.
    expect(sfntSum(font), face.id).toBe(0xb1b0afba);
  }
  expect(() => woff2ToTtf(new Uint8Array(48))).toThrow("Not a WOFF2 file");
});

test("the name-font sheet holds every font's letters, drawn", async () => {
  const Resvg = await startResvg();
  const out = await mkdtemp(join(tmpdir(), "name-fonts-"));
  expect(await exportNameFonts(out, Resvg, fontsDir)).toBe(NAME_FONTS.length);
  const sheet = JSON.parse(await readFile(join(out, "name-fonts.json"), "utf8"));
  await rm(out, { recursive: true });
  expect(sheet.em).toBe(40);
  expect(Object.keys(sheet.fonts)).toEqual(NAME_FONTS.map((font) => font.id));
  for (const face of NAME_FONTS) {
    const entry = sheet.fonts[face.id];
    expect(entry.size, face.id).toBe(face.size);
    const alpha = inflateSync(Buffer.from(entry.alpha, "base64"));
    expect(alpha.length, face.id).toBe(entry.width * entry.height);
    expect(entry.glyphs).toHaveLength(95);
    for (const letter of NAME_LETTERS) {
      const glyph = entry.glyphs[letter.charCodeAt(0) - 32];
      expect(glyph, `${face.id} ${letter}`).not.toBeNull();
      const [advance, x, y, width, height] = glyph;
      expect(advance, `${face.id} ${letter}`).toBeGreaterThan(0);
      let ink = 0;
      for (let row = y; row < y + height; row++)
        for (let column = x; column < x + width; column++) ink = Math.max(ink, alpha[row * entry.width + column]);
      expect(ink, `${face.id} ${letter}`).toBeGreaterThan(200);
    }
    // The space has an advance and no ink.
    expect(entry.glyphs[0][3] * entry.glyphs[0][4], face.id).toBe(0);
  }
});
