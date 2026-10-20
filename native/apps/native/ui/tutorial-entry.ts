export { TUTORIAL_MAP } from "../../web/src/tutorial/data";
export const tutorialEnabled = () => true;
export const tutorialPrompt = () => false;
export const tutorialSub = () => "Jump, strafe, build speed and finish the course";
export const openTutorial = (_pick?: (map: string) => void) => window.dispatchEvent(new CustomEvent("bunnyhop:tutorial"));
export const openTutorialBoard = openTutorial;
