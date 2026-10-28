// Tutorial entry points (all behind the flag, see flag.ts). Since v0.0.10 the tutorial lives at the top of the map list
// (Play; its row and panel are tutorial/learn.ts), with one quiet line under onboarding's "Hop in" as the first-visit
// invitation and the pause menu's item. Players can hide it there (flag.ts tutorialHidden): the row and the pause item go, and the home
// screen's "Tutorial" link (always shown) opens it in the map list. Tiny on purpose: the tutorial itself (mode.ts)
// only loads on its map, the leaderboard dialog when it's opened.

import { requestRace } from "../player/race";
import { BONUS_STYLE } from "../styles";
import { LESSON_IDS, TUTORIAL_MAP } from "./data";
import { firstSeen, NEW_PLAYER_MS, tutorialEnabled, tutorialHidden, tutorialProgress, tutorialUrl } from "./flag";
import { FINAL_TRACK } from "./flow";

export { tutorialEnabled, TUTORIAL_MAP };

/**
 * The tutorial's leaderboard: its final course (bonus 1) only. The main track (the whole tutorial, lessons included) is
 * never submitted. Used by the pause menu's Leaderboard tab on the tutorial and the dialog below.
 */
export const TUTORIAL_BOARD = { tracks: [FINAL_TRACK], track: FINAL_TRACK, trackNames: { [FINAL_TRACK]: "Final course" } };

/** True where the tutorial invites you in (the map list's top row, the pause menu): on, and not hidden by the player. */
export function tutorialPrompt(): boolean {
  return tutorialEnabled() && !tutorialHidden();
}

/**
 * "Learn to bhop" on the home screen's menu: a new player's first NEW_PLAYER_MS (from this browser's first visit), until
 * they finish the tutorial or hide it. `onboarded`: the first-visit intro was already behind this browser.
 */
export function tutorialOnHome(onboarded: boolean, now = Date.now()): boolean {
  return tutorialPrompt() && !tutorialProgress().finished && now - firstSeen(onboarded, now) < NEW_PLAYER_MS;
}

/** The final course's leaderboard in a dialog (map list). Race opens the tutorial with that run as the ghost. */
export function openTutorialBoard(pick?: (map: string) => void): void {
  void import("../ui/leaderboard").then((m) =>
    m.openLeaderboardDialog(TUTORIAL_MAP, BONUS_STYLE, {
      ...TUTORIAL_BOARD,
      subtitle: "Learn to bhop",
      onRace: (e, track) => {
        document.querySelector<HTMLDialogElement>("dialog.rb-dialog[open]")?.close();
        requestRace({ kind: "run", runId: e.runId, name: `#${e.rank} · ${e.player.name}`, track, time: e.time });
        openTutorial(pick);
      },
    }),
  );
}

/** Opens the tutorial: through the menu's map picker when there is one (no reload), else a page load. */
export function openTutorial(pick?: (map: string) => void): void {
  if (pick) pick(TUTORIAL_MAP);
  else location.href = tutorialUrl();
}

/** Lessons done (of the current four). */
export function lessonsDone(): number {
  const p = tutorialProgress();
  return LESSON_IDS.filter((id) => p.lessons[id]).length;
}

/** The tutorial's one-line status: your progress once you've started (nothing before: the name says what it is). */
export function tutorialSub(): string {
  const p = tutorialProgress();
  const n = lessonsDone();
  if (p.finished) return p.best !== undefined ? `Finished, best ${p.best.toFixed(2)} s${p.gold ? " (gold)" : ""}` : "Finished";
  if (n) return `${n} of ${LESSON_IDS.length} lessons done`;
  return "";
}
