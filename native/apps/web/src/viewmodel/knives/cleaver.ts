// Clover Cleaver (knife-cleaver, Prize): a chunky cleaver. A tall minty-steel slab with a bright edge bevel and a
// four-leaf clover cut through it near the spine (rimmed in leaf green), on a fat carrot handle with an accent ferrule
// and a leaf tuft. Original design. pivots.hole is the clover cut (its toss-and-catch / hold-to-spin inspect).

import { add, ring, scale, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, CARROT, CARROT_DARK, edgeWeight, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { hump, idleSway, reducedMotion } from "./bayonet";
import { straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const STEEL = fixed(0xcfe2d8, KMAT.polished), STEEL_DARK = fixed(0xa9c2b6, KMAT.polished), BEVEL = fixed(0xf4fbf7, KMAT.polished);
/** Blade slab: z from the ferrule to the nose, spine at +y, edge at -y. */
const Z0 = 1.95, Z1 = 8.6, SPINE = 0.42, EDGE = -2.05;
/** The clover's contour radius at angle a (four heart-shaped lobes) for leaf size r. */
function cloverR(a: number, r: number): number {
  const p = Math.abs(Math.sin(2 * a));
  return r * (0.38 + 0.62 * Math.pow(p, 0.6)) * (1 - 0.18 * Math.pow(Math.abs(Math.cos(4 * a)), 6) * p);
}
/** Clover cut centre (near the spine, toward the nose) and leaf size. */
export const HOLE_C: V3 = [0, -0.45, 6.75], HOLE_R = 0.62;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Blade: a wedge-section slab (thick spine, sharp edge), rounded nose and heel, with the clover cut THROUGH it
  //     (v0.0.38, Astra 11-06: it was a dark decal on a solid slab). Each face is a polar grid round the clover's
  //     centre, from its contour out to the slab's outline (every ray from the centre crosses the outline once), the
  //     same wedge section as before (thin at the edge, the spine full), an inner wall round the cut, the rim.
  const mid = (SPINE + EDGE) / 2, half = (SPINE - EDGE) / 2;
  const width = (s: number) => half * Math.min(1, Math.sqrt(Math.min(1, s / 0.06)) * 0.25 + 0.75) * (s > 0.86 ? Math.sqrt(Math.max(0, 1 - ((s - 0.86) / 0.14) ** 2)) * 0.92 + 0.08 : 1);
  const shift = (s: number) => (s > 0.86 ? 0.35 * ((s - 0.86) / 0.14) ** 2 : 0);
  const thick = (s: number) => 0.17 - 0.03 * s;
  const sOf = (z: number) => (z - Z0) / (Z1 - Z0);
  /** Across the slab at (y, z): -1 edge .. 1 spine. */
  const acrossOf = (y: number, z: number) => {
    const s = Math.min(1, Math.max(0, sOf(z)));
    return Math.max(-1, Math.min(1, (y - mid - shift(s)) / Math.max(1e-3, width(s))));
  };
  const inside = (y: number, z: number) => {
    const s = sOf(z);
    return s >= 0 && s <= 1 && Math.abs(y - mid - shift(s)) <= width(s);
  };
  /** Half thickness at (y, z): the wedge (thin edge, full spine). */
  const halfT = (y: number, z: number) => {
    const c = acrossOf(y, z);
    return thick(Math.min(1, Math.max(0, sOf(z)))) * (0.1 + 0.9 * Math.pow((c + 1) / 2, 0.7));
  };
  const nA = fp ? 64 : 32, nR = fp ? 8 : 4;
  /** The outline's distance from the clover's centre along the ray at angle a (bisection). */
  const outAt = (a: number) => {
    let lo = cloverR(a, HOLE_R), hi = 12;
    for (let it = 0; it < 30; it++) {
      const m2 = (lo + hi) / 2;
      if (inside(HOLE_C[1] + Math.cos(a) * m2, HOLE_C[2] + Math.sin(a) * m2)) lo = m2;
      else hi = m2;
    }
    return lo;
  };
  // Columns spaced evenly along the outline (the far heel and nose get as many as the near spine), not by angle.
  const fine = 720, arc: number[] = [0], ang: number[] = [];
  let prevP: [number, number] | null = null;
  for (let q = 0; q <= fine; q++) {
    const a = (q / fine) * Math.PI * 2 + Math.PI / 4, r1 = outAt(a);
    const pt: [number, number] = [Math.cos(a) * r1, Math.sin(a) * r1];
    ang.push(a);
    if (prevP) arc.push(arc[arc.length - 1] + Math.hypot(pt[0] - prevP[0], pt[1] - prevP[1]));
    prevP = pt;
  }
  const ring2: { dir: [number, number]; r0: number; r1: number }[] = [];
  for (let k2 = 0, q = 0; k2 < nA; k2++) {
    const target = (k2 / nA) * arc[fine];
    while (q < fine - 1 && arc[q + 1] < target) q++;
    const f = (target - arc[q]) / Math.max(1e-9, arc[q + 1] - arc[q]);
    const a = ang[q] + (ang[q + 1] - ang[q]) * f;
    ring2.push({ dir: [Math.cos(a), Math.sin(a)], r0: cloverR(a, HOLE_R), r1: outAt(a) });
  }
  const at = (k2: number, t: number, side: number): V3 => {
    const { dir, r0, r1 } = ring2[k2];
    const r = r0 + (r1 - r0) * t;
    const y = HOLE_C[1] + dir[0] * r, z = HOLE_C[2] + dir[1] * r;
    return [side * halfT(y, z), y, z];
  };
  const tOf = (i: number) => Math.pow(i / nR, 1.35);
  const paintAt = (p: V3): Paint => {
    const c = acrossOf(p[1], p[2]);
    return c < -0.8 ? BEVEL : c > 0.86 ? STEEL_DARK : STEEL;
  };
  const fin = (p: V3): [number, number, number] => {
    const u = Math.min(1, Math.max(0, sOf(p[2]))), v = acrossOf(p[1], p[2]);
    return [u, v, edgeWeight(u, Math.max(0, -v * 1.1))];
  };
  for (const side of [1, -1]) {
    const rows: V3[][] = [];
    for (let i = 0; i <= nR; i++) {
      const row: V3[] = [];
      for (let k2 = 0; k2 < nA; k2++) row.push(at(k2, tOf(i), side));
      rows.push(side > 0 ? row : row.reverse());
    }
    k.surface(rows, { paint: (i, kk) => paintAt(rows[i][kk]), part: PART.blade, fin: (i, kk) => fin(rows[i][kk]), closed: true, capStart: null, capEnd: null, out: () => [side, 0, 0] });
  }
  // The cut's inner wall (facing the clover's centre) and the slab's rim (facing out).
  for (const [t, inward] of [[0, true], [1, false]] as const) {
    const rows = [1, -1].map((side) => Array.from({ length: nA }, (_, k2) => at(k2, t, side)));
    if (!inward) rows.reverse();
    k.surface(rows, {
      paint: (i, kk) => (inward ? STEEL_DARK : paintAt(rows[i][kk])),
      part: PART.blade,
      fin: (i, kk) => fin(rows[i][kk]),
      closed: true,
      capStart: null,
      capEnd: null,
      out: (i, kk) => {
        const d = ring2[inward ? kk : kk].dir;
        return inward ? [0, -d[0], -d[1]] : [0, d[0], d[1]];
      },
    });
  }
  // The green rim round the cut, on both faces.
  for (const side of [-1, 1]) {
    const n = fp ? 28 : 16;
    const outline = (r: number): V3[] => {
      const pts: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 4;
        const rr = cloverR(a, r);
        const y = HOLE_C[1] + Math.cos(a) * rr, z = HOLE_C[2] + Math.sin(a) * rr;
        pts.push([side * (halfT(y, z) + 0.01), y, z]);
      }
      return pts;
    };
    k.loop(outline(HOLE_R * 1.06), fp ? 0.05 : 0.065, 4, [1, 0, 0], (i) => (i % 2 ? LEAF : LEAF_DARK), { part: PART.guard });
  }
  // --- Ferrule (accent) and the carrot handle (fat, ringed, rounded butt) with a leaf tuft.
  {
    const rows = [Z0 - 0.42, Z0 - 0.36, Z0 + 0.02, Z0 + 0.12].map((z, i) => ring([0, 0, z], X, Y, [0.36, 0.44, 0.42, 0.24][i], [0.48, 0.58, 0.56, 0.4][i], fp ? 14 : 10));
    k.hilt("fitting", () => k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "ferrule" }));
    const n = fp ? 14 : 7;
    const grip: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = -2.55 + (Z0 - 0.4 + 2.55) * t;
      const r = (0.5 + 0.08 * Math.sin(t * Math.PI)) * Math.min(1, 0.55 + 0.45 * Math.sqrt(Math.min(1, t / 0.08))) * (i % 3 === 1 ? 0.95 : 1);
      grip.push(ring([0, 0, z], X, Y, r * 0.86, r, fp ? 14 : 10, 2, 0.3 * i));
    }
    k.hilt("handle", () => k.surface(grip, { paint: (i) => (i % 3 === 1 ? CARROT_DARK : CARROT), part: PART.grip, capStart: CARROT, capEnd: CARROT, name: "handle" }));
    for (let j = 0; j < 3; j++) {
      const a = (j - 1) * 0.55;
      const path: V3[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        path.push(add([0, Math.sin(a) * 1.0 * t, -2.5 - (1.0 + (j === 1 ? 0.4 : 0)) * t], scale([-0.5, 0, 0], t * t)));
      }
      k.hilt("pommel", () => k.leaf(path, (i) => 0.24 * Math.sin(((i + 0.3) / 5.6) * Math.PI) + 0.03, 0.05, [1, 0, 0], () => (j === 1 ? LEAF : LEAF_DARK)));
    }
  }
}

