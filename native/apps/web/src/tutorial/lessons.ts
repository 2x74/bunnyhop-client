// Lesson copy. One goal per lesson and one short line telling you how; everything else is shown in the map (painted
// titles, the strafe line, gates and the exit lighting up) or by the demo ghost. The coach's nudges (coach.ts) only
// appear when something's going wrong. {jump}, {forward}, {left}, {right} become the player's bound keys.

import type { LessonId } from "./data";
import type { Nudge } from "./coach";

export interface LessonCopy {
  title: string;
  /** The instruction per step (lesson 2 has two: left, then right). Legit Scroll has its own for lesson 1. */
  steps: string[];
  legit?: string[];
  /** Strafe guide (crosshair arcs) on by default. */
  guide: boolean;
  /** Landing marker (where this hop comes down) on by default. */
  landing: boolean;
}

export const LESSONS: Record<LessonId, LessonCopy> = {
  jump: { title: "Jump", steps: ["Hold {jump} to keep jumping"], legit: ["Scroll to jump each time you land"], guide: false, landing: false },
  strafe: { title: "Strafe in the air", steps: ["In the air: hold {left}, move the mouse left", "Now {right}, mouse right"], guide: true, landing: false },
  speed: { title: "Build speed", steps: ["Switch sides each jump to build speed"], guide: true, landing: false },
  final: { title: "Put it together", steps: ["Jump at the orange edges"], guide: false, landing: true },
};

/** When the lesson's goal is met (the exit lights up). */
export const EXIT_OPEN = "The exit is open, hop through";

export const NUDGES: Record<Nudge, string> = {
  forward: "Let go of {forward} in the air",
  opposite: "Mouse and key the same way",
  "mouse-left": "Move the mouse left too",
  "mouse-right": "Move the mouse right too",
  "key-left": "Hold {left} while you turn left",
  "key-right": "Hold {right} while you turn right",
  slower: "Turn a little slower and smoother",
  "keep-holding": "Keep holding it, no need to tap",
  "scroll-on-land": "Scroll right as you touch down",
  edge: "Jump at the edge, not before",
};
