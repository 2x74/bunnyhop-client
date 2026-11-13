import type { BunnyLook } from "./look";
import type { V3 } from "./rig";
import { headShapeFit } from "./head-shape";

/**
 * A hat's fit to the Supporter heads: one scale + offset for the whole hat, and an optional second one (`face`) for
 * the vertices whose `headwear` attribute is 2 (parts that sit on the face rather than the hood, like a wig's fringe).
 */
export interface HatFit { scale: V3; offset: V3; face?: { scale: V3; offset: V3 } }
const IDENTITY: HatFit = { scale: [1, 1, 1], offset: [0, 0, 0] };

/** The standard bunny's face (mesh.ts) onto the Plush / Bun-E faceplate (supporter.ts supporterHead), flattened a little. */
function faceFit(plush: boolean): { scale: V3; offset: V3 } {
  const C: V3 = [0, -0.55, 68.7], R: V3 = [4.05, 4.35, 4.85];
  const rx = plush ? 6.0 : 7.2, rz = plush ? 6.5 : 7.8;
  const F: V3 = [0, -5.9, 70], FR: V3 = [rx * 0.79, 2.6, rz * 0.77];
  const scale: V3 = [FR[0] / R[0], FR[1] / R[1], FR[2] / R[2]];
  return { scale, offset: [F[0] - C[0] * scale[0], F[1] - C[1] * scale[1], F[2] - C[2] * scale[2]] };
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

/** Applied after bind-space hat animation, before head skinning: animation pivots stay canonical. */
export function hatFit(look: BunnyLook, hat?: string | null): HatFit {
  // The standard bunny's head is built bigger (head-shape.ts): its hats and wigs take the same scale.
  if (look === "bunny") return grown(hat, headShapeFit());
  if (look !== "plush" && look !== "bune") return grown(hat, IDENTITY);
  const plush = look === "plush";
  if (["hat-halo", "hat-gem-orbit", "hat-lucky-coins", "hat-aurora"].includes(hat ?? "")) {
    return { scale: [1, 1, 1], offset: [0, 0, plush ? 5.5 : 3] };
  }
  // Perched objects retain their proportions; their feet/brim meet the new crown of the head.
  if (hat === "hat-capybara" || hat === "hat-maxwell") return grown(hat, { scale: [1, 1, 1], offset: [0, .15, plush ? .65 : .55] });
  if (hat === "hat-tophat") return { scale: [1, 1, 1], offset: [0, 0, plush ? .7 : .6] };
  // Worn on the face: onto the faceplate.
  if (hat === "hat-oni-mask") return faceFit(plush);
  // Bands and caps follow the new hood/helmet ellipsoid, rather than the faceplate or ear cups.
  const scale: V3 = plush ? [6 / 5.55, 6.1 / 6.05, 6.5 / 6] : [6.48 / 5.55, 5.85 / 6.05, 7.02 / 6];
  const center: V3 = plush ? [0, -.1, 70.2] : [0, .01, 69.58];
  const hood: HatFit = { scale, offset: [0, center[1] - .55 * scale[1], center[2] - 69.35 * scale[2]] };
  // Wigs: the buns / ponytail on the hood, the fringe on the faceplate. The faceplate is flat where the bunny's face is
  // round, so the fringe is pressed flatter than the mask: its roots stay behind the rim, its tips on the eye band.
  if (hat === "hat-space-buns" || hat === "hat-ponytail") {
    // Bun-E's helmet opening is smaller for its faceplate than the plush hood's: a smaller fringe stays inside it.
    // Bun-E's fringe is also set lower, so its top stays under the helmet's rim from the front and 3/4.
    const f = faceFit(plush), k = plush ? 1 : 0.8, drop = plush ? 0 : 0.85;
    return { ...hood, face: { scale: [f.scale[0] * k, 0.75, f.scale[2] * k], offset: [0, -4.72, 70 - 68.7 * f.scale[2] * k - drop] } };
  }
  return hood;
}
