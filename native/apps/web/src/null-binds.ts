// Automatic null binds (Settings > Keys, off by default): with both keys of an axis held (A + D, or W + S), the one
// pressed last wins instead of the two cancelling out, like the CS:S null-movement script. Releasing it hands the
// movement back to the other key if that is still held. DOM-free: input.ts resolves held keys with it, and the replay
// header records that the setting was on (replay.ts FLAG_NULL_BINDS), so the anticheat expects instant key switches.
//
// The recorded commands are the resolved ones (one key's bit and its ±450), so re-simulation needs nothing new.

const IN_FORWARD = 1 << 3;
const IN_BACK = 1 << 4;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;
const AXES = [IN_MOVELEFT | IN_MOVERIGHT, IN_FORWARD | IN_BACK] as const;

/** Same policy as manual turn binds: every style except Legit Scroll (strict CS:S keys); practice allows them anywhere. */
export const nullBindsAllowed = (style: string): boolean => style !== "scroll";

/**
 * The movement bits with null binds applied. `pressed`: the button bits of each held key, oldest press first. On each
 * axis where both directions are held, only the newest key that holds a direction on that axis counts (a single key
 * bound to both directions still cancels, as without null binds). Other bits pass through.
 */
export function resolveNullBinds(pressed: readonly number[]): number {
  let bits = 0;
  for (const b of pressed) bits |= b;
  for (const axis of AXES) {
    if ((bits & axis) !== axis) continue;
    let keep = axis;
    for (let i = pressed.length - 1; i >= 0; i--) {
      if (pressed[i] & axis) {
        keep = pressed[i] & axis;
        break;
      }
    }
    bits = (bits & ~axis) | keep;
  }
  return bits;
}

/** True when a command holds both directions of an axis (what a null-bind client never sends). */
export function bothDirections(buttons: number): boolean {
  return AXES.some((axis) => (buttons & axis) === axis);
}
