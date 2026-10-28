// Named presets from the desktop client's old settings screen become the website's setting profiles (web
// ui/settings-profiles.ts, the Profile menu by Export / Import) once. The old list stays in storage untouched.
//
// A profile covers what the website's do: not the mouse, graphics or sound (PROFILE_EXCLUDES), so a preset's
// sensitivity or volume doesn't come along.

import {
  findProfile, loadProfiles, MAX_PROFILES, PROFILE_NAME_MAX, saveProfile, storeProfiles,
} from "../../web/src/ui/settings-profiles";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { prefsFromNative } from "./settings-transfer";

const OLD_PRESETS = "bunnyhop:native-settings-presets:v1";
const MIGRATED = "bunnyhop:native-settings-presets:migrated";

interface OldPreset {
  name: string;
  settings: Record<string, unknown>;
}

/** The old presets in `raw` (anything malformed is skipped). */
export function parseOldPresets(raw: string | null): OldPreset[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return [];
  }
  const list = (value as { list?: unknown } | null)?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is OldPreset => {
    if (!item || typeof item !== "object") return false;
    const preset = item as Partial<OldPreset>;
    if (typeof preset.name !== "string" || !preset.name.trim()) return false;
    return !!preset.settings && typeof preset.settings === "object";
  });
}

/** Saves each old preset as a profile unless one of that name exists; returns the names saved. */
export function presetsToProfiles(presets: readonly OldPreset[], storage: Storage = localStorage): string[] {
  const store = loadProfiles(storage);
  const active = store.active;
  const saved: string[] = [];
  for (const preset of presets) {
    const name = preset.name.trim().replace(/\s+/g, " ").slice(0, PROFILE_NAME_MAX);
    if (findProfile(store, name) || store.list.length >= MAX_PROFILES) continue;
    saveProfile(store, name, prefsFromNative(preset.settings, DEFAULT_PREFS));
    saved.push(name);
  }
  store.active = active;
  if (saved.length) storeProfiles(store, storage);
  return saved;
}

/** Moves the old presets over, once. */
export function migrateNativePresets(storage: Storage = localStorage): void {
  try {
    if (storage.getItem(MIGRATED)) return;
    presetsToProfiles(parseOldPresets(storage.getItem(OLD_PRESETS)), storage);
    storage.setItem(MIGRATED, "1");
  } catch {
    /* storage blocked: tried again next start */
  }
}
