import { test, expect } from "bun:test";
import { applyState, settingsPatch, state, NATIVE_BIND_ACTIONS } from "./bridge";

// Host → menu state for the v27 additions: only well-formed values get in; a bad field leaves the last good one.
const ID = "AbCdEfGhIjKlMnOp";

test("practice state keeps the web's shape and bounds", () => {
  expect(state.practice.keepVelocity).toBe(true); // web prefs practice.keepVelocity default
  applyState({ practice: { available: true, mode: true, active: true, tool: "noclip", noclip: true, menuOpen: true, count: 4, current: 9, keepVelocity: false, unavailable: null } });
  expect(state.practice).toEqual({ available: true, unavailable: null, mode: true, active: true, thirdPerson: false, tool: "noclip", noclip: true, menuOpen: true, count: 4, current: 4, keepVelocity: false });
  applyState({ practice: { tool: "wallhack", count: -1, mode: "yes", unavailable: 7 } });
  expect(state.practice.tool).toBe("noclip");
  expect(state.practice.count).toBe(4);
  expect(state.practice.mode).toBe(true);
  applyState({ practice: { unavailable: "Practice is for solo play, not servers.", tool: null } });
  expect(state.practice.unavailable).toBe("Practice is for solo play, not servers.");
  expect(state.practice.tool).toBeNull();
});

test("gauntlet, player and music state", () => {
  applyState({ gauntlet: { id: "../x", map: "bad map" } });
  expect(state.gauntlet).toEqual({ id: null, map: null });
  applyState({ gauntlet: { id: ID, map: "bhop_a" } });
  expect(state.gauntlet).toEqual({ id: ID, map: "bhop_a" });
  applyState({ gauntlet: null });
  expect(state.gauntlet).toEqual({ id: null, map: null });
  applyState({ player: { map: "bhop_a", style: "nope", track: 0, mode: "solo" } });
  expect(state.player).toBeNull();
  applyState({ player: { map: "bhop_a", style: "sideways", track: 1, mode: "replay", practice: true } });
  expect(state.player).toEqual({ map: "bhop_a", style: "sideways", track: 1, mode: "replay", practice: true });
  applyState({ music: { id: "drift", title: "Drift (menu)", role: "menu", playing: true, available: true, loading: false, status: "" } });
  applyState({ music: { title: 42, playing: "yes" } });
  expect(state.music).toEqual({ id: "drift", title: "Drift (menu)", role: "menu", playing: true, available: true, loading: false, status: "" });
  applyState({ playback: { player: { runId: "run_1", name: "Other", id: "<script>" } } });
  expect(state.playback.player).toEqual({ runId: "run_1", name: "Other" });
});

test("settings: HUD scale in whole percents 50–175, keep speed, practice binds round-trip", () => {
  expect(settingsPatch({ hudScale: 125, practiceKeepVelocity: false })).toEqual({ hudScale: 125, practiceKeepVelocity: false });
  for (const bad of [49, 176, 100.5, "100", null]) expect(settingsPatch({ hudScale: bad })).toEqual({});
  for (const action of ["mainMenu", "practice", "noclip", "cpSave", "cpTeleport", "cpPrev", "cpNext"]) expect(NATIVE_BIND_ACTIONS).toContain(action as never);
  // The website's defaults: noclip on Z, third person on T. Show player clips is a native-only action with no key.
  expect(state.settings.binds.noclip).toEqual(["KeyZ"]);
  expect(state.settings.binds.thirdPerson).toEqual(["KeyT"]);
  expect(state.settings.binds.showTriggers).toEqual(["Mouse3"]);
  expect(state.settings.binds.showClips).toEqual([]);
  // The runner model is retired: the menu can't send it, even from an old settings file or another device.
  expect(settingsPatch({ playerModel: "runner", ghostModel: "runner" })).toEqual({});
  expect(settingsPatch({ playerModel: "bunny", ghostModel: "same" })).toEqual({ playerModel: "bunny", ghostModel: "same" });
  expect(state.settings.clipsVisible).toBe(false);
  expect(state.settings.weaponSounds).toBe(true);
  expect(settingsPatch({ clipsVisible: true, weaponSounds: false, binds: { noclip: ["Backquote"], showClips: ["KeyT"] } })).toEqual({ clipsVisible: true, weaponSounds: false, binds: { noclip: ["Backquote"], showClips: ["KeyT"] } });
  expect(state.settings.binds.cpSave).toEqual(["KeyC"]);
  expect(state.settings.binds.cpTeleport).toEqual(["KeyX"]);
  expect(state.settings.binds.practice).toEqual([]);
  expect(state.settings.binds.mainMenu).toEqual([]);
  expect(settingsPatch({ binds: { cpSave: ["KeyV"], noclip: ["Escape"] } })).toEqual({ binds: { cpSave: ["KeyV"] } });
});
