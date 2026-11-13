// What the last pointer lock gave the mouse (input.ts lock()): raw input, or the OS's pointer speed and acceleration
// (Safari, Firefox before 152, Linux browsers, or a browser that refused raw). Settings → Raw input shows it beside the
// switch, and main.ts says it once, the first time a lock comes back without raw input. DOM-free.

export type LockPath = "raw" | "os";

let last: { path: LockPath; asked: boolean } | null = null;

/** The last lock this page took (`asked`: raw input was asked for), or null before the first. */
export const lastLockPath = (): { path: LockPath; asked: boolean } | null => last;

export function noteLockPath(path: LockPath, asked: boolean): void {
  last = { path, asked };
}

/** Settings → Raw input's live readout ("" before the first lock, or when raw input was switched off). */
export function lockPathText(l = last): string {
  if (!l) return "";
  if (l.path === "raw") return "Working in this browser";
  return l.asked ? "Not available in this browser, so OS acceleration applies" : "";
}

/** The one-time line when a lock asked for raw input and didn't get it. */
export const OS_ACCEL_LINE = "This browser has no raw mouse input, so your system's pointer acceleration applies.";

const SAID_KEY = "bunnyhop:os-accel-said";
let saidHere = false;

/** True the first time in this browser (storage blocked: once per page), and from then on false. */
export function sayOsAccelOnce(): boolean {
  if (saidHere) return false;
  saidHere = true;
  try {
    if (localStorage.getItem(SAID_KEY)) return false;
    localStorage.setItem(SAID_KEY, "1");
  } catch {
    /* storage blocked: once per page */
  }
  return true;
}
