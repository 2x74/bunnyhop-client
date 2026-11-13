// Whether a pointer event came from the pointer really moving. The hover cards (ui/run-stats.ts, ui/hover-card.ts) ask
// before they open: a menu that appears under a resting cursor (the pause menu, when mouse look hands the cursor back),
// and rows that scroll or are redrawn beneath it, send pointerover too, at the position the cursor already had.

/** True when (x, y) is somewhere else than the last known position. An unknown last position is not a move. */
export function movedFrom(prev: { x: number; y: number } | null, x: number, y: number): boolean {
  return !!prev && (prev.x !== x || prev.y !== y);
}

let at: { x: number; y: number } | null = null;
let mover: Event | null = null;
let bound = false;

/** Starts watching (once). The first event after this, and after mouse look ends, only records where the pointer is. */
export function watchPointer(): void {
  if (bound) return;
  bound = true;
  const track = (e: PointerEvent) => {
    if (movedFrom(at, e.clientX, e.clientY)) mover = e;
    if (!at || mover === e) at = { x: e.clientX, y: e.clientY };
  };
  // Capture on the window: before any card's own handler sees the event.
  addEventListener("pointermove", track, true);
  addEventListener("pointerover", track, true);
  document.addEventListener("pointerlockchange", () => (at = null));
}

/** Whether this pointerover / pointermove moved the pointer (a boundary event under a resting cursor did not). */
export const pointerMoved = (e: PointerEvent): boolean => mover === e;
