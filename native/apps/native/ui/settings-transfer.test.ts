import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  buildSettingsDoc,
  encodeSettingsCode,
  parseSettingsText,
  planSettingsImport,
} from "../../web/src/ui/settings-io";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { loadProfiles } from "../../web/src/ui/settings-profiles";
import { state } from "./bridge";
import { hostSettings, nativeView } from "./prefs-bridge";
import { parseOldPresets, presetsToProfiles } from "./settings-presets";
import { mergeSettings, nativeOnlySettings, syncDocument } from "./settings-sync";
import { prefsFromNative, websiteSettingsText } from "./settings-transfer";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Storage for the presets migration. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

// Exported by the website on v29/turn-speed (Settings → Export settings) with sensitivity 1.8, turn speed 300°/s,
// fast turn 2.5× and Fast turn bound to Left Shift.
const websiteCode = async (): Promise<string> =>
  (await readFile(new URL("./web-settings-v29.txt", import.meta.url), "utf8")).trim();

test("a website settings code imports as on the website and becomes native settings", async () => {
  const parsed = await parseSettingsText(await websiteCode());
  if (!parsed.ok) throw new Error(parsed.error);
  const plan = planSettingsImport(parsed.doc, clone(DEFAULT_PREFS));
  expect(plan.next.sensitivity).toBe(1.8);
  const native = nativeView(plan.next, hostSettings());
  expect(native).toMatchObject({ sensitivity: 1.8, yawSpeed: 300, angleSpeedKey: 2.5 });
  expect((native.binds as Record<string, string[]>).turnFast).toEqual(["ShiftLeft"]);
});

test("a bhs1. code from the native client reads back the same on the website", async () => {
  const prefs = clone(DEFAULT_PREFS);
  prefs.sensitivity = 3.25;
  prefs.crosshair.style = "dot";
  prefs.binds.noclip = ["Backquote"];
  const code = await encodeSettingsCode(buildSettingsDoc(prefs));
  expect(code.startsWith("bhs1.")).toBe(true);
  const parsed = await parseSettingsText(`here's mine: ${code} gl`);
  if (!parsed.ok) throw new Error(parsed.error);
  const plan = planSettingsImport(parsed.doc, clone(DEFAULT_PREFS));
  expect(plan.invalid).toEqual([]);
  expect(plan.skipped).toEqual([]);
  expect(plan.next).toEqual(prefs);
});

test("an old native settings file imports through the website's dialog", async () => {
  const old = {
    format: "bunnyhop-native-settings",
    version: 1,
    settings: { sensitivity: 1.5, yawSpeed: 150, yawSpeedAlt: 300, crosshair: false },
  };
  const parsed = await parseSettingsText(websiteSettingsText(JSON.stringify(old)));
  if (!parsed.ok) throw new Error(parsed.error);
  const plan = planSettingsImport(parsed.doc, clone(DEFAULT_PREFS));
  expect(plan.next.sensitivity).toBe(1.5);
  expect(plan.next.yawSpeed).toBe(150);
  expect(plan.next.angleSpeedKey).toBe(2);
  expect(plan.next.crosshair.style).toBe("none");
  // Anything else is left for the website's parser to judge.
  expect(websiteSettingsText("bhs1.abc")).toBe("bhs1.abc");
});

test("old native presets become website profiles once, without their mouse settings", () => {
  const storage = memoryStorage();
  const raw = JSON.stringify({
    active: "",
    list: [
      { name: "Practice", settings: { sensitivity: 9, crosshairColor: "#ff0000", hudScale: 140 } },
      { name: "  Racing  ", settings: { keysOverlay: false } },
      { name: "", settings: { fov: 100 } },
      "junk",
    ],
  });
  const presets = parseOldPresets(raw);
  expect(presets.map((preset) => preset.name)).toEqual(["Practice", "  Racing  "]);
  expect(presetsToProfiles(presets, storage)).toEqual(["Practice", "Racing"]);
  const profiles = loadProfiles(storage);
  const practice = profiles.list[0].settings as {
    crosshair: { color: string };
    hud: { scale: number };
    sensitivity?: number;
  };
  expect(practice.crosshair.color).toBe("#ff0000");
  expect(practice.hud.scale).toBe(1.4);
  expect(practice.sensitivity).toBeUndefined();
  expect(profiles.active).toBeNull();
  // A profile of that name already there wins.
  expect(presetsToProfiles(presets, storage)).toEqual([]);
});

test("the account copy keeps what this build doesn't know and carries native-only settings", () => {
  const remote = { sensitivity: 1, graphics: { preset: "source", futureKnob: 3 }, futureTop: { on: true } };
  const merged = mergeSettings(remote, { sensitivity: 2, graphics: { preset: "classic" } });
  expect(merged).toEqual({ sensitivity: 2, graphics: { preset: "classic", futureKnob: 3 }, futureTop: { on: true } });
  const native = nativeOnlySettings();
  expect(native).toMatchObject({ discordJoin: state.settings.discordJoin, sfxPack: "default", waterQuality: "simple" });
  for (const left of ["windowMode", "alwaysOnTop", "mouseDiagnostics", "sensitivity", "playerModel", "ghostModel"]) {
    expect(left in native).toBe(false);
  }
  const doc = syncDocument({ format: "bunnyhop.lol/settings", version: 1, exported: "", settings: remote as never });
  expect(doc.settings.native).toEqual(native);
  expect((doc.settings as Record<string, unknown>).futureTop).toEqual({ on: true });
  expect(prefsFromNative({ sensitivity: 4 }).sensitivity).toBe(4);
});
