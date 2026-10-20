// Skinned-surface builder for the bunny (mesh.ts): smooth-shaded lofts through rings of points, flat caps, up to four
// bone weights per vertex, a paint per face. Emits one non-indexed BufferGeometry with the attributes the player
// materials read (player/materials.ts):
//   partColor vec3   fixed colour (linear), used when accent == 0
//   accent    float  -1 = spinning propeller (partColor), 0 = partColor, 1 = style accent, 2 = accent + glow, 3 + k = colourway palette slot k,
//                    -2 capybara body, -3 eyes, -4 mouth (partColor, movement reactions);
//                    12..15 hat crystal (player/hat-fx.ts: partColor, moving / lit), >= 16 glove faces
//   skinIndex / skinWeight (4 influences)
//   finishUV  vec4   only when a section set `finish` (knife blades, viewmodel/knives/): x along the blade 0 (guard)
//                    .. 1 (tip), y across it -1..1, z part id (viewmodel/knives/types.ts PART: 0 none, 1 blade, 2 guard,
//                    3 grip, 4 glove shell, 5 cuff), w edge / tip weight 0..1 (wear mask). (0, 0, 0, 0) elsewhere.

import * as THREE from "three";
import type { V3 } from "./rig";

/** Weights: [bone, weight] pairs (normalised and truncated to the 4 largest on emit). */
export type Wt = [number, number][];
/** Paint: accent code (see header) and a fixed colour for code 0. */
export type Paint = { code: number; color?: number };

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Blend between bone a (t = 0) and b (t = 1). */
export const blend = (a: number, b: number, t: number): Wt => (t <= 0.001 ? [[a, 1]] : t >= 0.999 ? [[b, 1]] : [[a, 1 - t], [b, t]]);

/** Piecewise-linear "hat" weights over control points [value, bone] (sorted by value). */
export function hat(x: number, ctl: [number, number][]): Wt {
  if (x <= ctl[0][0]) return [[ctl[0][1], 1]];
  for (let i = 0; i + 1 < ctl.length; i++) {
    const [x0, b0] = ctl[i];
    const [x1, b1] = ctl[i + 1];
    if (x <= x1) return blend(b0, b1, (x - x0) / (x1 - x0));
  }
  return [[ctl[ctl.length - 1][1], 1]];
}

/** Mixes weight sets: sum of w_i * set_i. */
export function mixW(...sets: [Wt, number][]): Wt {
  const m = new Map<number, number>();
  for (const [s, k] of sets) if (k > 0) for (const [b, w] of s) m.set(b, (m.get(b) ?? 0) + w * k);
  return [...m];
}

/** Orthonormal frame around a direction: [t, u, v] with u closest to `ref`. */
export function frame(t: V3, ref: V3): [V3, V3, V3] {
  t = norm(t);
  let u = sub(ref, scale(t, dot(ref, t)));
  if (len(u) < 1e-4) u = sub([0, 0, 1], scale(t, t[2]));
  u = norm(u);
  return [t, u, cross(t, u)];
}

/** Ring of n points around c in the plane (u, v): superellipse |x/ru|^e + |y/rv|^e = 1. */
export function ring(c: V3, u: V3, v: V3, ru: number, rv: number, n: number, e = 2, phase = 0): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e) * ru;
    const y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e) * rv;
    out.push(add(c, add(scale(u, x), scale(v, y))));
  }
  return out;
}

