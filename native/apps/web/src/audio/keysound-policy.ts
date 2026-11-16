// Key sounds (Settings → Audio → Key sounds): which presses sound and at what pitch. DOM-free for the tests; the player
// is audio/keysounds.ts.
//
// Strafe keys are the keys the style strafes with (styles.ts strafeKeys: A / D, W / S in Sideways, W in W-only). Left
// plays a semitone down and right a semitone up, so the rhythm reads by ear; the other movement keys (All movement
// keys) play at the sound's own pitch, between the two.

import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT } from "../input";
import type { StrafeKeys } from "../styles";

export type KeySoundSet = "thock" | "click" | "wood" | "blip";
export type KeySoundKeys = "strafe" | "movement";

/** Sets as Settings lists them; the shipped sound of each is `key_<set>` (catalog.ts). */
export const KEY_SOUND_SETS: [KeySoundSet, string][] = [
  ["thock", "Thock"],
  ["click", "Click"],
  ["wood", "Wood"],
  ["blip", "Blip"],
];

/** A semitone down / up. */
export const KEY_RATE_LEFT = 2 ** (-1 / 12);
export const KEY_RATE_RIGHT = 2 ** (1 / 12);

const MOVE_BITS = IN_FORWARD | IN_BACK | IN_MOVELEFT | IN_MOVERIGHT | IN_JUMP | IN_DUCK;

/** The set's sound id, the default set for anything unknown (a hand-edited or newer save). */
export function keySoundId(set: string): "key_thock" | "key_click" | "key_wood" | "key_blip" {
  return KEY_SOUND_SETS.some(([s]) => s === set) ? (`key_${set}` as "key_thock") : "key_thock";
}

/**
 * Playback rate for keys going down that hold `bits` (IN_*), or 0 for no sound. Several keys at once (a crouch-jump
 * bind, one replay tick) make one sound: a strafe key's if there is one.
 */
export function keySoundRate(bits: number, keys: KeySoundKeys, strafe: StrafeKeys): number {
  if (strafe === "w") {
    if (bits & IN_FORWARD) return 1;
  } else {
    const [lo, hi] = strafe === "ws" ? [IN_FORWARD, IN_BACK] : [IN_MOVELEFT, IN_MOVERIGHT];
    if (bits & lo) return KEY_RATE_LEFT;
    if (bits & hi) return KEY_RATE_RIGHT;
  }
  return keys === "movement" && bits & MOVE_BITS ? 1 : 0;
}

/**
 * !keysounds [on|off|<sound>]: what the key sounds become (nothing: they flip; a sound by name turns them on with it),
 * or null for an argument it doesn't take.
 */
export function keySoundsArg(arg: string, cur: { enabled: boolean; set: KeySoundSet }): { enabled: boolean; set: KeySoundSet } | null {
  const a = arg.trim().toLowerCase();
  const set = KEY_SOUND_SETS.find(([s]) => s === a)?.[0];
  if (set) return { enabled: true, set };
  if (a === "on" || a === "off") return { enabled: a === "on", set: cur.set };
  return a ? null : { enabled: !cur.enabled, set: cur.set };
}
