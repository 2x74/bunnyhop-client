// Hard-surface helpers for the gun builders (guns/models/*): soft-edged extrusions of side profiles, lathed tubes and
// rods, all through a KnifeCtx (knives/ctx.ts), so they land in the same Builder geometry as the hands (one draw call)
// with the player materials' paint codes, skin weights and finishUV. Every edge is rounded a little (bevel rows /
// rounded profile corners) and shaded smooth, which gives the knives' chunky hand-made toy look rather than CAD.
//
// Gun-local frame (types.ts): x forward, y left, z up. Profiles are side views in (x, z), extruded across y.

import { add, scale, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import type { KnifeCtx } from "../knives/ctx";
import { PART } from "../knives/types";

export type P2 = [number, number];
type PartId = (typeof PART)[keyof typeof PART];

export interface ShapeOpts {
  paint: Paint | ((i: number, k: number) => Paint);
  /** Bone (gun part) in first person: "Gun" (default), "Slide", "Mag", "Pump", "Aux". */
  bone?: string;
  part?: PartId;
  /** Paint of the end caps (default: the paint's first face). */
  cap?: Paint;
}

const paintFn = (p: ShapeOpts["paint"]) => (typeof p === "function" ? p : () => p);
/** Bone name in the rig ("Gun" -> "v_weapon.Gun"); undefined for the gun body. */
export const boneOf = (b?: string) => (b && b !== "Gun" ? `Gun_${b}` : "Gun_Body");

/** Rounds the corners of a closed polygon (x, z): each corner becomes an arc of `seg` + 1 points with radius r. */
export function roundPoly(pts: P2[], r: number | number[] = 0.12, seg = 2): P2[] {
  const out: P2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const rr = typeof r === "number" ? r : r[i] ?? 0.12;
    const da = [a[0] - p[0], a[1] - p[1]], db = [b[0] - p[0], b[1] - p[1]];
    const la = Math.hypot(da[0], da[1]), lb = Math.hypot(db[0], db[1]);
    if (rr <= 0 || la < 1e-6 || lb < 1e-6) {
      out.push(p);
      continue;
    }
    const k = Math.min(rr, la * 0.45, lb * 0.45);
    const p0: P2 = [p[0] + (da[0] / la) * k, p[1] + (da[1] / la) * k];
    const p1: P2 = [p[0] + (db[0] / lb) * k, p[1] + (db[1] / lb) * k];
    // Quadratic Bezier through the corner (close enough to an arc, never overshoots the polygon).
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * p[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * p[1] + t * t * p1[1]]);
    }
  }
  return out;
}

/** Splits the edges of a closed polygon so none is longer than `max`. */
export function densify(pts: P2[], max: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / max));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Moves each point of a closed polygon toward the inside by d (along its vertex normal). */
function inset(pts: P2[], d: number): P2[] {
  const n = pts.length;
  // Orientation: positive area = counter-clockwise.
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const s = area > 0 ? 1 : -1;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const t = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(t[0], t[1]) || 1;
    // Inward normal of a CCW polygon is (-ty, tx).
    return [p[0] - (t[1] / l) * d * s, p[1] + (t[0] / l) * d * s] as P2;
  });
}

