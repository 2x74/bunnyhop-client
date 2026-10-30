// Hats (progression.ts slot "hat": the owner's three and the Supporter's three): built in code like crown.ts, in the
// bunny's bind pose and skinned to the head bone, sharing the bunny's skeleton and material (one extra draw call, only
// for bunnies wearing one).
//
//   - Founder Crown: violet band with rounded scallops and orange tips, a carrot on the front, cyan side gems: the
//     Founder colours (outfit-founder violet, fin-founder / trail-founder orange, ghost-founder cyan), so it never reads
//     as one of the gold / silver / bronze rank crowns.
//   - Tiny Top Hat: a small black top hat with an orange band, perched on the front of the hood between the ears.
//   - Carrot Beanie: an orange ribbed beanie pulled over the hood (the ears come through), green leafy pom-pom.
//   - The Supporter's three (the Geode set; a supporter owns all of them and picks one), crystal in aqua and amethyst,
//     moving and lit by player/hat-fx.ts (accent codes 12-15; held still in Potato mode):
//     - Gem Orbit: four gems in our own cuts (a silver pyramid, an amethyst diamond, a five-sided emerald, an eight-sided
//       sapphire), flat facets in three tones, circling above the ears; the ring turns, each gem spins and
//       bobs, and one at a time pops and catches a white shine (hold, burst, shine, rest).
//     - Halo: a thick faceted ring (hexagonal section) floating above the ear tips, tipped back toward the third-person
//       camera, three amethyst insets; a short arc of light goes round it every 7 s.
//     - Circlet: a band of dark amethyst glass round the hood with one angular crest over the forehead and a small
//       chevron at the back; a light sweeps to and fro along the aqua line across its front.
//
//   - More Supporter hats, asked for by supporters: Propeller Cap, Capybara and Maxwell (moving, accent -1..-8); the
//     Space Buns and Ponytail wigs (wigs.ts: the player's hair colour; the ponytail swings) and the Half Oni Mask
//     (oni-mask.ts). On the standard bunny a wig is built for the bare head (the hood is down: mesh.ts), on Plush and
//     Bun-E for their hoods: headwearKey picks the build.
//
// headwear() is the one rule for what a bunny wears on its head: the hat when one is on, else the rank crown.

import * as THREE from "three";
import { add, Builder, cross, frame, norm, ring, scale, sub, type Paint, type Wt } from "./builder";
import { crownGeometry } from "./crown";
import { oniMask } from "./oni-mask";
import { ponytail, ponytailDown, spaceBuns, spaceBunsDown } from "./wigs";
import { isWig } from "../../loadout";
import type { BunnyLook } from "./look";
import { rig, type V3 } from "./rig";
import { AURORA_C, HALO_C, HALO_N, ORBIT_C, ORBIT_R, PROPELLER_C, orbitAngle } from "../hat-fx";
import type { CosmeticLoadout } from "../../loadout";

const fixed = (color: number): Paint => ({ code: 0, color });

/** The hood (mesh.ts): centre and radii; -y is the face side. */
const HOOD_C: V3 = [0, 0.55, 69.35];
const HOOD_R: V3 = [5.55, 6.05, 6.0];

function headWeight(): Wt {
  return [[rig().bone("Head1"), 1]];
}

