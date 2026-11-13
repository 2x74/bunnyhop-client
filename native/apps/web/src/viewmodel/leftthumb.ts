// The knife viewmodel's left thumb (v0.0.41). The open left hand is v_knife_t's own, bone for bone, and stays that way.
// One joint is corrected: v_knife_t bends the thumb's last joint sideways, toward the back of the hand, which no thumb
// can do (the joint is a hinge about the bone's z; the bend is about its y). It is 9 degrees past straight in the idle
// and the draw's end, 16 from the rig's rest pose, and on the glove's thumb it reads as a tip bent backwards. Valve's
// own hand mesh hides it.
//
// The correction is a fixed turn of that one bone about its own origin, added to whatever the sequence does, so every
// action keeps its motion and no other bone moves.

import type { VmRig } from "./rig";

/** Degrees the last joint is turned back toward the palm side, about its own y. */
export const LEFT_THUMB = { tip: 9 };

let bone = -1;

/** Applies LEFT_THUMB to a pose whose left hand is v_knife_t's (the sequences, not the procedural fallback). */
export function poseLeftThumb(W: Float32Array, r: VmRig): void {
  if (bone < 0) bone = r.bone("Left_Thumb03");
  const a = (LEFT_THUMB.tip * Math.PI) / 180;
  if (!a) return;
  // W * Ry(-a): the bone's x and z axes turn about its y; its origin and y stay.
  const c = Math.cos(a), s = Math.sin(a), o = bone * 12;
  for (let k = 0; k < 3; k++) {
    const x = W[o + k * 4], z = W[o + k * 4 + 2];
    W[o + k * 4] = x * c + z * s;
    W[o + k * 4 + 2] = z * c - x * s;
  }
}
