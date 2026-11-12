// Source names for the console (console/): key names (`bind mouse4 ...`) and bind commands (`+jump`, `slot1`), mapped to
// this game's bind codes (KeyboardEvent.code plus input.ts's mouse pseudo-codes) and actions (ui/settings.ts Action).
// DOM-free (apps/web/test/console.test.ts).
//
// Key names are Source's (inputsystem ButtonCode names, case-insensitive): a-z, 0-9, F1-F12, SPACE, CTRL, SHIFT, ALT
// (and RCTRL / RSHIFT / RALT), MOUSE1-MOUSE5, MWHEELUP / MWHEELDOWN, the KP_ keypad names (KP_INS = keypad 0 ... KP_PGUP =
// keypad 9, KP_SLASH, KP_ENTER...), arrows, punctuation. KP_0-KP_9 also work. MWHEEL is ours: either wheel direction
// (the default jump bind).

import type { Action } from "../ui/settings";

/** Source key name (upper case) -> bind code. The first name listed for a code is the one shown. */
const KEY_NAMES: [string, string][] = [
  ["SPACE", "Space"],
  ["CTRL", "ControlLeft"],
  ["RCTRL", "ControlRight"],
  ["SHIFT", "ShiftLeft"],
  ["RSHIFT", "ShiftRight"],
  ["ALT", "AltLeft"],
  ["RALT", "AltRight"],
  ["LWIN", "MetaLeft"],
  ["RWIN", "MetaRight"],
  ["APP", "ContextMenu"],
  ["TAB", "Tab"],
  ["ENTER", "Enter"],
  ["BACKSPACE", "Backspace"],
  ["CAPSLOCK", "CapsLock"],
  ["NUMLOCK", "NumLock"],
  ["SCROLLLOCK", "ScrollLock"],
  ["ESCAPE", "Escape"],
  ["INS", "Insert"],
  ["DEL", "Delete"],
  ["HOME", "Home"],
  ["END", "End"],
  ["PGUP", "PageUp"],
  ["PGDN", "PageDown"],
  ["PAUSE", "Pause"],
  ["UPARROW", "ArrowUp"],
  ["DOWNARROW", "ArrowDown"],
  ["LEFTARROW", "ArrowLeft"],
  ["RIGHTARROW", "ArrowRight"],
  ["MOUSE1", "Mouse1"],
  ["MOUSE2", "Mouse2"],
  ["MOUSE3", "Mouse3"],
  ["MOUSE4", "Mouse4"],
  ["MOUSE5", "Mouse5"],
  ["MWHEELUP", "MWheelUp"],
  ["MWHEELDOWN", "MWheelDown"],
  ["MWHEEL", "MouseWheel"],
  ["SEMICOLON", "Semicolon"],
  ["'", "Quote"],
  ["`", "Backquote"],
  [",", "Comma"],
  [".", "Period"],
  ["/", "Slash"],
  ["\\", "Backslash"],
  ["-", "Minus"],
  ["=", "Equal"],
  ["[", "BracketLeft"],
  ["]", "BracketRight"],
  ["KP_INS", "Numpad0"],
  ["KP_END", "Numpad1"],
  ["KP_DOWNARROW", "Numpad2"],
  ["KP_PGDN", "Numpad3"],
  ["KP_LEFTARROW", "Numpad4"],
  ["KP_5", "Numpad5"],
  ["KP_RIGHTARROW", "Numpad6"],
  ["KP_HOME", "Numpad7"],
  ["KP_UPARROW", "Numpad8"],
  ["KP_PGUP", "Numpad9"],
  ["KP_SLASH", "NumpadDivide"],
  ["KP_MULTIPLY", "NumpadMultiply"],
  ["KP_MINUS", "NumpadSubtract"],
  ["KP_PLUS", "NumpadAdd"],
  ["KP_ENTER", "NumpadEnter"],
  ["KP_DEL", "NumpadDecimal"],
  // Aliases (read, never shown).
  ["CONTROL", "ControlLeft"],
  ["LCTRL", "ControlLeft"],
  ["LSHIFT", "ShiftLeft"],
  ["LALT", "AltLeft"],
  ["INSERT", "Insert"],
  ["DELETE", "Delete"],
  ["PAGEUP", "PageUp"],
  ["PAGEDOWN", "PageDown"],
  ["ESC", "Escape"],
  ["RETURN", "Enter"],
  ["UP", "ArrowUp"],
  ["DOWN", "ArrowDown"],
  ["LEFT", "ArrowLeft"],
  ["RIGHT", "ArrowRight"],
  ["MWHEELUP+DOWN", "MouseWheel"],
  ["KP_DECIMAL", "NumpadDecimal"],
];

