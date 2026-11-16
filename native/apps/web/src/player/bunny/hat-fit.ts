// Every fit of headwear to a head lives here, as data: item geometry (hats.ts, wigs.ts, oni-mask.ts) is built once
// against the reference head (the v0.0.29 one: the face ellipsoid head-shape.ts FACE, the hood ellipsoid centre
// (0, 0.55, 69.35) radii (5.55, 6.05, 6.0), ear roots (+-2.25, 1.35, 74.3)) and never needs to know which head wears it.
//   standard bunny   one uniform scale about the top of the neck: 1.2 for the hood and everything on it, 1.28 for the
//                    bare head under a wig (head-shape.ts); items on the lower face (JAW_ITEMS) are also carried onto
//                    the jaw, vertex by vertex, when they are built (onJaw).
//   Plush / Bun-E    per item class below (hatFit): floating items lifted, perched ones moved, face items onto the
//                    faceplate at one scale across and up (FACE_FIT), bands and caps onto the hood / helmet ellipsoid.
import type * as THREE from "three";
import type { BunnyLook } from "./look";
import type { V3 } from "./rig";
import { headShapeFit, jawShape } from "./head-shape";
import { isWig } from "../../loadout";

/**
 * A hat's fit to the Supporter heads: one scale + offset for the whole hat, and an optional second one (`face`) for
 * the vertices whose `headwear` attribute is 2 (parts that sit on the face rather than the hood, like a wig's fringe).
 */
export interface HatFit { scale: V3; offset: V3; face?: { scale: V3; offset: V3 } }
const IDENTITY: HatFit = { scale: [1, 1, 1], offset: [0, 0, 0] };

/**
 * The standard bunny's face (mesh.ts) onto the Plush / Bun-E faceplate (supporter.ts supporterHead): a shallow dark
 * dome, centre F, half width rx * 0.79, half height rz * 0.77, 2.3 deep. One scale across and up (`size`: the item
 * keeps its own proportions; until v0.0.42 it was stretched to the plate's width, 13% wider than tall, and on Bun-E
 * the Half Oni Mask reached past the helmet's opening), flattened front to back only as far as the plate needs
 * (`depth`), and set so the item's side edges (at `EDGE` of the face's half width) lie on the plate.
 */
const FACE_FIT = { plush: { size: 1.031, depth: 0.62 }, bune: { size: 1.238, depth: 0.7 } };
const EDGE = 0.909;
function faceFit(plush: boolean): { scale: V3; offset: V3 } {
  const C: V3 = [0, -0.55, 68.7], R: V3 = [4.05, 4.35, 4.85];
  const rx = plush ? 6.0 : 7.2, F: V3 = [0, -5.9, 70];
  const { size, depth } = FACE_FIT[plush ? "plush" : "bune"];
  // The plate's surface (0.3 proud of it) where the item's side edge comes to, and the item's own depth there.
  const x = (EDGE * R[0] * size) / (rx * 0.79);
  const plateY = F[1] - 2.3 * Math.sqrt(Math.max(0, 1 - x * x)) - 0.3;
  const centreY = plateY + depth * R[1] * Math.sqrt(1 - EDGE * EDGE);
  const scale: V3 = [size, depth, size];
  return { scale, offset: [F[0] - C[0] * size, centreY - C[1] * depth, F[2] - C[2] * size] };
}

/**
 * Hats grown for play distance (v0.0.41): the two animals were lumps between the ears from 300 units. Scaled about
 * `pivot` (bind space, where the animal rests on the hood) and then moved, before the head's own fit, so their shader
 * animation (hat-fx.ts) keeps its pivots.
 */
const GROW: Record<string, { s: number; pivot: V3; move: V3 }> = {
  "hat-capybara": { s: 1.45, pivot: [0, -2.2, 75.1], move: [0, -0.3, 0.2] },
  "hat-maxwell": { s: 1.45, pivot: [0, -2.2, 75.1], move: [0, -0.3, 0.2] },
};

/** `fit` after a hat's GROW. */
function grown(hat: string | null | undefined, fit: { scale: V3; offset: V3 }): { scale: V3; offset: V3 } {
  const g = GROW[hat ?? ""];
  if (!g) return fit;
  // p -> pivot + s (p - pivot) + move, then p -> p * scale + offset.
  const o = g.pivot.map((c, i) => c * (1 - g.s) + g.move[i]);
  return { scale: [fit.scale[0] * g.s, fit.scale[1] * g.s, fit.scale[2] * g.s], offset: [o[0] * fit.scale[0] + fit.offset[0], o[1] * fit.scale[1] + fit.offset[1], o[2] * fit.scale[2] + fit.offset[2]] };
}

/**
 * A mask on a faceplate. Bun-E's head is built at 0.9 about BUNE_PIVOT (supporter.ts): a mask takes that too, or it is
 * a tenth too big for the helmet's opening and stands off the plate in front of it (hood items have it in their fit;
 * the wigs' fringes are sized by eye below). `back`: how far back it then sits (units).
 */
const BUNE_SCALE = 0.9, BUNE_PIVOT: V3 = [0, 1, 64];
function maskFit(plush: boolean, back = 0): { scale: V3; offset: V3 } {
  const f = faceFit(plush), k = plush ? 1 : BUNE_SCALE;
  return { scale: [f.scale[0] * k, f.scale[1] * k, f.scale[2] * k], offset: [f.offset[0] * k + BUNE_PIVOT[0] * (1 - k), f.offset[1] * k + BUNE_PIVOT[1] * (1 - k) + back, f.offset[2] * k + BUNE_PIVOT[2] * (1 - k)] };
}
/**
 * The Kitsune Mask over the face covers the whole opening: how far back of the face fit it sits, as near the front of
 * the hood's rim / the helmet's as Plush's button eyes and Bun-E's lit ones, which stay under it, allow (0.5 and 0.3
 * off it).
 */
