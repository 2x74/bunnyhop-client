import { expect, test } from "bun:test";
import { buildSettingsDoc, encodeSettingsCode } from "../../web/src/ui/settings-io";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { importSettings, readSettingsText } from "./settings-transfer";

test("settings import: a website settings code (bhs1.) applies like its JSON", async () => {
  const prefs = { ...DEFAULT_PREFS, sensitivity: 3.25 };
  const code = await encodeSettingsCode(buildSettingsDoc(prefs));
  expect(code.startsWith("bhs1.")).toBe(true);
  // Pasted straight, or with chat noise around it.
  for (const text of [code, `here's mine: ${code} gl`]) {
    const result = importSettings(await readSettingsText(text));
    expect(result.patch.sensitivity).toBe(3.25);
  }
  // JSON keeps working: the web file and a native export.
  expect(importSettings(await readSettingsText(JSON.stringify(buildSettingsDoc(prefs)))).patch.sensitivity).toBe(3.25);
  expect(importSettings(await readSettingsText('{"format":"bunnyhop-native-settings","version":1,"settings":{"sensitivity":1.5}}')).patch.sensitivity).toBe(1.5);
});

test("settings import: clear messages for empty, damaged and non-settings text", async () => {
  await expect(readSettingsText("  ")).rejects.toThrow(/Paste a settings code/);
  await expect(readSettingsText("bhs1.AAAA-not-real")).rejects.toThrow(/damaged or cut off/);
  await expect(readSettingsText("hello")).rejects.toThrow(/Codes start with bhs1/);
});
