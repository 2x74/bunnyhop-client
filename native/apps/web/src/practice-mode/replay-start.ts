// Practice from a replay: the replay viewer's "Practice from here" re-simulates a replay on the live core up to the shown
// tick and carries on from there as a practice attempt (controller.ts fromReplay), the way a checkpoint teleport does.
// This is the part that decides whether a replay can be played into the live game. DOM-free (apps/api/test/practice.test.ts).

import type { Settings } from "../core";
import { replayStyle, replayTimerRules, type ReplayHeader } from "../replay";
import { styleForTrack, styleLabel, styleSettings, type StyleId } from "../styles";
import { TIMER_RULES } from "../timer";

const f32 = Math.fround;

/** The replay was recorded with exactly the settings the live game runs the style with now. */
export function sameSettings(a: Settings, b: Settings): boolean {
  const num = ["tickInterval", "airAccelerate", "accelerate", "friction", "stopSpeed", "gravity", "maxSpeed"] as const;
  return num.every((k) => f32(a[k]) === f32(b[k])) && a.autohop === b.autohop && !!a.stamina === !!b.stamina && a.physics === b.physics;
}

/**
 * Why the replay can't be practised from on this map and style, or null if it can. It continues in the live game, so it
 * has to be the style you have selected (bonus tracks are Normal) and play back with the physics and timer rules the game
 * runs now; runs from older versions keep their original movement and are only for watching.
 */
export function replayStartProblem(h: ReplayHeader, o: { map: string; selectedStyle: StyleId }): string | null {
  if (h.map !== o.map) return "That replay is for another map.";
  const style = replayStyle(h);
  if (style !== styleForTrack(o.selectedStyle, h.track)) return `That replay is ${styleLabel(style)}. Switch to it first.`;
  if (replayTimerRules(h) !== TIMER_RULES || !sameSettings(h.settings, styleSettings(style as StyleId))) return "That replay is from an older version of the game, so it can only be watched.";
  return null;
}
