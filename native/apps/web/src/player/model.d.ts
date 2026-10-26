// Shared presentation pose contract extracted from player/model.ts.
// Native builds do not include the browser model facade or renderer.
export interface PlayerPose {
  /** Deterministic presentation clock for runner replay/export. */
  visualTime?:number;
  /** Feet origin, Source units (x, y, z; z up). */
  position: ArrayLike<number>;
  /** Units/s. Derived from position changes when omitted. */
  velocity?: ArrayLike<number>;
  /** View angles, degrees (Source: yaw CCW from +X, pitch + = down). */
  yaw: number;
  pitch: number;
  /** FL_DUCKING. */
  crouched: boolean;
  /** FL_ONGROUND (callers sampling slower than the tick rate should OR in any ground tick since the last frame). */
  grounded: boolean;
  /** Command inputs (i16 domain, e.g. ±450). Optional; used for strafe lean. */
  forwardmove?: number;
  sidemove?: number;
  /**
   * A jump happened since the last setState (PLAYERANIMEVENT_JUMP). Optional: when omitted the model detects jumps
   * from the vertical velocity. Network clients that receive jump events should pass them.
   */
  jumped?: boolean;
  /**
   * Cosmetic carrot swing since the last setState: 1 = slash (primary), 2 = stab (secondary). Models with the CS:S
   * animations play the knife attack layer (Idle/Walk/Run/Crouch_Shoot_KNIFE, like CCSPlayerAnimState's fire layer).
   */
  attack?: number;
  /**
   * Inspect signal since the last setState (viewmodel/inspects/combo.ts SIG_START = 1: the base inspect started,
   * SIG_NEXT = 2: the next trick of the chain took over). The bunny and CS:S models play it as a gesture layer
   * (viewmodel/inspects/third.ts); attacks and snaps cancel it.
   */
  inspect?: number;
  /** The inspect key is held (hold-to-loop tricks keep looping while true). */
  inspectHeld?: boolean;
}