const KITSUNE_BACK = { plush: -0.05, bune: 0.35 };

/** Applied after bind-space hat animation, before head skinning: animation pivots stay canonical. */
export function hatFit(look: BunnyLook, hat?: string | null): HatFit {
  // The standard bunny's head is built bigger (head-shape.ts): its hats and wigs take the same scale.
  // (A wig is on the bare head, which is bigger still.)
  if (look === "bunny") return grown(hat, headShapeFit(isWig(hat)));
  if (look !== "plush" && look !== "bune") return grown(hat, IDENTITY);
  const plush = look === "plush";
  if (["hat-halo", "hat-gem-orbit", "hat-lucky-coins", "hat-aurora"].includes(hat ?? "")) {
    return { scale: [1, 1, 1], offset: [0, 0, plush ? 5.5 : 3] };
  }
  // Perched objects retain their proportions; their feet/brim meet the new crown of the head.
  if (hat === "hat-capybara" || hat === "hat-maxwell") return grown(hat, { scale: [1, 1, 1], offset: [0, .15, plush ? .65 : .55] });
  if (hat === "hat-tophat") return { scale: [1, 1, 1], offset: [0, 0, plush ? .7 : .6] };
  // Worn on the face: onto the faceplate.
  if (hat === "hat-oni-mask") return maskFit(plush);
  // Bands and caps follow the new hood/helmet ellipsoid, rather than the faceplate or ear cups.
  const scale: V3 = plush ? [6 / 5.55, 6.1 / 6.05, 6.5 / 6] : [6.48 / 5.55, 5.85 / 6.05, 7.02 / 6];
  const center: V3 = plush ? [0, -.1, 70.2] : [0, .01, 69.58];
  const hood: HatFit = { scale, offset: [0, center[1] - .55 * scale[1], center[2] - 69.35 * scale[2]] };
  // Wigs: the buns / ponytail on the hood, the fringe on the faceplate. The faceplate is flat where the bunny's face is
  // round, so the fringe is pressed flatter than the mask: its roots stay behind the rim, its tips on the eye band.
  // The Kitsune Mask (kitsune-mask.ts): over the face its mask is a face part and goes onto the faceplate, its cord
  // stays on the hood; pushed up, all of it is on the hood (no face parts).
  if (hat === "hat-kitsune-mask") return { ...hood, face: maskFit(plush, plush ? KITSUNE_BACK.plush : KITSUNE_BACK.bune) };
  if (isWig(hat)) {
    // Bun-E's helmet opening is smaller for its faceplate than the plush hood's: a smaller fringe stays inside it.
    // Bun-E's fringe is also set lower, so its top stays under the helmet's rim from the front and 3/4.
    const f = faceFit(plush), k = plush ? 1 : 0.8, drop = plush ? 0 : 0.85;
    return { ...hood, face: { scale: [f.scale[0] * k, 0.75, f.scale[2] * k], offset: [0, -4.72, 70 - 68.7 * f.scale[2] * k - drop] } };
  }
  return hood;
}

/**
 * Items worn on the standard bunny's lower face. They are built on the face ellipsoid (head-shape.ts FACE) like
 * everything else; on the standard bunny their geometry is carried onto the jaw (hats.ts builds "<id>@jaw" with onJaw),
 * so the item's own code never changes with the head. Add a face item's id here and it follows the jaw.
 */
export const JAW_ITEMS: readonly string[] = ["hat-oni-mask"];

/**
 * Carries a built item onto the jaw, in place: every position through head-shape.ts jawShape (nothing above eye level
 * moves), every normal through the same map (its inverse transpose, by differences).
 */
export function onJaw(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const P = g.getAttribute("position"), N = g.getAttribute("normal");
  const h = 0.01;
  for (let i = 0; i < P.count; i++) {
    const p: V3 = [P.getX(i), P.getY(i), P.getZ(i)];
    const q = jawShape(p);
    if (N && q !== p) {
      // The map's columns a, b, c; the normal goes through (b x c, c x a, a x b).
      const d = (k: number): V3 => {
        const e = jawShape([p[0] + (k === 0 ? h : 0), p[1] + (k === 1 ? h : 0), p[2] + (k === 2 ? h : 0)]);
        return [(e[0] - q[0]) / h, (e[1] - q[1]) / h, (e[2] - q[2]) / h];
      };
      const a = d(0), b = d(1), c = d(2);
      const x = (u: V3, v: V3): V3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const bc = x(b, c), ca = x(c, a), ab = x(a, b), n = [N.getX(i), N.getY(i), N.getZ(i)];
      const m = [0, 1, 2].map((k) => bc[k] * n[0] + ca[k] * n[1] + ab[k] * n[2]);
      const l = Math.hypot(m[0], m[1], m[2]) || 1;
      N.setXYZ(i, m[0] / l, m[1] / l, m[2] / l);
    }
    P.setXYZ(i, q[0], q[1], q[2]);
  }
  P.needsUpdate = true;
  if (N) N.needsUpdate = true;
  return g;
}
