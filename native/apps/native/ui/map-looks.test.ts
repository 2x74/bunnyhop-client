import { afterEach, expect, test } from "bun:test";
import type { ChatContext } from "../../web/src/chat-commands";
import { MAP_LOOK_CAP } from "../../web/src/map-look";
import { DEFAULT_PREFS, prefs } from "../../web/src/ui/settings";
import { state } from "./bridge";
import { brightCommand, fullbrightCommand, mergeHostLooks } from "./map-looks";
import { hostSettings, nativeView, pullHost, type HostSettings } from "./prefs-bridge";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const keysBefore = state.settingsKeys;

afterEach(() => {
  prefs.update((p) => {
    p.mapLooks = {};
  });
  state.settingsKeys = keysBefore;
  state.extraSettings = {};
});

function chat() {
  const replies: string[] = [];
  const context = { where: "solo", reply: (text: string) => replies.push(text) } as unknown as ChatContext;
  return { replies, context };
}

test("the host's looks keep my order; what it changed or added counts as the latest", () => {
  const mine = { bhop_a: { brightness: 1.2 }, bhop_b: { fullbright: true }, bhop_c: { brightness: 0.8 } };
  const host = {
    bhop_c: { brightness: 0.8 },
    bhop_a: { brightness: 1.3 },
    bhop_d: { fullbright: true },
    "bad name": { brightness: 1.1 },
    prototype: { fullbright: true },
    bhop_e: { brightness: "loud" },
  };
  const merged = mergeHostLooks(mine, host);
  expect(Object.keys(merged)).toEqual(["bhop_c", "bhop_a", "bhop_d"]);
  expect(merged.bhop_a).toEqual({ brightness: 1.3 });
  expect(mergeHostLooks(mine, "junk")).toEqual({});
});

test("a map the host adds past the cap drops the oldest", () => {
  const mine = Object.fromEntries(Array.from({ length: MAP_LOOK_CAP }, (_, i) => [`bhop_${i}`, { brightness: 1.1 }]));
  const merged = mergeHostLooks(mine, { ...mine, bhop_new: { fullbright: true } });
  const names = Object.keys(merged);
  expect(names.length).toBe(MAP_LOOK_CAP);
  expect(names[0]).toBe("bhop_1");
  expect(names.at(-1)).toBe("bhop_new");
});

test("!bright sets, resets and opens the menu for the map you're on", () => {
  const { replies, context } = chat();
  let opened = 0;
  const open = () => opened++;
  brightCommand(context, "130", "bhop_aux_a9", open);
  expect(prefs.get().mapLooks.bhop_aux_a9).toEqual({ brightness: 1.3 });
  // A number over 2.5 is a percent, and the value stays in the slider's range.
  brightCommand(context, "250", "bhop_aux_a9", open);
  expect(prefs.get().mapLooks.bhop_aux_a9).toEqual({ brightness: 2 });
  brightCommand(context, "", "bhop_aux_a9", open);
  brightCommand(context, "loud", "bhop_aux_a9", open);
  brightCommand(context, "reset", "bhop_aux_a9", open);
  expect(prefs.get().mapLooks.bhop_aux_a9).toBeUndefined();
  brightCommand(context, "1.3", null, open);
  expect(opened).toBe(1);
  expect(replies).toEqual([
    "Brightness 130% on bhop_aux_a9.",
    "Brightness 200% on bhop_aux_a9.",
    "Use !bright 1.3, !bright reset, or !bright for the menu.",
    "bhop_aux_a9 uses your settings again.",
    "Not available here.",
  ]);
});

test("!fb switches this map's Fullbright, or sets it on or off", () => {
  const { replies, context } = chat();
  fullbrightCommand(context, "", "bhop_dumb_blocks_3");
  expect(prefs.get().mapLooks.bhop_dumb_blocks_3).toEqual({ fullbright: !DEFAULT_PREFS.graphics.fullbright });
  fullbrightCommand(context, "off", "bhop_dumb_blocks_3");
  fullbrightCommand(context, "maybe", "bhop_dumb_blocks_3");
  expect(prefs.get().mapLooks.bhop_dumb_blocks_3).toEqual({ fullbright: false });
  expect(replies).toEqual([
    "Fullbright on on bhop_dumb_blocks_3.",
    "Fullbright off on bhop_dumb_blocks_3.",
    "Use !fb, !fb on or !fb off.",
  ]);
});

test("the host gets every map's look and its changes come back into prefs", () => {
  state.settingsKeys = [...Object.keys(state.settings), "mapLooks"];
  const p = clone(prefs.get());
  p.mapLooks = { bhop_a: { brightness: 1.2 } };
  const host = (mapLooks: unknown) => ({ ...hostSettings(), mapLooks }) as HostSettings;
  expect(nativeView(p, host({})).mapLooks).toEqual({ bhop_a: { brightness: 1.2 } });
  // The same looks are no change.
  expect(pullHost(p, host({ bhop_a: { brightness: 1.2 } }))).not.toContain("mapLooks");
  expect(pullHost(p, host({ bhop_a: { brightness: 1.2 }, bhop_b: { fullbright: true } }))).toContain("mapLooks");
  expect(p.mapLooks).toEqual({ bhop_a: { brightness: 1.2 }, bhop_b: { fullbright: true } });
});
