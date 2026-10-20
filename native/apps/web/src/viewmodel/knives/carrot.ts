// Carrot Blade (knife-carrot, Garden, the default): a slightly flattened carrot cone with growth rings, an accent guard,
// a ridged leaf-green grip and three leaves out of the pommel. First and third person are the original recipes from
// viewmodel/mesh.ts and player/bunny/mesh.ts, unchanged (they only gained the finishUV attribute).

import { add, norm, ring, scale, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, CARROT, CARROT_DARK, edgeWeight, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const at = (z: number): V3 => [0, 0, z];

/** Paints of the carrot recipe (the Golden Carrot reuses it in gold). */
export interface CarrotPalette {
  blade: Paint;
  ring: Paint;
  grip: Paint;
  guard: Paint;
  leaf: Paint;
  leafDark: Paint;
}
export const CARROT_PALETTE: CarrotPalette = { blade: CARROT, ring: CARROT_DARK, grip: LEAF_DARK, guard: ACCENT, leaf: LEAF, leafDark: LEAF_DARK };

export function buildCarrotFp(k: KnifeCtx, P: CarrotPalette = CARROT_PALETTE): void {
  // Grip: wrapped leaf-green handle with ridges.
  const grip: V3[][] = [];
  for (let i = 0; i <= 10; i++) {
    const z = -2.3 + (4.0 * i) / 10;
    const rad = 0.5 + (i % 2 ? 0.05 : 0);
    grip.push(ring(at(z), X, Y, rad * 0.9, rad, 12));
  }
  k.surface(grip, { paint: () => P.grip, part: PART.grip, capStart: P.grip, capEnd: P.grip });
  // Guard (accent).
  const guard = [ring(at(1.6), X, Y, 0.8, 1.05, 14), ring(at(1.95), X, Y, 0.92, 1.22, 14), ring(at(2.3), X, Y, 0.78, 1.02, 14)];
  k.surface(guard, { paint: () => P.guard, part: PART.guard, capStart: P.guard, capEnd: P.guard });
  // Blade: a slightly flattened carrot cone with growth rings, tapering to a point.
  const blade: V3[][] = [];
  const n = 18;
  const rads: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = 2.3 + t * 8.9;
    const rad = (0.8 * Math.pow(1 - t, 0.85) + 0.04) * (i % 3 === 1 ? 0.93 : 1);
    rads.push(rad);
    blade.push(ring(at(z), X, Y, rad * 0.8, rad, 14, 2, 0.3 * i));
  }
  // Finish coordinates match the prototype shader's carrot profile (u = (z - 2.3) / 8.9, v = y / radius).
  k.surface(blade, {
    paint: (i) => (i % 3 === 1 ? P.ring : P.blade),
    part: PART.blade,
    fin: (i, j) => {
      const u = i / n;
      const v = Math.max(-1, Math.min(1, blade[i][j][1] / Math.max(0.8 * Math.pow(1 - u, 0.85) + 0.04, 0.05)));
      return [u, v, edgeWeight(u, Math.abs(v))];
    },
    capStart: P.blade,
  });
  // Leaves out of the pommel.
  for (let j = 0; j < 3; j++) {
    const a = (j - 1) * 0.5;
    const dir = norm([0.25, Math.sin(a) * 0.9, -1]);
    const path: V3[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const droop = add(scale(dir, t * (2.1 + (j === 1 ? 0.7 : 0))), [-0.45 * t * t, 0, 0]);
      path.push(add(at(-2.3), droop));
    }
    k.tube(path, (i) => 0.38 * Math.sin(((i + 0.5) / 5) * Math.PI) + 0.07, 6, X, () => (j === 1 ? P.leaf : P.leafDark), { part: PART.grip });
  }
}

/** Third person (player/bunny/mesh.ts's recipe in the TpSpec frame: z = blade direction, y = the old u0, -x = v0). */
export function buildCarrotTp(k: KnifeCtx, P: CarrotPalette = CARROT_PALETTE): void {
  const V: V3 = [-1, 0, 0];
  const grip: V3[][] = [];
  for (let i = 0; i <= 8; i++) {
    const s = -0.4 + (5.0 * i) / 8;
    const rad = 0.7 + (i % 2 ? 0.07 : 0);
    grip.push(ring(at(s), Y, V, rad, rad, 10));
  }
  k.surface(grip, { paint: () => P.grip, part: PART.grip, capStart: P.grip, capEnd: P.grip });
  const guard = [ring(at(4.5), Y, V, 1.35, 1.0, 12), ring(at(4.9), Y, V, 1.5, 1.12, 12), ring(at(5.3), Y, V, 1.3, 0.95, 12)];
  k.surface(guard, { paint: () => P.guard, part: PART.guard, capStart: P.guard, capEnd: P.guard });
  const blade: V3[][] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = 5.3 + t * 10.3;
    const rad = (1.25 * Math.pow(1 - t, 0.85) + 0.05) * (i % 3 === 1 ? 0.93 : 1);
    blade.push(ring(at(s), Y, V, rad * 0.78, rad, 10, 2, 0.3 * i));
  }
  k.surface(blade, {
    paint: (i) => (i % 3 === 1 ? P.ring : P.blade),
    part: PART.blade,
    fin: (i, j) => {
      const u = i / n;
      const v = Math.max(-1, Math.min(1, -blade[i][j][0] / Math.max(1.25 * Math.pow(1 - u, 0.85) + 0.05, 0.05)));
      return [u, v, edgeWeight(u, Math.abs(v))];
    },
    capStart: P.blade,
  });
  for (let j = 0; j < 3; j++) {
    const a = (j - 1) * 0.45;
    const dir = norm(add(scale(at(1), -1), add(scale(Y, Math.sin(a) * 0.9), scale(V, 0.25))));
    const path: V3[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const droop = add(scale(dir, t * (2.6 + (j === 1 ? 0.9 : 0))), scale(V, -0.5 * t * t));
      path.push(add(at(-0.4), droop));
    }
    k.tube(path, (i) => 0.48 * Math.sin(((i + 0.5) / 5) * Math.PI) + 0.08, 6, Y, (): Paint => (j === 1 ? P.leaf : P.leafDark), { part: PART.grip });
  }
}

export const carrot: KnifeDef = {
  id: "carrot",
  cosmeticId: "knife-carrot",
  name: "Carrot Blade",
  rarity: 1,
  blurb: "The original carrot blade.",
  build: (k) => (k.view === "fp" ? buildCarrotFp(k) : buildCarrotTp(k)),
  // The bunny's original third-person placement; the recipe above is already third-person sized, s = 1.15 makes it
  // read at normal viewing distance (v0.0.5: every knife's third-person scale went up ~30%, knives/types.ts TpSpec).
  tp: { o: [2.05, -1.45, 3.1], z: [0.53, 0.1, -0.84], y: [0, 1, 0], s: 1.15 },
};
