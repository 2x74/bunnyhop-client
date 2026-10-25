// The web's play-lock.ts asks "Leave site?" while a run is going and allowLeave() lifts that before a deliberate
// navigation. The native menu never unloads its page (navigations become native screens, nativeLocation), so there is
// nothing to lift.
export function allowLeave(): void {}
