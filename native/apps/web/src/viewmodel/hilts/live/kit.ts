// Geometry kit for living hilts (v0.0.43): the pieces a design emits in the knife-local frame, mapped to the viewmodel's
// bind space and skinned to the knife's bones exactly like a knife part (knives/ctx.ts fpCtx), into two small meshes:
//
//   lit   surfaces shaded like the hands and knife (live/material.ts LIT): per vertex the albedo (partColor), a
//         material code and three local coordinates (finishUV: code, u, v, w), the piece it belongs to (accent) and a
//         second shape (position2 / normal2) the piece can morph toward (lids closing, petals opening).
//   glow  additive light (live/material.ts GLOW): soft round sprites and short glowing segments, each on a channel whose
//         intensity and tint the design sets per frame.
//
// Pieces: index 0 is the still body; a design numbers its moving pieces 1..PIECES-1 and drives each with a transform
// (knife-local, about any pivot) and a morph weight through LiveUniforms. Channels do the same for light.
// Third person never builds these (see live/index.ts).

import * as THREE from "three";
import { add, cross, dot, len, norm, scale, sub } from "../../../player/bunny/builder";
import type { V3 } from "../../../player/bunny/rig";
import { xform } from "../../../player/bunny/rig";
import { vmRig } from "../../rig";

/** Moving pieces per design (uniform array size; piece 0 = static). */
export const PIECES = 12;
/** Light channels per design. */
export const CHANNELS = 12;

/** Lit material codes (finishUV.x of a lit vertex; live/material.ts litAlbedo). */
export const MAT = {
  matte: 0,
  polished: 1,
  satin: 2,
  glossy: 3,
  eye: 4,
  runes: 5,
  emit: 6,
  wood: 7,
  flesh: 8,
  brass: 9,
  jewel: 10,
  leaf: 11,
  cracks: 12,
  scales: 13,
  iron: 14,
  petal: 15,
} as const;

export interface SurfOpts {
  /** Albedo (hex, sRGB) per grid point. */
  color: number | ((i: number, k: number) => number);
  mat: number;
  piece?: number;
  /** Three local coordinates per grid point for the material (default 0). */
  uvw?: (i: number, k: number) => V3;
  /** The second shape (same grid) this piece morphs toward. */
  morph?: V3[][];
  closed?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
  /** Outward reference per grid point (default: away from the row's centroid). */
  out?: (i: number, k: number) => V3;
  /** Bone (short name, e.g. "Bfly_Blade"); default Knife_Handle. */
  bone?: string;
  /** Faceted (flat normals per quad). */
  flat?: boolean;
}

export interface GlowOpts {
  /** Linear-ish colour (hex) and size (knife units: sprite radius, segment half width). */
  color: number;
  size: number;
  channel: number;
  bone?: string;
  /** Intensity multiplier of this sprite within its channel. */
  gain?: number;
}

/** Normals of a grid (central differences), oriented by `out` / away from each row's centroid. */
function gridNormals(rows: V3[][], closed: boolean, out?: (i: number, k: number) => V3): V3[][] {
  const R = rows.length, K = rows[0].length;
  const cen = rows.map((r) => scale(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length));
  return rows.map((r, i) =>
    r.map((p, k) => {
      const kp = closed ? (k + 1) % K : Math.min(K - 1, k + 1), km = closed ? (k - 1 + K) % K : Math.max(0, k - 1);
      const ip = Math.min(R - 1, i + 1), im = Math.max(0, i - 1);
      let n = cross(sub(r[kp], r[km]), sub(rows[ip][k], rows[im][k]));
      const ref = out ? out(i, k) : sub(p, cen[i]);
      if (len(n) < 1e-7) n = len(ref) > 1e-7 ? ref : [0, 0, 1];
      if (dot(n, ref) < 0) n = scale(n, -1);
      return norm(n);
    }),
  );
}

export class LiveKit {
  private P: number[] = [];
  private N: number[] = [];
  private P2: number[] = [];
  private N2: number[] = [];
  private C: number[] = [];
  private A: number[] = [];
  private F: number[] = [];
  private SI: number[] = [];
  // Glow
  private gP: number[] = [];
  private gB: number[] = [];
  private gC: number[] = [];
  private gK: number[] = [];
  private gCol: number[] = [];
  private gSI: number[] = [];
  private col = new THREE.Color();
  /** Named points a design exposes (knife-local): `pommel` = its lanyard ring's centre (the charm's hook). */
  readonly anchors: Record<string, V3> = {};
  private K: Float32Array;
  private kb: number;
  /** Knife-local -> bind space (the viewmodel's), or identity for measuring (tests). */
  constructor(private bind = true) {
    const r = vmRig();
    this.kb = r.bone("Knife_Handle");
    this.K = r.bind.subarray(this.kb * 12, this.kb * 12 + 12);
  }

