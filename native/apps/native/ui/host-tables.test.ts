// Tables the host draws from that copy the website's data: map tiers (src/map_tiers.hpp). When a re-sync changes the
// website's side, this fails; follow the change in the native file named in the test.
import { test, expect } from "bun:test";
import { MAX_TIER, TIER_COLORS, TIER_NAMES, TIER_UNKNOWN_COLOR, TIERS } from "../../web/src/tiers";

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
