import { afterEach, expect, test } from "bun:test";
import { DEFAULT_PREFS, type Prefs } from "../../web/src/ui/settings";
import { state } from "./bridge";
import { MAPPINGS, hostCan, hostSettings, nativeView, patchBetween, pullHost, type HostSettings } from "./prefs-bridge";
import { REQUESTED_KEYS, followsRule, nativeKeyFor, readPath, requestedDefault } from "./settings-keys";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const host = (settings: Record<string, unknown> = {}): HostSettings => {
  const base = hostSettings();
  return { ...base, ...settings, binds: { ...base.binds, ...(settings.binds as object) } } as HostSettings;
};
const original = clone({ settings: state.settings, keys: state.settingsKeys, binds: state.bindActions });

afterEach(() => {
  state.settings = clone(original.settings);
  state.settingsKeys = original.keys;
  state.bindActions = original.binds;
  state.capabilities = null;
  state.extraSettings = {};
});

test("the website's defaults stand for the native defaults", () => {
  const view = nativeView(clone(DEFAULT_PREFS), host());
  // The website starts with the FPS counter off; the native HUD layout starts empty (every element shown).
  expect(view.hudLayout).toMatchObject({ fps: { visible: false } });
  delete view.hudLayout;
  for (const [key, value] of Object.entries(view)) expect([key, value]).toEqual([key, (state.settings as never)[key]]);
});

test("every native value the host holds comes back unchanged through prefs", () => {
  const changed = host({
    sensitivity: 1.37,
    separateVertical: true,
    verticalSensitivity: 0.8,
    fov: 104,
    yawSpeed: 300,
    angleSpeedKey: 2.5,
    crosshairStyle: "t",
    crosshairColor: "#00e5ff",
    crosshairGap: 7,
    hudScale: 135,
    hud: false,
    keysStyle: "minimal",
    keysOverlay: false,
    speedGraph: true,
    jumpStats: true,
    jumpStatsMode: "every",
    viewmodelLeftHand: true,
    viewmodelFov: 61,
    ghostOpacity: 0.7,
    musicVolume: 0.3,
    muteUi: true,
    sourceLook: false,
    fpsLimit: 240,
    practiceKeepVelocity: false,
    mouseDiagnostics: true,
    timedInput: false,
    announcer: { ...state.settings.announcer, enabled: true, pb: "holyshit" },
    hudLayout: { timer: { x: 50, y: 40, visible: false }, keys: { x: 10, y: 90, scale: 1.5 } },
    binds: { jump: ["Space"], turnFast: ["ShiftLeft"], noclip: ["Backquote"] },
  });
  const prefs = clone(DEFAULT_PREFS);
  pullHost(prefs, changed);
  expect(prefs.sensitivity).toBe(1.37);
  expect(prefs.crosshair.style).toBe("t");
  expect(prefs.hud.scale).toBe(1.35);
  expect(prefs.hud.hidden).toBe(true);
  expect(prefs.hud.layout.timer.on).toBe(false);
  expect(prefs.hud.layout.keys.s).toBe(1.5);
  expect(prefs.graphics.preset).toBe("classic");
  expect(prefs.binds.turnFast).toEqual(["ShiftLeft"]);
  const view = nativeView(prefs, changed);
  for (const [key, value] of Object.entries(view)) expect([key, value]).toEqual([key, changed[key]]);
});

test("what the web can't say keeps the host's detail", () => {
  const prefs = clone(DEFAULT_PREFS);
  // A switched-off crosshair is the web's "None"; turning it back on restores the style it had.
  const off = host({ crosshair: false, crosshairStyle: "circle" });
  pullHost(prefs, off);
  expect(prefs.crosshair.style).toBe("none");
  expect(nativeView(prefs, off)).toMatchObject({ crosshair: false, crosshairStyle: "circle" });
  // Every 4th jump shows as the web's "Every 6th" without becoming 6.
  const everyFourth = host({ jumpStatsMode: "interval", jumpStatsInterval: 4 });
  pullHost(prefs, everyFourth);
  expect(prefs.hud.ssj.mode).toBe("everySixth");
  expect(nativeView(prefs, everyFourth)).toMatchObject({ jumpStatsMode: "interval", jumpStatsInterval: 4 });
  prefs.hud.ssj.mode = "sixth";
  expect(nativeView(prefs, everyFourth)).toMatchObject({ jumpStatsMode: "sixth", jumpStatsInterval: 4 });
});

