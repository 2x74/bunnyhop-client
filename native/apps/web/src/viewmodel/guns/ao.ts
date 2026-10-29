// Soft ambient occlusion baked into a gun's vertex colours (partColor) once, at build: recesses and inner corners
// (under a slide's overhang, round a trigger guard, where a plate or a sight meets the face it sits on, a stock's
// joint) darken a little, so the construction reads at first-person distance on every look, Potato and third person
// included, for no runtime cost.
//
// Estimate per vertex: the gun's triangles (as area-weighted centroids) within the radius that lie above the vertex's
// tangent plane, each counted by roughly the solid angle it covers (area / distance², capped) times how far above the
// plane it is; saturated with 1 - exp(-k·occ). Only surfaces that face each other count, so flat faces and convex
// edges stay untouched. Hands (other bones) neither receive nor cast. Occluders are bucketed in a sorted cell grid over
// typed arrays (built once per gun + glove, with the geometry).

import type * as THREE from "three";

/** Search radius in gun-local units (scaled with the model: the bunny's gun is built at GunDef.tp.s). */
const BASE_RADIUS = 0.6;
/** How strongly the occlusion darkens (colour * (1 - STRENGTH * ao)). */
const STRENGTH = 0.55;

/**
 * Bakes AO into `g`'s partColor for the vertices `isGun(i)` accepts (all when omitted), `scale`: model units per
 * gun-local unit. Non-indexed Builder geometry.
 */
export function bakeGunAO(g: THREE.BufferGeometry, isGun: (vertex: number) => boolean = () => true, scale = 1): void {
  const Pa = g.getAttribute("position"), Na = g.getAttribute("normal"), Ca = g.getAttribute("partColor");
  if (!Pa || !Na || !Ca) return;
  const P = Pa.array as Float32Array, N = Na.array as Float32Array, C = Ca.array as Float32Array;
  const R = BASE_RADIUS * scale, r2 = R * R, eps = 0.004 * scale * scale;
  const nv = Pa.count, nt = Math.floor(nv / 3);
  // Which triangles are the gun's (a triangle is all one part).
  const gun = new Uint8Array(nt);
  let m = 0;
  for (let t = 0; t < nt; t++) if (isGun(t * 3)) (gun[t] = 1), m++;
  const cellOf = (x: number, y: number, z: number) => ((Math.floor(x / R) + 512) * 1024 + (Math.floor(y / R) + 512)) * 1024 + (Math.floor(z / R) + 512);
  // Occluders: gun triangles' centroids and areas.
  const cx = new Float32Array(m), cy = new Float32Array(m), cz = new Float32Array(m), ar = new Float32Array(m), cc = new Float64Array(m);
  let n = 0;
  for (let t = 0; t < nt; t++) {
    if (!gun[t]) continue;
    const a = t * 9;
    const ux = P[a + 3] - P[a], uy = P[a + 4] - P[a + 1], uz = P[a + 5] - P[a + 2];
    const vx = P[a + 6] - P[a], vy = P[a + 7] - P[a + 1], vz = P[a + 8] - P[a + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area < 1e-7) continue;
    cx[n] = P[a] + (ux + vx) / 3;
    cy[n] = P[a + 1] + (uy + vy) / 3;
    cz[n] = P[a + 2] + (uz + vz) / 3;
    ar[n] = area;
    cc[n] = cellOf(cx[n], cy[n], cz[n]);
    n++;
  }
  // Sorted by cell: each cell's occluders are one contiguous run [start, end).
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => cc[a] - cc[b]);
  const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), sa = new Float32Array(n);
  const start = new Map<number, number>(), end = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = order[i], c = cc[o];
    (sx[i] = cx[o]), (sy[i] = cy[o]), (sz[i] = cz[o]), (sa[i] = ar[o]);
    if (!start.has(c)) start.set(c, i);
    end.set(c, i + 1);
  }
  // Per vertex (vertices repeat per triangle: the last result is reused while the position and normal repeat).
  let lx = NaN, ly = NaN, lz = NaN, lnx = NaN, lny = NaN, lnz = NaN, lao = 0;
  for (let v = 0; v < nv; v++) {
    if (!gun[(v / 3) | 0]) continue;
    const o3 = v * 3;
    const px = P[o3], py = P[o3 + 1], pz = P[o3 + 2], nx = N[o3], ny = N[o3 + 1], nz = N[o3 + 2];
    let ao = lao;
    if (px !== lx || py !== ly || pz !== lz || nx !== lnx || ny !== lny || nz !== lnz) {
      const gx = Math.floor(px / R) + 512, gy = Math.floor(py / R) + 512, gz = Math.floor(pz / R) + 512;
      let occ = 0;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const c = ((gx + i) * 1024 + (gy + j)) * 1024 + (gz + k);
            const s = start.get(c);
            if (s === undefined) continue;
            const e = end.get(c)!;
            for (let q = s; q < e; q++) {
              const dx = sx[q] - px, dy = sy[q] - py, dz = sz[q] - pz;
              const hd = dx * nx + dy * ny + dz * nz;
              if (hd <= 0) continue;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > r2 || d2 < 1e-6) continue;
              const d = Math.sqrt(d2);
              const h = hd / d;
              if (h < 0.15) continue;
              const w = sa[q] / (d2 + eps);
              occ += (w < 1 ? w : 1) * h * (1 - d / R);
            }
          }
      ao = 1 - Math.exp(-occ * 0.35);
      (lx = px), (ly = py), (lz = pz), (lnx = nx), (lny = ny), (lnz = nz), (lao = ao);
    }
    if (ao > 0.003) {
      const k = 1 - STRENGTH * ao;
      C[o3] *= k;
      C[o3 + 1] *= k;
      C[o3 + 2] *= k;
    }
  }
  Ca.needsUpdate = true;
}
