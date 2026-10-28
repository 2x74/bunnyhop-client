// The menu keeps the website's settings document (web ui/settings.ts `prefs`), so the website's settings screen,
// profiles, export and account sync work unchanged. This module keeps it and the host's native settings in step:
//
// - A change to prefs sends the native keys it changes, and only the keys the host has ({type:"settings", patch}).
// - A host state whose settings differ from what prefs stand for writes the host's values into prefs.
//
// Which settings the host has: the keys of its settings object, plus any `capabilities` it lists (HUD elements as
// "hud:<web element id>"). Before the host has said, the menu assumes this build's native keys (bridge.ts).

import { CLASSIC, type HudLayout as WebHudLayout } from "../../web/src/hud/layout";
import { DEFAULT_PREFS, keyLabel, prefs, type Action, type Prefs } from "../../web/src/ui/settings";
import { toast } from "../../web/src/notify";
import { NATIVE_BIND_ACTIONS, nativeKeyCode, send, settingsPatch, state, type SettingsPatch } from "./bridge";
import { defaultPosition, type HudElementId, type HudLayout as NativeHudLayout } from "./hud-layout";
import { REQUESTED_KEYS, readPath, requestedPatch, writePath } from "./settings-keys";

/** The host's settings as one object: native keys and the website keys it has added. */
export type HostSettings = Record<string, unknown> & typeof state.settings;

export interface Mapping {
  /** The native keys it writes. */
  keys: readonly string[];
  /** The native values these prefs stand for. Lossy mappings keep the host's detail where the web can't say it. */
  toNative: (p: Prefs, host: HostSettings) => Record<string, unknown>;
  /** Writes the host's values into prefs. */
  toPrefs: (p: Prefs, host: HostSettings) => void;
}

/** A web pref path that holds exactly the native value. */
function direct(path: string, key: string): Mapping {
  return {
    keys: [key],
    toNative: (p) => ({ [key]: readPath(p, path) }),
    toPrefs: (p, host) => {
      if (host[key] !== undefined) writePath(p, path, host[key]);
    },
  };
}

const DIRECT: readonly [string, string][] = [
  ["sensitivity", "sensitivity"],
  ["verticalSensitivityEnabled", "separateVertical"],
  ["verticalSensitivity", "verticalSensitivity"],
  ["invertY", "invertY"],
  ["timedInput", "timedInput"],
  ["inputStats", "mouseDiagnostics"],
  ["fov", "fov"],
  ["yawSpeed", "yawSpeed"],
  ["angleSpeedKey", "angleSpeedKey"],
  ["crosshair.color", "crosshairColor"],
  ["crosshair.size", "crosshairSize"],
  ["crosshair.thickness", "crosshairThickness"],
  ["crosshair.gap", "crosshairGap"],
  ["crosshair.alpha", "crosshairAlpha"],
  ["crosshair.outline", "crosshairOutline"],
  ["colorBlind", "colorBlind"],
  ["hud.speedColors", "speedColors"],
  ["hud.gainTicks", "gainTicks"],
  ["hud.keys.style", "keysStyle"],
  ["hud.layout.keys.on", "keysOverlay"],
  ["hud.layout.graph.on", "speedGraph"],
  ["hud.layout.jumpStats.on", "jumpStats"],
  ["hud.layout.strafeTrainer.on", "strafeTrainer"],
  ["hud.strafeTrainer.smoothing", "strafeTrainerSmoothing"],
  ["hud.strafeTrainer.hints", "strafeTrainerHints"],
  ["showGhost", "showGhost"],
  ["ghost.opacity", "ghostOpacity"],
  ["ghost.nearFade", "ghostNearFade"],
  ["ghost.tag", "ghostTag"],
  ["showPlayerGlow", "showPlayerGlow"],
  ["firstPersonGlow", "firstPersonGlow"],
  ["showZones", "zonesVisible"],
  ["triggers.show", "triggersVisible"],
  ["triggers.clips", "clipsVisible"],
  ["viewmodel.show", "viewmodel"],
  ["viewmodel.fov", "viewmodelFov"],
  ["viewmodel.x", "viewmodelX"],
  ["viewmodel.y", "viewmodelY"],
  ["viewmodel.z", "viewmodelZ"],
  ["viewmodel.bob", "viewmodelBob"],
  ["viewmodel.sway", "viewmodelSway"],
  ["volume", "volume"],
  ["audio.music", "musicVolume"],
  ["audio.sfx", "sfxVolume"],
  ["audio.ui", "uiVolume"],
  ["audio.ambience", "ambienceVolume"],
  ["audio.muted", "muted"],
  ["audio.mute.music", "muteMusic"],
  ["audio.mute.sfx", "muteSfx"],
  ["audio.mute.ui", "muteUi"],
  ["audio.mute.ambience", "muteAmbience"],
  ["audio.classic", "classicSounds"],
  ["audio.footsteps", "footsteps"],
  ["audio.wind", "wind"],
  ["audio.others", "othersAudio"],
  ["audio.ghosts", "ghostAudio"],
  ["audio.muteInBackground", "muteInBackground"],
  ["audio.perfectIndicator", "perfectIndicator"],
  ["audio.perfectTick", "perfectTick"],
  ["practice.keepVelocity", "practiceKeepVelocity"],
  ["holdRestart", "holdRestart"],
  ["graphics.fpsLimit", "fpsLimit"],
];