function founderCrown(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  const LAVENDER = 0xa77cff, DEEP = 0x2a1660, ORANGE = 0xff7a1a, CYAN = 0x3ff0ff, LEAF = 0x3fbf5a;
  // Laid out at the rank crown's size, then grown about the bottom of the band (M): ~20% wider so it still sits on the
  // hood (the bottom ring stays just inside the hood's surface), ~60% taller so the scallops clear the ears' bases and
  // read at third-person distance. Gems grow 40% (uniformly, so they stay round).
  const A: V3 = [0, 0.45, 73.15];
  const M = (p: V3): V3 => [A[0] + (p[0] - A[0]) * 1.2, A[1] + (p[1] - A[1]) * 1.2, A[2] + (p[2] - A[2]) * 1.6];
  const G = 1.4;
  const c = (z: number): V3 => [0, 0.45, z];
  const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
  const N = 96;
  const R = (z: number, ru: number, rv: number) => ring(c(z), X, Y, ru, rv, N).map(M);
  // Rounded points, tiara-like: five across the front (the tallest centred on the face, at 270 degrees) and one at the
  // back, none over the ears (they come up through the band at about -10..65 and 115..190 degrees): the rank crowns
  // have five evenly spaced sharp spikes. [angle (deg), half width (deg), height]
  const POINTS: [number, number, number][] = [[214, 14, 2.0], [242, 14, 2.4], [270, 14, 2.9], [298, 14, 2.4], [326, 14, 2.0], [90, 18, 2.0]];
  const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const lobes = (k: number) => Math.max(0, ...POINTS.map(([a, hw, ht]) => ht * Math.pow(Math.max(0, Math.cos((Math.PI / 2) * Math.min(1, angDiff((k / N) * 360, a) / hw))), 0.85)));
  const band = [R(73.5, 3.55, 3.85), R(74.4, 3.64, 3.94), R(75.2, 3.72, 4.02)];
  const top = ring(c(75.2), X, Y, 3.8, 4.1, N).map((p, k): V3 => M([p[0], p[1], p[2] + lobes(k)]));
  // Orange band rising into lavender scallops (reads against the violet Founder hoodie), deep violet rolled rim.
  b.surface([...band, top], { paint: (i) => fixed(i < 2 ? ORANGE : LAVENDER), weight: () => W });
  b.surface([R(73.3, 3.5, 3.8), R(73.5, 3.74, 4.04), R(73.8, 3.7, 4.0)], { paint: () => fixed(DEEP), weight: () => W });
  const ball = (p: V3, r: V3, color: number) => b.surface(b.ellipsoidRows(p, scale(r, G), [0, 0, 1], [1, 0, 0], 10, 6), { paint: () => fixed(color), weight: () => W, closed: true });
  for (const [a, , ht] of POINTS) {
    const r = (a * Math.PI) / 180;
    ball(M([3.8 * 1.02 * Math.cos(r), 0.45 + 4.1 * 1.02 * Math.sin(r), 75.2 + ht + 0.2]), [0.42, 0.42, 0.42], CYAN);
  }
  // The front: a cyan gem with a little carrot top (two green leaves) above it; deep violet side gems.
  const front = M([0, 0.45 - 4.15, 74.35]);
  ball(front, [0.72, 0.42, 0.85], CYAN);
  for (const sx of [-1, 1]) ball(add(front, [0.42 * sx, 0.07, 1.47]), [0.2, 0.2, 0.5], LEAF);
  for (const sx of [-1, 1]) ball(M([3.35 * sx, 0.45 - 2.3, 74.35]), [0.42, 0.42, 0.42], DEEP);
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

function topHat(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  const BLACK = 0x231d33, BAND = 0xff7a1a, SHEEN = 0x3a3150;
  // Perched on the front of the hood, in front of the ears (their fronts are at y ~0.35): the brim is an oval, wide
  // across and shallow front-to-back, so its back edge stays clear of them; tipped a little forward and to one side.
  const axis = norm([0.12, -0.15, 1]);
  const base: V3 = [0, -2.6, 75.1];
  const u = norm([1, 0, -axis[0]]);
  const v = norm([0, 1, -axis[1]]);
  /** Height and width scale; front-to-back (v) the brim and crown grow less (SV). */
  const S = 1.65, SV = 1.15;
  const at = (h: number): V3 => add(base, scale(axis, h * S));
  const N = 28;
  // Brim: a thin disc with a slight curl at the sides.
  const brim = (h: number, r: number) => ring(at(h), u, v, r * 1.12 * S, r * SV, N);
  // (Flat rings: `out` says which way each faces, else their normals flip at random.)
  const down = scale(axis, -1);
  b.surface([[...Array(N)].map(() => at(-0.05)), brim(-0.05, 1.4), brim(-0.05, 2.25)], { paint: () => fixed(BLACK), weight: () => W, out: () => down });
  const lip = [brim(-0.05, 2.25), brim(0.12, 2.38), brim(0.2, 2.15), brim(0.18, 1.3)];
  b.surface(lip, { paint: () => fixed(BLACK), weight: () => W, out: (i, k) => (i < 2 ? add(lip[i][k], scale(at(0), -1)) : axis) });
  // Crown of the hat: slightly flared towards the top, an orange band near the brim.
  const cyl = (h: number, r: number) => ring(at(h), u, v, r * S, r * (SV + 0.15), N);
  const rows = [cyl(0.15, 1.3), cyl(0.3, 1.3), cyl(0.75, 1.31), cyl(0.85, 1.32), cyl(2.9, 1.42), cyl(3.05, 1.4)];
  b.surface(rows, { paint: (i) => fixed(i === 1 || i === 2 ? BAND : i >= 4 ? SHEEN : BLACK), weight: () => W, capEnd: fixed(BLACK) });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

function beanie(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  const ORANGE = 0xff7a1a, RIB = 0xe8650e, CUFF = 0xd95a0c, LEAF = 0x3fbf5a, LEAF2 = 0x2f9a48;
  // Pulled over the hood, tipped back so the front edge sits above the face.
  const axis = norm([0, 0.32, 1]);
  const r: V3 = [HOOD_R[0] + 0.32, HOOD_R[1] + 0.32, HOOD_R[2] + 0.3];
  const SEG = 32;
  const shell = (d: number, a: number): V3[] => b.ellipsoidRows(HOOD_C, [r[0] + d, r[1] + d, r[2] + d], axis, [1, 0, 0], SEG, 1, a, a)[0];
  const rows = b.ellipsoidRows(HOOD_C, r, axis, [1, 0, 0], SEG, 10, 0, 0.98);
  b.surface(rows, { paint: (_i, k) => fixed(k % 2 ? RIB : ORANGE), weight: () => W });
  // Folded cuff: a thicker band hugging the edge (follows the dome from the rim up), rolled lips top and bottom.
  b.surface([shell(0, 0.99), shell(0.42, 0.985), shell(0.5, 0.92), shell(0.5, 0.82), shell(0.4, 0.765), shell(0, 0.76)], {
    paint: () => fixed(CUFF),
    weight: () => W,
  });
  // Pom-pom: a carrot top of leaves (a few flattened blobs) at the crown.
  const tip = add(HOOD_C, [axis[0] * r[0], axis[1] * r[1], axis[2] * r[2]]);
  const blob = (p: V3, s: V3, color: number) => b.surface(b.ellipsoidRows(p, s, [0, 0, 1], [1, 0, 0], 10, 6), { paint: () => fixed(color), weight: () => W, closed: true });
  const P = 1.35; // pom-pom size (owner call: readable at third-person distance)
  blob(add(tip, [0, 0, 0.55 * P]), [0.95 * P, 0.95 * P, 0.8 * P], LEAF);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    blob(add(tip, [Math.cos(a) * 0.75 * P, Math.sin(a) * 0.75 * P, 0.9 * P]), [0.42 * P, 0.42 * P, 0.7 * P], k % 2 ? LEAF2 : LEAF);
  }
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

/** Supporter crystal colours (the Geode set): three flat values per crystal plus one pale highlight facet. */
const GEM = { pale: 0xd6fff8, aqua: 0x5ff2df, aqua2: 0x34c9c6, teal: 0x167a8c, violet: 0x9a7cff, violet2: 0x7258ea, violet3: 0x45329e };
/** Accent codes for moving / glowing crystal (player/hat-fx.ts). */
const FX = { aurora: 11, orbit: 12, halo: 13, haloInset: 14, line: 15 } as const;
const fx = (code: number, color: number): Paint => ({ code, color });

/**
 * A crystal point: a ring of `sides` facets between two tips (double-terminated, like a quartz point), flat-shaded.
 * c: centre, t: long axis (unit), r: girdle radius, below / above: tip distances, band: height of the straight sides.
 * paint(row, k): row 0 the lower point, 1 the sides, 2 the upper point; k the facet round it.
 */
function crystal(b: Builder, c: V3, t: V3, r: number, below: number, above: number, band: number, sides: number, paint: (row: number, k: number) => Paint, W: Wt, twist = 0): void {
  const [, u, v] = frame(t, Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]);
  const at = (h: number): V3 => add(c, scale(t, h));
  const rows = [
    ring(at(-below), u, v, 0, 0, sides),
    ring(at(-band / 2), u, v, r, r, sides, 2, twist),
    ring(at(band / 2), u, v, r * 1.04, r * 1.04, sides, 2, twist),
    ring(at(above), u, v, 0, 0, sides),
  ];
  b.surface(rows, { paint, weight: () => W, flat: true, out: (i, k) => (i === 0 ? scale(t, -1) : i === 3 ? t : sub(rows[i][k], at(0))) });
}

/** Facet tones round a crystal: light, mid and a dark side plane, so the form reads from any side in flat light. */
const tones = (light: number, mid: number, dark: number) => [light, mid, dark, dark, mid, light];

/**
 * A cut gem round a vertical axis at c: a pointed pavilion below the girdle, a crown above it closing to a flat table
 * (table radius 0 = a point). Flat-shaded; paint(row, k): row 0 the pavilion, 1 the crown, 2 the table.
 */
function cut(b: Builder, c: V3, sides: number, r: number, below: number, above: number, table: number, paint: (row: number, k: number) => Paint, W: Wt, twist = 0): void {
  const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
  const S = 1.45; // gem size (third-person distance)
  [r, below, above, table] = [r * S, below * S, above * S, table * S];
  const at = (z: number): V3 => [c[0], c[1], c[2] + z];
  const rows = [ring(at(-below), X, Y, 0, 0, sides, 2, twist), ring(at(0), X, Y, r, r, sides, 2, twist), ring(at(above), X, Y, table, table, sides, 2, twist)];
  if (table > 0) rows.push(ring(at(above), X, Y, 0, 0, sides, 2, twist));
  b.surface(rows, { paint: (i, k) => paint(i, k), weight: () => W, flat: true, out: (i, k) => (i === 0 ? [0, 0, -1] : i === 3 ? [0, 0, 1] : sub(rows[i][k], at(i === 2 ? above - 1 : 0))) });
}

/** The Gem Orbit's four gems: our own cuts, each in three flat tones of its colour (light, mid, dark). */
const ORBIT_GEMS: { cut: (b: Builder, c: V3, W: Wt) => void }[] = (() => {
  // The dark tone is the mid one about 35% darker, so every gem keeps three readable facet values.
  const dim = (c: number) => (Math.round(((c >> 16) & 255) * 0.65) << 16) | (Math.round(((c >> 8) & 255) * 0.65) << 8) | Math.round((c & 255) * 0.65);
  const T = (light: number, mid: number) => (row: number, k: number, n: number) => {
    const dark = dim(mid);
    // Facets lit from the upper left: the ones facing it light, the far ones dark; the pavilion a step darker.
    const a = ((k + 0.5) / n) * Math.PI * 2;
    const f = Math.cos(a - 2.4);
    const t = f > 0.35 ? light : f > -0.35 ? mid : dark;
    return fx(FX.orbit, row === 0 ? (t === light ? mid : dark) : t);
  };
  const silver = T(0xf2f5fa, 0xc3cad6);
  const amethyst = T(0xd9b8ff, 0x9b5cf5);
  const emerald = T(0x8ff7cf, 0x22c98e);
  const sapphire = T(0x9cc8ff, 0x3f7ef0);
  return [
    // A pyramid on a shallow base (silver).
    { cut: (b, c, W) => cut(b, c, 4, 1.15, 0.45, 1.35, 0, (i, k) => silver(i, k, 4), W, Math.PI / 4) },
    // A tall diamond, point up and down (amethyst).
    { cut: (b, c, W) => cut(b, c, 4, 0.85, 1.3, 1.3, 0, (i, k) => amethyst(i, k, 4), W) },
    // A five-sided cut with a flat table (emerald).
    { cut: (b, c, W) => cut(b, c, 5, 1.1, 1.14, 0.6, 0.62, (i, k) => emerald(i, k, 5), W, Math.PI / 2) },
    // An eight-sided brilliant (sapphire).
    { cut: (b, c, W) => cut(b, c, 8, 1.15, 1.14, 0.54, 0.66, (i, k) => sapphire(i, k, 8), W, Math.PI / 8) },
  ];
})();

function gemOrbit(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // Four gems in a ring above the ear tips (hat-fx.ts ORBIT_C / ORBIT_R): the ring turns, each gem spins
  // on its own axis and bobs, and one at a time pops and catches a shine. Built at rest; the shader moves them.
  ORBIT_GEMS.forEach((g, i) => {
    const a = orbitAngle(i);
    g.cut(b, add(ORBIT_C, [Math.cos(a) * ORBIT_R, Math.sin(a) * ORBIT_R, 0]), W);
  });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

function halo(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // A faceted ring (a hexagonal section, flat-shaded: pale mint top bevels, aqua sides, a dark teal underside)
  // floating above the ear tips, tipped back a little toward the third-person camera; three amethyst segments are inset
  // in it. A short arc of light goes round it every few seconds (hat-fx.ts).
  const [, u, v] = frame(HALO_N, [1, 0, 0]);
  const R = 3.4, N = 48;
  const at = (a: number, dr: number, dn: number): V3 => add(add(HALO_C, scale(HALO_N, dn)), add(scale(u, Math.cos(a) * (R + dr)), scale(v, Math.sin(a) * (R + dr))));
  const SEC = 6;
  const sec: [number, number][] = Array.from({ length: SEC }, (_, j) => [Math.cos((j / SEC) * Math.PI * 2) * 0.92, Math.sin((j / SEC) * Math.PI * 2) * 0.64]);
  const rows: V3[][] = [];
  for (let i = 0; i <= N; i++) rows.push(sec.map(([dr, dn]) => at((i / N) * Math.PI * 2, dr, dn)));
  // Face k of the section sits between points k and k + 1: its direction is (k + 0.5) * 60 degrees (0 = outward).
  const faceTone = (k: number, top: number, out: number, inn: number, under: number) => {
    const s = Math.sin(((k + 0.5) / SEC) * Math.PI * 2), c = Math.cos(((k + 0.5) / SEC) * Math.PI * 2);
    return s > 0.6 ? top : s < -0.6 ? under : c > 0 ? out : inn;
  };
  const inset = (i: number) => [8, 24, 40].some((m) => Math.abs(i - m) <= 1);
  // A dark amethyst seam either side of each inset, so it reads as set into the ring rather than painted on.
  const seam = (i: number) => [8, 24, 40].some((m) => Math.abs(i - m) === 2);
  b.surface(rows, {
    closed: true,
    paint: (i, k) =>
      seam(i)
        ? fx(FX.haloInset, faceTone(k, GEM.violet3, 0x2a1f66, 0x2a1f66, 0x1c1446))
        : inset(i)
          ? fx(FX.haloInset, faceTone(k, 0xb9a6ff, GEM.violet, GEM.violet2, GEM.violet3))
          : fx(FX.halo, faceTone(k, 0x9ff3e8, GEM.aqua, GEM.aqua2, 0x0f5f6c)),
    weight: () => W,
    flat: true,
    out: (i, k) => sub(rows[i][k], at((i / N) * Math.PI * 2, 0, 0)),
  });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

function circlet(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // A faceted headband of dark amethyst glass round the hood: one angular crest over the forehead, a thin band that
  // dips toward the nape (under the ears) and a small chevron at the back for the third-person camera. An aqua line is
  // set across the front, broken either side of the crest, with a light that sweeps to and fro along it (hat-fx.ts).
  // Few segments on purpose, so it reads as cut facets.
  const K = 26;
  const rAt = (z: number) => Math.sqrt(Math.max(0.04, 1 - ((z - HOOD_C[2]) / HOOD_R[2]) ** 2));
  /** Band point at angle th (0 = the front, -y) and height z, `out` units off the hood (its radius taken at zr). */
  const pt = (th: number, z: number, zr: number, out: number): V3 => {
    const k = rAt(zr);
    return [HOOD_C[0] + Math.sin(th) * (HOOD_R[0] * k + out), HOOD_C[1] - Math.cos(th) * (HOOD_R[1] * k + out), z];
  };
  // Per angle: the band's foot height (front high, back low), its height (the plate in front), how far it stands off.
  const front = (th: number) => Math.pow(Math.max(0, Math.cos(th)), 1.6);
  const foot = (th: number) => 72.0 + 1.9 * (0.5 + 0.5 * Math.cos(th));
  const ang = (th: number) => Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
  const crest = (th: number) => Math.max(0, 1 - ang(th) / 0.62);
  const back = (th: number) => Math.max(0, 1 - (Math.PI - ang(th)) / 0.42);
  const tall = (th: number) => 0.42 + 0.6 * front(th) + 2.0 * crest(th) + 0.75 * back(th);
  // Rows across the band, bottom to top: [height fraction, standoff]; the line is the strip between rows 3 and 4.
  const prof: [number, number][] = [[0, 0.05], [0, 0.42], [0.3, 0.5], [0.44, 0.56], [0.54, 0.56], [0.72, 0.5], [1, 0.4], [1, 0.02]];
  const rows: V3[][] = prof.map(([f, o]) =>
    Array.from({ length: K }, (_, j) => {
      const th = (j / K) * Math.PI * 2;
      const zb = foot(th), h = tall(th);
      // Lean the plate in a little less than the dome does, so it stands up like a visor.
      return pt(th, zb + f * h, zb + f * h * 0.55, o + 0.15 * front(th) * f);
    }),
  );
  const DARK = 0x231b52, MID = 0x342a78, LIGHT = 0x4d3fa6, RIM = 0x8f72ff;
  b.surface(rows, {
    closed: true,
    flat: true,
    paint: (i, k) => {
      const th = ((k + 0.5) / K) * Math.PI * 2;
      // The line: across the forehead, broken either side of the crest.
      if (i === 3) return front(th) > 0.12 && Math.abs(ang(th) - 0.5) > 0.09 ? fx(FX.line, GEM.aqua) : fixed(RIM);
      if (i === 5) return fixed(RIM); // top bevel
      // The lower edge goes darker under the crest, to part it from a hood trim of the same amethyst.
      if (i === 0 || i === 1) return fixed(front(th) > 0.5 ? 0x150f33 : DARK);
      if (i === 6) return fixed(DARK);
      return fixed(k % 2 ? MID : i < 3 ? DARK : LIGHT);
    },
    weight: () => W,
    out: (i, k) => sub(rows[i][k], [HOOD_C[0], HOOD_C[1], rows[i][k][2] - (i === 0 ? 1 : i === prof.length - 1 ? -1 : 0)]),
  });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

// ---------------------------------------------------------------------------------------------
// High Roller

/** A gold coin standing on edge at c, its faces toward `t` (flat-shaded rim, a raised face disc each side). */
function coin(b: Builder, c: V3, t: V3, W: Wt): void {
  const [, u, v] = frame(t, [0, 0, 1]);
  const R = 1.35, H = 0.2, N = 18;
  const at = (h: number): V3 => add(c, scale(t, h));
  const GOLD = 0xffcf4a, RIM = 0xc9921f, FACE = 0xffe08a, EDGE = 0xa8761a;
  const rows = [ring(at(-H), u, v, 0, 0, N), ring(at(-H), u, v, R, R, N), ring(at(H), u, v, R, R, N), ring(at(H), u, v, 0, 0, N)];
  b.surface(rows, { paint: (i, k) => fx(FX.orbit, i === 1 ? (k % 2 ? RIM : EDGE) : GOLD), weight: () => W, flat: true, out: (i, k) => (i === 0 ? scale(t, -1) : i === 3 ? t : sub(rows[i][k], at(0))) });
  for (const sgn of [-1, 1]) {
    const f = [ring(at(sgn * H), u, v, R * 0.66, R * 0.66, N), ring(at(sgn * (H + 0.09)), u, v, R * 0.6, R * 0.6, N), ring(at(sgn * (H + 0.09)), u, v, 0, 0, N)];
    b.surface(f, { paint: (i) => fx(FX.orbit, i === 0 ? RIM : FACE), weight: () => W, flat: true, out: (i, k) => (i === 2 ? scale(t, sgn) : sub(f[i][k], at(0))) });
    // A small bar across each face (a stamped mark), our own and plain.
    const m = [ring(add(at(sgn * (H + 0.09)), scale(v, 0.38)), u, t, 0.12, 0.06, 6), ring(add(at(sgn * (H + 0.09)), scale(v, -0.38)), u, t, 0.12, 0.06, 6)];
    b.surface(m, { paint: () => fx(FX.orbit, RIM), weight: () => W, capStart: fx(FX.orbit, RIM), capEnd: fx(FX.orbit, RIM) });
  }
}

function luckyCoins(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // Four gold coins on the Gem Orbit's ring (hat-fx.ts code 12: the ring turns, each coin flips on its own axis and
  // bobs, one at a time pops and catches a shine), faces turned outward at rest.
  for (let i = 0; i < 4; i++) {
    const a = orbitAngle(i);
    coin(b, add(ORBIT_C, [Math.cos(a) * ORBIT_R, Math.sin(a) * ORBIT_R, 0]), [Math.cos(a), Math.sin(a), 0], W);
  }
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

function dealerVisor(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // A dealer's eyeshade: a black band round the hood with gold piping, and a curved felt-green shade over the forehead,
  // a lighter green at its edge.
  const K = 32;
  const rAt = (z: number) => Math.sqrt(Math.max(0.04, 1 - ((z - HOOD_C[2]) / HOOD_R[2]) ** 2));
  const pt = (th: number, z: number, out: number): V3 => {
    const k = rAt(z);
    return [HOOD_C[0] + Math.sin(th) * (HOOD_R[0] * k + out), HOOD_C[1] - Math.cos(th) * (HOOD_R[1] * k + out), z];
  };
  const foot = (th: number) => 72.3 + 1.5 * (0.5 + 0.5 * Math.cos(th));
  const BAND = 0x111216, GOLD = 0xe0b13a, SHADE = 0x1e9a5a, SHADE2 = 0x167a47, EDGE = 0x5fd896;
  const prof: [number, number][] = [[0, 0.04], [0, 0.32], [0.15, 0.36], [0.85, 0.36], [1, 0.32], [1, 0.04]];
  const band = prof.map(([f, o]) => Array.from({ length: K }, (_, j) => {
    const th = (j / K) * Math.PI * 2;
    return pt(th, foot(th) + f * 0.75, o);
  }));
  b.surface(band, { closed: true, paint: (i) => fixed(i === 2 || i === 4 ? GOLD : BAND), weight: () => W, out: (i, k) => sub(band[i][k], [HOOD_C[0], HOOD_C[1], band[i][k][2]]) });
  // The shade: from the band's front edge, out, forward and a little down, curving round the front 150 degrees.
  const S = 13, A = (75 * Math.PI) / 180;
  const shade: V3[][] = [0, 0.35, 0.7, 1].map((r) =>
    Array.from({ length: S + 1 }, (_, j) => {
      const th = -A + (2 * A * j) / S;
      const base = pt(th, foot(th) + 0.7, 0.36);
      const outDir: V3 = norm([Math.sin(th), -Math.cos(th), 0]);
      const reach = 3.1 * (0.75 + 0.25 * Math.cos(th)) * r;
      return add(base, add(scale(outDir, reach), [0, 0, -0.95 * r * r + 0.25 * r]));
    }),
  );
  b.surface(shade, { closed: false, paint: (i) => fixed(i === 2 ? EDGE : i === 1 ? SHADE2 : SHADE), weight: () => W, out: () => [0, 0, 1] });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Borealis

function auroraRibbon(): THREE.BufferGeometry {
  const W = headWeight();
  const b = new Builder();
  // A ribbon of light floating above the ears: a wavy band (it rises and dips three times round), green at its foot
  // into teal and violet at its top, self-lit with a swell flowing round it (hat-fx.ts code 11).
  const R = 3.6, N = 60, H = 1.35;
  const rows: V3[][] = [0, 0.33, 0.66, 1].map((f) =>
    Array.from({ length: N }, (_, j) => {
      const a = (j / N) * Math.PI * 2;
      const r = R + 0.25 * Math.sin(a * 2 + 0.6);
      return add(AURORA_C, [Math.cos(a) * r, Math.sin(a) * r, 0.4 * Math.sin(a * 3) + (f - 0.5) * H * (0.8 + 0.2 * Math.cos(a * 3))]);
    }),
  );
  const COL = [0x3ff0a0, 0x2fd6c8, 0x8a6bff];
  b.surface(rows, { closed: true, paint: (i) => fx(FX.aurora, COL[i]), weight: () => W, out: (i, k) => sub(rows[i][k], [AURORA_C[0], AURORA_C[1], rows[i][k][2]]) });
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

/** A toy cap over the hood; the rotor sits forward of the ears so it can turn freely. */
function propellerCap(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  const RED = 0xec2342, BLUE = 0x128ad1, YELLOW = 0xffcf3d, GREEN = 0x21ae70;
  const colors = [RED, GREEN, BLUE, YELLOW, RED, GREEN];
  // Follow the hood closely, like the Carrot Beanie, with openings around the ear roots.
  // Lift only the forehead over the hood trim: shearing the whole dome pushed the back into the hood.
  const dome = (x: number, y: number): V3 => {
    const radius2 = (x / 5.85) ** 2 + ((y - 0.55) / 6.35) ** 2;
    // Add 0.6 units at the crown, tapering to zero at the fitted rim and bill seam.
    const lift = 0.6 * Math.max(0, 1 - radius2 / (0.83 ** 2));
    return [x, y, 69.45 + 0.24 * Math.max(0, 0.55 - y) + 6.65 * Math.sqrt(Math.max(0, 1 - radius2)) + lift];
  };
  const normal = (p: V3): V3 => {
    const radius2 = (p[0] / 5.85) ** 2 + ((p[1] - 0.55) / 6.35) ** 2;
    const slope = 6.65 / Math.sqrt(Math.max(0.001, 1 - radius2)) + (radius2 < 0.83 ** 2 ? 1.2 / (0.83 ** 2) : 0);
    return norm([slope * p[0] / (5.85 ** 2), slope * (p[1] - 0.55) / (6.35 ** 2) + (p[1] < 0.55 ? 0.24 : 0), 1]);
  };
  const holes = [-1, 1].map(side => Array.from({ length: 32 }, (_, k): V3 => {
    const a = k / 32 * Math.PI * 2;
    return dome(side * 2.65 + 1.95 * Math.cos(a), 1.6 + 1.25 * Math.sin(a));
  }));
  // Subtract a convex opening by keeping each outside half-plane fragment. Intersections
  // are projected back onto the dome, giving the opening a continuous, curved edge.
  const subtractHole = (polygon: V3[], hole: V3[]): V3[][] => {
    // Most dome triangles miss the opening entirely; avoid splitting those into slivers.
    if (hole.some((a, i) => {
      const c = hole[(i + 1) % hole.length];
      return polygon.every(p => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]) <= 0);
    })) return [polygon];
    let inside = polygon;
    const outside: V3[][] = [];
    for (let i = 0; i < hole.length && inside.length; i++) {
      const a = hole[i], c = hole[(i + 1) % hole.length];
      const distance = (p: V3) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
      const keep: V3[] = [], cut: V3[] = [];
      for (let j = 0; j < inside.length; j++) {
        const p = inside[j], q = inside[(j + 1) % inside.length];
        const dp = distance(p), dq = distance(q);
        (dp >= 0 ? keep : cut).push(p);
        if ((dp >= 0) !== (dq >= 0)) {
          const t = dp / (dp - dq);
          const hit = dome(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
          keep.push(hit); cut.push(hit);
        }
      }
      if (cut.length >= 3) outside.push(cut);
      inside = keep;
    }
    return outside;
  };
  const SEG = 72, ROWS = 14;
  const point = (i: number, k: number): V3 => {
    const r = 0.83 * Math.sin(i / ROWS * Math.PI / 2), a = k / SEG * Math.PI * 2;
    return dome(5.85 * r * Math.cos(a), 0.55 + 6.35 * r * Math.sin(a));
  };
  for (let i = 0; i < ROWS; i++) for (let k = 0; k < SEG; k++) {
    const a = point(i, k), c = point(i + 1, k + 1);
    for (const triangle of [[a, point(i, k + 1), c], [a, c, point(i + 1, k)]]) {
      let parts = [triangle];
      for (const hole of holes) parts = parts.flatMap(p => subtractHole(p, hole));
      for (const poly of parts) for (let j = 1; j + 1 < poly.length; j++) {
        const [p, q, r] = [poly[0], poly[j], poly[j + 1]];
        b.tri(p, q, r, normal(p), normal(q), normal(r), fixed(colors[Math.floor(k / 12)]), W, W, W);
      }
    }
  }
  for (const hole of holes) {
    const path = [...hole, hole[0]].map(p => add(p, [0, 0, 0.06]));
    b.tube(path, 0.065, 8, [0, 0, 1], () => fixed(BLUE), () => W, false);
  }
  const edge = Array.from({ length: SEG + 1 }, (_, k) => point(ROWS, k));
  b.tube(edge, 0.09, 8, [0, 0, 1], () => fixed(BLUE), () => W, false);
  const blob = (p: V3, size: V3, paint: Paint) => b.surface(b.ellipsoidRows(p, size, [0, 0, 1], [1, 0, 0], 24, 8), { paint: () => paint, weight: () => W, closed: true });
  // A baseball-cap bill: a broad rounded rectangle projecting from the forehead,
  // with almost straight sides, rounded front corners and a gentle crosswise bend.
  const bill = Array.from({ length: 7 }, (_, row) => {
    const f = row / 6;
    return Array.from({ length: 33 }, (_, k): V3 => {
      const t = -1 + 2 * k / 32;
      const arc = t * Math.PI / 2;
      const x = 4.35 * Math.sin(arc);
      const y = 0.55 - 6.35 * 0.83 * Math.sqrt(1 - (x / (5.85 * 0.83)) ** 2);
      const base = dome(x, y);
      // An elliptical nose meets the side edges tangentially, without pointed corners.
      const tip: V3 = [4.45 * Math.sin(arc), -6.8 - 2.2 * Math.cos(arc), 73.95 - 0.65 * Math.sin(arc) ** 2];
      return [base[0] + (tip[0] - base[0]) * f, base[1] + (tip[1] - base[1]) * f, base[2] + (tip[2] - base[2]) * f];
    });
  });
  const underside = bill.map(row => row.map(p => add(p, [0, 0, -0.16])));
  b.surface(bill, { closed: false, paint: () => fixed(BLUE), weight: () => W, out: () => [0, 0, 1] });
  b.surface(underside, { closed: false, paint: () => fixed(0x086dab), weight: () => W, out: () => [0, 0, -1] });
  b.surface([bill[6], underside[6]], { closed: false, paint: () => fixed(BLUE), weight: () => W, out: () => [0, -1, 0] });
  for (const k of [0, 32]) b.surface([bill.map(row => row[k]), underside.map(row => row[k])], {
    closed: false, paint: () => fixed(BLUE), weight: () => W, out: () => [k === 0 ? -1 : 1, 0, 0],
  });
  blob([0, PROPELLER_C[1], 76.35], [0.65, 0.65, 0.35], fixed(RED));
  b.surface([ring([0, PROPELLER_C[1], 76.35], [1, 0, 0], [0, 1, 0], 0.19, 0.19, 12), ring(PROPELLER_C, [1, 0, 0], [0, 1, 0], 0.19, 0.19, 12)], {
    paint: () => fixed(0xffe6a0), weight: () => W, capEnd: fixed(YELLOW),
  });
  for (const [z, color] of [[76.05, RED], [76.7, 0x7657cd], [77.35, YELLOW]]) {
    blob([0, PROPELLER_C[1], z], [0.3, 0.3, 0.34], fixed(color));
  }
  // Accent -1 rotates position and normal in the shared hat shader, before head skinning.
  for (const side of [-1, 1]) blob(add(PROPELLER_C, [side * 1.5, 0, 0]), [1.55, 0.52, 0.12], { code: -1, color: BLUE });
  blob(add(PROPELLER_C, [0, 0, 0.1]), [0.35, 0.35, 0.28], fixed(BLUE));
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

/** A sleepy capybara loaf resting on the forehead, forward of the bunny ear roots. */
function capybara(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  const FUR = 0xa97848, HEAD = 0xb88955, MUZZLE = 0xc99c68, DARK = 0x493020, EAR = 0x805232;
  // Slightly squared volumes give the capybara its barrel body and blunt muzzle.
  const blob = (c: V3, r: V3, color: number, square = 1, seg = 24, rows = 12, code = -2) => {
    const points = b.ellipsoidRows([0, 0, 0], [1, 1, 1], [0, 0, 1], [1, 0, 0], seg, rows)
      .map(row => row.map(p => p.map((v, i) => c[i] + Math.sign(v) * Math.pow(Math.abs(v), square) * r[i]) as V3));
    // The longer rump narrows between the bunny ear roots.
    if (color === FUR && c[0] === 0) for (const row of points) for (const p of row) {
      p[0] *= 1 - 0.38 * Math.max(0, Math.min(1, (p[1] + 0.5) / 2.1));
    }
    b.surface(points, { closed: true, paint: () => ({ code, color }), weight: () => W, out: (i, k) => sub(points[i][k], c) });
  };
  blob([0, -0.55, 76.95], [2.25, 2.25, 1.85], FUR, 0.82);
  // Four tucked paws make the contact with the curved hood intentional.
  for (const side of [-1, 1]) {
    blob([side * 1.35, -0.2, 75.5], [0.65, 0.85, 0.65], FUR);
    blob([side * 1.55, -3.25, 75.65], [0.62, 0.9, 1.05], HEAD);
  }
  blob([0, -3.45, 77.65], [2.2, 1.65, 1.65], HEAD, 0.72);
  blob([0, -4.75, 77.2], [1.85, 0.85, 1.05], MUZZLE, 0.66);
  for (const side of [-1, 1]) {
    // Small round ears, with recessed-looking warm brown centres.
    blob([side * 1.6, -2.9, 79.1], [0.55, 0.4, 0.65], FUR);
    blob([side * 1.6, -3.23, 79.17], [0.32, 0.12, 0.39], EAR);
    // The shared shader opens these sleepy lids with horizontal bhop speed.
    blob([side * 1.65, -4.77, 78.25], [0.26, 0.15, 0.37], DARK, 1, 16, 8, -3);
    blob([side * 0.57, -5.59, 77.55], [0.16, 0.07, 0.11], DARK, 1, 12, 6);
  }
  // A flat resting mouth becomes a small surprised "o" at high speed.
  const mouth = Array.from({ length: 25 }, (_, i): V3 => {
    const a = i / 24 * Math.PI * 2;
    return [0.42 * Math.cos(a), -5.61, 76.86 + 0.32 * Math.sin(a)];
  });
  b.tube(mouth, 0.055, 8, [0, -1, 0], () => ({ code: -4, color: DARK }), () => W);
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

/** Maxwell the tuxedo cat loaf perched on the forehead, with iconic eyes and bhop-driven spin, hop and facial reactions. */
function maxwell(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  const FUR = 0x161820, HEAD = 0x1d202a, EAR_OUT = 0x12141b, EAR_IN = 0x2a262c, WHITE = 0xf0f3f8, CREAM = 0xdad5cd, NOSE = 0x322b30, EYE_RIM = 0x8e9682, PUPIL = 0x090a0d;
  const blob = (c: V3, r: V3, color: number, square = 1, seg = 24, rows = 12, code = -5) => {
    const points = b.ellipsoidRows([0, 0, 0], [1, 1, 1], [0, 0, 1], [1, 0, 0], seg, rows)
      .map(row => row.map(p => p.map((v, i) => c[i] + Math.sign(v) * Math.pow(Math.abs(v), square) * r[i]) as V3));
    if (color === FUR && c[0] === 0) for (const row of points) for (const p of row) {
      // Taper the rear of the cat loaf between the bunny ear roots and arch the back like the classic low-poly Maxwell loaf.
      p[0] *= 1 - 0.38 * Math.max(0, Math.min(1, (p[1] + 0.5) / 2.2));
      if (p[2] > c[2]) p[2] += 0.34 * Math.max(0, 1 - ((p[1] + 0.4) / 1.95) ** 2);
    }
    b.surface(points, { closed: true, paint: () => ({ code, color }), weight: () => W, out: (i, k) => sub(points[i][k], c) });
  };
  // Arched tuxedo cat loaf body and shoulders centered around the forehead pivot so it can spin cleanly in place.
  blob([0, -0.7, 76.92], [2.1, 2.22, 1.82], FUR, 0.76);
  for (const side of [-1, 1]) {
    blob([side * 1.28, -2.42, 76.34], [0.74, 0.94, 0.96], HEAD, 0.84);
    // Four tucked white socks resting cleanly on the curved hood.
    blob([side * 1.32, -0.45, 75.46], [0.56, 0.78, 0.56], WHITE, 0.82);
    blob([side * 1.08, -3.12, 75.48], [0.56, 0.8, 0.54], WHITE, 0.78);
  }
  // Prominent white tuxedo chest bib under the chin.
  blob([0, -2.52, 76.42], [1.38, 0.8, 1.1], WHITE, 0.84);
  blob([0, -2.84, 75.78], [1.16, 0.68, 0.62], WHITE, 0.84);
  // Broad low-poly rounded cat head and snout bridge.
  blob([0, -3.32, 77.72], [1.94, 1.46, 1.42], HEAD, 0.82);
  blob([0, -4.28, 77.42], [1.34, 0.68, 0.74], HEAD, 0.78);
  // Plump cream/white peanut whisker pads and chin under the dark face.
  for (const side of [-1, 1]) blob([side * 0.58, -4.68, 76.96], [0.68, 0.52, 0.44], CREAM, 0.8);
  blob([0, -4.58, 76.64], [0.58, 0.42, 0.28], WHITE, 0.85);
  blob([0, -5.12, 77.22], [0.28, 0.16, 0.17], NOSE, 0.75, 14, 8);
  for (const side of [-1, 1]) {
    // Wide-set pointed cat ears angled slightly outward like the Source Dingus / Maxwell mesh.
    const earRows = [0, 0.28, 0.62, 0.88, 1].map(f => {
      const s = 1 - 0.86 * Math.pow(f, 1.15);
      const c: V3 = [side * (1.26 + 0.64 * f), -3.14 - 0.12 * f, 78.66 + 1.72 * f];
      return ring(c, norm([side * 0.92, 0.16, -0.34]), norm([-side * 0.16, 0.98, -0.1]), 0.68 * s, 0.4 * s, 16, 1.65);
    });
    b.surface(earRows, { closed: true, paint: () => ({ code: -5, color: EAR_OUT }), weight: () => W, capEnd: { code: -5, color: EAR_OUT } });
    const innerRows = [0.08, 0.45, 0.82].map(f => {
      const s = 1 - 0.82 * f;
      const c: V3 = [side * (1.28 + 0.56 * f), -3.4 - 0.08 * f, 78.78 + 1.38 * f];
      return ring(c, [1, 0, 0], [0, 0, 1], 0.34 * s, 0.4 * s, 12, 1.6);
    });
    b.surface(innerRows, { closed: true, paint: () => ({ code: -5, color: EAR_IN }), weight: () => W, capEnd: { code: -5, color: EAR_IN } });
    // Maxwell's iconic eyes: pale sage-grey outer iris ring, huge dark glossy oval eye, and off-center white catchlight.
    blob([side * 0.94, -4.52, 77.78], [0.46, 0.2, 0.39], EYE_RIM, 0.86, 16, 8, -6);
    blob([side * 0.95, -4.64, 77.78], [0.35, 0.16, 0.31], PUPIL, 0.88, 16, 8, -6);
    blob([side * 0.82, -4.77, 77.91], [0.13, 0.08, 0.12], WHITE, 0.9, 12, 6, -6);
    blob([side * 1.07, -4.75, 77.67], [0.065, 0.05, 0.06], WHITE, 0.9, 10, 6, -6);
    // Crisp white whiskers fanning out from each cheek and brow.
    b.tube([[side * 0.85, -4.42, 78.26], [side * 1.35, -4.3, 78.58], [side * 1.82, -4.15, 78.78]], 0.032, 6, [0, 0, 1], () => ({ code: -5, color: WHITE }), () => W);
    b.tube([[side * 1.05, -4.68, 77.06], [side * 1.72, -4.56, 77.12], [side * 2.38, -4.38, 77.14]], 0.04, 6, [0, 0, 1], () => ({ code: -5, color: WHITE }), () => W);
    b.tube([[side * 1.02, -4.64, 76.88], [side * 1.68, -4.52, 76.82], [side * 2.28, -4.34, 76.74]], 0.038, 6, [0, 0, 1], () => ({ code: -5, color: WHITE }), () => W);
  }
  // Small mouth under the peanut whisker pads that opens into a surprised "o" at high speed.
  const mouth = Array.from({ length: 21 }, (_, i): V3 => {
    const a = i / 20 * Math.PI * 2;
    return [0.32 * Math.cos(a), -4.94, 76.76 + 0.24 * Math.sin(a)];
  });
  b.tube(mouth, 0.046, 8, [0, -1, 0], () => ({ code: -7, color: NOSE }), () => W);
  // Curled dark tail tucked closely behind the rump so it clears the bunny ears while spinning.
  const tail: V3[] = [
    [0, 1.18, 75.84],
    [0.52, 1.42, 75.92],
    [1.04, 1.32, 76.06],
    [1.36, 0.92, 76.22],
    [1.44, 0.38, 76.38],
  ];
  b.tube(tail, i => 0.34 - 0.025 * i, 10, [0, 0, 1], i => ({ code: -8, color: i >= 4 ? WHITE : EAR_OUT }), () => W);
  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}
const BUILD: Record<string, () => THREE.BufferGeometry> = {
  "hat-propeller": propellerCap,
  "hat-capybara": capybara,
  "hat-maxwell": maxwell,
  "hat-space-buns": spaceBuns,
  "hat-ponytail": ponytail,
  // The wigs on the bare head (hood down), keyed by headwearKey.
  "hat-space-buns@down": spaceBunsDown,
  "hat-ponytail@down": ponytailDown,
  "hat-oni-mask": oniMask,
  "hat-founder-crown": founderCrown,
  "hat-tophat": topHat,
  "hat-beanie": beanie,
  "hat-gem-orbit": gemOrbit,
  "hat-halo": halo,
  "hat-circlet": circlet,
  "hat-dealer-visor": dealerVisor,
  "hat-lucky-coins": luckyCoins,
  "hat-aurora": auroraRibbon,
};

const cache = new Map<string, THREE.BufferGeometry>();

/** A hat's geometry (built once each); null for an unknown id. */
export function hatGeometry(id: string): THREE.BufferGeometry | null {
  const make = BUILD[id];
  if (!make) return null;
  let g = cache.get(id);
  if (!g) cache.set(id, (g = make()));
  return g;
}

/** A hat this build can draw (headwear() falls back to the crown otherwise). */
export const isHat = (id: string | null | undefined): boolean => !!id && !!BUILD[id];

/** Already built (or seeded) for this hat id. */
export const hasHatGeometry = (id: string): boolean => cache.has(id);

/** A hat built elsewhere (prebuild.ts, in a worker), unless one is already there. */
export function seedHatGeometry(id: string, g: THREE.BufferGeometry): void {
  if (BUILD[id] && !cache.has(id)) cache.set(id, g);
}

/**
 * What a bunny wears on its head: the hat when one is on (the owner's, the Supporter's), else the rank crown
 * for overall #1-#3, else nothing. A hat wins over the crown its wearer holds (owner call, v0.0.6).
 */
export function headwear(l: CosmeticLoadout | null | undefined, look: BunnyLook = "bunny"): THREE.BufferGeometry | null {
  return (l?.hat ? hatGeometry(headwearKey(l.hat, look)) : null) ?? (l?.crown ? crownGeometry(l.crown) : null);
}

/** The geometry key of a hat on a look: a wig on the standard bunny is the hood-down build ("<id>@down"). */
export const headwearKey = (hat: string, look: BunnyLook): string => (look === "bunny" && isWig(hat) ? `${hat}@down` : hat);
