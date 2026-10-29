// Half Oni Mask (a Supporter hat, progression.ts slot "hat"; registered in hats.ts): a red lacquer oni mask over the
// lower half of the face, right up under the visor so the eyes still show. Hard lacquer in angular planes: a scowling ledge under
// the visor, angular cheekbones with a thin gold line along each, a sharp nose with flared nostrils, a grimace with a
// dark mouth, teeth top and bottom and long upper fangs, and two ivory tusks rising from the jaw either side of the
// mouth, up in front of the visor. A black lacquer rim gives the shell its thickness.
//
// Bind pose, Source space (z up, the bunny faces -y). The face is skinned head-to-neck down its lower half (mesh.ts
// headW), so the mask uses the same weights and stays on it when the head turns.

import * as THREE from "three";
import { add, Builder, frame, hat, norm, ring, scale, sub, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";

const fixed = (color: number): Paint => ({ code: 0, color });

const RED = 0xc81e2a, RED_DARK = 0x84121d, BLACK = 0x161117, MOUTH = 0x1c070c, TEETH = 0xf3ecdc, TUSK = 0xece0c2, TUSK_TIP = 0xc9b78c, GOLD = 0xe6b54a;

/** The face (mesh.ts): centre and radii; -y is the face side. */
const FACE_C: V3 = [0, -0.55, 68.7];
const FACE_R: V3 = [4.05, 4.35, 4.85];

/**
 * Longitude reach of the mask either side (the visor wraps to 1.22), its top and jaw. The top follows the visor's lower
 * lip (mesh.ts: lat 0.02, its ends lifting 0.09 at 1.22) so the mask tucks up under it, dipping in a shallow V at the nose.
 */
const L = 1.14;
const top = (lon: number) => 0.012 + 0.09 * (lon / 1.22) ** 2 - 0.035 * (1 - Math.min(1, Math.abs(lon) / 0.45));
const jaw = (lon: number) => -1.04 + 0.42 * Math.abs(lon / L) ** 2.2;

/**
 * The mouth: lat of the upper and lower lip at a longitude (a wide grimace, corners pulled up), and its half width. The
 * lips meet at the corners; past them one line runs on out to the mask's sides, where the upper and lower shells meet.
 */
const MW = 0.6;
const upperLip = (lon: number) => {
  const u = Math.abs(lon) / MW;
  return u < 1 ? -0.34 + 0.08 * u * u : -0.26 - 0.12 * (u - 1);
};
const lowerLip = (lon: number) => {
  const u = Math.abs(lon) / MW;
  return upperLip(lon) - (u < 1 ? 0.36 * (1 - u * u) ** 0.6 : 0);
};

/** Linear falloffs, so the relief comes out in planes and ridges rather than soft bumps. */
const tent = (x: number, w: number) => Math.max(0, 1 - Math.abs(x) / w);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Distance (in lon / lat) from a point to a segment, and how far along it (0..1). */
function seg(lon: number, lat: number, a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp01(((lon - a[0]) * dx + (lat - a[1]) * dy) / (dx * dx + dy * dy));
  return [Math.hypot(lon - a[0] - t * dx, lat - a[1] - t * dy), t];
}
/** The cheekbone ridge (left side; mirror lon): from beside the nose out and up toward the visor's end. */
const CHEEK: [[number, number], [number, number]] = [[0.24, -0.15], [0.98, -0.05]];

/** How far the mask stands off the face. */
function relief(lon: number, lat: number): number {
  const al = Math.abs(lon);
  let o = 0.3;
  // A scowl: a ledge just under the top edge, deepest beside the nose; the edge itself stays low, tucked under the visor.
  o += 0.42 * tent(top(lon) - 0.05 - lat, 0.13) * (0.55 + 0.45 * tent(al - 0.38, 0.5));
  // The nose: a sharp bridge rising to a tip, then cut back underneath.
  const t = clamp01((top(0) - lat) / 0.19);
  const under = lat < -0.215 ? tent(-0.215 - lat, 0.075) : 1;
  o += tent(lon, 0.1 + 0.08 * t) * (0.3 + 0.95 * t) * under;
  // Flared nostril wings.
  for (const s of [-1, 1]) o += 0.5 * tent(lon - s * 0.15, 0.085) * tent(lat + 0.205, 0.07);
  // Cheekbones: a hard ridge, the plane below it falling away toward the mouth.
  {
    const [d, f] = seg(al, lat, CHEEK[0], CHEEK[1]);
    const below = lat < CHEEK[0][1] + (CHEEK[1][1] - CHEEK[0][1]) * f;
    o += (0.58 - 0.2 * f) * tent(d, below ? 0.26 : 0.1);
  }
  // A squared chin.
  o += 0.22 * tent(lon, 0.32) * tent(lat + 0.88, 0.16);
  // Lips: a raised rim round the grimace.
  if (al < MW + 0.08) {
    const dl = Math.min(Math.abs(lat - upperLip(lon)), Math.abs(lat - lowerLip(lon)));
    o += 0.2 * tent(dl, 0.07) * (1 - (al / (MW + 0.08)) ** 4);
  }
  return o;
}

function facePoint(lon: number, lat: number, off: number): V3 {
  const d: V3 = [Math.sin(lon) * Math.cos(lat), -Math.cos(lon) * Math.cos(lat), Math.sin(lat)];
  return [FACE_C[0] + d[0] * (FACE_R[0] + off), FACE_C[1] + d[1] * (FACE_R[1] + off), FACE_C[2] + d[2] * (FACE_R[2] + off)];
}
const maskPoint = (lon: number, lat: number, extra = 0): V3 => facePoint(lon, lat, relief(lon, lat) + extra);

/** Catmull-Rom through control points, n samples. */
function curve(ctrl: V3[], n: number): V3[] {
  const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  return Array.from({ length: n }, (_, s) => {
    const f = (s / (n - 1)) * (ctrl.length - 1);
    const i = Math.min(ctrl.length - 2, Math.floor(f)), t = f - i;
    const [p0, p1, p2, p3] = [P[i], P[i + 1], P[i + 2], P[i + 3]];
    return [0, 1, 2].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t * t * t)) as V3;
  });
}