/** Crosshair "None" is the native crosshair switched off; the style it had is kept for when it comes back. */
const crosshairStyle: Mapping = {
  keys: ["crosshairStyle", "crosshair"],
  toNative: (p, host) => {
    const style = p.crosshair.style;
    if (style === "none" && host.crosshair === false) return { crosshairStyle: host.crosshairStyle, crosshair: false };
    return { crosshairStyle: style, crosshair: style !== "none" };
  },
  toPrefs: (p, host) => {
    p.crosshair.style = host.crosshair === false ? "none" : host.crosshairStyle;
  },
};

/** The web's "Every 6th" is the native "every N" with N = 6; other intervals stay the host's. */
const jumpStatsMode: Mapping = {
  keys: ["jumpStatsMode", "jumpStatsInterval"],
  toNative: (p, host) => {
    const mode = p.hud.ssj.mode;
    if (mode !== "everySixth") return { jumpStatsMode: mode, jumpStatsInterval: host.jumpStatsInterval };
    const interval = host.jumpStatsMode === "interval" ? host.jumpStatsInterval : 6;
    return { jumpStatsMode: "interval", jumpStatsInterval: interval };
  },
  toPrefs: (p, host) => {
    p.hud.ssj.mode = host.jumpStatsMode === "interval" ? "everySixth" : host.jumpStatsMode;
  },
};

const hand: Mapping = {
  keys: ["viewmodelLeftHand"],
  toNative: (p) => ({ viewmodelLeftHand: p.viewmodel.hand === "left" }),
  toPrefs: (p, host) => {
    p.viewmodel.hand = host.viewmodelLeftHand ? "left" : "right";
  },
};

const hideUi: Mapping = {
  keys: ["hud"],
  toNative: (p) => ({ hud: !p.hud.hidden }),
  toPrefs: (p, host) => {
    p.hud.hidden = !host.hud;
  },
};

/** The web's 0.5–1.75 in percent; the host keeps whole percents. */
const hudScale: Mapping = {
  keys: ["hudScale"],
  toNative: (p) => ({ hudScale: Math.round(p.hud.scale * 100) }),
  toPrefs: (p, host) => {
    if (Math.round(p.hud.scale * 100) !== host.hudScale) p.hud.scale = host.hudScale / 100;
  },
};

/** The look: the Source look on or off. Enhanced and Cinematic are Source-based web looks. */
const look: Mapping = {
  keys: ["sourceLook"],
  toNative: (p) => ({ sourceLook: p.graphics.preset !== "classic" }),
  toPrefs: (p, host) => {
    if (!host.sourceLook) p.graphics.preset = "classic";
    else if (p.graphics.preset === "classic") p.graphics.preset = "source";
  },
};

const announcer: Mapping = {
  keys: ["announcer"],
  toNative: (p) => ({ announcer: { ...p.audio.announcer } }),
  toPrefs: (p, host) => {
    Object.assign(p.audio.announcer, host.announcer);
  },
};

/** Web HUD elements the native HUD draws with its own ids. The keys overlay has its own switch (keysOverlay). */
const LAYOUT_IDS: readonly [keyof WebHudLayout, HudElementId][] = [
  ["speed", "speed"],
  ["timer", "timer"],
  ["split", "splits"],
  ["stats", "runStats"],
  ["map", "map"],
  ["fps", "fps"],
  ["ammo", "health"],
];

