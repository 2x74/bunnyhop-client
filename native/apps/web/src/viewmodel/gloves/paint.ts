// Glove paint codes shared by the first-person (fp.ts) and third-person (tp.ts) glove builders and the shader
// (glsl.ts). A glove face is painted with accent code 16 + slot + 8 * material (player/bunny/builder.ts `accent`):
//   slot      0 base, 1 fingers / second panel, 2 tips / accent, 3 strap / cuff, 4 detail (stitching, snaps),
//             5 paw (the bunny's own paw: the colourway's glove colour, for fingerless / open-back styles)
//   material  per-face surface recipe (MAT below), read by the fragment shader for grain, weave, sheen ...
// Without the GLOVE define (ghosts, the plain material) every glove code reads as the colourway glove slot.
//
// finishUV on glove vertices (written by the builders): x = distance to the nearest panel seam (units; 9 = none), y =
// a coordinate along the part (units: wrap bands, ribs), z = PART.glove (4), w = edge wear weight 0..1.

import type { Paint } from "../../player/bunny/builder";

export const GLOVE_CODE0 = 16;

/**
 * Colourway palette slots the hands use (= player/bunny/mesh.ts SLOT, repeated here so the glove builders don't import
 * the bunny mesh, which imports them).
 */
export const PAL_SLOT = { hoodie: 0, trim: 1, glove: 6 } as const;

export const SLOT_G = { base: 0, fingers: 1, tips: 2, strap: 3, detail: 4, paw: 5 } as const;

/** Surface recipes (gloves/glsl.ts gloveAlbedo). */
export const MAT = {
  /** Neoprene / knit: fine ribs, soft. */
  knit: 0,
  /** Leather: grain, sheen. */
  leather: 1,
  /** Perforated leather: leather with punched dots. */
  perf: 2,
  /** Cloth wrap: weave and overlapping wrap edges. */
  wrap: 3,
  /** Rubber / padding: matte pebble. */
  rubber: 4,
  /** Fuzz / fur: noisy, soft rim. */
  fuzz: 5,
  /** Hard plate (moto armour): glossy clear coat. */
  plate: 6,
  /** Canvas: coarse weave, dirt. */
  canvas: 7,
  /** Velcro hook side: dense dark speckle. */
  velcro: 8,
  /** Metal (snaps, rivets): bright reflection. */
  metal: 9,
} as const;

export type GloveSlot = (typeof SLOT_G)[keyof typeof SLOT_G];
export type GloveMat = (typeof MAT)[keyof typeof MAT];

const cache = new Map<number, Paint>();
/** The paint for a glove face of colour slot `slot` in material `mat`. */
export function gp(slot: GloveSlot, mat: GloveMat): Paint {
  const code = GLOVE_CODE0 + slot + 8 * mat;
  let p = cache.get(code);
  if (!p) cache.set(code, (p = { code }));
  return p;
}

/** No seam nearby (finishUV.x). */
export const NO_SEAM = 9;
