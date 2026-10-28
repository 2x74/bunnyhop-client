// Setting profiles (Settings → the Profile menu by Export / Import): named copies of a setup a player switches between
// in one click, e.g. "Practice" and "Racing". A profile is a saved settings document (settings-io.ts) with the device
// left out, kept in this browser. DOM-free; tested in apps/web/test/settings-profiles.test.ts.
//
// WHAT A PROFILE COVERS. Everything about how the game plays and looks to you: crosshair, FOV, HUD layout and scale, the
// strafe trainer, keys overlay, jump stats, triggers and zones, binds (null binds, hold to restart, auto restart,
// practice), ghosts and name tags, viewmodel, paint. What it leaves alone (PROFILE_EXCLUDES):
//   - the mouse: sensitivity, vertical sensitivity, DPI, invert, raw input, spike filter, input stats. Sensitivity
//     belongs to the mouse and the hand on it, not to a mode: switching to "Racing" must not change your aim, and a
//     profile someone hands you must not bring their sensitivity with it. cm/360 is muscle memory.
//   - graphics (quality, resolution, aspect, FPS limits, brightness, player models) and sound (volumes, mutes, music,
//     announcer): they follow the machine and the headphones, not the mode.
//   - Hide UI's on / off (the Hide UI key flips it all the time; it isn't part of a setup).
//   - the colour-blind palette: it's about your eyes, not the mode, and loading a profile someone shared must not turn
//     it off.
// A profile is checked value by value on the way back in like an imported file (planSettingsImport, the same RULES),
// and the left-out keys are stripped again on load, so an edited profile can't reach them either.
//
// ACTIVE AND MODIFIED. The profile loaded or saved last is the active one. Change anything it covers afterwards and it's
// modified (Save writes the change into it); change the mouse, graphics or sound and it isn't.
//
// NOT SYNCED. Settings kept with the account (platform/settings-sync.ts) carry one settings document, last write wins,
// capped at 32 KB on the server. A profile is ~3.7 KB, so ten are over the cap on their own, and a whole-document last
// write would drop a profile saved on one device the moment another device saved its settings. Profiles stay in this
// browser; Export still carries whatever setup is loaded.

import { DEFAULT_PREFS, type Prefs } from "./settings";
import { buildSettingsDoc, FORMAT, FORMAT_VERSION, planSettingsImport, type ImportPlan } from "./settings-io";

export const PROFILES_KEY = "bunnyhop:profiles";
export const MAX_PROFILES = 10;
export const PROFILE_NAME_MAX = 24;

/** Prefs a profile leaves alone (dotted paths into Prefs). See the header. */
export const PROFILE_EXCLUDES: readonly string[] = [
  "sensitivity",
  "verticalSensitivityEnabled",
  "verticalSensitivity",
  "dpi",
  "dpiConfirmed",
  "dpiHidden",
  "invertY",
  "rawInput",
  "spikeFilter",
  "timedInput",
  "inputStats",
  "graphics",
  "models",
  "volume",
  "audio",
  "hud.hidden",
  "colorBlind",
];

export interface Profile {
  name: string;
  /** When it was last saved (ISO). */
  saved: string;
  /** The covered part of a settings document's `settings`. */
  settings: Record<string, unknown>;
}

