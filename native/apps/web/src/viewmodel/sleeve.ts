// The first-person hoodie sleeve (every glove style but the Plush / Bun-E arms, which belong to their gloves): built in
// code in the v_knife_t bind pose round the forearm (gloves/fp.ts Hand: root, dA, fu, fv, L = the wrist), skinned to
// the forearm and the wrist twist helper exactly as before, so every knife hold, inspect and gun pose moves it the same.
//
// A fleece sleeve that gathers into a rib-knit cuff:
//   - the silhouette and the cuff / glove joint are the old ones (radii round the forearm, the cuff from L - 1.15 to its
//     opening at L + 0.62, where the glove comes out); inside the clearance capsule the inspects check (r 2.1);
//   - soft rolls of fabric bunched against the cuff, a little gathering right at the cuff seam, two shallow creases at
//     the elbow on the underside;
//   - a rounded cuff top, and the opening turned in over a lip so the cuff has thickness, dark inside;
//   - finishUV for the garment shading (player/fabric.ts): fleece with the underarm seam on the underside and a row of
//     stitches above the cuff seam, the cuff's ribs and cover stitch, baked occlusion in the fold valleys, at the seam
//     and inside the opening (where the glove disappears into it).
// ~4.2k vertices a side (the old tube: ~1.1k): first-person hands + sleeves ~15k in the knit glove (was ~9k). Colourway slots as before: hoodie for the sleeve, trim for the cuff.

import { add, Builder, clamp, scale, smoothstep, type Paint, type Wt } from "../player/bunny/builder";
import { around, gfin, GARMENT } from "../player/fabric";
import type { Hand } from "./gloves/fp";

const S = (slot: number, shade = 0): Paint => ({ code: 3 + slot + shade });
/** Palette slots (player/bunny/palettes.ts: hoodie 0, trim 1). The cuff's inside: the trim in shadow. */
const HOODIE = S(0), TRIM = S(1), TRIM_IN = S(1, 0.3);

/** Segments round the arm. */
const N = 20;
const TAU = Math.PI * 2;
const gauss = (x: number) => Math.exp(-x * x);

/** Row kinds: fleece, cuff (rib), the cuff's inside. */
const enum K {
  Fleece,
  Rib,
  Inside,
}

/** Base radius of the fleece along the forearm (s from the arm root; the old sleeve's stations). */
function fleeceR(s: number, L: number): number {
  const st: [number, number][] = [
    [-14, 2.55],
    [-7, 2.45],
    [-2, 2.35],
    [2, 2.22],
    [L - 3.2, 2.0],
    [L - 1.35, 1.9 * 0.97],
    [L - 1.15, 1.83],
  ];
  if (s <= st[0][0]) return st[0][1];
  for (let i = 0; i + 1 < st.length; i++) {
    const [s0, r0] = st[i], [s1, r1] = st[i + 1];
    if (s <= s1) {
      const t = (s - s0) / (s1 - s0);
      return r0 + (r1 - r0) * (t * t * (3 - 2 * t));
    }
  }
  return st[st.length - 1][1];
}

/**
 * Fabric folds: a radial offset (units, before the ring's 0.86 / 0.84 scale) at s and angle a (0 = the underside, where
 * the seam is). Rolls bunched against the cuff (wavy, not quite round), gathering at the cuff seam, two soft creases
 * under the elbow.
 */
function fold(s: number, a: number, L: number): number {
  let d = 0;
  // Bunching zone above the cuff.
  const zb = smoothstep(L - 5.8, L - 4.2, s) * (1 - smoothstep(L - 1.5, L - 1.24, s));
  if (zb > 0) {
    const A = [0.3, 0.24, 0.15];
    for (let j = 0; j < 3; j++) {
      const c = L - 1.95 - 1.02 * j + 0.22 * Math.sin(a + 1.3 * j) + 0.1 * Math.sin(2 * a + j);
      d += A[j] * (0.72 + 0.28 * Math.cos(a + 2.1 * j)) * gauss((s - c) / 0.33);
    }
    d += 0.035 * Math.cos(3 * a + 0.7);
    d *= zb;
  }
  // Gathering where the fleece goes into the cuff seam.
  d += 0.04 * Math.cos(6 * a + 0.4) * smoothstep(L - 2.0, L - 1.45, s) * (1 - smoothstep(L - 1.3, L - 1.18, s));
  // Elbow: two shallow diagonal creases on the underside.
  const ze = smoothstep(-4.6, -3.4, s) * (1 - smoothstep(-0.4, 0.8, s));
  if (ze > 0) {
    const under = smoothstep(-0.1, 0.75, Math.cos(a));
    d += 0.1 * ze * under * Math.sin((TAU * (s + 0.9 * Math.sin(a))) / 3.2);
  }
  return d;
}

