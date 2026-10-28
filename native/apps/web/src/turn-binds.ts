// Manual Source +left / +right. Shared by input and replay analysis; never presses A/D.
export const IN_LEFT = 1 << 7;
export const IN_RIGHT = 1 << 8;
export const TURN_BITS = IN_LEFT | IN_RIGHT;
/**
 * Fast turn (Source +speed with cl_anglespeedkey): held with +left / +right, the bind turns at yawSpeed × angleSpeedKey.
 * Bit 6 (Source's IN_CANCEL slot; no build ever set it). Only recorded on a command that turns, and only by builds that
 * write the replay's turn-speed record (replay.ts "BHTS").
 */
export const IN_TURN_FAST = 1 << 6;
/** A turn-bind hold is one direction at one speed: these bits change between holds. */
export const TURN_HOLD_BITS = TURN_BITS | IN_TURN_FAST;
/** CS:S cl_yawspeed default, degrees per second; every replay without a turn-speed record turned at exactly this. */
export const YAW_SPEED = 210;

/** cl_yawspeed (degrees per second) and cl_anglespeedkey (the fast-turn multiplier), as the replay records them. */
export interface TurnSpeed {
  yawSpeed: number;
  angleSpeedKey: number;
}
/** Replays without a turn-speed record: 210°/s and no fast turn (an IN_TURN_FAST bit there is forged). */
export const LEGACY_TURN_SPEED: TurnSpeed = { yawSpeed: YAW_SPEED, angleSpeedKey: 1 };
/** Settings defaults: CS:S's cl_yawspeed, fast turn at twice that. */
export const DEFAULT_TURN_SPEED: TurnSpeed = { yawSpeed: YAW_SPEED, angleSpeedKey: 2 };
/**
 * Allowed cl_yawspeed, degrees per second (inclusive). A held bind turns a fixed angle per tick, and a fixed angle is
 * the best strafe angle (atan(30 / v)) at one speed only: 720°/s (7.2° a tick at 100 tick) is optimal at about 240 u/s,
 * 60°/s (0.6°) at about 2,860 u/s. So the range covers keyboard strafing over every speed the maps reach, as tuning
 * cl_yawspeed does in CS:S, and nothing past it: a faster bind is a spin (fast turn covers turning around), a slower
 * one barely turns, and its held ticks would leave the strafe measures with the view almost still.
 */
export const YAW_SPEED_RANGE: readonly [number, number] = [60, 720];
/** Allowed cl_anglespeedkey (inclusive): up to 2,880°/s at the top yaw speed, a 180° turn in 7 ticks. */
export const ANGLE_SPEED_KEY_RANGE: readonly [number, number] = [1, 4];

/** Legit Scroll keeps strict scroll rules; practice can use these controls in every style. */
export const turnBindsAllowed = (style: string): boolean => style !== "scroll";

const inRange = (v: number, [lo, hi]: readonly [number, number]) => Number.isFinite(v) && v >= lo && v <= hi;
/** Whether a turn-speed record is one the game accepts (ranked or not). */
export const turnSpeedAllowed = (t: TurnSpeed): boolean => inRange(t.yawSpeed, YAW_SPEED_RANGE) && inRange(t.angleSpeedKey, ANGLE_SPEED_KEY_RANGE);

/**
 * The speeds a client turns with: clamped to the allowed range and rounded to float32, exactly as the replay stores
 * them, so the recorded base changes are reproducible from the record.
 */
export function turnSpeedOf(yawSpeed: number, angleSpeedKey: number): TurnSpeed {
  const c = (v: number, [lo, hi]: readonly [number, number], d: number) => Math.fround(Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { yawSpeed: c(yawSpeed, YAW_SPEED_RANGE, DEFAULT_TURN_SPEED.yawSpeed), angleSpeedKey: c(angleSpeedKey, ANGLE_SPEED_KEY_RANGE, DEFAULT_TURN_SPEED.angleSpeedKey) };
}

/**
 * Degrees the view turns on one simulation tick (independent of render FPS). Opposing binds cancel; IN_TURN_FAST
 * multiplies by angleSpeedKey (Source CInput::DetermineKeySpeed). Evaluated left to right in float64:
 * direction × yawSpeed × (fast ? angleSpeedKey : 1) × dt. Legacy (210, no fast): the same bits as before the record.
 */
export function turnDelta(buttons: number, dt: number, speed: TurnSpeed = LEGACY_TURN_SPEED): number {
  return ((buttons & IN_LEFT ? 1 : 0) - (buttons & IN_RIGHT ? 1 : 0)) * speed.yawSpeed * (buttons & IN_TURN_FAST ? speed.angleSpeedKey : 1) * dt;
}