  private bone(name?: string): number {
    if (!name) return this.kb;
    return vmRig().bone(name);
  }
  private L(p: V3): V3 {
    return this.bind ? xform(this.K, 0, p) : p;
  }
  private D(d: V3): V3 {
    if (!this.bind) return d;
    const K = this.K;
    return [K[0] * d[0] + K[1] * d[1] + K[2] * d[2], K[4] * d[0] + K[5] * d[1] + K[6] * d[2], K[8] * d[0] + K[9] * d[1] + K[10] * d[2]];
  }

  /** Triangles emitted so far (lit). */
  get tris(): number {
    return this.P.length / 9;
  }
  /** Sprites / segments emitted so far (glow). */
  get glows(): number {
    return this.gP.length / 18;
  }

  /** A smooth surface through rows of knife-local points (rows[i][k]; columns wrap when closed). */
  surface(rows: V3[][], o: SurfOpts): void {
    const closed = o.closed ?? true;
    const R = rows.length, K = rows[0].length;
    const N = gridNormals(rows, closed, o.out);
    const M = o.morph ?? rows;
    const N2 = o.morph ? gridNormals(o.morph, closed, o.out) : N;
    const piece = o.piece ?? 0, bone = this.bone(o.bone);
    const colorOf = typeof o.color === "number" ? () => o.color as number : o.color;
    const uvw = o.uvw ?? (() => [0, 0, 0] as V3);
    const vert = (i: number, k: number, n: V3, n2: V3, ck: [number, number]) => {
      const kk = k % K;
      const p = this.L(rows[i][kk]), q = this.L(M[i][kk]);
      const nn = this.D(n), nq = this.D(n2);
      this.P.push(p[0], p[1], p[2]);
      this.P2.push(q[0], q[1], q[2]);
      this.N.push(nn[0], nn[1], nn[2]);
      this.N2.push(nq[0], nq[1], nq[2]);
      this.col.set(colorOf(ck[0], ck[1]));
      this.C.push(this.col.r, this.col.g, this.col.b);
      this.A.push(piece);
      const w = uvw(i, k);
      this.F.push(o.mat, w[0], w[1], w[2]);
      this.SI.push(bone);
    };
    const kmax = closed ? K : K - 1;
    for (let i = 0; i + 1 < R; i++)
      for (let k = 0; k < kmax; k++) {
        const k1 = k + 1;
        const quad: [number, number][] = [[i, k], [i, k1], [i + 1, k1], [i + 1, k]];
        let fn: V3 | null = null, fn2: V3 | null = null;
        if (o.flat) {
          const g = (rr: V3[][], a: [number, number]) => rr[a[0]][a[1] % K];
          fn = norm(cross(sub(g(rows, quad[2]), g(rows, quad[0])), sub(g(rows, quad[3]), g(rows, quad[1]))));
          const ref = add(N[i][k], N[i + 1][k1 % K]);
          if (dot(fn, ref) < 0) fn = scale(fn, -1);
          fn2 = norm(cross(sub(g(M, quad[2]), g(M, quad[0])), sub(g(M, quad[3]), g(M, quad[1]))));
          if (dot(fn2, add(N2[i][k], N2[i + 1][k1 % K])) < 0) fn2 = scale(fn2, -1);
        }
        for (const t of [[0, 1, 2], [0, 2, 3]])
          for (const j of t) {
            const [a, b] = quad[j];
            vert(a, b, fn ?? N[a][b % K], fn2 ?? N2[a][b % K], [i, k]);
          }
      }
    const cap = (i: number, j: number) => {
      const c = scale(rows[i].reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / K);
      const c2 = scale(M[i].reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / K);
      const cj = scale(rows[j].reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / K);
      const cj2 = scale(M[j].reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / K);
      const n = norm(sub(c, cj)), n2 = norm(sub(c2, cj2));
      const w0 = uvw(i, 0);
      for (let k = 0; k < kmax; k++) {
        const pts: [V3, V3, V3][] = [[c, c2, w0], [rows[i][k], M[i][k], uvw(i, k)], [rows[i][(k + 1) % K], M[i][(k + 1) % K], uvw(i, k + 1)]];
        for (const [p0, q0, w] of pts) {
          const p = this.L(p0), q = this.L(q0), nn = this.D(n), nq = this.D(n2);
          this.P.push(p[0], p[1], p[2]);
          this.P2.push(q[0], q[1], q[2]);
          this.N.push(nn[0], nn[1], nn[2]);
          this.N2.push(nq[0], nq[1], nq[2]);
          this.col.set(colorOf(i, k));
          this.C.push(this.col.r, this.col.g, this.col.b);
          this.A.push(piece);
          this.F.push(o.mat, w[0], w[1], w[2]);
          this.SI.push(bone);
        }
      }
    };
    if (o.capStart) cap(0, 1);
    if (o.capEnd) cap(R - 1, R - 2);
  }

