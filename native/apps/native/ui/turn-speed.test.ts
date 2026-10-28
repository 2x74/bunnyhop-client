import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseSettingsText } from "../../web/src/ui/settings-io";
import { settingsPatch, state } from "./bridge";
import { parsePresets } from "./settings-presets";
import { exportSettings, importSettings, readSettingsText } from "./settings-transfer";
import { migrateTurnSpeed, roundAngleSpeedKey, roundYawSpeed } from "./turn-speed";

// Exported by the website on v29/turn-speed (Settings → Export settings) with sensitivity 1.8, turn speed 300°/s,
// fast turn 2.5× and Fast turn bound to Left Shift.
const webCode = async (): Promise<string> =>
  (await readFile(new URL("./web-settings-v29.txt", import.meta.url), "utf8")).trim();

test("turn speed: a website v29 settings code imports both speeds and the fast-turn bind", async () => {
  const result = importSettings(await readSettingsText(await webCode()));
  expect(result.patch.sensitivity).toBe(1.8);
  expect(result.patch.yawSpeed).toBe(300);
  expect(result.patch.angleSpeedKey).toBe(2.5);
  expect(result.patch.binds?.turnFast).toEqual(["ShiftLeft"]);
  expect(result.unsupported).not.toContain("yawSpeed");
  expect(result.unsupported).not.toContain("angleSpeedKey");
});

test("turn speed: the website's JSON file imports the same, and a native export reads back unchanged", async () => {
  const parsed = await parseSettingsText(await webCode());
  if (!parsed.ok) throw new Error(parsed.error);
  const fromJson = importSettings(await readSettingsText(JSON.stringify(parsed.doc, null, 2)));
  expect(fromJson.patch.yawSpeed).toBe(300);
  expect(fromJson.patch.angleSpeedKey).toBe(2.5);
  expect(fromJson.patch.binds?.turnFast).toEqual(["ShiftLeft"]);

  const binds = { ...state.settings.binds, ...fromJson.patch.binds };
  const settings = { ...state.settings, ...fromJson.patch, binds };
  const exported = exportSettings(settings);
  expect(JSON.parse(exported).settings.yawSpeedAlt).toBeUndefined();
  const again = importSettings(await readSettingsText(exported));
  expect(again.unsupported).toEqual([]);
  expect(again.patch.yawSpeed).toBe(300);
  expect(again.patch.angleSpeedKey).toBe(2.5);
  expect(again.patch.binds?.turnFast).toEqual(["ShiftLeft"]);
});

test("turn speed: the host's ranges are enforced and the old modifier speed is never sent", () => {
  expect(settingsPatch({ yawSpeed: 60, angleSpeedKey: 1 })).toEqual({ yawSpeed: 60, angleSpeedKey: 1 });
  expect(settingsPatch({ yawSpeed: 720, angleSpeedKey: 4 })).toEqual({ yawSpeed: 720, angleSpeedKey: 4 });
  expect(settingsPatch({ yawSpeed: 59, angleSpeedKey: 4.01 })).toEqual({});
  expect(settingsPatch({ yawSpeed: Number.NaN, angleSpeedKey: "2" })).toEqual({});
  expect(settingsPatch({ yawSpeedAlt: 420 })).toEqual({});
  expect(state.settings.angleSpeedKey).toBe(2);
  expect("yawSpeedAlt" in state.settings).toBe(false);
});

test("turn speed: an older native file or preset turns its modifier speed into a multiplier", () => {
  expect(migrateTurnSpeed({ yawSpeed: 200, yawSpeedAlt: 500 })).toEqual({ yawSpeed: 200, angleSpeedKey: 2.5 });
  // As the host does with its own settings file: the result is clamped into range.
  expect(migrateTurnSpeed({ yawSpeed: 1000, yawSpeedAlt: 90 })).toEqual({ yawSpeed: 720, angleSpeedKey: 1 });
  expect(migrateTurnSpeed({ yawSpeedAlt: 840 })).toEqual({ angleSpeedKey: 4 });
  // A file that already has the multiplier keeps it.
  expect(migrateTurnSpeed({ yawSpeed: 210, yawSpeedAlt: 630, angleSpeedKey: 1.5 }))
    .toEqual({ yawSpeed: 210, angleSpeedKey: 1.5 });

  const oldFile = { format: "bunnyhop-native-settings", version: 1, settings: { yawSpeed: 150, yawSpeedAlt: 300 } };
  const old = importSettings(oldFile);
  expect(old.patch).toEqual({ yawSpeed: 150, angleSpeedKey: 2 });
  expect(old.unsupported).toEqual([]);

  const presets = parsePresets({ active: "", list: [{ name: "Old", settings: { yawSpeed: 100, yawSpeedAlt: 250 } }] });
  expect(presets.list[0].settings).toEqual({ yawSpeed: 100, angleSpeedKey: 2.5 });
});

test("turn speed: values are stored the way the website rounds them", () => {
  expect(roundYawSpeed(212.6)).toBe(213);
  expect(roundAngleSpeedKey(2.37)).toBe(2.35);
  expect(roundAngleSpeedKey(3.999)).toBe(4);
});
