// Which attempts are practice (session.ts keeps one of these). Like bhoptimer: checkpoints and noclip work in any solo
// attempt, and saving a checkpoint changes nothing. The moment you teleport to a checkpoint or noclip, the attempt is
// practice: its timer keeps going (yellow) but it is never submitted, never a PB, never a ghost.
//
// What ends it: a reset of the core (R, B, M, a style switch: session.ts resetCore -> onReset), which also starts a
// fresh recording. Walking back into the start zone doesn't (bhoptimer clears practice when the timer starts there):
// the world was moved outside the simulation, and a submitted replay must be a clean reset plus recorded commands
// (sim.ts, verifier.ts). Practice mode (the pause menu, !practice, its bind) makes every attempt practice until it's
// turned off. DOM-free (test/practice-attempt.test.ts).

/** A practice tool that moves the player outside the simulation, or a practice spawn (start-point.ts) that begins the attempt there. */
export type PracticeUse = "teleport" | "noclip" | "spawn";

export class PracticeAttempt {
  /** Practice mode is on: every attempt is practice, also after a restart. */
  mode = false;
  /** Why this attempt is practice ("mode", or the first tool used), or null for a clean attempt. */
  private why: "mode" | PracticeUse | null = null;
  /** A tool or practice spawn moved the player outside the simulation this attempt, also in practice mode. */
  private moved = false;

  /** This attempt is practice (practice mode, or a tool was used). Never submitted. */
  get practice(): boolean {
    return this.why !== null;
  }

  /** The tool that made this attempt practice, if it wasn't practice mode. */
  get tool(): PracticeUse | null {
    return this.why === "mode" ? null : this.why;
  }

  /** The player's place wasn't reached by movement alone this attempt: noclip, a checkpoint teleport or a practice spawn. */
  get unwalked(): boolean {
    return this.moved;
  }

  /** Practice mode on or off. Turning it off keeps this attempt practice: the caller restarts right after. */
  setMode(on: boolean): void {
    this.mode = on;
    if (on) this.why = "mode";
  }

  /** A checkpoint teleport, noclip or practice spawn. True if a clean attempt just became practice (say so once). */
  use(tool: PracticeUse): boolean {
    this.moved = true;
    if (this.why) return false;
    this.why = tool;
    return true;
  }

  /**
   * A reset (core reset, fresh recording): the new attempt is clean unless practice mode is on. True if a practice
   * attempt just gave way to a clean one (attempts.ts counts these as practice exits).
   */
  reset(): boolean {
    const exited = this.why !== null && !this.mode;
    this.why = this.mode ? "mode" : null;
    this.moved = false;
    return exited;
  }
}

/**
 * What a finish does: "practice" (practice mode or a tool: the end card for your own reference, no replay, nothing
 * saved), "unranked" (third person, a lesson, scripted commands, the debug hook, a gun: kept on this device, never
 * submitted or a PB), or "submit".
 */
export function finishRoute(o: { practice: boolean; unranked: boolean }): "practice" | "unranked" | "submit" {
  if (o.practice) return "practice";
  return o.unranked ? "unranked" : "submit";
}

const restartHow = (key: string | null) => (key ? `Press ${key}` : "Type !r");

/** The line when a clean attempt turns into practice. `restartKey`: the restart bind's label, if it has one. */
export function practiceFlipLine(running: boolean, restartKey: string | null): string {
  return running ? `This run is practice now. ${restartHow(restartKey)} to restart for a real run.` : `Practice until you restart. ${restartHow(restartKey)} for a real run.`;
}

/** The line when a practice attempt (a tool, not practice mode) comes back to a start zone. */
export function practiceStartLine(restartKey: string | null): string {
  return `Still practice. ${restartHow(restartKey)} to restart for a real run.`;
}
