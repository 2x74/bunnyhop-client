import { test, expect } from "bun:test";
import { STYLE_DEFS } from "../../web/src/styles";
import { ROOM_WIRE_STYLES } from "./room-styles";

// The C++ client lists styles in room_styles.hpp: F3 follows menu_styles, the race picker race_styles.
const header = await Bun.file(new URL("../src/room_styles.hpp", import.meta.url)).text();

function cppList(name: string): string[] {
  const body = new RegExp(`${name} = \\{([^}]*)\\}`).exec(header)?.[1];
  if (!body) throw new Error(`no ${name} in room_styles.hpp`);
  return [...body.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
}

// Styles the vendored website knows keep its menu order; the rest are styles it doesn't have yet.
function inWebsiteOrder(ids: string[]): string[] {
  const known = new Set<string>(STYLE_DEFS.map((d) => d.id));
  return ids.filter((id) => known.has(id));
}

test("F3 follows the website's style menu and covers every wire style", () => {
  const menu = cppList("menu_styles");
  expect(inWebsiteOrder(menu)).toEqual(STYLE_DEFS.map((d) => d.id));
  expect([...menu].sort()).toEqual([...ROOM_WIRE_STYLES].sort());
});

test("the race picker offers every style but Segmented, in menu order", () => {
  const menu = cppList("menu_styles");
  expect(cppList("race_styles")).toEqual(menu.filter((id) => id !== "segmented"));
});
