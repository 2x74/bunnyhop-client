// The tutorial's home (v0.0.10): a row pinned at the top of the map list (ui/maps.ts) and its panel: one line on how
// far you got, the final course's board, Start, and "Hide" (flag.ts tutorialHidden). Hidden, the row goes; the
// home screen's "Tutorial" link and the map list's search still find it.

import { BONUS_STYLE } from "../styles";
import { h } from "../ui/dom";
import { mapBoard } from "../ui/map-board";
import { LESSON_IDS, TUTORIAL_MAP } from "./data";
import { openTutorial, openTutorialBoard } from "./entry";
import { setTutorialHidden, tutorialHidden, tutorialProgress } from "./flag";
import { FINAL_TRACK } from "./flow";

/** Words that find the tutorial in the map list's search (also when it's hidden). */
const WORDS = ["tutorial", "learn to bhop", "lessons", "how to bhop", TUTORIAL_MAP];

export function matchesTutorial(q: string): boolean {
  return q.length >= 3 && WORDS.some((w) => w.includes(q));
}

/** The logo's hop arcs (home screen) on a dark panel: the tutorial's picture in the list and its panel. */
export function tutorialArt(cls: string): HTMLElement {
  const el = h(`div.card-art.tut-art.${cls}`, { "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet"><path class="tut-trail" d="M8 70 Q22 56 36 70 Q55 46 74 70 Q99 36 124 70 Q140 44 156 58"/><circle class="tut-dot" cx="156" cy="58" r="3.4"/></svg>`;
  return el;
}

export interface TutorialPanelOptions {
  pick: (map: string) => void;
  /** Hidden or shown again (the list redraws). */
  onHidden: (hidden: boolean) => void;
}

/** Title, one sentence, the final course's board, Start and a text Hide. (The lessons teach the rest, in the game.) */
export function tutorialPanel(o: TutorialPanelOptions): HTMLElement {
  const p = tutorialProgress();
  const done = LESSON_IDS.filter((id) => p.lessons[id]).length;
  const hidden = tutorialHidden();
  const start = h("button.btn.primary.mbd-play", { type: "button", onclick: () => openTutorial(o.pick) }, p.finished ? "Play it again" : done ? "Continue" : "Start");
  const line = p.finished
    ? "You finished it. The final course is a race against everyone who did."
    : done
      ? `${done} of ${LESSON_IDS.length} lessons done.`
      : "Four short lessons with a strafe guide, then a final course. About two minutes.";
  return h(
    "div.mbd-inner.mbd-tut",
    { "data-name": TUTORIAL_MAP },
    tutorialArt("mbd-art"),
    h(
      "div.mbd-main",
      null,
      h("header.mbd-title", null, h("h3", null, "Learn to bhop"), h("p.mbd-meta", null, line)),
      mapBoard({ map: TUTORIAL_MAP, style: BONUS_STYLE, track: FINAL_TRACK, ranked: null, title: "Final course", onFull: () => openTutorialBoard(o.pick) }),
      h(
        "div.mbd-actions",
        null,
        start,
        h(
          "button.link-btn.tut-hide",
          { type: "button", title: hidden ? null : "It stays under Tutorial on the home screen.", onclick: () => (setTutorialHidden(!hidden), o.onHidden(!hidden)) },
          hidden ? "Show at the top" : "Hide",
        ),
      ),
    ),
  );
}
