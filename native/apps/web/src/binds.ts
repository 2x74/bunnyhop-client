// Default key binds, DOM-free so shared code (settings, its tests under the API's Node-only typecheck) can import
// them without pulling in the input layer. Codes are described in input.ts.

import type { Action } from "./ui/settings";

/**
 * Weapon selection (physics v5 maps hand out guns): slot 1 (primary), slot 2 (pistol), slot 3 (knife), the last weapon,
 * next / previous, drop and reload. Ordinary actions (ui/settings.ts `Action`, Settings -> Keys "Weapons"; defaults
 * added to saved binds by migrateBinds). Input.setBinds still never lets them take a key another action uses.
 */
export type WeaponAction = "slot1" | "slot2" | "slot3" | "lastWeapon" | "nextWeapon" | "prevWeapon" | "drop" | "reload";
export const WEAPON_ACTIONS: readonly WeaponAction[] = ["slot1", "slot2", "slot3", "lastWeapon", "nextWeapon", "prevWeapon", "drop", "reload"];
export type BindAction = Action | WeaponAction;
export const isWeaponAction = (a: string): a is WeaponAction => (WEAPON_ACTIONS as readonly string[]).includes(a);

/**
 * Mouse button codes are Source's names: Mouse1 left, Mouse2 right, Mouse3 middle, Mouse4 / Mouse5 the side buttons,
 * then Mouse6 and up for additional buttons reported by the browser.
 * MouseEvent.button numbers them left 0, middle 1, right 2 (before 0.0.12 the code was `Mouse${button + 1}`, which made
 * right-click Mouse3 and left the default stab / silencer bind, Mouse2, on the middle button; settings.ts
 * migrateMouseNames moves saved binds over).
 */
export function mouseCode(button: number): string {
  return button === 1 ? "Mouse3" : button === 2 ? "Mouse2" : `Mouse${button + 1}`;
}

/**
 * Side buttons also mean browser Back / Forward. Cancel the whole press, including release and auxclick:
 * canceling only mousedown can still navigate on release. Keep propagation so input / bind capture still sees it.
 * The caller decides when the game owns these buttons; normal page navigation works outside that scope.
 */
export function guardSideMouseButtons(target: EventTarget, active: () => boolean): () => void {
  const owned = new Set<number>();
  const guard = (event: Event) => {
    const button = (event as Event & { button: number }).button;
    if (!(button >= 3)) return;
    const on = active();
    if (event.type === "mousedown") {
      if (on) owned.add(button);
      else owned.delete(button);
    }
    // A bind can open a menu and release pointer lock on mousedown. Still own that press's release / auxclick.
    if (on || owned.has(button)) event.preventDefault();
    if (event.type === "auxclick") owned.delete(button);
  };
  const events = ["mousedown", "mouseup", "auxclick"] as const;
  const options = { capture: true, passive: false };
  for (const type of events) target.addEventListener(type, guard, options);
  return () => {
    for (const type of events) target.removeEventListener(type, guard, options);
  };
}

export const DEFAULT_BINDS: Record<BindAction, string[]> = {
  forward: ["KeyW"],
  back: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  jump: ["Space", "MouseWheel"],
  duck: ["ControlLeft"],
  use: ["KeyE"],
  restart: ["KeyR"],
  restartBonus: ["KeyB", "F4"],
  restartMain: ["KeyM"],
  // Start point (start-point.ts): 4 is a free left-hand key, so the mouse can hold the view while saving. Clear stays
  // unbound (rare; !clearstart in rooms, or save a new one).
  setStart: ["Digit4"],
  clearStart: [],
  cycleStyle: ["F3"],
  // Main menu straight from the game: unbound (it ends the run; leave-confirm.ts asks once during a timed run). The
  // pause menu's own key for it is Backspace (menu.ts), which the tutorial uses in game for the previous lesson.
  mainMenu: [],
  hudEditor: ["F2"],
  // Chat (say / say_team in CS:S). Before it was an action these keys opened it whenever nothing else was bound to them;
  // saved binds that use Y or U for something else keep it there (settings.ts migrateBinds adds only free keys).
  chat: ["KeyY", "KeyU"],
  thirdPerson: ["KeyT"],
  // Viewmodel (cosmetic; never sim inputs). Movement binds win if a key is bound to both (see Input.press).
  attack: ["Mouse1"],
  attack2: ["Mouse2"],
  inspect: ["KeyF"],
  viewmodel: ["KeyH"],
  // Unbound: a toggle most players never use shouldn't take a key off anyone (bind it in Settings -> Keys).
  flashlight: ["KeyL"],
  keysOverlay: [],
  // Hide UI while watching a replay or spectating (ui/hide-ui.ts), for recording clips. F1 hides the HUD in a lot of
  // games; F2 / F3 are already the HUD editor and the style switch.
  hideUi: ["F1"],
  // M is the main-track restart; O / P are free in game and in the replay viewer.
  mute: ["KeyO"],
  nextTrack: ["KeyP"],
  // Private surface paint. Opt in through Settings -> Keys; no existing keyboard or side-button bind is taken.
  paint: [],
  paintOnce: [],
  clearPaint: [],
  measurePoint: [],
  clearMeasure: [],
  lastLj: [],
  // Practice (practice-mode/). Practice mode's toggle is in the pause menu, so it starts unbound. The tools work in any
  // solo attempt (a teleport or noclip makes it practice), but during a real timed run X / Z only act while the !cp
  // menu is open (rules.ts practiceKeyGate); C always saves. Where the tools can't work, their keys fall through (the
  // tutorial's X; the dev zone editor's Z while practice mode is off). Z / X / C sit together under the movement keys; the arrows
  // turn the view like CS:S's default +left / +right binds.
  practice: [],
  noclip: ["KeyZ"],
  cpSave: ["KeyC"],
  cpTeleport: ["KeyX"],
  cpPrev: [],
  cpNext: [],
  turnLeft: ["ArrowLeft"],
  turnRight: ["ArrowRight"],
  // Fast turn (CS:S +speed with cl_anglespeedkey): up arrow, between the turn keys. Shift stays free for a crouch bind.
  turnFast: ["ArrowUp"],
  // Weapons (CS:S slots). The zone editor's digit keys still work while it is open (main.ts passes them on).
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  slot3: ["Digit3"],
  lastWeapon: ["KeyQ"],
  // Unbound by default: the wheel is a jump bind and R restarts (bind them in Settings -> Keys).
  nextWeapon: [],
  prevWeapon: [],
  drop: ["KeyG"],
  reload: [],
  // Weapon commands (weapon-commands.ts): next to the slot keys, like bhop servers' !usp / !glock / !guns.
  giveUsp: ["Digit5"],
  giveGlock: ["Digit6"],
  gunMenu: ["Digit7"],
};
