import { test, expect } from "bun:test";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { state, settingsPatch } from "./bridge";
import { DEFAULT_ANNOUNCER, announcerPatch } from "./audio-settings";
import { hostSettings, nativeView, pullHost, type HostSettings } from "./prefs-bridge";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("announcer and granular channel settings validate atomically", () => {
  for (const invalid of [
    { speedThreshold: 0 },
    { streakThreshold: 2.5 },
    { volume: Infinity },
    { wr: "file:///tmp/sound.wav" },
    { evil: true },
  ]) {
    expect(announcerPatch(invalid, DEFAULT_ANNOUNCER)).toBeNull();
  }
  expect(settingsPatch({ ambienceVolume: 2, announcer: { streakThreshold: 1 } })).toEqual({});
});

test("the website's audio settings are the native buses, mutes and announcer", () => {
  const prefs = clone(DEFAULT_PREFS);
  Object.assign(prefs.audio, { sfx: 0.3, ambience: 0.4, classic: true, perfectTick: true, muteInBackground: false });
  prefs.audio.map = 0.25;
  prefs.audio.mute = { sfx: true, ui: true, ambience: true, music: true, map: true };
  prefs.audio.announcer = { ...prefs.audio.announcer, enabled: true, highSpeedThreshold: 3200 };
  const native = nativeView(prefs, hostSettings());
  expect(native).toMatchObject({
    sfxVolume: 0.3,
    ambienceVolume: 0.4,
    mapVolume: 0.25,
    muteMap: true,
    classicSounds: true,
    perfectTick: true,
    muteSfx: true,
    muteUi: true,
    muteAmbience: true,
    muteMusic: true,
    muteInBackground: false,
    announcer: { enabled: true, highSpeedThreshold: 3200 },
  });
  const back = clone(DEFAULT_PREFS);
  pullHost(back, { ...hostSettings(), ...native } as HostSettings);
  expect(back.audio).toEqual(prefs.audio);
  expect(state.settings.announcer).toEqual(DEFAULT_ANNOUNCER);
});

test("map sounds keep the website default and reject invalid host levels", () => {
  expect(state.settings.mapVolume).toBe(DEFAULT_PREFS.audio.map);
  expect(state.settings.mapVolume).toBe(0.5);
  expect(state.settings.muteMap).toBe(false);
  expect(settingsPatch({ mapVolume: -1 })).toEqual({});
  expect(settingsPatch({ mapVolume: Infinity })).toEqual({});
  expect(settingsPatch({ mapVolume: 1.1 })).toEqual({});
  expect(settingsPatch({ mapVolume: 0, muteMap: true })).toEqual({ mapVolume: 0, muteMap: true });
});
