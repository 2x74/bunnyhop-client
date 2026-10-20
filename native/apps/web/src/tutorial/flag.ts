// The tutorial is on for everyone since v0.0.7 (the map is hosted: research/TUTORIAL.md). `?tutorial=0` turns it off
// (remembered as localStorage "bunnyhop:tutorial" = "0"), `?tutorial=1` back on.
// Players can also hide it (v0.0.10): its row at the top of the map list and the pause menu item go away, and it stays
// one click away from the home screen's links (and the map list's search). Unlike `?tutorial=0`, it's still there.
// Also the tutorial's local progress (lessons done, the final course, the graduate badge record).

import { getPB } from "../pb";
import { BONUS_STYLE } from "../styles";
import { TUTORIAL_MAP, type LessonId } from "./data";
import { FINAL_TRACK } from "./flow";

const FLAG = "bunnyhop:tutorial";
const PROGRESS = "bunnyhop:tutorial-progress";

export function tutorialEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("tutorial");
    if (q === "1") localStorage.removeItem(FLAG);
    if (q === "0") localStorage.setItem(FLAG, "0");
    return localStorage.getItem(FLAG) !== "0";
  } catch {
    return true;
  }
}

const FIRST_SEEN = "bunnyhop:first-seen";
/** How long a new player has "Learn to bhop" on the home screen's menu (home.ts), unless they finish or hide it. */
export const NEW_PLAYER_MS = 48 * 3600_000;

/**
 * When this browser first opened the game (ms), recorded on the first home screen. A browser that already had the
 * first-visit intro behind it before this existed (0.0.15) is an old hand: 0.
 */
export function firstSeen(onboarded: boolean, now = Date.now()): number {
  try {
    const v = Number(localStorage.getItem(FIRST_SEEN));
    if (localStorage.getItem(FIRST_SEEN) !== null && Number.isFinite(v)) return v;
    const t = onboarded ? 0 : now;
    localStorage.setItem(FIRST_SEEN, String(t));
    return t;
  } catch {
    return now;
  }
}

const HIDDEN = "bunnyhop:tutorial-hidden";
const hiddenListeners = new Set<(hidden: boolean) => void>();

/** The player hid the tutorial from the map list and the pause menu (Settings, or "Hide" on the tutorial itself). */
export function tutorialHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN) === "1";
  } catch {
    return false;
  }
}

export function setTutorialHidden(hidden: boolean): void {
  if (hidden === tutorialHidden()) return;
  try {
    if (hidden) localStorage.setItem(HIDDEN, "1");
    else localStorage.removeItem(HIDDEN);
  } catch {
    /* private mode: applies to this page only */
  }
  for (const l of hiddenListeners) l(hidden);
}

/** Called when the tutorial is hidden or shown again. Returns an unsubscribe function. */
export function onTutorialHidden(fn: (hidden: boolean) => void): () => void {
  hiddenListeners.add(fn);
  return () => hiddenListeners.delete(fn);
}

export interface TutorialProgress {
  /** Lesson id -> first completion (ms). */
  lessons: Partial<Record<LessonId, number>>;
  /** First finish of the final course (ms), best time (s), gold reached. */
  finished?: number;
  best?: number;
  gold?: boolean;
}

export function tutorialProgress(): TutorialProgress {
  let p: TutorialProgress;
  try {
    const v = JSON.parse(localStorage.getItem(PROGRESS) ?? "null") as TutorialProgress | null;
    p = v && typeof v === "object" && v.lessons ? v : { lessons: {} };
  } catch {
    return { lessons: {} };
  }
  // One-time repair (v0.0.7 lost finishes, research/TUTORIAL.md): a saved final-course PB proves a finish.
  if (repairProgress(p, getPB(TUTORIAL_MAP, BONUS_STYLE, FINAL_TRACK))) save(p);
  return p;
}

/**
 * Records a finish of the final course (mode.ts): the course and the tutorial count as done whatever the run was
 * (practice too). Only a bonus 1 time is a best: the main track (the whole tutorial) ends in the same zone.
 * Returns whether this was the first finish (the graduation).
 */
export function recordFinalFinish(p: TutorialProgress, f: { track: number; seconds: number; gold: boolean; at: number }): boolean {
  const first = !p.finished;
  p.lessons.final ??= f.at;
  p.finished ??= f.at;
  if (f.track === FINAL_TRACK) {
    p.best = Math.min(p.best ?? Infinity, f.seconds);
    p.gold ||= f.gold;
  }
  return first;
}

/**
 * Progress from before v0.0.8 could miss a finish of the final course (the end of a run straight through the lessons
 * was never recorded). A final-course PB on this device proves one: mark it finished with that time. Returns whether
 * anything changed.
 */
export function repairProgress(p: TutorialProgress, pb: { time: number; date: number } | null): boolean {
  if (!pb || (p.finished && p.best !== undefined && p.best <= pb.time)) return false;
  p.lessons.final ??= pb.date;
  p.finished ??= pb.date;
  p.best = Math.min(p.best ?? Infinity, pb.time);
  return true;
}

function save(p: TutorialProgress): void {
  try {
    localStorage.setItem(PROGRESS, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

export function saveTutorialProgress(f: (p: TutorialProgress) => void): TutorialProgress {
  const p = tutorialProgress();
  f(p);
  save(p);
  return p;
}

/** URL that opens the tutorial. */
export function tutorialUrl(lesson?: LessonId): string {
  const u = new URL(location.origin + "/");
  u.searchParams.set("map", TUTORIAL_MAP);
  if (lesson) u.searchParams.set("lesson", lesson);
  return u.toString();
}