const NAME_TO_CODE = new Map<string, string>();
const CODE_TO_NAME = new Map<string, string>();
for (const [n, c] of KEY_NAMES) {
  NAME_TO_CODE.set(n, c);
  if (!CODE_TO_NAME.has(c)) CODE_TO_NAME.set(c, n);
}
for (let i = 0; i <= 9; i++) {
  NAME_TO_CODE.set(String(i), `Digit${i}`);
  CODE_TO_NAME.set(`Digit${i}`, String(i));
  NAME_TO_CODE.set(`KP_${i}`, `Numpad${i}`);
}
for (let i = 0; i < 26; i++) {
  const l = String.fromCharCode(65 + i);
  NAME_TO_CODE.set(l, `Key${l}`);
  CODE_TO_NAME.set(`Key${l}`, l.toLowerCase());
}
for (let i = 1; i <= 24; i++) {
  NAME_TO_CODE.set(`F${i}`, `F${i}`);
  CODE_TO_NAME.set(`F${i}`, `F${i}`);
}

/** The bind code for a Source key name ("mouse4" -> "Mouse4", "kp_end" -> "Numpad1"), or null. */
export function codeForKey(name: string): string | null {
  const n = name.trim().toUpperCase();
  const c = NAME_TO_CODE.get(n);
  if (c) return c;
  // MOUSE6 and up: extra buttons the browser reports (binds.ts mouseCode).
  const m = /^MOUSE([6-9]|1\d)$/.exec(n);
  return m ? `Mouse${m[1]}` : null;
}

/** The Source key name for a bind code ("KeyW" -> "w", "Mouse4" -> "MOUSE4"), or the code itself for one Source has no name for. */
export function keyForCode(code: string): string {
  return CODE_TO_NAME.get(code) ?? (/^Mouse\d+$/.test(code) ? code.toUpperCase() : code);
}

/** Every key name shown (tab completion). */
export const KEY_LIST: readonly string[] = [...new Set(CODE_TO_NAME.values())];

/**
 * Bind commands -> actions. The first name per action is the one `binds` shows; the rest are read too (CS:GO names,
 * bhop server commands such as sm_r, Source's `impulse 100` flashlight). `+` commands hold; the rest fire on press,
 * as every non-movement action here does.
 */
