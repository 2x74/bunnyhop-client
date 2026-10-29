// A bigger, rounder head on the same body (v0.0.29). The standard bunny's whole head (neck,
// face, visor, eyes, nose, hood, rim and the ears up; with the hood down the bare head only) is built at its usual size
// and scaled about a pivot at the top of the neck (mesh.ts), and every hat, wig and crown gets the same scale through
// hat-fit.ts, so they sit on it exactly as they sat on the old head. Bones are unchanged: the head still turns about
// Head1, the ears still flop about their own bones.

import type { V3 } from "./rig";

export const HEAD_SHAPE: { scale: number; pivot: V3 } = { scale: 1.15, pivot: [0, 1.2, 64.2] };

/** The scale + offset that carries a point on the old head onto the new one (hat-fit.ts HatFit). */
export function headShapeFit(): { scale: V3; offset: V3 } {
  const s = HEAD_SHAPE.scale, p = HEAD_SHAPE.pivot;
  return { scale: [s, s, s], offset: [p[0] * (1 - s), p[1] * (1 - s), p[2] * (1 - s)] };
}