export const cleaver: KnifeDef = withHilt({
  id: "cleaver",
  cosmeticId: "knife-cleaver",
  name: "Clover Cleaver",
  rarity: 3,
  blurb: "A chunky cleaver with a four-leaf clover cut through it.",
  build,
  // The ferrule and the ringed carrot handle (its darker growth rings the second tone); the leaf tuft and the clover
  // cut through the blade stay the cleaver's.
  hilt: { ferrule: "guard", handle: { role: "grip", alt: [CARROT_DARK] } },
  pivots: { hole: { p: HOLE_C, axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0.2]),
  // A heavy chopper, not a slicer: the same action timing as every knife, but the wrist cocks further back in the
  // wind-up, the arm drops through the cut behind the weight (the broad face turned toward you, not the edge), and the
  // recovery sags and lifts back late, as if the slab had to be hauled up again. Stab: a short downward chop.
 pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    // Idle: the slab's weight in a slow sway. Draw: it comes up heavy, the wrist sagging under it, then hauled level
    // with a small settle, the broad face turned to you on the way.
    if (action === "idle") return idleSway(s, 0.9);
    if (action === "draw") {
      s.wrist[0] += k * (9 * hump(t, 0.06, 0.46) - 5 * hump(t, 0.42, 0.78));
      s.arm.o[2] += k * (-0.5 * hump(t, 0.06, 0.5) + 0.2 * hump(t, 0.5, 0.85));
      s.arm.a[2] += k * -10 * hump(t, 0.1, 0.6);
      return;
    }
    if (action === "slash1" || action === "slash2") {
      const side = action === "slash1" ? 1 : -1;
      const cock = hump(t, 0, 0.2), cut = hump(t, 0.1, 0.44), sag = hump(t, 0.3, 0.9);
      s.wrist[0] += k * (-13 * cock + 12 * cut + 4 * sag);
      s.wrist[2] += k * side * (6 * cut - 10 * cock);
      // The flat shows through the cut: the forearm rolls the face toward the camera.
      s.arm.a[2] += k * side * -9 * cut;
      s.arm.a[0] += k * (3 * cock - 5 * cut);
      s.arm.o[2] += k * (0.5 * cock - 0.7 * cut - 0.5 * sag);
    } else if (action === "stab") {
      const lift = hump(t, 0, 0.3), chop = hump(t, 0.18, 0.6), sag = hump(t, 0.45, 1.0);
      s.wrist[0] += k * (-14 * lift + 16 * chop + 3 * sag);
      s.arm.o[2] += k * (0.6 * lift - 0.9 * chop - 0.3 * sag);
    }
  },
});