function bounds(pts: P2[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (z0 = Math.min(z0, z)), (z1 = Math.max(z1, z));
  return { x0, x1, z0, z1 };
}

/**
 * A side profile (x, z; star-shaped from its centroid, corners already rounded or rounded here with `round`) extruded
 * across y from y0 to y1, its edges bevelled by `bevel`. Returns nothing; emits through k.
 */
export function slab(k: KnifeCtx, prof: P2[], y0: number, y1: number, o: ShapeOpts & { bevel?: number; round?: number; seg?: number }): void {
  const rounded = o.round === 0 ? prof : roundPoly(prof, o.round ?? 0.1, k.view === "fp" ? (o.seg ?? 2) : 1);
  // First person: no straight edge of a grip longer than ~0.35 units (0.6 on other big parts), so the grip solver and
  // the audits (which test fingers against the mesh's vertices) see every face a finger can rest on. Third person keeps
  // the bare outline.
  const bb = bounds(rounded);
  const big = Math.hypot(bb.x1 - bb.x0, bb.z1 - bb.z0) > 2.5;
  const pts = k.view === "fp" && (o.part === PART.grip || big) ? densify(rounded, o.part === PART.grip ? 0.35 : 0.6) : rounded;
  const bev = Math.min(o.bevel ?? 0.07, (y1 - y0) * 0.3);
  const inner = inset(pts, bev * 0.8);
  const row = (p: P2[], y: number): V3[] => p.map(([x, z]) => [x, y, z]);
  const rows = [row(inner, y0), row(pts, y0 + bev), row(pts, y1 - bev), row(inner, y1)];
  const b = bounds(pts);
  const paint = paintFn(o.paint);
  const part = o.part ?? PART.none;
  const zm = (b.z0 + b.z1) / 2, zh = Math.max(1e-3, (b.z1 - b.z0) / 2);
  k.surface(rows, {
    paint: (i, kk) => paint(i, kk),
    bone: boneOf(o.bone),
    part,
    fin: part === PART.blade || part === PART.grip ? (i, kk) => [(rows[i][kk][0] - b.x0) / Math.max(1e-3, b.x1 - b.x0), (rows[i][kk][2] - zm) / zh, 0] : undefined,
    capStart: o.cap ?? paint(0, 0),
    capEnd: o.cap ?? paint(0, 0),
  });
}

/** A box (centre, half sizes along x, y, z) with rounded edges: a slab of a rounded rectangle. */
export function box(k: KnifeCtx, c: V3, h: V3, o: ShapeOpts & { bevel?: number; round?: number }): void {
  const prof: P2[] = [
    [c[0] - h[0], c[2] - h[2]],
    [c[0] + h[0], c[2] - h[2]],
    [c[0] + h[0], c[2] + h[2]],
    [c[0] - h[0], c[2] + h[2]],
  ];
  slab(k, prof, c[1] - h[1], c[1] + h[1], { ...o, round: o.round ?? Math.min(0.12, h[0] * 0.4, h[2] * 0.4) });
}

/**
 * A lathed tube along the x axis (rows at [x, radius]), centred at (y, z) = `c`, `sides` around; `e` > 2 squares the
 * section off (superellipse), `ry` / `rz` stretch it. Caps unless the radius at an end is 0.
 */
export function lathe(k: KnifeCtx, xr: [number, number][], o: ShapeOpts & { c?: [number, number]; sides?: number; e?: number; ry?: number; rz?: number; phase?: number; capStart?: boolean; capEnd?: boolean }): void {
  const sides = k.view === "fp" ? (o.sides ?? 12) : Math.max(6, Math.round((o.sides ?? 12) * 0.6));
  const [cy, cz] = o.c ?? [0, 0];
  const e = o.e ?? 2, ry = o.ry ?? 1, rz = o.rz ?? 1;
  const rows: V3[][] = xr.map(([x, r]) => {
    const row: V3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (o.phase ?? 0) + (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const u = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e), v = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e);
      row.push([x, cy + u * r * ry, cz + v * r * rz]);
    }
    return row;
  });
  const paint = paintFn(o.paint);
  const part = o.part ?? PART.none;
  const x0 = xr[0][0], x1 = xr[xr.length - 1][0];
  k.surface(rows, {
    paint: (i, kk) => paint(i, kk),
    bone: boneOf(o.bone),
    part,
    fin: part === PART.blade ? (i, kk) => [(rows[i][kk][0] - x0) / Math.max(1e-3, x1 - x0), Math.cos((kk / sides) * Math.PI * 2), 0] : undefined,
    capStart: o.capStart === false || xr[0][1] < 1e-4 ? null : (o.cap ?? paint(0, 0)),
    capEnd: o.capEnd === false || xr[xr.length - 1][1] < 1e-4 ? null : (o.cap ?? paint(xr.length - 2, 0)),
  });
}