function screenSize(): [number, number] {
  const width = typeof innerWidth === "number" && innerWidth > 0 ? innerWidth : 1600;
  const height = typeof innerHeight === "number" && innerHeight > 0 ? innerHeight : 900;
  return [width, height];
}

/** A native layout entry, placed where the element sits by default when it has no place yet. */
function nativeEntry(layout: NativeHudLayout, id: HudElementId): NonNullable<NativeHudLayout[HudElementId]> {
  const [width, height] = screenSize();
  return { ...(layout[id] ?? defaultPosition(id, width, height)) };
}

/**
 * The native HUD's own layout (percent positions the menu's placement canvas edits): the web's element switches and
 * the keys overlay size become its `visible` and `scale`. An element without an entry is shown at scale 1.
 */
const nativeLayout: Mapping = {
  keys: ["hudLayout"],
  toNative: (p, host) => {
    const layout: NativeHudLayout = { ...(host.hudLayout ?? {}) };
    for (const [webId, id] of LAYOUT_IDS) {
      const on = p.hud.layout[webId].on;
      if (on === (layout[id]?.visible !== false)) continue;
      layout[id] = { ...nativeEntry(layout, id), visible: on };
    }
    const size = p.hud.layout.keys.s;
    if (size !== (layout.keys?.scale ?? 1)) layout.keys = { ...nativeEntry(layout, "keys"), scale: size };
    return { hudLayout: layout };
  },
  toPrefs: (p, host) => {
    const layout = host.hudLayout ?? {};
    for (const [webId, id] of LAYOUT_IDS) p.hud.layout[webId].on = layout[id]?.visible !== false;
    p.hud.layout.keys.s = layout.keys?.scale ?? 1;
  },
};

/** Once the host takes the website's layout model it gets the whole layout, places included. */
const webLayout: Mapping = {
  keys: ["hudLayoutWeb"],
  toNative: (p) => ({ hudLayoutWeb: JSON.parse(JSON.stringify(p.hud.layout)) }),
  toPrefs: (p, host) => {
    const layout = host.hudLayoutWeb;
    if (!layout || typeof layout !== "object") return;
    for (const id of Object.keys(CLASSIC) as (keyof WebHudLayout)[]) {
      const place = (layout as Record<string, unknown>)[id];
      if (place && typeof place === "object") Object.assign(p.hud.layout[id], place);
    }
  },
};

const NATIVE_ONLY_ACTIONS = NATIVE_BIND_ACTIONS.filter((action) => !(action in DEFAULT_PREFS.binds));
const SHARED_ACTIONS = NATIVE_BIND_ACTIONS.filter((action) => action in DEFAULT_PREFS.binds) as Action[];

/**
 * Key binds. The web's actions take its binds; a key one of them takes leaves the native-only actions (chat, the
 * scoreboard...), as it leaves any other web action. Keys the native client can't read aren't sent.
 */
const binds: Mapping = {
  keys: ["binds"],
  toNative: (p, host) => {
    const out: Record<string, string[]> = {};
    const taken = new Set<string>();
    for (const action of SHARED_ACTIONS) {
      out[action] = p.binds[action].filter(nativeKeyCode);
      for (const code of out[action]) taken.add(code);
    }
    for (const action of NATIVE_ONLY_ACTIONS) {
      out[action] = (host.binds[action] ?? []).filter((code) => !taken.has(code));
    }
    return { binds: out };
  },
  toPrefs: (p, host) => {
    for (const action of SHARED_ACTIONS) if (host.binds[action]) p.binds[action] = [...host.binds[action]];
  },
};

const requested: Mapping[] = REQUESTED_KEYS.map((entry) => direct(entry.path, entry.key));

export const MAPPINGS: readonly Mapping[] = [
  ...DIRECT.map(([path, key]) => direct(path, key)),
  crosshairStyle,
  jumpStatsMode,
  hand,
  hideUi,
  hudScale,
  look,
  announcer,
  nativeLayout,
  webLayout,
  binds,
  ...requested,
];

// ---------------------------------------------------------------------------------------------- what the host has

