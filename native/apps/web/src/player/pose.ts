// The pose a player model is driven with: plain data only, no three.js, DOM or settings imports, so code that runs
// outside the browser (viewer/player.ts, which API tests import) can name it without pulling in the renderer.
// player/model.ts re-exports it.

export interface PlayerPose {
  /** Explicit visual clock for deterministic replay/export and local shadow animation. */
  visualTime?: number;
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
   * SIG_NEXT = 2: the next trick of the chain took over). The bunny plays it as a gesture layer
   * (viewmodel/inspects/third.ts); attacks and snaps cancel it.
   */
  inspect?: number;
  /** The inspect key is held (hold-to-loop tricks keep looping while true). */
  inspectHeld?: boolean;
  /**
   * On a ladder (the legs climb; no hop) and the water level (0..3; 2+ = swimming). Presentation only. Optional: without
   * them the bunny only leaves the jump phases out while the motion isn't ballistic (player/bunny/legs.ts "float").
   */
  ladder?: boolean;
  water?: number;
  /**
   * A shot from the gun in hand since the last setState (PlayerModel.setGun; the bunny kicks, flashes at the muzzle and
   * throws a case: player/bunny/gun-hold.ts). Knife swings stay `attack`.
   */
  gunShot?: boolean;
  /**
   * The gun in hand started a reload since the last setState, `seconds` long (the core's reload time, or the gun's own
   * for other players), or with `shell` one shell of a tube gun went in (`seconds` until the next one could).
   */
  gunReload?: { seconds: number; shell?: boolean; empty?: boolean } | null;
}
