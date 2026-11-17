// Timescale (!timescale, !ts, and Timescale in the pause menu's Style tab): slow motion for working out a route, only in solo
// practice mode. Only the frame loop's time accumulator is scaled (main.ts): the sim, the recording, the timer, SSJ and
// the HUD stay tick-based, and the timer shows game time. Mouse turn keeps its real-time rate, so each slowed tick
// carries more of it, as with CS:S host_timescale. Sounds fire on tick events and space out by themselves; no pitch
// shift. 0.1 to 1: above 1 isn't offered.
//
// A run can't keep a scale: frame() answers 1 the moment practice mode is off or anything else blocks it, and forgets
// the choice; a tick at another scale also makes the attempt practice (attempt.ts slowed). DOM-free
// (test/practice-timescale.test.ts).

import { registerChatCommand } from "../chat-commands";

export const TIMESCALE_MIN = 0.1;
/** The pause menu's buttons (menu.ts timescaleGroup). */
export const TIMESCALE_STEPS = [1, 0.75, 0.5, 0.25] as const;

export interface TimescaleContext {
  practiceMode: boolean;
  inRoom: boolean;
  tutorial: boolean;
  gauntlet: boolean;
  segmented: boolean;
  experiment: boolean;
}

/** Why the timescale can't be used now, or null. */
export function timescaleBlocked(c: TimescaleContext): string | null {
  if (c.inRoom) return "Timescale only works in solo practice.";
  if (c.tutorial) return "Timescale isn't available in the tutorial.";
  if (c.gauntlet) return "No timescale during a gauntlet.";
  if (c.experiment) return "Timescale is off while the input experiment runs.";
  if (c.segmented) return "Timescale isn't available in Segmented.";
  if (!c.practiceMode) return "Timescale only works in practice mode. Type !practice first.";
  return null;
}

/** "0.5x", "0.25x", "1x". */
export const timescaleLabel = (scale: number) => `${Math.round(scale * 100) / 100}x`;

/** A typed value: 0.1 to 1, "0.5", ".5", "50%" or "0.5x"; null when it isn't one. */
export function parseTimescale(arg: string): number | null {
  const m = /^(\d*\.?\d+)\s*(%|x)?$/i.exec(arg.trim());
  if (!m) return null;
  const v = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
  if (!Number.isFinite(v) || v < TIMESCALE_MIN - 1e-9 || v > 1 + 1e-9) return null;
  return Math.round(v * 100) / 100;
}

export class Timescale {
  private chosen = 1;

  /** The scale chosen in practice (1 when none). */
  get value(): number {
    return this.chosen;
  }

  /** The scale this frame runs at: the chosen one while it's allowed; otherwise 1, and the choice is forgotten. */
  frame(c: TimescaleContext): number {
    if (timescaleBlocked(c)) this.chosen = 1;
    return this.chosen;
  }

  /** Sets the scale. The reply line, or the reason it can't. */
  set(scale: number, c: TimescaleContext): string {
    const blocked = timescaleBlocked(c);
    if (blocked) return blocked;
    this.chosen = scale;
    return scale === 1 ? "Timescale back to normal." : `Timescale ${timescaleLabel(scale)}. It goes back to 1x when you leave practice.`;
  }
}

/**
 * One frame's ticks. `acc`: the game milliseconds not yet ticked; `elapsed`: real milliseconds since the last frame
 * (250 at most count, so a stall doesn't run a burst). Each tick's boundary `at` is where it fell on the real clock,
 * for timed input (timed-input.ts take): with the scale, a tick of game time spans tickMs / scale of real time.
 * Returns what's left in the accumulator. At scale 1 this is exactly the loop as it ran before the timescale.
 */
export function runTicks(acc: number, elapsed: number, now: number, scale: number, tickMs: number, tick: (at: number) => void): number {
  acc += Math.min(elapsed, 250) * scale;
  const from = now - elapsed;
  while (acc >= tickMs) {
    // (After a change of scale the leftover was gathered at the old one: never before the last frame.)
    tick(Math.max(from, now - (acc - tickMs) / scale));
    acc -= tickMs;
  }
  return acc;
}

/** !timescale [0.1-1] (alias !ts): solo practice only; in rooms it answers why not. */
export function registerTimescaleCommand(t: Timescale, context: () => TimescaleContext): () => void {
  return registerChatCommand({
    name: "timescale", aliases: ["ts"], args: "[0.1-1]", help: "slow motion in practice",
    about: "slows the game down in practice mode, from 0.1 to 1. The timer shows game time. It goes back to 1 when you leave practice.",
    group: "practice", panelOnly: true, where: "both",
    run: (ctx, arg) => {
      if (!arg.trim()) {
        const blocked = timescaleBlocked(context());
        return ctx.reply(blocked ?? `Timescale ${timescaleLabel(t.value)}. ${t.value === 1 ? "Type !timescale 0.5 to slow down." : "Type !timescale 1 for normal speed."}`);
      }
      const v = parseTimescale(arg);
      ctx.reply(v === null ? "Use !timescale 0.1 to 1, like !timescale 0.5" : t.set(v, context()));
    },
  });
}