/** The native keys of this build. The host ships with its menu, so it always has them. */
const BUILD_KEYS = Object.keys(state.settings);
/** HUD elements the native HUD draws before it lists its own ("hud:<web id>"). */
const BUILD_ELEMENTS = [
  "speed",
  "timer",
  "split",
  "stats",
  "keys",
  "graph",
  "jumpStats",
  "map",
  "fps",
  "ammo",
  "strafeTrainer",
];

/** The host stores this settings key: one of the build's, or one its settings object carries. */
export function hostHas(key: string): boolean {
  return BUILD_KEYS.includes(key) || !!state.settingsKeys?.includes(key);
}

/** The host can do this ("hud:<element>", "bind:<action>", or any settings key). */
export function hostCan(capability: string): boolean {
  if (state.capabilities?.includes(capability)) return true;
  if (capability.startsWith("hud:")) return hudElementShown(capability.slice(4));
  if (capability.startsWith("bind:")) return bindable(capability.slice(5));
  return hostHas(capability);
}

/** Without a list from the host, the elements this build draws. */
function hudElementShown(id: string): boolean {
  if (state.capabilities?.some((item) => item.startsWith("hud:"))) return false;
  return BUILD_ELEMENTS.includes(id);
}

function bindable(action: string): boolean {
  const actions: readonly string[] = state.bindActions ?? NATIVE_BIND_ACTIONS;
  return actions.includes(action);
}

/** The host's settings and the website settings it added, as one object. */
export function hostSettings(): HostSettings {
  return { ...state.extraSettings, ...state.settings } as HostSettings;
}

// ---------------------------------------------------------------------------------------------- comparing

/** JSON with sorted object keys, so two equal settings compare equal whatever order their keys came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** The native settings `p` stands for, for every mapping the host has. */
export function nativeView(p: Prefs, host: HostSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mapping of activeMappings()) Object.assign(out, mapping.toNative(p, host));
  return out;
}

function activeMappings(): Mapping[] {
  const webLayoutOn = hostHas("hudLayoutWeb");
  return MAPPINGS.filter((mapping) => {
    if (mapping === nativeLayout && webLayoutOn) return false;
    return mapping.keys.every(hostHas);
  });
}

/**
 * Writes into `p` every mapping whose host values differ from what `p` stands for. Returns the native keys that came
 * from the host.
 */
export function pullHost(p: Prefs, host: HostSettings): string[] {
  const pulled: string[] = [];
  for (const mapping of activeMappings()) {
    const mine = mapping.toNative(p, host);
    if (mapping.keys.every((key) => sameValue(mine[key], host[key]))) continue;
    mapping.toPrefs(p, host);
    pulled.push(...mapping.keys);
  }
  return pulled;
}

/** The native patch for a change from `before` to `after` (two nativeView results). Binds go action by action. */
export function patchBetween(before: Record<string, unknown>, after: Record<string, unknown>): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (sameValue(before[key], value)) continue;
    if (key !== "binds") {
      patch[key] = value;
      continue;
    }
    const was = (before.binds ?? {}) as Record<string, string[]>;
    const now = value as Record<string, string[]>;
    const changed = Object.entries(now).filter(([action, codes]) => !sameValue(was[action], codes));
    if (changed.length) patch.binds = Object.fromEntries(changed);
  }
  return validPatch(patch);
}

/** What the host will take: the native validation (bridge.ts) and the rules of the website keys (settings-keys.ts). */
function validPatch(patch: Record<string, unknown>): SettingsPatch {
  const out: SettingsPatch = { ...settingsPatch(patch), ...requestedPatch(patch) };
  if (patch.binds && out.binds) {
    const actions = Object.keys(patch.binds).filter((action) => out.binds![action] && bindable(action));
    out.binds = Object.fromEntries(actions.map((action) => [action, out.binds![action]]));
    if (!actions.length) delete out.binds;
  }
  const layout = patch.hudLayoutWeb;
  if (layout && typeof layout === "object") out.hudLayoutWeb = layout;
  // The host refuses a whole patch over one key it doesn't have.
  for (const key of Object.keys(out)) if (!hostHas(key)) delete out[key];
  return out;
}

// ---------------------------------------------------------------------------------------------- keeping in step

const KNOWN_KEYS = "bunnyhop:native-host-keys";
/** Changes go out together: a dragged slider sends one patch per this many ms, not one per pixel. */
const SEND_DELAY_MS = 60;
/** A change the host hasn't echoed after this long was refused (the host shows why); its value comes back. */
const PENDING_MS = 3000;

