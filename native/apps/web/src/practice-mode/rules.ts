// Practice rules: where practice works, what a practice chat command does, the third person rule. DOM-free
// (apps/api/test/practice.test.ts). Manual turn controls live in turn-binds.ts.

/** Practice tools: checkpoints and noclip. They work in any solo attempt; a teleport or noclip makes it practice. */
export const PRACTICE_TOOLS = ["noclip", "cpSave", "cpTeleport", "cpPrev", "cpNext"] as const;
export type PracticeTool = (typeof PRACTICE_TOOLS)[number];
export const isPracticeTool = (a: string): a is PracticeTool => (PRACTICE_TOOLS as readonly string[]).includes(a);

export interface PracticeContext {
  /** Playing in a multiplayer room (?server=). */
  inRoom: boolean;
  /** On the tutorial map (it has its own lesson practice). */
  tutorial: boolean;
  /** In a gauntlet attempt (gauntlet/mode.ts): its runs are its splits, and practice never submits. */
  gauntlet?: boolean;
}

/**
 * Why practice (practice mode, checkpoints, noclip) can't be used here, or null if it can. Rooms: everyone there sees
 * your player, and noclip or checkpoint teleports would look like a broken player to them; practice is for solo play.
 * The tutorial runs its own lessons (they're already practice).
 */
export function practiceUnavailable(c: PracticeContext): string | null {
  if (c.inRoom) return "Practice is for solo play, not servers.";
  if (c.tutorial) return "Practice isn't available in the tutorial.";
  if (c.gauntlet) return "No practice during a gauntlet.";
  return null;
}

/**
 * Third person can't be turned on during a ranked run: from the run's first tick until it finishes or restarts. It
 * stays available everywhere else: before you leave the start zone, after a finish, in practice mode, on any attempt
 * that is already practice, and turning it off is always allowed.
 */
export function thirdPersonBlocked(o: { turningOn: boolean; runStarted: boolean; unranked: boolean }): boolean {
  return o.turningOn && o.runStarted && !o.unranked;
}

/** A practice command typed in chat (chat-commands.ts PracticeCommand). */
export type PracticeChatCommand = "toggle" | "menu" | "noclip" | "save" | "tele" | "prev" | "next";

/**
 * What a practice chat command does: say why it can't ("unavailable": rooms, the tutorial, a gauntlet), turn practice
 * mode on or off ("toggle": !practice), or use the tool ("do"). Like the keys, the tools work in any solo attempt: !cp
 * never touches the run, and !tele / !noclip turn the attempt into practice (attempt.ts), with one line saying so.
 */
export function practiceCommandPlan(o: { cmd: PracticeChatCommand; unavailable: boolean }): "unavailable" | "toggle" | "do" {
  if (o.unavailable) return "unavailable";
  return o.cmd === "toggle" ? "toggle" : "do";
}

/**
 * Whether a bound practice key acts now (CS:S: during a run you open the checkpoint menu or type the command). Saving
 * always does: it never touches the run. A teleport or noclip from a key would turn a real timed run into practice, so
 * during one ("timedRun": the timer has started and the attempt isn't practice yet) the key only acts while the !cp
 * menu is open; otherwise it says how ("hint"). Before the start, after a finish and on practice attempts keys act.
 * Typed commands (!tele, !noclip) always act: typing is deliberate.
 */
export function practiceKeyGate(o: { tool: PracticeTool; timedRun: boolean; menuOpen: boolean }): "act" | "hint" {
  if (o.tool === "cpSave" || !o.timedRun || o.menuOpen) return "act";
  return "hint";
}

/** The hint a gated key gives (once per run). */
export const PRACTICE_KEY_HINT = "Type !cp to use checkpoints and noclip during a run.";
