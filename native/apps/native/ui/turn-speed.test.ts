import { expect, test } from "bun:test";
import { settingsPatch, state } from "./bridge";
import { migrateTurnSpeed } from "./turn-speed";

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
});