/**
 * A flat-shaded tooth: base at c, along t, w wide (toward `across`) and d deep, `sides` round. `tip` 0 comes to a point
 * (a fang); above it the end is cut square at that fraction of the base (a blunt, blocky tooth).
 */
function cone(b: Builder, c: V3, t: V3, len: number, w: number, d: number, across: V3, paint: Paint, W: (p: V3) => Wt, tip = 0, sides = 5): void {
  const [, u, v] = frame(norm(t), across);
  const mid = tip > 0 ? 0.92 : 0.62;
  const rows = [ring(c, u, v, w, d, sides), ring(add(c, scale(norm(t), len * 0.6)), u, v, w * mid, d * mid, sides), ring(add(c, scale(norm(t), len)), u, v, w * tip, d * tip, sides)];
  b.surface(rows, { paint: () => paint, weight: (p) => W(p), flat: true, capStart: paint, capEnd: tip > 0 ? paint : null });
}

export function oniMask(): THREE.BufferGeometry {
  const b = new Builder();
  const r = rig();
  const head = r.bone("Head1"), neck = r.bone("Neck1"), spine4 = r.bone("Spine4");
  const W = (p: V3): Wt => hat(p[2], [[62.8, spine4], [64.6, neck], [66.6, head]]);

  // The shell: an upper and a lower grid over the lower face, meeting along the lips (and the line running on from the
  // corners to the sides), so the mouth's edge is a clean curve rather than a staircase of cells. The relief is built
  // from linear ridges, so it reads as cut planes with smooth normals. Columns are spaced finer toward the centre where
  // the nose and mouth are.
  const K = 44, RU = 14, RL = 12;
  const lonAt = (k: number) => {
    const u = -1 + (2 * k) / K;
    return L * Math.sign(u) * Math.abs(u) ** 1.25;
  };
  const lons = Array.from({ length: K + 1 }, (_, k) => lonAt(k));
  const band = (from: (lon: number) => number, to: (lon: number) => number, R: number): [number, number][][] =>
    Array.from({ length: R + 1 }, (_, i) => lons.map((lon) => [lon, from(lon) + (to(lon) - from(lon)) * (i / R)] as [number, number]));
  const upper = band(top, upperLip, RU), lower = band(lowerLip, jaw, RL);
  const shell = (grid: [number, number][][]) => {
    const rows = grid.map((row) => row.map(([lon, lat]) => maskPoint(lon, lat)));
    b.surface(rows, {
      closed: false,
      flat: false,
      paint: (i, k) => {
        const cl = (grid[i][k][0] + grid[i + 1][k + 1][0]) / 2, ca = (grid[i][k][1] + grid[i + 1][k + 1][1]) / 2;
        // Darker lacquer at the far sides and along the jaw, so the mask's shape reads in flat light.
        return fixed(Math.abs(cl) > L * 0.84 || ca < jaw(cl) + 0.07 ? RED_DARK : RED);
      },
      weight: (p) => W(p),
      out: (i, k) => sub(rows[i][k], FACE_C),
    });
  };
  shell(upper);
  shell(lower);

  // The mouth: sunk into the shell between the lips, its walls dark red, the inside near black.
  {
    // The columns inside the corners and one more each side, where the lips have met (no gap to the shells).
    const inside = lons.map((lon, k) => (Math.abs(lon) < MW ? k : -1)).filter((k) => k >= 0);
    const cols = lons.slice(inside[0] - 1, inside[inside.length - 1] + 2);
    const lip = (f: (lon: number) => number, extra: number) => cols.map((lon) => maskPoint(lon, f(lon), extra));
    const depth = -0.34;
    const mid = (t: number) => (lon: number) => upperLip(lon) + (lowerLip(lon) - upperLip(lon)) * t;
    const rows = [lip(upperLip, 0), lip(upperLip, depth), lip(mid(0.5), depth - 0.06), lip(lowerLip, depth), lip(lowerLip, 0)];
    b.surface(rows, {
      closed: false,
      flat: true,
      paint: (i) => fixed(i === 0 || i === 3 ? RED_DARK : MOUTH),
      weight: (p) => W(p),
      out: (i, k) => sub(FACE_C, rows[i][k]),
    });
  }

  // Nostrils: two small dark hollows under the nose tip.
  for (const s of [-1, 1]) {
    const c = maskPoint(s * 0.075, -0.232, -0.05);
    b.surface(b.ellipsoidRows(c, [0.11, 0.07, 0.06], [0, -1, 0], [1, 0, 0], 10, 5), { paint: () => fixed(MOUTH), weight: (p) => W(p) });
  }

  // The edge: a band from the face up to the shell's edge all round (its thickness; on top, seen from above under the
  // visor, dark red so it reads as the mask's own edge rather than a gap), with a black lacquer rim rolled along it.
  const perim: [number, number][] = [
    ...upper[0],
    ...upper.slice(1).map((row) => row[K]),
    ...lower.slice(1).map((row) => row[K]),
    ...lower[RL].slice(0, K).reverse(),
    ...lower.slice(0, RL).reverse().map((row) => row[0]),
    ...upper.slice(1, RU).reverse().map((row) => row[0]),
  ];
  const outerEdge = perim.map(([lon, lat]) => maskPoint(lon, lat, 0.02));
  const innerEdge = perim.map(([lon, lat]) => facePoint(lon, lat, 0.04));
  b.surface([innerEdge, outerEdge], { closed: true, paint: (_i, k) => fixed(k < K ? RED_DARK : BLACK), weight: (p) => W(p), out: (_i, k) => sub(outerEdge[k], FACE_C) });
  b.tube([...outerEdge, outerEdge[0]], 0.1, 6, [0, 0, 1], () => fixed(BLACK), (p) => W(p), false);

  // Thin gold lines along the cheekbone ridges.
  for (const s of [-1, 1]) {
    const path = Array.from({ length: 12 }, (_, j): V3 => {
      const f = j / 11;
      const lon = CHEEK[0][0] + (CHEEK[1][0] - CHEEK[0][0]) * f, lat = CHEEK[0][1] + (CHEEK[1][1] - CHEEK[0][1]) * f;
      return maskPoint(s * lon, lat, 0.035);
    });
    b.tube(path, (j) => 0.055 * (1 - 0.4 * (j / 11)), 5, [0, 0, 1], () => fixed(GOLD), (p) => W(p));
  }

  // Teeth: a row along each lip, blunt and blocky (an oni's, not a shark's), the upper canines long pointed fangs reaching
  // over the lower lip.
  const tooth = (lon: number, lat: number, dir: number, len: number, w: number, tip: number) => {
    const c = maskPoint(lon, lat, -0.04);
    const next = maskPoint(lon, lat + dir * 0.05, -0.04);
    cone(b, c, sub(next, c), len, w, tip > 0 ? 0.15 : 0.13, [Math.cos(lon), Math.sin(lon), 0], fixed(TEETH), W, tip, tip > 0 ? 6 : 5);
  };
  // Six across the top between the fangs, six along the bottom, shoulder to shoulder.
  for (let j = 0; j < 6; j++) {
    const lon = -0.3 + (0.6 * j) / 5;
    tooth(lon, upperLip(lon) + 0.012, -1, 0.42, 0.31, 0.8);
  }
  for (const s of [-1, 1]) tooth(s * 0.44, upperLip(s * 0.44) + 0.012, -1, 1.5, 0.27, 0);
  for (let j = 0; j < 6; j++) {
    const lon = -0.31 + (0.62 * j) / 5;
    tooth(lon, lowerLip(lon) - 0.012, 1, 0.36, 0.3, 0.8);
  }

  // Tusks: from the jaw outside the corners of the grimace (clear of the teeth), out and up in front of the face to the visor's
  // lower edge, curling in a little at the tip; ivory going darker toward it, a gold collar where they leave the mask.
  for (const s of [-1, 1]) {
    const C: [number, number, number][] = [[0.72, -0.66, -0.1], [0.76, -0.54, 0.4], [0.79, -0.38, 0.85], [0.77, -0.22, 1.1], [0.71, -0.1, 1.2]];
    const path = curve(C.map(([lon, lat, o]) => maskPoint(s * lon, lat, o)), 16);
    b.tube(path, (j) => 0.5 * (1 - j / 15) ** 0.75 + 0.03, 10, [0, 0, 1], (j) => fixed(j > 10 ? TUSK_TIP : TUSK), (p) => W(p));
    const base = path[2], dir = norm(sub(path[3], path[1]));
    const [, u, v] = frame(dir, [0, 0, 1]);
    b.tube([...ring(base, u, v, 0.5, 0.5, 14), ring(base, u, v, 0.5, 0.5, 14)[0]], 0.07, 5, dir, () => fixed(GOLD), (p) => W(p), false);
  }

  const g = b.geometry();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}
