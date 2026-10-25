// Auto restart (Settings -> Keys -> Run): once a timed run's clock passes a time it can no longer beat (your PB, the
// world record, or the custom ghost you're racing), restart it the way the restart key does, or only play a sound.
// Off by default. Display and client flow only: the restart is the same one R does (main.ts restartAction), nothing
// in the run, its replay or its submission changes. DOM-free (test/auto-restart.test.ts); main.ts asks once per frame.

import type { RunStatus } from "./timer";

/** What the run is measured against. "ghost": the custom ghost (a leaderboard run or replay file you chose to race). */
export type AutoRestartWhen = "off" | "pb" | "wr" | "ghost";
/** Restart, or only play a sound and let the run go on. */
export type AutoRestartAction = "restart" | "sound";

export interface AutoRestartRun {
  /** Increases with every reset (session.ts attempt): one action per attempt. */
  attempt: number;
  status: RunStatus;
  /** The run's clock (seconds, whole ticks). */
  time: number;
  /** The time to beat (seconds), or null: none known (no PB yet, WR not read, no custom ghost on this track). */
  target: number | null;
  /** A practice attempt (practice mode, third person, a lesson, the debug hook): it doesn't count, so nothing to save. */
  unranked: boolean;
  /** Somewhere a restart isn't ours to make: a !race duel on this board, the tutorial, the replay viewer. */
  blocked: boolean;
}

/** The run can no longer beat its target: its clock is past it (an equal time doesn't beat it either, but may tie). */
export function pastTarget(r: AutoRestartRun): boolean {
  return r.status === "running" && !r.unranked && !r.blocked && r.target !== null && r.target > 0 && r.time > r.target;
}

/** One action per attempt: a sound plays once, and a restart that didn't happen isn't tried every frame. */
export class AutoRestart {
  private firedFor = -1;

  /** The action due now, or null. */
  check(when: AutoRestartWhen, action: AutoRestartAction, r: AutoRestartRun): AutoRestartAction | null {
    if (when === "off" || r.attempt === this.firedFor || !pastTarget(r)) return null;
    this.firedFor = r.attempt;
    return action === "sound" ? "sound" : "restart";
  }
}
