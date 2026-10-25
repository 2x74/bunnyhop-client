// Leaving the map (pause → Main menu, Backspace, the in-game Main menu bind's hold): everything the menu runs for that
// map stops at once, before any later callback can act on it. The host calls window.bunnyhopNativeMenu.onLeaveMap()
// for every leave_map, also the ones it starts itself (the bind); the menu's own Main menu calls the same teardown and
// then sends {type:"leaveMap"}. Idempotent: a second call (the host echoing the menu's leave) finds nothing to stop.
//
//   room      NativeRoomService.leave(): closes the transport, cancels a pending map change (its timer would otherwise
//             send nativeMap for the old room) and the 200 ms flush, and bumps the room generation, so a late
//             handler, account reply or hostMap() can't reopen or reload anything.
//   gauntlet  NativeGauntlet.leave(): ping / next-map / resend timers stop, the attempt stays open on the server.
//   transient the finish card and the gauntlet split line (main.ts).

export interface MapLifecycle {
  room: { leave(): void; readonly view: { id: string | null } };
  gauntlet: { leave(): void };
  /** Menu-side state for the map being left (finish card, split line). */
  clear: () => void;
}

export function leaveMapTeardown(o: MapLifecycle): () => void {
  return () => {
    // Each part on its own: one throwing must not leave another running.
    for (const step of [() => o.room.leave(), () => o.gauntlet.leave(), o.clear]) {
      try { step(); } catch (error) { console.error("leave map:", error); }
    }
  };
}
