// Clover Cleaver (knife-cleaver, Prize): a chunky cleaver. A tall minty-steel slab with a bright edge bevel and a
// four-leaf clover cut through it near the spine (rimmed in leaf green), on a fat carrot handle with an accent ferrule
// and a leaf tuft. Original design. pivots.hole is the clover cut (its toss-and-catch / hold-to-spin inspect).

import { add, ring, scale, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, CARROT, CARROT_DARK, fixed, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { straightHold } from "./hold";
import { PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const STEEL = fixed(0xcfe2d8), STEEL_DARK = fixed(0xa9c2b6), BEVEL = fixed(0xf4fbf7), HOLE = fixed(0x10161c);
/** Blade slab: z from the ferrule to the nose, spine at +y, edge at -y. */
const Z0 = 1.95, Z1 = 8.6, SPINE = 0.42, EDGE = -2.05;
/** Clover cut centre (near the spine, toward the nose) and leaf size. */
const HOLE_C: V3 = [0, -0.45, 6.75], HOLE_R = 0.62;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const m = 14;
  // --- Blade: a wedge-section slab (thick spine, sharp edge), rounded nose and heel.
  const mid = (SPINE + EDGE) / 2, half = (SPINE - EDGE) / 2;
  k.blade({
    n: 14,
    m,
    center: (s) => [0, mid, Z0 + (Z1 - Z0) * s],
    // Heel rounds in over the first 6 %, the nose over the last 14 % (more on the edge side: the belly).
    width: (s) => half * Math.min(1, Math.sqrt(Math.min(1, s / 0.06)) * 0.25 + 0.75) * (s > 0.86 ? Math.sqrt(Math.max(0, 1 - ((s - 0.86) / 0.14) ** 2)) * 0.92 + 0.08 : 1),
    thick: (s) => 0.17 - 0.03 * s,
    shift: (s) => (s > 0.86 ? 0.35 * ((s - 0.86) / 0.14) ** 2 : 0),
    edge: -1,
    ex: 6,
    bands: false,
    paint: (i, kk): Paint => {
      const a = Math.cos((kk / m) * Math.PI * 2);
      if (a < -0.72) return BEVEL;
      if (a > 0.82) return STEEL_DARK;
      return STEEL;
    },
    capStart: STEEL_DARK,
  });
  // --- Clover cut: four heart-shaped leaves around the centre, rimmed in green, dark inside (reads as a hole).
  for (const side of [-1, 1]) {
    const x = side * 0.165;
    const n = fp ? 28 : 16;
    const outline = (r: number): V3[] => {
      const pts: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 4;
        // Four lobes (|sin 2a| petals) with a heart notch.
        const p = Math.abs(Math.sin(2 * a));
        const rr = r * (0.38 + 0.62 * Math.pow(p, 0.6)) * (1 - 0.18 * Math.pow(Math.abs(Math.cos(4 * a)), 6) * p);
        pts.push([x, HOLE_C[1] + Math.cos(a) * rr, HOLE_C[2] + Math.sin(a) * rr]);
      }
      return pts;
    };
    // Dark disc (the cut) and the green rim.
    const inner = outline(HOLE_R), c: V3 = [x + side * 0.004, HOLE_C[1], HOLE_C[2]];
    k.surface([inner.map(() => c), inner.map((p) => [p[0] + side * 0.004, p[1], p[2]] as V3)], { paint: () => HOLE, part: PART.none, closed: true });
    k.loop(outline(HOLE_R * 1.04), fp ? 0.055 : 0.07, 4, [1, 0, 0], (i) => (i % 2 ? LEAF : LEAF_DARK), { part: PART.guard });
  }
  // --- Ferrule (accent) and the carrot handle (fat, ringed, rounded butt) with a leaf tuft.
  {
    const rows = [Z0 - 0.42, Z0 - 0.36, Z0 + 0.02, Z0 + 0.12].map((z, i) => ring([0, 0, z], X, Y, [0.36, 0.44, 0.42, 0.24][i], [0.48, 0.58, 0.56, 0.4][i], fp ? 14 : 10));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
    const n = fp ? 14 : 7;
    const grip: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = -2.55 + (Z0 - 0.4 + 2.55) * t;
      const r = (0.5 + 0.08 * Math.sin(t * Math.PI)) * Math.min(1, 0.55 + 0.45 * Math.sqrt(Math.min(1, t / 0.08))) * (i % 3 === 1 ? 0.95 : 1);
      grip.push(ring([0, 0, z], X, Y, r * 0.86, r, fp ? 14 : 10, 2, 0.3 * i));
    }
    k.surface(grip, { paint: (i) => (i % 3 === 1 ? CARROT_DARK : CARROT), part: PART.grip, capStart: CARROT, capEnd: CARROT });
    for (let j = 0; j < 3; j++) {
      const a = (j - 1) * 0.55;
      const path: V3[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        path.push(add([0, Math.sin(a) * 1.0 * t, -2.5 - (1.0 + (j === 1 ? 0.4 : 0)) * t], scale([-0.5, 0, 0], t * t)));
      }
      k.leaf(path, (i) => 0.24 * Math.sin(((i + 0.3) / 5.6) * Math.PI) + 0.03, 0.05, [1, 0, 0], () => (j === 1 ? LEAF : LEAF_DARK));
    }
  }
}

export const cleaver: KnifeDef = {
  id: "cleaver",
  cosmeticId: "knife-cleaver",
  name: "Clover Cleaver",
  rarity: 3,
  blurb: "A chunky cleaver with a four-leaf clover cut through it.",
  build,
  pivots: { hole: { p: HOLE_C, axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0.2]),
};
