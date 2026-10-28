// Why an attempt is practice (never submitted online, never saved as a PB), or null for a normal run. session.ts keeps
// the flags per attempt; the end card shows the reason. DOM-free (tools/tutorial/tutorial.test.ts runs it).

export interface PracticeFlags {
  /** The debug hook opted into outside the dev server: the whole session. */
  debug: boolean;
  /** Live third person was used this attempt. */
  thirdPerson: boolean;
  /** Commands came from the debug hook's script this attempt. */
  scripted: boolean;
  /** A tutorial lesson (1-3) was played this attempt. Not third person: the card says which. */
  lesson: boolean;
  /** Practice mode (practice-mode/: every attempt is practice while it's on) was on during this attempt. */
  mode?: boolean;
  /** A checkpoint teleport or noclip was used this attempt (practice-mode/attempt.ts). */
  tool?: "teleport" | "noclip" | "spawn" | null;
  /** A weapon command gave a gun ranked runs don't allow (weapon-rules.ts) this attempt. */
  freeGun?: boolean;
}

export function practiceReason(f: PracticeFlags): string | null {
  if (f.mode) return "practice mode";
  if (f.tool) return f.tool === "noclip" ? "practice run (noclip)" : f.tool === "spawn" ? "practice run (practice spawn)" : "practice run (checkpoint teleport)";
  if (f.debug) return "practice run (debug mode)";
  if (f.thirdPerson) return "practice run (third person)";
  if (f.scripted) return "practice run (scripted)";
  if (f.lesson) return "tutorial lesson (practice)";
  if (f.freeGun) return "practice run (gun)";
  return null;
}
