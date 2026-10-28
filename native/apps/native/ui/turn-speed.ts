// Turn binds (web turn-binds.ts): cl_yawspeed is how fast Turn left / Turn right turn the view, and
// cl_anglespeedkey multiplies it while Fast turn is held. Both are saved with each recording.

export const DEFAULT_YAW_SPEED = 210;
export const DEFAULT_ANGLE_SPEED_KEY = 2;
/** Degrees per second, inclusive. The host and the replay verifier reject anything outside it. */
export const YAW_SPEED_RANGE = { min: 60, max: 720, step: 5 } as const;
/** The fast-turn multiplier, inclusive. */
export const ANGLE_SPEED_KEY_RANGE = { min: 1, max: 4, step: .05 } as const;

type Range = { readonly min: number; readonly max: number };

const clamp = (value: number, range: Range): number => Math.min(range.max, Math.max(range.min, value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Brings imported or saved settings up to date, as the host does with its own settings file: an older native
 * `yawSpeedAlt` (an absolute speed) becomes a multiplier, and speeds outside the allowed ranges are clamped.
 * Returns a copy; the input is left alone.
 */
export function migrateTurnSpeed(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  const alternate = out.yawSpeedAlt;
  delete out.yawSpeedAlt;
  const speed = finite(out.yawSpeed) ? out.yawSpeed : DEFAULT_YAW_SPEED;
  if (finite(alternate) && !("angleSpeedKey" in out) && speed > 0) {
    out.angleSpeedKey = clamp(alternate / speed, ANGLE_SPEED_KEY_RANGE);
  }
  if (finite(out.yawSpeed)) {
    out.yawSpeed = clamp(out.yawSpeed, YAW_SPEED_RANGE);
  }
  if (finite(out.angleSpeedKey)) {
    out.angleSpeedKey = clamp(out.angleSpeedKey, ANGLE_SPEED_KEY_RANGE);
  }
  return out;
}