/** Catmull-Rom through samples ys at uniform spacing, evaluated at fractional index f. */
export function cr(ys: number[], f: number): number {
  const i = clamp(Math.floor(f), 0, ys.length - 2);
  const t = f - i;
  const p0 = ys[Math.max(0, i - 1)], p1 = ys[i], p2 = ys[i + 1], p3 = ys[Math.min(ys.length - 1, i + 2)];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

export class Builder {
  private P: number[] = [];
  private N: number[] = [];
  private C: number[] = [];
  private A: number[] = [];
  private SI: number[] = [];
  private SW: number[] = [];
  private F: number[] = [];
  private hasF = false;
  private col = new THREE.Color();
  /** finishUV for the vertices emitted while set (from the bind-pose position; see the header). null = zeros. */
  finish: ((p: V3) => readonly [number, number, number, number]) | null = null;

  private vert(p: V3, n: V3, paint: Paint, w: Wt): void {
    this.P.push(p[0], p[1], p[2]);
    this.N.push(n[0], n[1], n[2]);
    this.col.set(paint.color ?? 0xffffff);
    this.C.push(this.col.r, this.col.g, this.col.b);
    this.A.push(paint.code);
    if (this.finish) {
      const f = this.finish(p);
      this.F.push(f[0], f[1], f[2], f[3]);
      this.hasF = true;
    } else this.F.push(0, 0, 0, 0);
    const ws = w.filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ws.reduce((s, [, x]) => s + x, 0) || 1;
    for (let k = 0; k < 4; k++) {
      this.SI.push(ws[k] ? ws[k][0] : 0);
      this.SW.push(ws[k] ? ws[k][1] / sum : 0);
    }
  }

  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, paint: Paint, wa: Wt, wb: Wt, wc: Wt): void {
    const fn = cross(sub(b, a), sub(c, a));
    if (len(fn) < 1e-7) return;
    // Wind counter-clockwise as seen from the side the (averaged) normal points to.
    if (dot(fn, add(add(na, nb), nc)) < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
      [wb, wc] = [wc, wb];
    }
    this.vert(a, na, paint, wa);
    this.vert(b, nb, paint, wb);
    this.vert(c, nc, paint, wc);
  }

  /**
   * Smooth surface through rows of points (rows[i][k]); columns wrap when `closed`. Normals are the grid's central
   * differences, oriented away from each row's centroid (or along `out(i, k)` when given). paint / weights per face /
   * vertex. Optional flat caps at the first / last row.
   */
  surface(
    rows: V3[][],
    o: {
      closed?: boolean;
      paint: (i: number, k: number) => Paint;
      weight: (p: V3, i: number, k: number) => Wt;
      capStart?: Paint | null;
      capEnd?: Paint | null;
      out?: (i: number, k: number) => V3;
      flat?: boolean;
    },
  ): void {
    const R = rows.length;
    const K = rows[0].length;
    const closed = o.closed ?? true;
    const cen = rows.map((r) => scale(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length));
    const W = rows.map((r, i) => r.map((p, k) => o.weight(p, i, k)));
    const N: V3[][] = rows.map((r, i) =>
      r.map((p, k) => {
        const kp = closed ? (k + 1) % K : Math.min(K - 1, k + 1);
        const km = closed ? (k - 1 + K) % K : Math.max(0, k - 1);
        const ip = Math.min(R - 1, i + 1);
        const im = Math.max(0, i - 1);
        let n = cross(sub(r[kp], r[km]), sub(rows[ip][k], rows[im][k]));
        const ref = o.out ? o.out(i, k) : sub(p, cen[i]);
        if (len(n) < 1e-6) n = ref; // poles
        if (dot(n, ref) < 0) n = scale(n, -1);
        return norm(n);
      }),
    );
    const kmax = closed ? K : K - 1;
    for (let i = 0; i + 1 < R; i++) {
      for (let k = 0; k < kmax; k++) {
        const k1 = (k + 1) % K;
        const a = rows[i][k], b = rows[i][k1], c = rows[i + 1][k1], d = rows[i + 1][k];
        let na = N[i][k], nb = N[i][k1], nc = N[i + 1][k1], nd = N[i + 1][k];
        if (o.flat) {
          let fn = norm(cross(sub(c, a), sub(d, b)));
          if (dot(fn, add(add(na, nb), add(nc, nd))) < 0) fn = scale(fn, -1);
          na = nb = nc = nd = fn;
        }
        const p = o.paint(i, k);
        this.tri(a, b, c, na, nb, nc, p, W[i][k], W[i][k1], W[i + 1][k1]);
        this.tri(a, c, d, na, nc, nd, p, W[i][k], W[i + 1][k1], W[i + 1][k]);
      }
    }
    const cap = (i: number, j: number, paint: Paint) => {
      const c = cen[i];
      const n = norm(sub(cen[i], cen[j]));
      const wc = o.weight(c, i, 0);
      for (let k = 0; k < K; k++) {
        const k1 = (k + 1) % K;
        if (!closed && k1 === 0) break;
        this.tri(c, rows[i][k], rows[i][k1], n, n, n, paint, wc, W[i][k], W[i][k1]);
      }
    };
    if (o.capStart) cap(0, 1, o.capStart);
    if (o.capEnd) cap(R - 1, R - 2, o.capEnd);
  }

  /** Ellipsoid as a surface around `axis` (rows from +axis pole to -axis pole), polar angles aMin..aMax. */
  ellipsoidRows(c: V3, r: V3, axis: V3, uRef: V3, seg: number, rows: number, aMin = 0, aMax = Math.PI): V3[][] {
    const [t, u, v] = frame(axis, uRef);
    const out: V3[][] = [];
    for (let i = 0; i <= rows; i++) {
      const a = aMin + ((aMax - aMin) * i) / rows;
      const row: V3[] = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        const d = add(add(scale(t, Math.cos(a)), scale(u, Math.sin(a) * Math.cos(th))), scale(v, Math.sin(a) * Math.sin(th)));
        row.push([c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]]);
      }
      out.push(row);
    }
    return out;
  }

  /** Tube along an open polyline (rings perpendicular to the path, closed ends). */
  tube(path: V3[], radius: number | ((i: number) => number), sides: number, ref: V3, paint: (i: number) => Paint, weight: (p: V3, i: number) => Wt, caps = true): void {
    const rows = path.map((p, i) => {
      const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
      const [, u, v] = frame(d, ref);
      const r = typeof radius === "number" ? radius : radius(i);
      return ring(p, u, v, r, r, sides);
    });
    this.surface(rows, { paint: (i) => paint(i), weight: (p, i) => weight(p, i), capStart: caps ? paint(0) : null, capEnd: caps ? paint(path.length - 2) : null });
  }

  /** Uniformly resize a newly emitted section around a bind-space anchor. */
  scaleSection(firstVertex: number, origin: V3, factor: number): void {
    for (let i = firstVertex * 3; i < this.P.length; i += 3)
      for (let k = 0; k < 3; k++) this.P[i + k] = origin[k] + (this.P[i + k] - origin[k]) * factor;
    // Uniform positive scaling preserves normals and bone weights.
  }

  get vertexCount(): number {
    return this.P.length / 3;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute("partColor", new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute("accent", new THREE.Float32BufferAttribute(this.A, 1));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.SW, 4));
    if (this.hasF) g.setAttribute("finishUV", new THREE.Float32BufferAttribute(this.F, 4));
    g.computeBoundingBox();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 38), 56);
    return g;
  }
}
