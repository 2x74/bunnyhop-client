// Build-time only: the peak marks and pride flags the HUD draws after names and in the flag column, rasterized from
// the website's own SVGs into hud-glyphs.json (src/hud_glyph_sheet.hpp places them in the glyph atlas).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PEAK_TIERS, peakMarkId, SPECIAL_BADGES } from "../../web/src/creators";
import { PRIDE_FLAGS } from "../../web/src/countries";
import { prideFlagSvg } from "../../web/src/ui/pride-flags";

/** One atlas cell (hud_theme.hpp hud_glyph_cell). */
const CELL = 32;

interface Rendered {
  pixels: Uint8Array;
  free(): void;
}
interface Rasterizer {
  render(): Rendered;
  free(): void;
}
type ResvgClass = new (svg: string, options: object) => Rasterizer;

/** The 24-unit mark drawings (creators.ts SPECIAL_BADGES), at the cell's size. */
function markSvg(id: string): string {
  const mark = SPECIAL_BADGES[id];
  if (!mark) throw Error(`No mark drawing for ${id}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}" viewBox="0 0 24 24">${mark.svg}</svg>`;
}

/** A pride flag stretched over the whole cell, as the country flags fill theirs. */
function flagSvg(code: string): string {
  const svg = prideFlagSvg(code);
  if (!svg) throw Error(`No pride flag drawing for ${code}`);
  return svg.replace("<svg ", `<svg width="${CELL}" height="${CELL}" `);
}

function rasterize(Resvg: ResvgClass, svg: string, font: Uint8Array): Uint8Array {
  // The peak marks engrave their tier in a system sans; the bundled HUD font stands in for it.
  const rasterizer = new Resvg(svg, {
    font: {
      fontBuffers: [font],
      loadSystemFonts: false,
      defaultFontFamily: "JetBrains Mono",
      sansSerifFamily: "JetBrains Mono",
    },
  });
  const image = rasterizer.render();
  const pixels = Uint8Array.from(image.pixels);
  image.free();
  rasterizer.free();
  if (pixels.length !== CELL * CELL * 4) throw Error("A HUD glyph rendered at the wrong size");
  return pixels;
}

/** Writes hud-glyphs.json: {cell, glyphs: {id: base64 RGBA}}. Returns how many glyphs it holds. */
export async function exportHudGlyphs(out: string, Resvg: ResvgClass, font: Uint8Array): Promise<number> {
  const drawings: [string, string][] = [
    ...PEAK_TIERS.map((tier): [string, string] => [peakMarkId(tier), markSvg(peakMarkId(tier))]),
    ...Object.keys(PRIDE_FLAGS).map((code): [string, string] => [code, flagSvg(code)]),
  ];
  const glyphs: Record<string, string> = {};
  for (const [id, svg] of drawings) glyphs[id] = Buffer.from(rasterize(Resvg, svg, font)).toString("base64");
  await writeFile(join(out, "hud-glyphs.json"), JSON.stringify({ cell: CELL, glyphs }));
  return drawings.length;
}
