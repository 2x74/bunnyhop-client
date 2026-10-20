// The tutorial's flow rules, DOM-free: mode.ts and board.ts use them, tools/tutorial/tutorial.test.ts runs them on the
// real sim.

import type { LessonId } from "./data";

/** The final course is the map's bonus 1: its own timed run and board (bonus runs are Normal style). */
export const FINAL_TRACK = 1;

/** Lessons 1-3 are practice: an attempt that plays one is never submitted or saved as a PB. The final course isn't. */
export const lessonIsPractice = (id: LessonId): boolean => id !== "final";

/**
 * Whether arriving in the final course needs a restart onto its start pad. The exit portal from lesson 3 drops you at
 * the course's arrival point, ahead of the bonus 1 start pad, still at lesson 3's speed and with the main-track timer
 * of the whole tutorial going (or idle after an R in a lesson): no bonus 1 run could start from there. Restarting onto
 * the pad (what R does on the course) makes every final-course attempt a fresh bonus 1 run from a standing start, which
 * timer rules 2 need. Already on the pad (a restart onto bonus 1 from the menu, ?lesson=final): nothing to do.
 */
export function needsFinalRestart(entering: LessonId, from: LessonId | null, onStartPad: boolean): boolean {
  return entering === "final" && from !== "final" && !onStartPad;
}

/**
 * The run to beat next on a board sorted fastest first: the slowest run strictly faster than `mine` (null: you're
 * first, or it isn't among `rows`). `rows` is any contiguous stretch of the board from its top.
 */
export function nextToBeat<E extends { time: number }>(rows: readonly E[], mine: { time: number } | null): E | null {
  if (!mine) return null;
  let out: E | null = null;
  for (const e of rows) if (e.time < mine.time) out = e;
  return out;
}

/**
 * Where the gold-time line goes among `rows` (sorted fastest first): the index of the first row slower than gold, or
 * rows.length after the last; null when it would fall below a full page (it's off the shown part of the board).
 */
export function goldSlot(rows: readonly { time: number }[], gold: number, page: number, total: number): number | null {
  const i = rows.findIndex((e) => e.time > gold);
  if (i >= 0) return i;
  return rows.length < page || total <= rows.length ? rows.length : null;
}
