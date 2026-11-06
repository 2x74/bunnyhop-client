// Running a command bind (Prefs.cmdBinds) or an alias the way Source does (engine keys.cpp Key_Event, cmd.cpp aliases),
// for the input layer (input.ts) and the console. DOM-free.
//
//   press    every command of the bind in order: `+x` holds action x (or runs alias `+x`), `-x` lets it go (or runs
//            alias `-x`), an alias name runs its text, anything else (`say gg`, `slot1`, `toggle cl_showfps 0 1`) runs
//            once, like typed in the console.
//   release  Source sends `-x` for a bind that starts with `+`. For a chain this follows CS:GO, which (unlike the 2007
//            engine, which only released the first one) lets go of every top-level `+` command, in the order pressed:
//            `+moveleft; +left` -> `-moveleft`, `-left`; `+mleft` -> alias `-mleft`.
//
// Holds made directly by the bind belong to the key (the release lets go of exactly those). Holds made inside an alias
// are the alias's to release (Source runs them without a key number, i.e. "held until -x"): a `-x` from an alias lets
// go of every hold of x the binds made, which is what `alias +mleft "+moveleft; +left"; alias -mleft "-moveleft; -left"`
// and the toggle scripts (`alias jt jon; alias jon "+jump; alias jt joff"; ...`) rely on. Physical keys are never
// released by a command. Aliases nest; a loop stops at MAX_DEPTH / MAX_STEPS with an error. `wait` (the classic
// crouch-jump scripts' `-jump; wait; -duck`) puts what follows one tick later: input.ts runs it after the next command.

import { actionForCommand } from "./names";
import { splitCommands, tokenize } from "./parse";
import type { Action } from "../ui/settings";

export const MAX_DEPTH = 16;
export const MAX_STEPS = 256;

export interface ChainOps {
  /** Hold `action` (a `+` command). `own`: made by the bind itself (the key's release lets go of it). */
  hold(action: Action, own: boolean): void;
  /** Let go of `action` (a `-` command). `own`: this key's own hold only; else every command hold of it. */
  unhold(action: Action, own: boolean): void;
  /** Anything else, run once (the console's command runner). */
  once(command: string): void;
  /** An alias loop or a runaway chain (stopped). */
  error?(text: string): void;
  /** Source's `wait`: what follows runs one tick later. Without a handler it's ignored. */
  wait?(): void;
}

/** Name -> text, names lower case (Prefs.aliases). */
export type Aliases = Readonly<Record<string, string>>;

interface Run {
  steps: number;
  stopped: boolean;
}

function exec(text: string, aliases: Aliases, ops: ChainOps, depth: number, own: boolean, run: Run): void {
  for (const cmd of splitCommands(text)) {
    if (run.stopped) return;
    if (++run.steps > MAX_STEPS) {
      run.stopped = true;
      ops.error?.(`Stopped after ${MAX_STEPS} commands (an alias loop?).`);
      return;
    }
    const name = (tokenize(cmd)[0] ?? "").toLowerCase();
    if (!name) continue;
    if (name === "wait") {
      ops.wait?.();
      continue;
    }
    // Aliases first, as Source's command buffer checks them before commands.
    if (Object.prototype.hasOwnProperty.call(aliases, name)) {
      if (depth >= MAX_DEPTH) {
        run.stopped = true;
        ops.error?.(`Alias "${name}" nests deeper than ${MAX_DEPTH} (a loop?).`);
        return;
      }
      exec(aliases[name], aliases, ops, depth + 1, false, run);
      continue;
    }
    if (name.startsWith("+") || name.startsWith("-")) {
      const a = actionForCommand("+" + name.slice(1));
      if (a) {
        if (name[0] === "+") ops.hold(a, own);
        else ops.unhold(a, own);
      } else if (name[0] === "+") ops.once(cmd); // unknown: the runner says so
      // (an unknown `-x`: the release of a + command nobody defined; Source prints it, here it's quiet)
      continue;
    }
    ops.once(cmd);
  }
}

/** The top-level `+` commands of a bind, as the `-` commands its release runs (in press order). */
export function releaseOf(text: string): string[] {
  const out: string[] = [];
  for (const cmd of splitCommands(text)) {
    const name = (tokenize(cmd)[0] ?? "").toLowerCase();
    if (name.length > 1 && name.startsWith("+")) out.push("-" + name.slice(1));
  }
  return out;
}

/** A key bound to `text` went down. */
export function runPress(text: string, aliases: Aliases, ops: ChainOps): void {
  exec(text, aliases, ops, 0, true, { steps: 0, stopped: false });
}

/** The key bound to `text` came up: its `-` commands. */
export function runRelease(text: string, aliases: Aliases, ops: ChainOps): void {
  const minus = releaseOf(text);
  if (minus.length) exec(minus.join(";"), aliases, ops, 0, true, { steps: 0, stopped: false });
}

/** Movement commands (+forward / +back / +moveleft / +moveright) and turn commands (+left / +right / +speed). */
export const MOVE_ACTIONS: ReadonlySet<Action> = new Set<Action>(["forward", "back", "left", "right"]);
export const TURN_ACTIONS: ReadonlySet<Action> = new Set<Action>(["turnLeft", "turnRight", "turnFast"]);
/** Why a key can't move and turn (the console, config import, a refused press). */
export const MOVE_TURN_REFUSAL = "Moving and turning on one key isn't allowed.";

/**
 * True when one press of a key bound to `text` would start both a movement and a turn command, however nested in
 * aliases (owner rule, 11-06: no keyboard strafe-and-turn on one key). A dry run: holds only, nothing runs. Two
 * physical keys pressed together are still two presses, and allowed.
 */
export function mixesMoveAndTurn(text: string, aliases: Aliases): boolean {
  let move = false;
  let turn = false;
  runPress(text, aliases, {
    hold: (a) => {
      if (MOVE_ACTIONS.has(a)) move = true;
      if (TURN_ACTIONS.has(a)) turn = true;
    },
    unhold: () => {},
    once: () => {},
  });
  return move && turn;
}

/**
 * Every action a bind holds while its key is down (aliases followed), for the Keys page and checks. Once-commands
 * aren't listed.
 */
export function heldActions(text: string, aliases: Aliases): Action[] {
  const held = new Set<Action>();
  runPress(text, aliases, { hold: (a) => held.add(a), unhold: (a) => held.delete(a), once: () => {} });
  return [...held];
}
