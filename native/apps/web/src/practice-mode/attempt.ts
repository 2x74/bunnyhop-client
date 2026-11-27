// Which attempts are practice (session.ts keeps one of these). Like bhoptimer: checkpoints and noclip work in any solo
// attempt, and saving a checkpoint changes nothing. The moment you teleport to a checkpoint or noclip, the attempt is
// practice: its timer keeps going (yellow) but it is never submitted, never a PB, never a ghost.
//
// What ends it: a reset of the core (R, B, M, a style switch: session.ts resetCore -> onReset), which also starts a
// fresh recording. Walking back into the start zone doesn't (bhoptimer clears practice when the timer starts there):
// the world was moved outside the simulation, and a submitted replay must be a clean reset plus recorded commands
// (sim.ts, verifier.ts). Practice mode (the pause menu, !practice, its bind) makes every attempt practice until it's
// turned off. DOM-free (test/practice-attempt.test.ts).

/**
 * A practice tool that moves the player outside the simulation, or a practice spawn (start-point.ts) that begins the
 * attempt there. (Infinite's noclip isn't one: the core flies it from the recorded commands, crates/core game/flight.rs.)
 */
export type PracticeUse = "teleport" | "noclip" | "spawn";

/**
 * Why this attempt's recording no longer plays back to where the player is (practice replays, session.ts
 * keepPracticeReplay): noclip, a teleport the recording couldn't follow (a checkpoint without a playable path, or
 * "Practice from here" without the replay's commands), or a teleport that reset the speed (Keep speed off).
 */
export type ReplayLoss = "noclip" | "teleport" | "speed";

export class PracticeAttempt {
  /** Practice mode is on: every attempt is practice, also after a restart. */
  mode = false;
  /** Why this attempt is practice ("mode", a tick at another timescale, or the first tool used), or null for a clean attempt. */
  private why: "mode" | "timescale" | PracticeUse | null = null;
  /** The slowest timescale (timescale.ts) a tick of this attempt ran at. */
  private slowest = 1;
  /** A tool or practice spawn moved the player outside the simulation this attempt, also in practice mode. */
  private moved = false;
  private lost: ReplayLoss | null = null;
  /** A practice spawn began this attempt (also in practice mode, where it isn't the reason). */
  private spawned = false;

  /** This attempt is practice (practice mode, or a tool was used). Never submitted. */
  get practice(): boolean {
    return this.why !== null;
  }

  /** The tool that made this attempt practice, if it wasn't practice mode. */
  get tool(): PracticeUse | null {
    return this.why === "mode" || this.why === "timescale" ? null : this.why;
  }

  /** The slowest timescale this attempt ran at (1: never slowed); practice replays are labelled with it. */
  get timescale(): number {
    return this.slowest;
  }

  /**
   * A tick ran at `scale`. Practice mode is the only place a scale other than 1 is allowed (timescale.ts); this is the
   * second guard: such an attempt is practice whatever else happens, until the next reset.
   */
  ticked(scale: number): void {
    if (scale === 1) return;
    this.slowest = Math.min(this.slowest, scale);
    this.why ??= "timescale";
  }

  /** The player's place wasn't reached by movement alone this attempt: noclip, a checkpoint teleport or a practice spawn. */
  get unwalked(): boolean {
    return this.moved;
  }

  /**
   * Why the recording since the reset can't be played back now, or null when it can: every command from the reset (or a
   * practice spawn, which the replay header records) up to now re-simulates to the live state.
   */
  get replayLoss(): ReplayLoss | null {
    return this.lost;
  }

  /** The recording was rebuilt from a checkpoint's playable path (segments.ts): it plays back again. */
  rejoined(): void {
    this.lost = null;
  }

  /** A teleport set the speed to zero outside the simulation (Keep speed off). */
  speedReset(): void {
    this.lost = "speed";
  }

  /** Practice mode on or off. Turning it off keeps this attempt practice: the caller restarts right after. */
  setMode(on: boolean): void {
    this.mode = on;
    if (on) this.why = "mode";
  }

  /** A checkpoint teleport, noclip or practice spawn. True if a clean attempt just became practice (say so once). */
  use(tool: PracticeUse): boolean {
    this.moved = true;
    if (tool !== "spawn") this.lost = tool;
    else this.spawned = true;
    if (this.why) return false;
    this.why = tool;
    return true;
  }

  /**
   * Infinite's flight (crates/core game/flight.rs) moved the player this attempt. The attempt stays clean (the flight is
   * recorded and re-simulated), but the place wasn't walked to: a start point set from here is a practice spawn.
   */
  flew(): void {
    this.moved = true;
  }

  /**
   * Only a noclip or a checkpoint teleport made this attempt practice, and nothing else that stays with it: no practice
   * mode, practice spawn or slowed tick. A Segmented checkpoint saved while the run was clean takes such an attempt back
   * to a real Segmented run (resume): its load throws away everything since the save, the noclip or teleport included.
   */
  get resumable(): boolean {
    return (this.why === "noclip" || this.why === "teleport") && !this.mode && !this.spawned && this.slowest === 1;
  }

  /**
   * A Segmented load of a checkpoint saved while the run was clean (session.ts segmentRestored): the attempt is clean
   * again, with the recording the load rebuilt. False (nothing changes) unless it's resumable.
   */
  resume(): boolean {
    if (!this.resumable) return false;
    this.why = null;
    this.lost = null;
    this.moved = false;
    return true;
  }

