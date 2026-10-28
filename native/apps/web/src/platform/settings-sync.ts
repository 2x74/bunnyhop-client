// Settings saved with the account (apps/api src/settings-sync.ts): the whole Settings document (ui/settings-io.ts)
// follows a registered player between devices and builds. Always on in the Wavedash build, whose storage starts empty
// with every new Wavedash build; opt-in on the site (Settings → Account → "Keep settings with my account").
//
// Last write wins: this device remembers when its settings last changed (bunnyhop:settings-at); at start (and when the
// player or the switch changes) the newer of the two copies is kept: the account's is applied here, or this device's
// uploaded. Changes upload a few seconds after the last one. What comes back from the server is checked value by value
// like an imported settings file (planSettingsImport), so a bad copy can't break the game.

import { api, type User } from "../api";
import { WAVEDASH } from "./env";
import { prefs } from "../ui/settings";
import { buildSettingsDoc, planSettingsImport, type SettingsDoc } from "../ui/settings-io";

const AT_KEY = "bunnyhop:settings-at";
const OPT_KEY = "bunnyhop:settings-sync";
const SAVE_DELAY_MS = 4000;

/** Sync is on for this device: always in the Wavedash build, the player's switch on the site. */
export function settingsSyncOn(): boolean {
  if (WAVEDASH) return true;
  try {
    return localStorage.getItem(OPT_KEY) === "1";
  } catch {
    return false;
  }
}

const localAt = (): number => Number(localStorage.getItem(AT_KEY) ?? 0) || 0;
const setLocalAt = (t: number) => {
  try {
    localStorage.setItem(AT_KEY, String(t));
  } catch {
    /* storage blocked */
  }
};

let player: User | null = null;
let applying = false;
let timer = 0;
let watching = false;

const eligible = (u: User | null): u is User => !!u && u.provider !== "guest";

async function upload(): Promise<void> {
  if (!settingsSyncOn() || !eligible(player)) return;
  try {
    await api.saveSettings(buildSettingsDoc(prefs.get()));
  } catch {
    /* offline / rate limited: the next change tries again */
  }
}

/** Brings this device and the account in step for `user` (the newer copy wins). */
export async function syncSettings(user: User | null): Promise<void> {
  player = user;
  if (!watching) {
    watching = true;
    let first = true;
    prefs.watch(() => {
      if (first) return void (first = false);
      if (applying) return;
      setLocalAt(Date.now());
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void upload(), SAVE_DELAY_MS);
    });
  }
  if (!settingsSyncOn() || !eligible(user)) return;
  let saved: { doc: unknown; updatedAt?: number };
  try {
    saved = await api.savedSettings();
  } catch {
    return;
  }
  if (player !== user) return; // the player changed meanwhile
  const doc = saved.doc as SettingsDoc | null;
  if (doc && typeof doc === "object" && (saved.updatedAt ?? 0) > localAt()) {
    const plan = planSettingsImport(doc, prefs.get());
    if (plan.changed.length) {
      applying = true;
      try {
        prefs.update((p) => Object.assign(p, plan.next));
      } finally {
        applying = false;
      }
    }
    setLocalAt(saved.updatedAt ?? Date.now());
  } else if (!doc || localAt() > (saved.updatedAt ?? 0)) {
    await upload();
  }
}

/** The site's switch (Settings → Account). Turning it on syncs at once. */
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
