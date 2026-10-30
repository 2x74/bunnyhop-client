import { expect, test } from "bun:test";
import { displayCatalog, fullscreenModePatch, settingsPatch, type DisplayInfo } from "./bridge";
import { chosenDisplay, displaySizes, sameShape, shapeName, sizeRates } from "./fullscreen-modes";

const dell: DisplayInfo = {
  name: "DELL S2721DGF",
  index: 0,
  window: false,
  primary: true,
  desktop: { width: 2560, height: 1440, refreshHz: 165 },
  modes: [
    { width: 2560, height: 1440, refreshHz: 165 },
    { width: 2560, height: 1440, refreshHz: 144 },
    { width: 1280, height: 960, refreshHz: 60 },
    { width: 1280, height: 960, refreshHz: 120 },
    { width: 1440, height: 1080, refreshHz: 120 },
  ],
};
const second: DisplayInfo = { ...dell, index: 1, window: true, primary: false };

test("resolutions are listed once, largest first, with their rates", () => {
  expect(displaySizes(dell).map((m) => `${m.width}x${m.height}`)).toEqual(["2560x1440", "1440x1080", "1280x960"]);
  expect(sizeRates(dell, 1280, 960)).toEqual([120, 60]);
  expect(shapeName(1280, 960)).toBe("4:3");
  expect(shapeName(1680, 1050)).toBe("16:10");
  expect(shapeName(3440, 1440)).toBe("21:9");
  expect(sameShape({ width: 1366, height: 768, refreshHz: 60 }, { width: 1920, height: 1080, refreshHz: 60 })).toBe(
    true,
  );
});

test("two monitors of the same model are told apart by their place", () => {
  const mode = { display: "DELL S2721DGF", displayIndex: 1, width: 0, height: 0, refreshHz: 0 };
  expect(chosenDisplay([dell, second], mode)?.index).toBe(1);
  expect(chosenDisplay([dell, second], { ...mode, display: "", displayIndex: -1 })?.index).toBe(1);
});

test("the host's modes and settings are checked before use", () => {
  expect(fullscreenModePatch({ display: "", displayIndex: -1, width: 1280, height: 960, refreshHz: 239.76 })).toEqual({
    display: "",
    displayIndex: -1,
    width: 1280,
    height: 960,
    refreshHz: 239.76,
  });
  expect(fullscreenModePatch({ display: "", displayIndex: -1, width: 1280, height: 0, refreshHz: 0 })).toBeNull();
  expect(fullscreenModePatch({ display: "", displayIndex: -1, width: 100, height: 100, refreshHz: 0 })).toBeNull();
  expect(settingsPatch({ fullscreenScaling: "bars" }).fullscreenScaling).toBe("bars");
  expect(settingsPatch({ fullscreenScaling: "center" }).fullscreenScaling).toBeUndefined();
  const catalog = displayCatalog({
    displays: [{ ...dell, modes: [...dell.modes, { width: 0, height: 0, refreshHz: 60 }, "x"] }, 5],
    exclusive: { width: 1280, height: 960, refreshHz: 120 },
  });
  expect(catalog?.displays).toHaveLength(1);
  expect(catalog?.displays[0].modes).toHaveLength(5);
  expect(catalog?.exclusive).toEqual({ width: 1280, height: 960, refreshHz: 120 });
  expect(displayCatalog("nope")).toBeNull();
});
