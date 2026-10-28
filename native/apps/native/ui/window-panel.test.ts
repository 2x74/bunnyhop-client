import { test, expect } from "bun:test";
import { settingsPatch, nativeKeyCode } from "./bridge";
test("window settings accept only defined modes and strict booleans", () => {
  expect(
    settingsPatch({
      windowMode: "borderless",
      alwaysOnTop: true,
      rememberWindowBounds: false,
      minimizeOnFocusLoss: true,
    }),
  ).toEqual({ windowMode: "borderless", alwaysOnTop: true, rememberWindowBounds: false, minimizeOnFocusLoss: true });
  expect(
    settingsPatch({
      windowMode: "exclusive-random",
      alwaysOnTop: 1,
      rememberWindowBounds: "yes",
      minimizeOnFocusLoss: null,
      windowBounds: { x: -500, width: 0 },
    }),
  ).toEqual({});
  expect(nativeKeyCode("F10")).toBe(false);
});