const COMMANDS: [Action, ...string[]][] = [
  ["forward", "+forward"],
  ["back", "+back"],
  ["left", "+moveleft"],
  ["right", "+moveright"],
  ["jump", "+jump"],
  ["jumpToggle", "jump_toggle", "+jump_toggle", "toggle_jump"],
  ["duck", "+duck"],
  ["crouchJump", "+crouchjump"],
  ["use", "+use"],
  ["attack", "+attack"],
  ["attack2", "+attack2"],
  ["turnLeft", "+left"],
  ["turnRight", "+right"],
  ["turnFast", "+speed"],
  ["slot1", "slot1"],
  ["slot2", "slot2"],
  ["slot3", "slot3"],
  ["lastWeapon", "lastinv"],
  ["nextWeapon", "invnext"],
  ["prevWeapon", "invprev"],
  ["drop", "drop"],
  ["reload", "+reload", "reload"],
  ["inspect", "+lookatweapon", "inspect"],
  ["chat", "messagemode", "messagemode2"],
  ["console", "toggleconsole"],
  ["restart", "restart", "sm_r", "sm_restart"],
  ["restartBonus", "restart_bonus", "sm_b", "sm_bonus"],
  ["restartMain", "restart_main", "sm_m", "sm_main"],
  ["setStart", "setstart", "sm_ss", "sm_setstart"],
  ["clearStart", "clearstart", "sm_clearstart"],
  ["cycleStyle", "style_next", "sm_nextstyle"],
  ["mainMenu", "mainmenu"],
  ["hudEditor", "hud_editor"],
  ["thirdPerson", "thirdperson"],
  ["freecam", "freecam"],
  ["viewmodel", "viewmodel_toggle"],
  ["flashlight", "flashlight", "impulse 100"],
  ["keysOverlay", "keys_toggle"],
  ["hideUi", "hideui"],
  ["mute", "mute"],
  ["nextTrack", "music_next"],
  ["paint", "+paint"],
  ["paintOnce", "paint_once"],
  ["clearPaint", "paint_clear"],
  ["measurePoint", "measure"],
  ["clearMeasure", "measure_clear"],
  ["lastLj", "lastjump"],
  ["practice", "practice"],
  ["noclip", "noclip", "sm_noclip", "sm_nc"],
  ["cpSave", "cp_save", "sm_save"],
  ["cpTeleport", "cp_tele", "sm_tele"],
  ["cpPrev", "cp_prev", "sm_prevcp"],
  ["cpNext", "cp_next", "sm_nextcp"],
  ["giveUsp", "give_usp", "sm_usp"],
  ["giveGlock", "give_glock", "sm_glock"],
  ["gunMenu", "guns", "sm_guns"],
];

const COMMAND_TO_ACTION = new Map<string, Action>();
const ACTION_TO_COMMAND = new Map<Action, string>();
for (const [a, ...names] of COMMANDS) {
  ACTION_TO_COMMAND.set(a, names[0]);
  for (const n of names) COMMAND_TO_ACTION.set(n, a);
}

/**
 * The action a single bind command runs ("+jump" -> jump, "impulse 100" -> flashlight, "sm_r" -> restart), or null.
 * `say !r` isn't one: a say bind goes through the chat like typing it (console/exec.ts, a command bind).
 */
export function actionForCommand(command: string): Action | null {
  const c = command.trim().replace(/\s+/g, " ").toLowerCase();
  return COMMAND_TO_ACTION.get(c) ?? null;
}

/** The command `binds` shows for an action ("+jump", "slot1", "jump_toggle"). */
export const commandForAction = (a: Action): string => ACTION_TO_COMMAND.get(a) ?? a;

/** Every bind command shown (tab completion after `bind <key> `). */
export const COMMAND_LIST: readonly string[] = [...ACTION_TO_COMMAND.values()];

/** Source movement / action commands this game can't bind, with why (a config import says so line by line). */
export const UNSUPPORTED_COMMANDS: Record<string, string> = {
  "+moveup": "no swimming up key here (jump swims up)",
  "+movedown": "no swimming down key here (duck swims down)",
  "+walk": "no walk key in bhop",
  "+showscores": "the scoreboard is Tab in servers",
  "+klook": "no keyboard look",
  "+lookup": "no keyboard look",
  "+lookdown": "no keyboard look",
  "+strafe": "no strafe modifier",
  "+alt1": "no alt1 key",
  "+zoom": "no zoom key",
  buymenu: "no buy menu (!guns gives guns)",
  autobuy: "no buying",
  rebuy: "no buying",
  chooseteam: "no teams",
  jpeg: "screenshots: use your OS or browser",
  screenshot: "screenshots: use your OS or browser",
  showconsole: "use toggleconsole",
  cancelselect: "Esc always opens the menu",
};