/** Folds' valleys: how far a point sits below the average of its neighbours along the arm (0 .. ~0.05). */
const concavity = (s: number, a: number, L: number) => 0.5 * (fold(s - 0.28, a, L) + fold(s + 0.28, a, L)) - fold(s, a, L);

/** The hoodie sleeve + rib cuff round one forearm, up to `until` along it (a long glove cuff covers the rest). */
export function sleeve(b: Builder, h: Hand, until = Infinity): void {
  const L = h.L;
  // Rows: [s, radius, kind]. Fleece radius from fleeceR + folds; the cuff's own profile.
  const rows0: [number, number, K][] = [];
  for (const s of [-14, -9.5, -6]) rows0.push([s, 0, K.Fleece]);
  for (let s = -4.2; s <= 0.41; s += 0.9) rows0.push([s, 0, K.Fleece]);
  for (const s of [1.6, 2.6]) rows0.push([s, 0, K.Fleece]);
  for (let s = L - 5.5; s < L - 1.27; s += 0.35) rows0.push([s, 0, K.Fleece]);
  rows0.push([L - 1.22, 0, K.Fleece]);
  // Rib cuff: a rounded top (sewn on at L - 1.15), straight, a soft shoulder down to the opening.
  const cuff: [number, number][] = [
    [L - 1.15, 1.86],
    [L - 1.04, 2.03],
    [L - 0.86, 2.12],
    [L - 0.15, 2.16],
    [L + 0.42, 2.06],
    [L + 0.55, 1.93],
    [L + 0.62, 1.76],
  ];
  for (const [s, r] of cuff) rows0.push([s, r, K.Rib]);
  // Turned in over a lip: the opening's thickness, then the inside going back up the arm (dark).
  rows0.push([L + 0.645, 1.64, K.Inside], [L + 0.6, 1.52, K.Inside], [L + 0.3, 1.47, K.Inside]);
  const rows = rows0.filter((r) => r[0] <= until);
  const cut = rows.length < rows0.length;

  const seamS = L - 1.15;
  const Mf = around(TAU * 2.0 * 0.85), Mr = around(TAU * 2.1 * 0.85);
  const ang = (k: number) => Math.PI + (k / N) * TAU; // ring angle; 0 (k = N / 2) points up, the seam (k = 0) down
  const pts = rows.map(([s, r0, kind]) =>
    Array.from({ length: N }, (_, k) => {
      const a = ang(k);
      // fold() angle: 0 = the underside (the ring's -fu side).
      const r = kind === K.Fleece ? fleeceR(s, L) + fold(s, a - Math.PI, L) : r0;
      const c = add(h.root, scale(h.dA, s));
      const ca = Math.cos(a), sa = Math.sin(a);
      // Superellipse (e = 2.15) like the old rings.
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / 2.15) * r * 0.86;
      const y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / 2.15) * r * 0.84;
      return add(c, add(scale(h.fu, x), scale(h.fv, y)));
    }),
  );

  const weight = (s: number): Wt => {
    const t = clamp((s - (L - 3.2)) / 3.4, 0, 1);
    return t <= 0 ? [[h.arm, 1]] : [[h.arm, 1 - 0.45 * t], [h.twist, 0.45 * t]];
  };
  const occlusion = (i: number, k: number): number => {
    const [s, , kind] = rows[i];
    if (kind === K.Inside) return 0.55 + 0.4 * smoothstep(L + 0.64, L + 0.4, s);
    if (kind === K.Rib) return 0.28 * smoothstep(L + 0.42, L + 0.62, s) + 0.18 * smoothstep(L - 1.0, L - 1.15, s);
    const a = ang(k) - Math.PI;
    return clamp(concavity(s, a, L) * 11, 0, 0.5) + 0.22 * smoothstep(L - 1.7, L - 1.22, s);
  };
  b.surface(pts, {
    paint: (i) => (rows[i][2] === K.Fleece ? HOODIE : rows[i][2] === K.Rib ? TRIM : TRIM_IN),
    weight: (_, i) => weight(rows[i][0]),
    // Face kind decides the material (the row the quad starts on), the point its coordinates.
    fin: (i, k, fi) => {
      const s = rows[i][0], kind = rows[fi][2];
      const ao = occlusion(i, k);
      if (kind === K.Fleece) return gfin(GARMENT.fleece, s - seamS, (k / N) * Mf, ao);
      return gfin(GARMENT.rib, s - seamS, (k / N) * Mr, ao);
    },
    // The inside of the turned-in cuff faces the arm (hidden by the glove); the cut end of a sleeve under a long cuff
    // is closed with the hoodie.
    capStart: HOODIE,
    capEnd: cut ? HOODIE : TRIM_IN,
  });
}
