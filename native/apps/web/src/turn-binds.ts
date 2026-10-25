// Manual Source +left / +right. Shared by input and replay analysis; never presses A/D.
export const IN_LEFT = 1 << 7;
export const IN_RIGHT = 1 << 8;
export const TURN_BITS = IN_LEFT | IN_RIGHT;
/** CS:S cl_yawspeed, degrees per second. */
export const YAW_SPEED = 210;

/** Legit Scroll keeps strict scroll rules; practice can use these controls in every style. */
export const turnBindsAllowed = (style: string): boolean => style !== "scroll";

/** Opposing binds cancel. Applied once per simulation tick, independent of render FPS. */
export function turnDelta(buttons: number, dt: number): number {
  return ((buttons & IN_LEFT ? 1 : 0) - (buttons & IN_RIGHT ? 1 : 0)) * YAW_SPEED * dt;
}
