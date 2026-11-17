// A bigger, rounder head on the same body (v0.0.29; a little bigger again in v0.0.42). The standard bunny's whole head (neck,
// face, visor, eyes, nose, hood, rim and the ears up; with the hood down the bare head only) is built at its usual size
// and scaled about a pivot at the top of the neck (mesh.ts), and every hat, wig and crown gets the same scale through
// hat-fit.ts, so they sit on it exactly as they sat on the old head. Bones are unchanged: the head still turns about
// Head1, the ears still flop about their own bones.

import type { V3 } from "./rig";

/** The face before the head's scale (mesh.ts builds it at this size): an ellipsoid, -y the face side. */
export const FACE: { c: V3; r: V3 } = { c: [0, -0.55, 68.7], r: [4.05, 4.35, 4.85] };

/**
 * The jaw (v0.0.42): the face was the whole ellipsoid, so with the hood down the bare head read as a ball in the
 * collar. Below eye level it now narrows to a chin, the chin stays forward (the face falls straighter before it turns
 * under), and the underside rises toward the neck instead of rounding down to a pole under the middle of the head.
 * Nothing above eye level moves, so the visor, the eyes, the hood, hats and wigs sit where they sat. Model B's jaw is a
 * little narrower. Units are the unscaled head's.
 */
export const JAW = { from: 0.1, narrow: 0.17, narrowB: 0.23, chin: 0.22, lift: 0.1, rise: 1.7 };

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A point on (or near: the mask, the nose) the face ellipsoid, carried onto the face with the jaw. */
export function jawShape(p: V3, feminine = false): V3 {
  const u = (FACE.c[2] - p[2]) / FACE.r[2]; // 0 at eye level, 1 at the ellipsoid's underside
  if (u <= 0) return p;
  const t = smooth(JAW.from, 1, u);
  const dy = p[1] - FACE.c[1];
  const y = FACE.c[1] + dy * (dy < 0 ? 1 + JAW.chin * smooth(0.3, 0.85, u) : 1);
  const z = FACE.c[2] - FACE.r[2] * u * (1 - JAW.lift * t) + JAW.rise * t * t * smooth(-2.2, 2, dy);
  return [p[0] * (1 - (feminine ? JAW.narrowB : JAW.narrow) * t), y, z];
}

/**
 * `scale`: the head with the hood up (face, hood, rim, ears). `bare`: the bare head with the hood down, bigger still
 * (v0.0.42): a head built to sit inside the hood was a pinhead on the hoodie once the hood came off, so it grows until
 * head and wig fill about the space the hood did.
 */
export const HEAD_SHAPE: { scale: number; bare: number; pivot: V3 } = { scale: 1.2, bare: 1.28, pivot: [0, 1.2, 64.2] };

/** The head's scale for the hood. */
export const headScale = (bare = false): number => (bare ? HEAD_SHAPE.bare : HEAD_SHAPE.scale);

/** The scale + offset that carries a point on the old head onto the new one (hat-fit.ts HatFit); `bare`: onto the bare head (a wig). */
export function headShapeFit(bare = false): { scale: V3; offset: V3 } {
  const s = headScale(bare), p = HEAD_SHAPE.pivot;
  return { scale: [s, s, s], offset: [p[0] * (1 - s), p[1] * (1 - s), p[2] * (1 - s)] };
}
