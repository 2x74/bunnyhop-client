// Perfect jump sound (Settings → Audio → Perfect jump sound; snd_perfecttick, !perfsound): which sound, and the streak
// that steps its pitch up. DOM-free for the tests; the player is audio/keysounds.ts PerfectSounds.
//
// A perfect jump is the timer's: a jump taken on the first tick on the ground (timer.ts perfGroundTicks === 1), among
// the jumps it measures (fewer than 0.1 s on the ground, not off a ladder). Only the scroll styles (EZ Scroll, Legit
// Scroll) have it: autohop jumps on the first ground tick every time.

import type { StyleId } from "../styles";

export type PerfectSoundSet = "ping" | "marimba" | "chime" | "pop";

/** Sets as Settings lists them; the shipped sound of each is `perfect_<set>` (catalog.ts). */
export const PERFECT_SOUND_SETS: [PerfectSoundSet, string][] = [
  ["ping", "Ping"],
  ["marimba", "Marimba"],
  ["chime", "Chime"],
  ["pop", "Pop"],
];

/**
 * The streak's rise (KovaaK's-style hit pitch): each perfect jump in a row plays STREAK_STEP semitones higher than the
 * last, up to the length's top, then holds there until the streak breaks (and starts over from the sound's own pitch).
 * Short tops out a major third up at the 9th perfect jump, Long a fifth up at the 15th.
 */
export const STREAK_STEP = 0.5;
export type StreakLength = "short" | "long";
export const STREAK_TOP: Record<StreakLength, number> = { short: 4, long: 7 };
/**
 * Highest step (semitones) per sound, so a short bright sample doesn't turn shrill: the ping's note crosses 2 kHz past
 * +5, and the chime, already 2.8 kHz at its own pitch, has 9% of its energy over 5 kHz at +4 (tools/audio/key-sounds.ts
 * measured each at 0, +4, +6, +7). The marimba and the pop stay under 1.5 kHz at +7.
 */
export const SOUND_TOP: Record<PerfectSoundSet, number> = { ping: 5, marimba: 7, chime: 3, pop: 7 };

/** The set's sound id, the default set for anything unknown. */
export function perfectSoundId(set: string): "perfect_ping" | "perfect_marimba" | "perfect_chime" | "perfect_pop" {
  return PERFECT_SOUND_SETS.some(([s]) => s === set) ? (`perfect_${set}` as "perfect_ping") : "perfect_ping";
}

/** Semitones up for the `n`th perfect jump in a row (1 = the first, at the sound's own pitch). */
export function streakSemitones(n: number, length: StreakLength, set: PerfectSoundSet): number {
  return Math.min(Math.max(0, n - 1) * STREAK_STEP, STREAK_TOP[length] ?? STREAK_TOP.long, SOUND_TOP[set] ?? 0);
}

/** Playback rate of the `n`th perfect jump in a row. */
export const streakRate = (n: number, length: StreakLength, set: PerfectSoundSet): number => 2 ** (streakSemitones(n, length, set) / 12);

/** The styles with perfect jumps. */
export const perfectStyle = (style: StyleId | string): boolean => style === "scroll" || style === "legit";

/**
 * Consecutive perfect jumps, broken like the announcer's perfect-hop streak (announcer-policy.ts): a measured jump that
 * wasn't perfect, a stop on the ground as long as the timer stops measuring at (timer.ts: ceil(0.1 s / tick) ticks), or
 * a broken tick (teleport, ladder, noclip, timer not running).
 */
export class PerfectStreak {
  count = 0;
  private ground = 0;

  /**
   * One tick. `hop`: the timer's verdict on a jump this tick (true perfect, false measured and not perfect, null no
   * measured jump). Returns the streak length when this tick's jump is perfect, else 0.
   */
  tick(hop: boolean | null, grounded: boolean, dt: number, broken: boolean): number {
    if (broken) return this.reset(), 0;
    this.ground = grounded ? this.ground + 1 : 0;
    if (this.ground >= Math.ceil(Math.fround(0.1 / dt))) this.count = 0;
    if (hop === false) this.count = 0;
    if (hop !== true) return 0;
    return ++this.count;
  }

  reset(): void {
    this.count = 0;
    this.ground = 0;
  }
}

/**
 * !perfsound [on|off|<sound>]: what the perfect jump sound becomes (nothing: it flips; a sound by name turns it on with
 * it), or null for an argument it doesn't take.
 */
export function perfSoundArg(arg: string, cur: { enabled: boolean; set: PerfectSoundSet }): { enabled: boolean; set: PerfectSoundSet } | null {
  const a = arg.trim().toLowerCase();
  const set = PERFECT_SOUND_SETS.find(([s]) => s === a)?.[0];
  if (set) return { enabled: true, set };
  if (a === "on" || a === "off") return { enabled: a === "on", set: cur.set };
  return a ? null : { enabled: !cur.enabled, set: cur.set };
}
