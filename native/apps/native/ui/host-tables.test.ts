// Tables the host draws from that copy the website's data: map tiers (src/map_tiers.hpp), and the peak marks and pride
// flags of the HUD glyph sheet (src/hud_glyph_sheet.hpp, drawn by src/export-hud-glyphs.ts). When a re-sync changes
// the website's side, this fails; follow the change in the native file named in the test.
import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PRIDE_FLAGS } from "../../web/src/countries";
import { PEAK_TIERS, peakMarkId } from "../../web/src/creators";
import { MAX_TIER, TIER_COLORS, TIER_NAMES, TIER_UNKNOWN_COLOR, TIERS } from "../../web/src/tiers";
import { exportHudGlyphs } from "../src/export-hud-glyphs";

const source = (file: string) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text();

/** The quoted strings or 0x colours inside `name = { ... };` in a C++ header. */
function cppList(text: string, name: string, item: RegExp): string[] {
  const start = text.indexOf(`${name} = {`);
  expect(start, name).toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf("};", start));
  return [...body.matchAll(item)].map((match) => match[1]);
}

test("map_tiers.hpp has the website's ten tiers, names and colours", async () => {
  const header = await source("map_tiers.hpp");
  expect(header).toContain(`max_map_tier = ${MAX_TIER};`);
  const colors = cppList(header, "tier_rgb", /0x([0-9a-f]{6})/g).map((hex) => `#${hex}`);
  expect(colors).toEqual(TIERS.map((tier) => TIER_COLORS[tier]));
  expect(header).toContain(`tier_unknown_rgb = 0x${TIER_UNKNOWN_COLOR.slice(1)};`);
  expect(cppList(header, "tier_names", /"([^"]+)"/g)).toEqual(TIERS.map((tier) => TIER_NAMES[tier]));
});

test("hud_glyph_sheet.hpp places every peak mark and pride flag the exporter draws", async () => {
  const header = await source("hud_glyph_sheet.hpp");
  const ids = cppList(header, "sheet_glyph_ids", /"([^"]+)"/g);
  const drawn = [...PEAK_TIERS.map(peakMarkId), ...Object.keys(PRIDE_FLAGS)];
  expect(ids).toEqual(expect.arrayContaining(drawn));
  // The host may place a peak mark before the vendored website draws it; that cell stays empty until a re-sync.
  for (const id of ids.filter((id) => !drawn.includes(id))) expect(id).toMatch(/^peak-([1-9]|10)$/);
  expect(header).toContain(`std::array<std::string_view, ${ids.length}> sheet_glyph_ids`);

  const resvgPath = Bun.resolveSync("@resvg/resvg-wasm", import.meta.dir);
  const { initWasm, Resvg } = await import(resvgPath);
  await initWasm(await readFile(join(dirname(resvgPath), "index_bg.wasm")));
  const font = await readFile(new URL("../../../tools/hermes/fonts/JetBrainsMono-Bold.ttf", import.meta.url));
  const out = await mkdtemp(join(tmpdir(), "hud-glyphs-"));
  expect(await exportHudGlyphs(out, Resvg, font)).toBe(drawn.length);
  const sheet = JSON.parse(await readFile(join(out, "hud-glyphs.json"), "utf8"));
  expect(sheet.cell).toBe(32);
  expect(Object.keys(sheet.glyphs)).toEqual(drawn);
  for (const id of drawn) {
    const rgba = Buffer.from(sheet.glyphs[id], "base64");
    expect(rgba.length, id).toBe(32 * 32 * 4);
    // Drawn, not blank: the cell's middle is opaque.
    expect(rgba[(16 * 32 + 16) * 4 + 3], id).toBe(255);
  }
  await rm(out, { recursive: true });
});
