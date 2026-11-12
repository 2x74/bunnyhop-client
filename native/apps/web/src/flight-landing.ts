// Start-zone restarts for a track that runs in another style (session.ts): where in the zone, and the Infinite flight
// landing that needs one on its own tick.
import type { StyleId } from "./styles";
import type { Zone } from "./zones";

/** `position` moved into zone `z` for a restart there: 1 unit inside each side (the middle of a thin side), feet at least 1 above its floor. */
export function restartPositionIn(z: Zone, position: readonly number[]): [number, number, number] {
  const clamp = (v: number, i: number) => (z.maxs[i] - z.mins[i] > 2 ? Math.min(z.maxs[i] - 1, Math.max(z.mins[i] + 1, v)) : (z.mins[i] + z.maxs[i]) / 2);
  return [clamp(position[0], 0), clamp(position[1], 1), Math.max(z.mins[2] + 1, position[2])];
}

/**
 * An Infinite flight's landing tick (core EVENT_FLIGHT_LANDED): the bonus track to restart on, else null. Decided from
 * the timer after that tick (`timer`: RunTimer), not from the zones the landing spot touches: the timer's selected
 * track is what the attempt will be timed on (it prefers its current track's start where starts overlap: timer.ts
 * noclipTick / update), so a main start overlapping the bonus start doesn't make it a main attempt.
 *
 * When the timer is armed in (in a start of) or has started a bonus track that runs in another style than this
 * attempt (since v0.0.40 only the tutorial's final course: styles.ts styleForTrack), the tick may have started a bonus run in Infinite, which the
 * verifier rejects at the finish, and command()'s switch never sees the player standing in the start. The session
 * restarts that bonus at its normal start point instead (the B key's restart: restart.ts restartTarget), which is
 * grounded and settled. Not at the landing spot: a flight can end in midair inside a tall start, and a spawn there is
 * never a valid replay start (restart.ts restartPointProblem). The main track, and a timer idle outside every start,
 * return null: today's behaviour.
 */
export function landingBonusRestart(
  timer: { readonly track: number; readonly inStart: boolean; readonly started: boolean },
  runStyle: StyleId,
  styleFor: (track: number) => StyleId,
): number | null {
  if (timer.track <= 0 || !(timer.inStart || timer.started)) return null;
  return styleFor(timer.track) === runStyle ? null : timer.track;
}
