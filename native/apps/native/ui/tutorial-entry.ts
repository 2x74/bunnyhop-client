// The web's tutorial entry points (tutorial/entry.ts) for the native menu. The row pinned at the top of the map list
// and its panel are the web's own (tutorial/learn.ts, ui/maps.ts); Start opens the native lessons. The host keeps
// lesson progress, and installTutorialProgress copies it into the web's record so the row and panel read it.
import { LESSON_IDS } from "../../web/src/tutorial/data";
import {
  firstSeen,
  NEW_PLAYER_MS,
  saveTutorialProgress,
  tutorialHidden,
  tutorialProgress,
} from "../../web/src/tutorial/flag";
import { state } from "./bridge";
export { TUTORIAL_MAP } from "../../web/src/tutorial/data";

export const tutorialEnabled = () => true;
/** At the top of the map list (and the pause menu) unless the player hid it (web "Show the tutorial"). */
export const tutorialPrompt = () => tutorialEnabled() && !tutorialHidden();
export const openTutorial = (_pick?: (map: string) => void) =>
  window.dispatchEvent(new CustomEvent("bunnyhop:tutorial"));
export const openTutorialBoard = openTutorial;

const lessonsDone = () => LESSON_IDS.filter((id) => state.tutorial.completed.includes(id)).length;

/** The row's line under "Tutorial" (web tutorialSub): progress once started, nothing before. */
export function tutorialSub(): string {
  const progress = tutorialProgress();
  if (progress.finished) {
    return progress.best !== undefined ? `Finished, best ${progress.best.toFixed(2)} s` : "Finished";
  }
  const done = lessonsDone();
  return done ? `${done} of ${LESSON_IDS.length} lessons done` : "";
}

/** "Learn to bhop" on the home menu: the web rule (a new player's first two days), until every lesson is done. */
export const tutorialOnHome = (onboarded: boolean, now = Date.now()) =>
  tutorialPrompt() && now - firstSeen(onboarded, now) < NEW_PLAYER_MS && lessonsDone() < LESSON_IDS.length;

/** Lessons the host has seen completed, into the web's tutorial record (first completion time, as the web keeps). */
function copyProgress(): void {
  const recorded = tutorialProgress().lessons;
  const missing = LESSON_IDS.filter((id) => state.tutorial.completed.includes(id) && recorded[id] === undefined);
  if (!missing.length) return;
  const now = Date.now();
  saveTutorialProgress((progress) => {
    for (const id of missing) progress.lessons[id] = now;
  });
}

export function installTutorialProgress(): void {
  window.addEventListener("bunnyhop:host-state", copyProgress);
}
