// Auto-strafe math for the assisted style (styles.ts "autostrafe"). DOM-free and deterministic: the browser session,
// replay playback, ghosts, the headless verifier and the API all run this exact code through StyleFilter, so the
// strafe the client records is reproduced bit-for-bit on re-simulation.
//
// Modelled on bhoptimer's shavit-tas "basic" autostrafe: the sign of the per-tick view yaw change picks the strafe
// key. Turning left (yaw increasing, Source convention) = sidemove -max (A); turning right = +max (D). Only exact
// arithmetic on the recorded f32 yaws, so every JS engine computes the same thing.

/** Movement value of an automatic key press (cl_sidespeed, like input.ts). */
export const AUTO_MOVE = 450;
/**
 * Ticks Auto-strafe keeps its last direction while the mouse reports no movement. Mouse movement arrives once per
 * rendered frame (input.ts: rAF-aligned pointer events, after the spike filter), and a frame can run 2-3 ticks at
 * 30-60 fps, so a still tick is usually a frame gap, not the player stopping. 5 ticks (50 ms) covers 20 fps.
 */
export const AUTO_HOLD_TICKS = 5;

/** View yaw change prev -> cur in degrees, normalised to [-180, 180]. 0 when there is no previous yaw (NaN). */
export function yawDelta(prev: number, cur: number): number {
  if (prev !== prev || !Number.isFinite(prev) || !Number.isFinite(cur)) return 0;
  let d = (cur - prev) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/** Strafe direction for a yaw change: -1 = left (A), +1 = right (D), 0 = the mouse didn't move. */
export function strafeDir(d: number): -1 | 0 | 1 {
  return d > 0 ? -1 : d < 0 ? 1 : 0;
}
