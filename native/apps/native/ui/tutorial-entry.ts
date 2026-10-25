import { LESSON_IDS } from "../../web/src/tutorial/data";
import { firstSeen, NEW_PLAYER_MS } from "../../web/src/tutorial/flag";
import { state } from "./bridge";
export { TUTORIAL_MAP } from "../../web/src/tutorial/data";
export const tutorialEnabled = () => true;
export const tutorialPrompt = () => false;
export const tutorialSub = () => "Jump, strafe, build speed and finish the course";
export const openTutorial = (_pick?: (map: string) => void) => window.dispatchEvent(new CustomEvent("bunnyhop:tutorial"));
export const openTutorialBoard = openTutorial;
/** "Learn to bhop" on the home menu: the web rule (a new player's first two days), until every lesson is done. */
export const tutorialOnHome = (onboarded: boolean, now = Date.now()) =>
  now - firstSeen(onboarded, now) < NEW_PLAYER_MS && LESSON_IDS.some((id) => !state.tutorial.completed.includes(id));
