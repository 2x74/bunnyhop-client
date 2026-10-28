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
  prefs.audio.mute = { sfx: true, ui: true, ambience: true, music: true };
  prefs.audio.announcer = { ...prefs.audio.announcer, enabled: true, highSpeedThreshold: 3200 };
  const native = nativeView(prefs, hostSettings());
  expect(native).toMatchObject({
    sfxVolume: 0.3,
    ambienceVolume: 0.4,
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
