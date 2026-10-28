import { installPrefsBridge } from "./prefs-bridge";
import { migrateNativePresets } from "./settings-presets";
import { installSettingsSync } from "./settings-sync";
import { installSettingsFiles } from "./settings-transfer";

/**
 * Settings follow the host from the menu's start: the glow switches the account editor shows, and every other setting
 * (prefs-bridge.ts), with account sync and the old presets moved to profiles.
 */
export function installGlowSettings(): void {
  installPrefsBridge();
  migrateNativePresets();
  installSettingsFiles();
  installSettingsSync();
}