  /** A practice spawn began this attempt (start-point.ts), also in practice mode where it isn't the reason. */
  get spawnUsed(): boolean {
    return this.spawned;
  }

  /**
   * A reset (core reset, fresh recording): the new attempt is clean unless practice mode is on. True if a practice
   * attempt just gave way to a clean one (attempts.ts counts these as practice exits).
   */
  reset(): boolean {
    const exited = this.why !== null && !this.mode;
    this.why = this.mode ? "mode" : null;
    this.slowest = 1;
    this.moved = false;
    this.lost = null;
    this.spawned = false;
    return exited;
  }
}

/** The Segmented board a practice finish in `style` can go to (submitSegmentedProblem): Segmented is Normal movement. */
export function segmentedBoardFor(style: string): "segmented" | null {
  return style === "autohop" || style === "segmented" ? "segmented" : null;
}

/**
 * Why a practice finish can't go to the Segmented board, or null when it can (session.ts segmentedOffer: the end card
 * offers it, !submitseg sends it; nothing goes without the player choosing). It can when the recording is actual
 * segments, exactly what a Segmented run records: from the reset, real movement between checkpoint loads that each
 * restore a state the run saved (segments.ts), with no noclip, teleport or speed reset after the last load (replayLoss),
 * and nothing on the path a run can't have: commands from another replay (Practice from here), a practice spawn, a
 * slowed tick, third person, a gun or scripted input (`tainted`, `spawn`, `slowed`, `other`). The replay is then the
 * Segmented one with style "segmented" in its header (styles.ts: same settings, filter and timer rules), and the
 * verifier checks it like any Segmented run.
 */
export function submitSegmentedProblem(o: {
  style: string;
  /** trackStyleProblem for "segmented" here (the tutorial's final course is Normal only). */
  trackProblem: string | null;
  /** Checkpoint loads on the recorded path (replay.segments). */
  loads: number;
  /** session.ts practiceReplayLoss: why the recording doesn't play back to here, or null. */
  replayLoss: string | null;
  /** A checkpoint on the path was saved in an attempt that can't count, or the path holds another replay's commands. */
  tainted: boolean;
  spawn: boolean;
  slowed: boolean;
  /** practiceReason without practice mode and tools (third person, a gun, scripted, debug, a lesson, experimental input). */
  other: string | null;
  /** Longer than the leaderboard takes (run-limits.ts). */
  tooLong: boolean;
}): string | null {
  if (!segmentedBoardFor(o.style)) return "only Normal runs can go to Segmented";
  if (o.trackProblem) return "not on this course";
  if (o.other) return o.other;
  if (o.spawn) return "the start point doesn't count";
  if (o.slowed) return "timescale was used";
  if (o.replayLoss) return o.replayLoss;
  if (o.tainted) return "a checkpoint on this run came from an attempt that doesn't count";
  if (o.tooLong) return "too long for the leaderboard";
  if (!o.loads) return "no checkpoint was loaded";
  return null;
}

/**
 * What a finish does: "practice" (practice mode or a tool: the end card for your own reference, and a practice replay
 * kept on this device when the recording plays back; never uploaded or a PB), "unranked" (third person, a lesson, scripted commands, the debug hook, a gun: kept on this device, never
 * submitted or a PB), or "submit".
 */
export function finishRoute(o: { practice: boolean; unranked: boolean }): "practice" | "unranked" | "submit" {
  if (o.practice) return "practice";
  return o.unranked ? "unranked" : "submit";
}

const restartHow = (key: string | null) => (key ? `Press ${key}` : "Type !r");

/**
 * The line when a clean attempt turns into practice. `restartKey`: the restart bind's label, if it has one. `resumable`:
 * a Segmented run with checkpoints from before (a load of one makes it real again: session.ts segmentResumable).
 */
export function practiceFlipLine(running: boolean, restartKey: string | null, tool: PracticeUse | null = null, resumable = false): string {
  if (resumable) return `This run is practice now. Load a checkpoint from before to go on with it, or ${restartKey ? `press ${restartKey}` : "type !r"} to restart.`;
  return running ? `This run is practice now. ${restartHow(restartKey)} to restart for a real run.` : `Practice until you restart. ${restartHow(restartKey)} for a real run.`;
}

const clearHow = (key: string | null) => (key ? `Press ${key}` : "Type !clearstart");

/**
 * The second line under the crosshair for a whole attempt on a practice spawn (start-point.ts). `clearKey`: the clear
 * start point bind's label, if it has one.
 */
export function practiceSpawnLine(clearKey: string | null): string {
  return `This start point doesn't count. ${clearHow(clearKey)} to go back to the real one.`;
}

/** The toast when a restart lands on a practice spawn. */
export function practiceSpawnToast(clearKey: string | null): string {
  return `Practice run: this start point doesn't count. ${clearHow(clearKey)} to go back to the real one.`;
}

/** The line when a practice attempt (a tool, not practice mode) comes back to a start zone. */
export function practiceStartLine(restartKey: string | null, tool: PracticeUse | null = null): string {
  return `Still practice. ${restartHow(restartKey)} to restart for a real run.`;
}