let installed = false;
let applying = false;
let pulledOnce = false;
let view: Record<string, unknown> = {};
let lastSettings: unknown = null;
let lastExtra: unknown = null;
let lastShape = "";
let outgoing: SettingsPatch = {};
let sendTimer: ReturnType<typeof setTimeout> | undefined;
/** Values sent (or about to be) that the host hasn't echoed yet; binds as "binds.<action>". */
const pending = new Map<string, { value: unknown; at: number }>();
const hostListeners = new Set<() => void>();
const nativeListeners = new Set<() => void>();
let lastNativeOnly = "";

/**
 * The prefs change being made is the host's first settings arriving (what the client had saved), not a change the
 * player made now.
 */
export const takingFirstHostSettings = (): boolean => applying && !pulledOnce;

/** Called after the host changed settings the screen shows, or what the host has changed. */
export function onHostSettings(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

/** Starts keeping prefs and the host's settings in step (once). */
export function installPrefsBridge(): void {
  if (installed) return;
  installed = true;
  view = nativeView(prefs.get(), hostSettings());
  lastNativeOnly = nativeOnlySignature();
  prefs.watch((p) => {
    if (!applying) pushPrefs(p);
  });
  if (typeof window !== "undefined") window.addEventListener("bunnyhop:host-state", receiveHost);
  receiveHost();
}

/**
 * Changes a setting only the native client has (window mode, Discord...). It goes out with the next batch like a
 * prefs change, and the menu reads it back at once.
 */
export function sendNativeSettings(patch: SettingsPatch): void {
  const valid = validPatch(patch);
  if (!Object.keys(valid).length) return;
  rememberPatch(valid);
  lastNativeOnly = nativeOnlySignature();
  queuePatch(valid);
}

/** Native-only settings changed on the host (Alt+Enter, the F-key switches): the screen re-reads them. */
export function onNativeSettings(listener: () => void): () => void {
  nativeListeners.add(listener);
  return () => nativeListeners.delete(listener);
}

const MAPPED_KEYS = new Set(MAPPINGS.flatMap((mapping) => mapping.keys));

function nativeOnlySignature(): string {
  const host = effectiveHost() as Record<string, unknown>;
  const own = Object.keys(state.settings)
    .filter((key) => !MAPPED_KEYS.has(key))
    .sort();
  const binds = host.binds as Record<string, unknown>;
  return canonical([own.map((key) => host[key]), NATIVE_ONLY_ACTIONS.map((action) => binds[action])]);
}

/** Adds `patch` to the batch going out next. */
function queuePatch(patch: SettingsPatch): void {
  const { binds: changedBinds, ...rest } = patch;
  outgoing = { ...outgoing, ...rest };
  if (changedBinds) outgoing.binds = { ...outgoing.binds, ...changedBinds };
  if (!sendTimer) sendTimer = setTimeout(flushSettings, SEND_DELAY_MS);
}

/** Sends what's waiting now (before the menu closes or a test reads the messages). */
export function flushSettings(): void {
  clearTimeout(sendTimer);
  sendTimer = undefined;
  if (!Object.keys(outgoing).length) return;
  const patch = outgoing;
  outgoing = {};
  send({ type: "settings", patch });
}

function pushPrefs(p: Prefs): void {
  const next = nativeView(p, effectiveHost());
  const patch = patchBetween(view, next);
  view = next;
  if (!Object.keys(patch).length) return;
  rememberPatch(patch);
  queuePatch(patch);
  dropUnreadableBinds(p);
}

/** Until the host answers, the menu reads its own change back (presets, the pause menu's switches). */
function rememberPatch(patch: SettingsPatch): void {
  const { binds: changedBinds, ...rest } = patch;
  const now = Date.now();
  const native: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    (key in state.settings ? native : extra)[key] = value;
    pending.set(key, { value, at: now });
  }
  for (const [action, codes] of Object.entries(changedBinds ?? {})) {
    pending.set(`binds.${action}`, { value: codes, at: now });
  }
  state.settings = { ...state.settings, ...native, binds: { ...state.settings.binds, ...changedBinds } };
  state.sensitivity = state.settings.sensitivity;
  state.extraSettings = { ...state.extraSettings, ...extra };
  lastSettings = state.settings;
  lastExtra = state.extraSettings;
}