test("a change sends only the native keys it touches, binds action by action", () => {
  const before = clone(DEFAULT_PREFS);
  const after = clone(DEFAULT_PREFS);
  after.fov = 100;
  after.binds.thirdPerson = ["KeyY"];
  const current = host({ binds: { chat: ["KeyY"] } });
  const patch = patchBetween(nativeView(before, current), nativeView(after, current));
  // Y leaves the native-only chat bind, as a key leaves any other action on the website.
  expect(patch).toEqual({ fov: 100, binds: { thirdPerson: ["KeyY"], chat: [] } });
});

test("paint colour, size and paint keys reach the host", () => {
  const after = clone(DEFAULT_PREFS);
  after.paint = { color: "#40dcff", size: "large" };
  after.binds.paint = ["Mouse4"];
  after.binds.clearPaint = ["KeyX"];
  const patch = patchBetween(nativeView(clone(DEFAULT_PREFS), host()), nativeView(after, host()));
  expect(patch).toEqual({
    paint: { color: "#40dcff", size: "large" },
    binds: { paint: ["Mouse4"], clearPaint: ["KeyX"] },
  });
  // A colour outside the website's palette never reaches the host.
  after.paint = { color: "#123456", size: "large" };
  const off = patchBetween(nativeView(clone(DEFAULT_PREFS), host()), nativeView(after, host()));
  expect(off.paint).toEqual({ color: "#ff4040", size: "large" });
});

test("keys the native client can't read never reach the host", () => {
  const before = clone(DEFAULT_PREFS);
  const after = clone(DEFAULT_PREFS);
  after.binds.jump = [...after.binds.jump, "Numpad0"];
  const patch = patchBetween(nativeView(before, host()), nativeView(after, host()));
  expect(patch).toEqual({});
});

test("a host without a website key gets no patch for it, and its rows wait", () => {
  const after: Prefs = clone(DEFAULT_PREFS);
  after.hud.keys.opacity = 0.5;
  after.sensitivity = 3;
  expect(patchBetween(nativeView(clone(DEFAULT_PREFS), host()), nativeView(after, host()))).toEqual({ sensitivity: 3 });
  expect(hostCan("hudKeysOpacity")).toBe(false);
  // The build's own keys are always there: the host ships with this menu.
  state.settingsKeys = ["sensitivity"];
  expect(hostCan("fov")).toBe(true);
  state.settingsKeys = ["sensitivity", "hudKeysOpacity"];
  expect(hostCan("hudKeysOpacity")).toBe(true);
  expect(patchBetween(nativeView(clone(DEFAULT_PREFS), host()), nativeView(after, host()))).toEqual({
    sensitivity: 3,
    hudKeysOpacity: 0.5,
  });
});

test("capabilities: HUD elements and bind actions", () => {
  expect(hostCan("hud:timer")).toBe(true);
  expect(hostCan("hud:spectators")).toBe(false);
  expect(hostCan("bind:chat")).toBe(true);
  expect(hostCan("bind:paint")).toBe(true);
  state.capabilities = ["hud:timer", "hud:spectators"];
  expect(hostCan("hud:spectators")).toBe(true);
  expect(hostCan("hud:fps")).toBe(false);
  state.bindActions = ["jump", "chat"];
  expect(hostCan("bind:chat")).toBe(true);
  expect(hostCan("bind:paint")).toBe(false);
});

test("website settings the host adds later map by name, with the website's values and defaults", () => {
  expect(nativeKeyFor("hud.keys.rows.wasd")).toBe("hudKeysRowsWasd");
  for (const entry of REQUESTED_KEYS) {
    expect(readPath(DEFAULT_PREFS, entry.path)).not.toBeUndefined();
    expect([entry.key, followsRule(entry.rule, requestedDefault(entry))]).toEqual([entry.key, true]);
  }
  const keys = REQUESTED_KEYS.map((entry) => entry.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const mapping of MAPPINGS)
    for (const key of mapping.keys)
      expect(key in state.settings || keys.includes(key) || key === "hudLayoutWeb").toBe(true);
  state.settingsKeys = [...Object.keys(state.settings), "hudKeysOpacity"];
  state.extraSettings = { hudKeysOpacity: 0.6 };
  const prefs = clone(DEFAULT_PREFS);
  pullHost(prefs, host());
  expect(prefs.hud.keys.opacity).toBe(0.6);
  const before = nativeView(prefs, host());
  prefs.hud.keys.opacity = 0.4;
  expect(patchBetween(before, nativeView(prefs, host()))).toEqual({ hudKeysOpacity: 0.4 });
});
