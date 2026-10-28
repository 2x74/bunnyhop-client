// Settings kept with the account ("Keep settings with my account"): the website's sync (web platform/settings-sync.ts)
// with one settings document for both, so a player's setup follows them between the website and the desktop client.
//
// Last write wins, as on the website: this device remembers when its settings last changed, and at start (and when the
// player or the switch changes) the newer copy is kept. Two things the website's upload would lose are kept here:
//
// - The account's document can hold settings this build doesn't know (a newer website). They stay in the upload.
// - Settings only the desktop client has ride along under `native` (the website ignores the key). The window and the
//   diagnostics overlay stay with the device; the retired player and ghost models don't travel.

import { api, type User } from "../../web/src/api";
import { WAVEDASH } from "../../web/src/platform/env";
import { buildSettingsDoc, planSettingsImport, type SettingsDoc } from "../../web/src/ui/settings-io";
import { prefs } from "../../web/src/ui/settings";
import { VERSION } from "../../web/src/version";
import { state, type SettingsPatch } from "./bridge";
import { MAPPINGS, onNativeSettings, sendNativeSettings, takingFirstHostSettings } from "./prefs-bridge";

const AT_KEY = "bunnyhop:settings-at";
const OPT_KEY = "bunnyhop:settings-sync";
const SAVE_DELAY_MS = 4000;
/** Native-only settings that belong to this computer, not the player. */
const DEVICE_KEYS = ["windowMode", "alwaysOnTop", "rememberWindowBounds", "minimizeOnFocusLoss", "mouseDiagnostics"];
/** Retired like on the website: everyone is shown in their loadout. */
const RETIRED_KEYS = ["playerModel", "ghostModel"];

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

/** Sync is on for this device (the switch in the account panel). */
export function settingsSyncOn(): boolean {
  if (WAVEDASH) return true;
  try {
    return localStorage.getItem(OPT_KEY) === "1";
  } catch {
    return false;
  }
}

const localAt = (): number => Number(localStorage.getItem(AT_KEY) ?? 0) || 0;
function setLocalAt(at: number): void {
  try {
    localStorage.setItem(AT_KEY, String(at));
  } catch {
    /* storage blocked */
  }
}

/** The native-only settings that travel with the account. */
export function nativeOnlySettings(): Obj {
  const mapped = new Set(MAPPINGS.flatMap((mapping) => mapping.keys));
  const out: Obj = {};
  for (const [key, value] of Object.entries(state.settings)) {
    if (!mapped.has(key) && !DEVICE_KEYS.includes(key) && !RETIRED_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

/** `local` over `remote`, keeping what only `remote` has (settings a newer build wrote). */
export function mergeSettings(remote: unknown, local: Obj): Obj {
  if (!isObj(remote)) return local;
  const out: Obj = { ...remote };
  for (const [key, value] of Object.entries(local)) {
    out[key] = isObj(value) && isObj(remote[key]) ? mergeSettings(remote[key], value) : value;
  }
  return out;
}

/** The document this device uploads, merged over the account's last copy. */
export function syncDocument(remote: SettingsDoc | null): SettingsDoc {
  const doc = buildSettingsDoc(prefs.get(), { app: VERSION });
  const settings = mergeSettings(remote?.settings, doc.settings as Obj);
  settings.native = nativeOnlySettings();
  return { ...doc, settings: settings as SettingsDoc["settings"] };
}

let player: User | null = null;
let syncReady: () => void = () => {};
let remoteDoc: SettingsDoc | null = null;
let applying = false;
let timer = 0;
let watching = false;

const eligible = (user: User | null): user is User => !!user && user.provider !== "guest";

async function upload(): Promise<void> {
  if (!settingsSyncOn() || !eligible(player)) return;
  const doc = syncDocument(remoteDoc);
  try {
    await api.saveSettings(doc);
    remoteDoc = doc;
  } catch {
    /* offline or rate limited: the next change tries again */
  }
}

function changedHere(): void {
  if (applying || takingFirstHostSettings()) return;
  setLocalAt(Date.now());
  clearTimeout(timer);
  timer = window.setTimeout(() => void upload(), SAVE_DELAY_MS);
}

function watchChanges(): void {
  if (watching) return;
  watching = true;
  let first = true;
  prefs.watch(() => {
    if (first) return void (first = false);
    changedHere();
  });
  onNativeSettings(changedHere);
}

/** Applies the account's copy here: the website's settings checked value by value, then the native ones. */
function applyRemote(doc: SettingsDoc): void {
  const plan = planSettingsImport(doc, prefs.get());
  applying = true;
  try {
    if (plan.changed.length) prefs.update((p) => Object.assign(p, plan.next));
    const native = doc.settings.native;
    if (isObj(native)) sendNativeSettings(native as SettingsPatch);
  } finally {
    applying = false;
  }
}

/** Brings this device and the account in step for `user` (the newer copy wins). */
export async function syncSettings(user: User | null): Promise<void> {
  player = user;
  watchChanges();
  // The account panel's "Keep settings with my account" switch shows from now on: the document it keeps is this one.
  syncReady();
  if (!settingsSyncOn() || !eligible(user)) return;
  let saved: { doc: unknown; updatedAt?: number };
  try {
    saved = await api.savedSettings();
  } catch {
    return;
  }
  if (player !== user) return;
  const doc = isObj(saved.doc) && isObj(saved.doc.settings) ? (saved.doc as unknown as SettingsDoc) : null;
  remoteDoc = doc;
  const remoteAt = saved.updatedAt ?? 0;
  if (doc && remoteAt > localAt()) {
    applyRemote(doc);
    setLocalAt(remoteAt || Date.now());
  } else if (!doc || localAt() > remoteAt) {
    await upload();
  }
}

/** The account panel's switch. Turning it on syncs at once. */
export function setSettingsSync(on: boolean): void {
  if (WAVEDASH) return;
  try {
    if (on) localStorage.setItem(OPT_KEY, "1");
    else localStorage.removeItem(OPT_KEY);
  } catch {
    /* storage blocked */
  }
  if (on) void syncSettings(player);
}

let installed = false;

/**
 * Syncs for the signed-in player now and whenever the account changes (once). `ready` runs when syncing starts, to
 * show the account panel's switch.
 */
export function installSettingsSync(ready: () => void): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  syncReady = ready;
  const refresh = (): void => {
    void api.me().then((user) => {
      if (!api.meStale()) void syncSettings(user ?? null);
    }, () => {});
  };
  addEventListener("bunnyhop:account", refresh);
  refresh();
}