/**
 * The host's settings with the values still on their way to it. An older state can arrive after a change was sent;
 * it must not drag a slider back.
 */
function effectiveHost(): HostSettings {
  const host = hostSettings() as Record<string, unknown>;
  const hostBinds = { ...(host.binds as Record<string, string[]>) };
  const now = Date.now();
  for (const [key, entry] of pending) {
    const action = key.startsWith("binds.") ? key.slice(6) : null;
    const current = action ? hostBinds[action] : host[key];
    if (sameValue(current, entry.value) || now - entry.at > PENDING_MS) {
      pending.delete(key);
      continue;
    }
    if (action) hostBinds[action] = entry.value as string[];
    else host[key] = entry.value;
  }
  return { ...host, binds: hostBinds } as HostSettings;
}

/** A web bind the native client can't read (a numpad key, Caps Lock...) comes off again, with a note. */
function dropUnreadableBinds(p: Prefs): void {
  const dropped = new Set<string>();
  for (const action of SHARED_ACTIONS) for (const code of p.binds[action]) if (!nativeKeyCode(code)) dropped.add(code);
  if (!dropped.size) return;
  applying = true;
  try {
    prefs.update((next) => {
      for (const action of SHARED_ACTIONS) next.binds[action] = next.binds[action].filter(nativeKeyCode);
    });
  } finally {
    applying = false;
  }
  const names = [...dropped].map(keyLabel).join(", ");
  toast(`${names} can't be bound in the desktop client.`);
}

function receiveHost(): void {
  const shape = JSON.stringify([state.settingsKeys, state.bindActions, state.capabilities]);
  const changedShape = shape !== lastShape;
  if (state.settings === lastSettings && state.extraSettings === lastExtra && !changedShape) return;
  lastSettings = state.settings;
  lastExtra = state.extraSettings;
  lastShape = shape;
  const fresh = newHostKeys();
  const host = effectiveHost();
  const before = JSON.stringify(prefs.get());
  applying = true;
  try {
    prefs.update((p) => {
      pullHost(p, fresh.size ? withPrefsFor(fresh, p, host) : host);
    });
  } finally {
    applying = false;
  }
  view = nativeView(prefs.get(), effectiveHost());
  if (fresh.size) sendNewKeys(fresh);
  const changed = JSON.stringify(prefs.get()) !== before;
  if (state.settingsKeys) pulledOnce = true;
  if (changed || changedShape) for (const listener of hostListeners) listener();
  const nativeOnly = nativeOnlySignature();
  if (nativeOnly === lastNativeOnly) return;
  lastNativeOnly = nativeOnly;
  for (const listener of nativeListeners) listener();
}

/**
 * Website keys the host has started storing since the menu last saw it (a C++ update): the player's website setting
 * goes to them instead of the host's default. The first time, nothing counts as new: an existing native install keeps
 * its settings.
 */
function newHostKeys(): Set<string> {
  if (!state.settingsKeys) return new Set();
  const current = state.settingsKeys.filter((key) => !BUILD_KEYS.includes(key));
  let known: unknown = null;
  try {
    known = JSON.parse(localStorage.getItem(KNOWN_KEYS) ?? "null");
  } catch {
    known = null;
  }
  try {
    const seen = new Set([...(Array.isArray(known) ? known : []), ...current]);
    localStorage.setItem(KNOWN_KEYS, JSON.stringify([...seen]));
  } catch {
    /* storage blocked: every start counts as the first */
  }
  if (!Array.isArray(known)) return new Set();
  return new Set(current.filter((key) => !(known as unknown[]).includes(key)));
}

function withPrefsFor(keys: Set<string>, p: Prefs, host: HostSettings): HostSettings {
  const mine = nativeView(p, host);
  const out = { ...host } as Record<string, unknown>;
  for (const key of keys) if (key in mine) out[key] = mine[key];
  return out as HostSettings;
}

function sendNewKeys(keys: Set<string>): void {
  const mine = nativeView(prefs.get(), effectiveHost());
  const patch = validPatch(Object.fromEntries([...keys].filter((key) => key in mine).map((key) => [key, mine[key]])));
  if (!Object.keys(patch).length) return;
  rememberPatch(patch);
  queuePatch(patch);
  flushSettings();
}
