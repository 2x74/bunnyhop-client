import { sanitizeWindowBounds } from './window-state.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SETTINGS_VERSION = 1;

export const PROFILE_NAMES = Object.freeze(['competitive', 'balanced', 'compatibility', 'custom']);
export const WINDOW_MODES = Object.freeze(['fullscreen', 'kiosk', 'windowed']);
export const GPU_BACKENDS = Object.freeze(['auto', 'd3d11', 'vulkan', 'opengl']);
export const PRIORITIES = Object.freeze(['normal', 'high']);
export const BUNNYHOP_DISCORD_APPLICATION_ID = '1556467060916224040';

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  windowBounds: null,
  profile: 'balanced',
  windowMode: 'fullscreen',
  uncap: false,
  gpuTweaks: false,
  gpuBackend: 'auto',
  pinDeviceScale: false,
  processPriority: 'normal',
  preferredDisplay: 'primary',
  preferHighestRefresh: false,
  localRunVault: true,
  capturePersonalBests: false,
  showDiagnosticsOnStart: false,
  updates: true,
  discordRichPresence: false,
  discordApplicationId: BUNNYHOP_DISCORD_APPLICATION_ID,
  discordShowMap: true,
  privacyMode: false,
});

export const PRESETS = Object.freeze({
  competitive: Object.freeze({
    profile: 'competitive',
    windowMode: 'fullscreen',
    uncap: true,
    gpuTweaks: true,
    gpuBackend: 'auto',
    pinDeviceScale: false,
    processPriority: 'high',
    preferHighestRefresh: true,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    windowMode: 'fullscreen',
    uncap: false,
    gpuTweaks: false,
    gpuBackend: 'auto',
    pinDeviceScale: false,
    processPriority: 'normal',
    preferHighestRefresh: true,
  }),
  compatibility: Object.freeze({
    profile: 'compatibility',
    windowMode: 'windowed',
    uncap: false,
    gpuTweaks: false,
    gpuBackend: 'auto',
    pinDeviceScale: false,
    processPriority: 'normal',
    preferHighestRefresh: false,
  }),
});

function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function display(value) {
  if (value === 'primary' || value === 'highest-refresh') return value;
  return /^display:-?\d{1,20}$/.test(String(value)) ? String(value) : 'primary';
}

/** Ignore unknown keys and invalid values. Settings are data, never flags. */
export function sanitizeSettings(input = {}) {
  const base = DEFAULT_SETTINGS;
  return {
    version: SETTINGS_VERSION,
    windowBounds: sanitizeWindowBounds(input.windowBounds),
    profile: oneOf(input.profile, PROFILE_NAMES, base.profile),
    windowMode: oneOf(input.windowMode, WINDOW_MODES, base.windowMode),
    uncap: bool(input.uncap, base.uncap),
    gpuTweaks: bool(input.gpuTweaks, base.gpuTweaks),
    gpuBackend: oneOf(input.gpuBackend, GPU_BACKENDS, base.gpuBackend),
    pinDeviceScale: bool(input.pinDeviceScale, base.pinDeviceScale),
    processPriority: oneOf(input.processPriority, PRIORITIES, base.processPriority),
    preferredDisplay: display(input.preferredDisplay),
    preferHighestRefresh: bool(input.preferHighestRefresh, base.preferHighestRefresh),
    localRunVault: bool(input.localRunVault, base.localRunVault),
    capturePersonalBests: bool(input.capturePersonalBests, base.capturePersonalBests),
    showDiagnosticsOnStart: bool(input.showDiagnosticsOnStart, base.showDiagnosticsOnStart),
    updates: bool(input.updates, base.updates),
    discordRichPresence: bool(input.discordRichPresence, base.discordRichPresence),
    discordApplicationId: /^\d{17,20}$/.test(String(input.discordApplicationId || '')) ? String(input.discordApplicationId) : BUNNYHOP_DISCORD_APPLICATION_ID,
    discordShowMap: bool(input.discordShowMap, base.discordShowMap),
    privacyMode: bool(input.privacyMode, base.privacyMode),
  };
}

export function applyPreset(settings, profile) {
  if (!Object.hasOwn(PRESETS, profile)) throw new Error(`unknown profile ${profile}`);
  return sanitizeSettings({ ...sanitizeSettings(settings), ...PRESETS[profile] });
}

export function defaultSettingsPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Bunnyhop', 'client-settings.json');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Bunnyhop', 'client-settings.json');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'bunnyhop', 'client-settings.json');
}

export function loadSettings(file = defaultSettingsPath()) {
  if (!existsSync(file)) return sanitizeSettings();
  try {
    return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return sanitizeSettings();
  }
}

export function saveSettings(file, input) {
  const settings = sanitizeSettings(input);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

/** CLI values are explicit overrides. Null means use the saved setting. */
export function resolveLaunchSettings(saved, overrides = {}) {
  const settings = sanitizeSettings(saved);
  const windowMode = overrides.windowMode ?? settings.windowMode;
  return {
    ...settings,
    windowMode,
    uncap: overrides.uncap ?? settings.uncap,
    gpuTweaks: overrides.gpuTweaks ?? settings.gpuTweaks,
    gpuBackend: overrides.gpuBackend ?? settings.gpuBackend,
    pinDeviceScale: overrides.pinDeviceScale ?? settings.pinDeviceScale,
    processPriority: overrides.processPriority ?? settings.processPriority,
  };
}