/** A rod between two gun-local points (round, `sides` around), capped. */
export function rod(k: KnifeCtx, a: V3, b: V3, r: number, o: ShapeOpts & { sides?: number }): void {
  const paint = paintFn(o.paint);
  k.tube([a, b], r, k.view === "fp" ? (o.sides ?? 8) : 6, Math.abs(b[2] - a[2]) > Math.abs(b[0] - a[0]) ? [1, 0, 0] : [0, 0, 1], (i) => paint(i, 0), { bone: boneOf(o.bone), part: o.part });
}

/** A rounded loop (trigger guard, sling loop) through gun-local points in the x-z plane at y = 0, tube radius r. */
export function guard(k: KnifeCtx, pts: P2[], r: number, o: ShapeOpts & { open?: boolean; y?: number }): void {
  const y = o.y ?? 0;
  const path = roundPoly(pts, 0.25, k.view === "fp" ? 3 : 1);
  const paint = paintFn(o.paint);
  if (o.open) {
    k.tube(
      path.map(([x, z]) => [x, y, z] as V3),
      r,
      k.view === "fp" ? 7 : 5,
      [0, 1, 0],
      (i) => paint(i, 0),
      { bone: boneOf(o.bone), part: o.part },
    );
    return;
  }
  k.loop(
    path.map(([x, z]) => [x, y, z] as V3),
    r,
    k.view === "fp" ? 7 : 5,
    [0, 1, 0],
    (i) => paint(i, 0),
    { bone: boneOf(o.bone), part: o.part },
  );
}

/** A small hemispherical dome (sights, buttons, the Cottontail's tail) at `c` facing `n`. */
export function dome(k: KnifeCtx, c: V3, n: V3, r: number, o: ShapeOpts & { h?: number; sides?: number }): void {
  const sides = k.view === "fp" ? (o.sides ?? 10) : 6;
  const rings = k.view === "fp" ? 4 : 2;
  const nn = scale(n, 1 / (Math.hypot(n[0], n[1], n[2]) || 1));
  const ref: V3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  // u, v ⟂ n
  const u0 = add(ref, scale(nn, -(ref[0] * nn[0] + ref[1] * nn[1] + ref[2] * nn[2])));
  const ul = Math.hypot(u0[0], u0[1], u0[2]);
  const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  const v: V3 = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
  const h = o.h ?? r;
  const rows: V3[][] = [];
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2);
    const rr = Math.cos(a) * r, z = Math.sin(a) * h;
    const row: V3[] = [];
    for (let s = 0; s < sides; s++) {
      const t = (s / sides) * Math.PI * 2;
      row.push(add(add(c, scale(nn, z)), add(scale(u, Math.cos(t) * Math.max(rr, 1e-3)), scale(v, Math.sin(t) * Math.max(rr, 1e-3)))));
    }
    rows.push(row);
  }
  const paint = paintFn(o.paint);
  k.surface(rows, { paint: (i, kk) => paint(i, kk), bone: boneOf(o.bone), part: o.part, capStart: o.cap ?? paint(0, 0), capEnd: null });
}

/** A ball (a squashed sphere) at c with radii r (x, y, z). */
export function ball(k: KnifeCtx, c: V3, r: V3, o: ShapeOpts & { sides?: number }): void {
  const sides = k.view === "fp" ? (o.sides ?? 10) : 6;
  const rings = k.view === "fp" ? 6 : 4;
  const rows: V3[][] = [];
  for (let i = 1; i < rings; i++) {
    const a = (i / rings) * Math.PI;
    const row: V3[] = [];
    for (let s = 0; s < sides; s++) {
      const t = (s / sides) * Math.PI * 2;
      row.push([c[0] + Math.cos(a) * r[0], c[1] + Math.sin(a) * Math.cos(t) * r[1], c[2] + Math.sin(a) * Math.sin(t) * r[2]]);
    }
    rows.push(row);
  }
  const paint = paintFn(o.paint);
  // Pole caps: the first / last ring closed with a fan (Builder caps), pushed out a little toward the poles.
  k.surface(rows, { paint: (i, kk) => paint(i, kk), bone: boneOf(o.bone), part: o.part, capStart: o.cap ?? paint(0, 0), capEnd: o.cap ?? paint(0, 0) });
}