export interface ProfileStore {
  /** Name of the profile loaded or saved last; null when none. */
  active: string | null;
  list: Profile[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Removes the PROFILE_EXCLUDES paths from a settings object (in place). */
function strip(settings: Obj): Obj {
  for (const path of PROFILE_EXCLUDES) {
    const segs = path.split(".");
    let o: unknown = settings;
    for (const s of segs.slice(0, -1)) o = isObj(o) ? o[s] : undefined;
    if (isObj(o)) delete o[segs[segs.length - 1]];
  }
  return settings;
}

/** What a profile saves from `p`: the settings document's values minus the excluded ones. */
export function profileSettings(p: Prefs): Obj {
  return strip(buildSettingsDoc(p).settings as Obj);
}

/** What loading `profile` over `current` does (validated like an import; excluded keys never apply). */
export function profilePlan(profile: Profile, current: Prefs): ImportPlan {
  const settings = strip(clone(profile.settings));
  return planSettingsImport({ format: FORMAT, version: FORMAT_VERSION, exported: profile.saved, settings }, current);
}

/** Whether `current` differs from `profile` in anything the profile covers. */
export function profileModified(profile: Profile, current: Prefs): boolean {
  return profilePlan(profile, current).changed.length > 0;
}

export const findProfile = (s: ProfileStore, name: string | null): Profile | null => (name === null ? null : s.list.find((x) => same(x.name, name)) ?? null);

/** Trims and folds runs of spaces. */
export const cleanName = (name: string): string => name.trim().replace(/\s+/g, " ");

/**
 * What's wrong with `name` for a new profile, or for renaming the profile `renaming` (null: fine). Saving under the name
 * of an existing profile overwrites it, so a taken name is only a problem for a rename.
 */
export function nameProblem(s: ProfileStore, name: string, renaming: string | null = null): string | null {
  const n = cleanName(name);
  if (!n) return "Give it a name.";
  if (n.length > PROFILE_NAME_MAX) return `Keep it to ${PROFILE_NAME_MAX} characters.`;
  const taken = findProfile(s, n);
  if (renaming !== null) return taken && !same(taken.name, renaming) ? `There's already a profile called ${taken.name}.` : null;
  if (!taken && s.list.length >= MAX_PROFILES) return `That's ${MAX_PROFILES} profiles already. Delete one first, or save over one by its name.`;
  return null;
}

/** Saves `p` as `name` (over the profile of that name if there is one) and makes it active. Throws on a bad name. */
export function saveProfile(s: ProfileStore, name: string, p: Prefs, at = Date.now()): Profile {
  const why = nameProblem(s, name);
  if (why) throw new Error(why);
  const n = cleanName(name);
  const prof: Profile = { name: findProfile(s, n)?.name ?? n, saved: new Date(at).toISOString(), settings: profileSettings(p) };
  const i = s.list.findIndex((x) => same(x.name, n));
  if (i >= 0) s.list[i] = prof;
  else s.list.push(prof);
  s.active = prof.name;
  return prof;
}

export function renameProfile(s: ProfileStore, from: string, to: string): void {
  const prof = findProfile(s, from);
  const why = nameProblem(s, to, from);
  if (!prof || why) throw new Error(why ?? "No such profile.");
  const wasActive = s.active !== null && same(s.active, prof.name);
  prof.name = cleanName(to);
  if (wasActive) s.active = prof.name;
}

export function deleteProfile(s: ProfileStore, name: string): void {
  s.list = s.list.filter((x) => !same(x.name, name));
  if (s.active !== null && same(s.active, name)) s.active = null;
}

/** Reads the stored profiles; anything malformed is dropped, never thrown. */
export function parseProfiles(raw: string | null): ProfileStore {
  const out: ProfileStore = { active: null, list: [] };
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (!isObj(v) || !Array.isArray(v.list)) return out;
  for (const x of v.list) {
    if (out.list.length >= MAX_PROFILES) break;
    if (!isObj(x) || typeof x.name !== "string" || !isObj(x.settings)) continue;
    const name = cleanName(x.name).slice(0, PROFILE_NAME_MAX);
    if (!name || findProfile(out, name)) continue;
    out.list.push({ name, saved: typeof x.saved === "string" ? x.saved : "", settings: x.settings });
  }
  out.active = typeof v.active === "string" ? findProfile(out, v.active)?.name ?? null : null;
  return out;
}

export function loadProfiles(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): ProfileStore {
  try {
    return parseProfiles(storage?.getItem(PROFILES_KEY) ?? null);
  } catch {
    return { active: null, list: [] };
  }
}

/** Saves the profiles; false when storage refused (private mode, quota). */
export function storeProfiles(s: ProfileStore, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): boolean {
  try {
    storage?.setItem(PROFILES_KEY, JSON.stringify({ v: 1, active: s.active, list: s.list }));
    return !!storage;
  } catch {
    return false;
  }
}

/** (For tests and the docs: the top-level prefs a profile carries.) */
export const PROFILE_KEYS = (): string[] => Object.keys(profileSettings(DEFAULT_PREFS));
