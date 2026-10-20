// The chat's free cursor: Y / U opens the chat with the pointer released (input.ts freeCursor), so the mouse can scroll
// the chat and the cursor is on screen while typing. The game keeps playing meanwhile, as it did with the chat over a
// locked pointer: input.locked stays true, the sim, the timer and the run clock (run-clock.ts) don't pause, and
// movement keys stay off while typing. Closing the chat takes the lock back (input.ts recapture); if the browser
// refuses, the game pauses as if the lock had been lost.
//
// A chat command that opens a panel which pauses play itself (!ssj, the HUD editor) takes the release over
// (takeFreeCursor): play pauses under the panel and the panel re-locks when it closes, as when opened from the game.

let free = false;

/** The pointer is released for the chat, not for a pause. */
export const cursorFree = (): boolean => free;

export function setCursorFree(on: boolean): void {
  free = on;
  document.body.classList.toggle("chat-cursor", on);
}

/**
 * Ends the free cursor without taking the lock back: every pointer-lock listener re-reads the state (input.ts first,
 * so input.locked turns false) and the game pauses as if the lock had just been lost.
 */
export function endFreeCursorAsPause(): void {
  setCursorFree(false);
  document.dispatchEvent(new Event("pointerlockchange"));
}

/** For panels that pause play while open: true if the chat's free cursor was on (now a pause the panel ends). */
export function takeFreeCursor(): boolean {
  if (!free) return false;
  endFreeCursorAsPause();
  return true;
}
