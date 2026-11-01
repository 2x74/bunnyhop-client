// How many input events the page received that the browser says a script made (event.isTrusted false): a dispatched key or
// mouse event, the laziest way to drive the game. Counted per run for the run's diagnostics (selfcheck.ts RunWatch, apps/api
// src/diagnostics.ts). Nothing acts on it: the events are handled like any other, and a tool that injects at the OS level
// looks trusted. Not recorded in the replay.

let untrusted = 0;

/** Every key, button, wheel and motion event, before anything else reads it. */
export function noteInputEvent(e: Event): void {
  if (!e.isTrusted) untrusted++;
}

export const untrustedInputEvents = (): number => untrusted;