  /** A tube along a knife-local path. */
  tube(path: V3[], radius: number | ((i: number) => number), sides: number, ref: V3, o: SurfOpts & { morphPath?: V3[] }): void {
    const ringAt = (pts: V3[], i: number): V3[] => {
      const d = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
      let u = sub(ref, scale(d, dot(ref, d)));
      if (len(u) < 1e-4) u = sub([0, 0, 1], scale(d, d[2]));
      u = norm(u);
      const v = cross(d, u);
      const r = typeof radius === "number" ? radius : radius(i);
      return Array.from({ length: sides }, (_, k) => {
        const a = (k / sides) * Math.PI * 2;
        return add(pts[i], add(scale(u, Math.cos(a) * r), scale(v, Math.sin(a) * r)));
      });
    };
    const rows = path.map((_, i) => ringAt(path, i));
    const morph = o.morphPath ? o.morphPath.map((_, i) => ringAt(o.morphPath!, i)) : o.morph;
    this.surface(rows, { capStart: true, capEnd: true, ...o, morph });
  }

  /** An ellipsoid (rows pole to pole about `axis`). */
  ellipsoid(c: V3, r: V3, axis: V3, uRef: V3, seg: number, nrows: number, o: SurfOpts): V3[][] {
    const rows = ellipsoidRows(c, r, axis, uRef, seg, nrows);
    this.surface(rows, o);
    return rows;
  }

  /** A soft round glow sprite at a knife-local point. */
  sprite(p: V3, o: GlowOpts): void {
    this.glowQuad(p, p, o, 0);
  }
  /** A glowing segment between two knife-local points (its ends round). */
  segment(a: V3, b: V3, o: GlowOpts): void {
    this.glowQuad(a, b, o, 1);
  }
  private glowQuad(a0: V3, b0: V3, o: GlowOpts, kind: number): void {
    const a = this.L(a0), b = this.L(b0), bone = this.bone(o.bone);
    this.col.set(o.color);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [cx, cy] of corners) {
      this.gP.push(a[0], a[1], a[2]);
      this.gB.push(b[0], b[1], b[2]);
      this.gC.push(cx, cy);
      this.gK.push(o.channel, kind, o.gain ?? 1);
      this.gCol.push(this.col.r, this.col.g, this.col.b, o.size);
      this.gSI.push(bone);
    }
  }

  /** The lit geometry (null when empty). */
  litGeometry(): THREE.BufferGeometry | null {
    if (!this.P.length) return null;
    const g = new THREE.BufferGeometry();
    const n = this.P.length / 3;
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute("position2", new THREE.Float32BufferAttribute(this.P2, 3));
    g.setAttribute("normal2", new THREE.Float32BufferAttribute(this.N2, 3));
    g.setAttribute("partColor", new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute("accent", new THREE.Float32BufferAttribute(this.A, 1));
    g.setAttribute("finishUV", new THREE.Float32BufferAttribute(this.F, 4));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.SI.flatMap((b) => [b, 0, 0, 0]), 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    return g;
  }

  /** The glow geometry (null when empty). Positions are the segment's start (a sprite's centre), `pb` its end. */
  glowGeometry(): THREE.BufferGeometry | null {
    if (!this.gP.length) return null;
    const g = new THREE.BufferGeometry();
    const n = this.gP.length / 3;
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.gP, 3));
    g.setAttribute("pb", new THREE.Float32BufferAttribute(this.gB, 3));
    g.setAttribute("gc", new THREE.Float32BufferAttribute(this.gC, 2));
    g.setAttribute("gk", new THREE.Float32BufferAttribute(this.gK, 3));
    g.setAttribute("gcol", new THREE.Float32BufferAttribute(this.gCol, 4));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.gSI.flatMap((b) => [b, 0, 0, 0]), 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    return g;
  }

  /** Knife-local -> bind (for moving glow segments a design rewrites per frame). */
  toBind(p: V3): V3 {
    return this.L(p);
  }
}

/** Rows of an ellipsoid about `axis` from its + pole to its - pole (polar angles a0..a1). */
export function ellipsoidRows(c: V3, r: V3, axis: V3, uRef: V3, seg: number, nrows: number, a0 = 0, a1 = Math.PI): V3[][] {
  const t = norm(axis);
  let u = sub(uRef, scale(t, dot(uRef, t)));
  u = norm(len(u) < 1e-4 ? [1, 0, 0] : u);
  const v = cross(t, u);
  const out: V3[][] = [];
  for (let i = 0; i <= nrows; i++) {
    const a = a0 + ((a1 - a0) * i) / nrows;
    const row: V3[] = [];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const d = add(add(scale(t, Math.cos(a) * r[2]), scale(u, Math.sin(a) * Math.cos(th) * r[0])), scale(v, Math.sin(a) * Math.sin(th) * r[1]));
      row.push(add(c, d));
    }
    out.push(row);
  }
  return out;
}

/** A superellipse ring (rounded rectangle for e > 2) of n points about c in the plane (u, v). */
export function sring(c: V3, u: V3, v: V3, ru: number, rv: number, n: number, e = 2, phase = 0): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    out.push(add(c, add(scale(u, Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e) * ru), scale(v, Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e) * rv))));
  }
  return out;
}
