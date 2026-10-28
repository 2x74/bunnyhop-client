// The web's play-lock.ts asks "Leave site?" while a run is going and allowLeave() lifts that before a deliberate
// navigation. The native menu never unloads its page (navigations become native screens, nativeLocation), so there is
// nothing to lift.
export function allowLeave(): void {}

// Web popovers (jump stats, share cards) take the pointer back for the game when they close. The native game owns its
// own mouse capture and resumes when the menu closes, so the menu has no pointer to take.
export async function resumePlay(): Promise<void> {}
