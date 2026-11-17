// The charms' modelling kit (v0.0.43): what every charm in set/ is made with, so the fourteen read as one hand's work.
// Charm-local space: x the viewer's right, y away from the viewer (the face looks along -y), z up; a charm hangs below
// its bail, built around z -1.2 and lifted so its `top` meets the bail's cap (meshes.ts).
//
//   ball     an ellipsoid or a rounded box (superellipsoid), optionally shaped by a warp; returns its Solid
//   turned   a body of revolution through a smoothed profile (rims, rolled lips, shoulders); returns its Solid
//   plate    a thick flat shape with rounded edges: a metal rim round a domed enamel face (star, heart, clover)
//   sweep    a section carried along a path, growing and shrinking (a crescent, a tail, a leaf)
//   decal    a flat shape laid on a Solid's surface, following its curve (eyes, cheeks, spots, a visor): crisp edges
//            where painting the surface's own faces would stair-step
//   line     a thin raised stroke on a Solid (a smile, a closed eye)
//   rimOn    a raised cord round a decal's edge (the hood's opening)
//
// A Solid answers "inside?" and "normal at" so decals can find the surface by bisection along their projection.
// Paints are a fixed colour with a knife hardware material (finishes/detail.ts KMAT): enamel = lacquer, brass =
// polished, brushed metal = satin, soft vinyl / plant = veg, cord and felt = grip.

import { Builder, add, cross, dot, frame, len, norm, scale, sub, type Paint, type Wt } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { KMAT } from "../knives/types";

/** Bones of a charm's skeleton (rig.ts). */
export const CB = { mount: 0, cord1: 1, cord2: 2, body: 3, part: 4, link: 5 } as const;
export const CHARM_BONES = 6;

export const P = (color: number, mat: number = KMAT.lacquer): Paint => ({ code: 0, color, mat });
/** The set's shared paints: brass hardware, ink for faces, a glint. */
export const BRASS = P(0xe6b24a, KMAT.polished), BRASS_DARK = P(0x9a6a22, KMAT.polished), BRASS_SATIN = P(0xd9a742, KMAT.satin);
export const INK = P(0x17181c), WHITE = P(0xf6f2ea), GLINT = P(0xffffff), BLUSH = P(0xf29aa6);
/** The colourway's accent, the accent lit from inside, the hoodie, the face (accent codes: player/bunny/builder.ts). */
export const ACCENT: Paint = { code: 1, mat: KMAT.lacquer };
export const ACCENT_GLOW: Paint = { code: 2 };
export const HOODIE: Paint = { code: 3, mat: KMAT.lacquer };
export const FACE: Paint = { code: 8, mat: KMAT.lacquer };

/** A closed shape decals can be laid on. */
export interface Solid {
  inside(p: V3): boolean;
  normal(p: V3): V3;
}

type PaintAt = Paint | ((p: V3, i: number, k: number) => Paint);
const paintFn = (p: PaintAt): ((p: V3, i: number, k: number) => Paint) => (typeof p === "function" ? p : () => p);

export interface BallOpts {
  paint: PaintAt;
  bone?: number;
  /** Polar axis and the direction the first meridian faces. */
  axis?: V3;
  uRef?: V3;
  seg?: number;
  rows?: number;
  /** Roundness of the section across the axis and of the profile along it: 2 = an ellipsoid, 4+ = a rounded box. */
  e?: number;
  ez?: number;
  /** Shapes the finished surface (charm-local point in, point out); the Solid returned is still the plain shape. */
  warp?: (p: V3) => V3;
  /** No surface, the Solid only (a plain stand-in for a warped ball, for its decals). */
  ghost?: boolean;
}

export class CharmCtx {
  /** Added to every point the charm's builder emits (meshes.ts: its top up to the bail). */
  o: V3 = [0, 0, 0];
  constructor(readonly b: Builder) {}
  w(bone: number): Wt {
    return [[bone, 1]];
  }

  // -------------------------------------------------------------------------------------------
  // Solids

  /** An ellipsoid (or rounded box: e / ez above 2) about `c`, radii [across u, across v, along the axis]. */
  ball(c: V3, r: V3, o: BallOpts): Solid {
    const axis = norm(o.axis ?? [0, 0, 1]);
    const [t, u, v] = frame(axis, o.uRef ?? (Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]));
    const seg = o.seg ?? 20, rows = o.rows ?? 12, e = o.e ?? 2, ez = o.ez ?? 2;
    const pw = (x: number, q: number) => Math.sign(x) * Math.pow(Math.abs(x), 2 / q);
    const grid: V3[][] = [];
    for (let i = 0; i <= rows; i++) {
      const a = Math.max(0.02, Math.min(Math.PI - 0.02, (Math.PI * i) / rows));
      const ca = pw(Math.cos(a), ez), sa = pw(Math.sin(a), ez);
      grid.push(
        Array.from({ length: seg }, (_, k) => {
          const th = (k / seg) * Math.PI * 2;
          let p = add(c, add(add(scale(t, ca * r[2]), scale(u, sa * pw(Math.cos(th), e) * r[0])), scale(v, sa * pw(Math.sin(th), e) * r[1])));
          if (o.warp) p = o.warp(p);
          return p;
        }),
      );
    }
    if (!o.ghost) this.emit(grid, o.paint, o.bone ?? CB.body, true, true);
    const local = (p: V3): V3 => {
      const d = sub(p, c);
      return [dot(d, u) / r[0], dot(d, v) / r[1], dot(d, t) / r[2]];
    };
    const f = (q: V3) => Math.pow(Math.pow(Math.abs(q[0]), e) + Math.pow(Math.abs(q[1]), e), ez / e) + Math.pow(Math.abs(q[2]), ez);
    return {
      inside: (p) => f(local(p)) < 1,
      normal: (p) => {
        // The gradient of the implicit, by differences (the exponents make the closed form fiddly).
        const h = 1e-3, q = local(p), f0 = f(q);
        const g: V3 = [(f([q[0] + h, q[1], q[2]]) - f0) / r[0], (f([q[0], q[1] + h, q[2]]) - f0) / r[1], (f([q[0], q[1], q[2] + h]) - f0) / r[2]];
        return norm(add(add(scale(u, g[0]), scale(v, g[1])), scale(t, g[2])));
      },
    };
  }

  /**
   * A body of revolution about z at `c`: `prof` control points [radius, z] from the top down, smoothed (Catmull-Rom,
   * `sub` points per span; a doubled control point keeps a crease), `squash` scales x / y (an oval section).
   */
  turned(prof: [number, number][], o: { paint: PaintAt; bone?: number; seg?: number; sub?: number; c?: V3; squash?: [number, number]; wobble?: (th: number, z: number) => number; capTop?: boolean; capBottom?: boolean }): Solid {
    const c = o.c ?? [0, 0, 0], seg = o.seg ?? 20, sq = o.squash ?? [1, 1];
    const pts = smooth(prof, o.sub ?? 3);
    const grid = pts.map(([r, z]) =>
      Array.from({ length: seg }, (_, k) => {
        const th = (k / seg) * Math.PI * 2;
        const rr = Math.max(0.003, r * (o.wobble ? o.wobble(th, z) : 1));
        return [c[0] + Math.cos(th) * rr * sq[0], c[1] + Math.sin(th) * rr * sq[1], c[2] + z] as V3;
      }),
    );
    this.emit(grid, o.paint, o.bone ?? CB.body, o.capTop ?? pts[0][0] > 0.01, o.capBottom ?? pts[pts.length - 1][0] > 0.01);
    // (Outermost radius at a height: a profile that folds back, a bell's lip, counts its outside.)
    const outer = (z: number): number => {
      let m = -1;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [r0, z0] = pts[i], [r1, z1] = pts[i + 1];
        if ((z <= z0 && z >= z1) || (z >= z0 && z <= z1)) m = Math.max(m, Math.abs(z1 - z0) < 1e-9 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (z - z0)) / (z1 - z0));
      }
      return m;
    };
    const inside = (p: V3) => {
      const x = (p[0] - c[0]) / sq[0], y = (p[1] - c[1]) / sq[1];
      return Math.hypot(x, y) < outer(p[2] - c[2]);
    };
    return {
      inside,
      normal: (p) => {
        const z = p[2] - c[2], h = 0.01;
        const x = (p[0] - c[0]) / sq[0], y = (p[1] - c[1]) / sq[1], rr = Math.hypot(x, y) || 1e-6;
        const dr = (outer(z + h) - outer(z - h)) / (2 * h);
        return norm([x / rr / sq[0], y / rr / sq[1], Number.isFinite(dr) ? -dr : 0]);
      },
    };
  }

  /**
   * A thick flat shape facing the viewer: `outline` in the x-z plane round `c` (its own origin: every point of the
   * outline must be seen from it), `thick` front to back. Its edge is a rounded band `bevel` wide in `rim` paint that runs
   * `rimWidth` onto the face; inside it the `face` paint rises in a dome `dome` high (the enamel in its setting).
   * The back is `back` (default the rim's paint), a lower dome with the same rounded edge.
   */
  plate(outline: [number, number][], c: V3, o: { thick: number; bevel: number; rimWidth?: number; dome?: number; face: PaintAt; rim: Paint; back?: Paint; bone?: number; rings?: number; soft?: number }): void {
    const n = outline.length, bone = o.bone ?? CB.body;
    const rimW = o.rimWidth ?? 0, dome = o.dome ?? 0, rings = o.rings ?? 4, soft = o.soft ?? 0;
    // Inward normals (the outline is counter-clockwise in x-z seen from -y: inward is to the left of travel).
    const nrm: [number, number][] = outline.map((p, i) => {
      const a = outline[(i - 1 + n) % n], b2 = outline[(i + 1) % n];
      const e1 = unit2([p[0] - a[0], p[1] - a[1]]), e2 = unit2([b2[0] - p[0], b2[1] - p[1]]);
      const n1: [number, number] = [-e1[1], e1[0]], n2: [number, number] = [-e2[1], e2[0]];
      const m = unit2([n1[0] + n2[0], n1[1] + n2[1]]);
      const k = Math.min(1.8, 1 / Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]));
      return [m[0] * k, m[1] * k];
    });
    // Make sure they point inward (toward the centre on average).
    let s = 0;
    for (let i = 0; i < n; i++) s += nrm[i][0] * -outline[i][0] + nrm[i][1] * -outline[i][1];
    const sgn = s >= 0 ? 1 : -1;
    // Inset by d: each point moves toward the centre along its own ray, far enough to be d inside the edge there (a
    // rim of even width), never past another point's ray: a notch or a sharp tip can't fold over.
    const off = (d: number): [number, number][] =>
      outline.map((p, i) => {
        const l = Math.hypot(p[0], p[1]) || 1e-6, ux = p[0] / l, uz = p[1] / l;
        const along = Math.max(0.3, -(nrm[i][0] * ux + nrm[i][1] * uz) * sgn);
        const m = Math.min(d / along, l * 0.7);
        return [p[0] - ux * m, p[1] - uz * m];
      });
    const cc = add(c, this.o);
    const row = (o2: [number, number][], y: number): V3[] => o2.map(([x, z]) => [cc[0] + x, cc[1] + y, cc[2] + z] as V3);
    const hy = o.thick / 2, bv = Math.min(o.bevel, hy);
    const rows: V3[][] = [];
    const paints: PaintAt[] = [];
    const push = (r: V3[], p: PaintAt) => (rows.push(r), paints.push(p));
    const back = o.back ?? o.rim;
    const toCentre = (o2: [number, number][], t: number): [number, number][] => o2.map(([x, z]) => [x * (1 - t), z * (1 - t)]);
    // The back: a low dome in toward the centre, then out to its rounded edge.
    const inner = off(bv);
    const bd = dome * 0.4;
    for (let j = 3; j >= 1; j--) push(row(toCentre(inner, j / 3.4), hy + bd * Math.sin(((j / 3.4) * Math.PI) / 2)), back);
    for (let j = 0; j <= 3; j++) {
      const a = (j / 3) * (Math.PI / 2);
      push(row(off(bv * (1 - Math.sin(a))), hy - bv * (1 - Math.cos(a))), j === 0 ? back : o.rim);
    }
    // Side, front edge.
    for (let j = 1; j <= 3; j++) {
      const a = (j / 3) * (Math.PI / 2);
      push(row(off(bv * (1 - Math.cos(a))), -hy + bv * (1 - Math.sin(a))), o.rim);
    }
    // The rim's flat on the face, then the enamel doming up toward the middle.
    if (rimW > 0) push(row(off(bv + rimW), -hy), o.rim);
    const start = off(bv + rimW);
    // (`soft`: the rings round off toward the middle, so a notch or a tip doesn't crease the whole dome.)
    const mean = start.reduce((a, p) => a + Math.hypot(p[0], p[1]), 0) / n;
    for (let j = 1; j <= rings; j++) {
      const t = j / (rings + 0.3), k = soft * Math.min(1, t * 1.6);
      const ring = start.map(([x, z]) => {
        const l = Math.hypot(x, z) || 1e-6, m = l + (mean - l) * k;
        return [(x / l) * m * (1 - t), (z / l) * m * (1 - t)] as [number, number];
      });
      push(row(ring, -hy - dome * Math.sin((t * Math.PI) / 2)), o.face);
    }
    const pf = paints.map(paintFn);
    this.b.surface(rows, { paint: (i, k) => pf[i + 1](mid(rows, i, k), i, k), weight: () => this.w(bone), capStart: pf[0]([cc[0], cc[1] + hy, cc[2]], 0, 0), capEnd: pf[pf.length - 1]([cc[0], cc[1] - hy - dome, cc[2]], 0, 0) });
  }

  /** A section carried along a path: `section(i)` its outline in the (u, v) plane across the path at point i. */
  sweep(path: V3[], section: (i: number) => [number, number][], o: { paint: PaintAt; bone?: number; ref?: V3; caps?: boolean }): void {
    const ref = o.ref ?? [0, 1, 0];
    const rows = path.map((p, i) => {
      const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
      const [, u, v] = frame(d, ref);
      return section(i).map(([a, b2]) => add(add(p, this.o), add(scale(u, a), scale(v, b2))));
    });
    const pf = paintFn(o.paint);
    const caps = o.caps ?? true;
    this.b.surface(rows, { paint: (i, k) => pf(mid(rows, i, k), i, k), weight: () => this.w(o.bone ?? CB.body), capStart: caps ? pf(rows[0][0], 0, 0) : null, capEnd: caps ? pf(rows[rows.length - 1][0], rows.length - 2, 0) : null });
  }

  /** A round tube along a path (radius per point). */
  tube(path: V3[], radius: number | ((i: number) => number), paint: Paint | ((i: number) => Paint), bone: number = CB.body, sides = 8, ref: V3 = [0, 1, 0], caps = true): void {
    const pf = typeof paint === "function" ? paint : () => paint;
    this.b.tube(path.map((p) => add(p, this.o)), radius, sides, ref, pf, () => this.w(bone), caps);
  }

  /** A ring about `axis` at `c` (`arc`: only that share of the turn, from `from` radians; open ends are capped). */
  torus(c: V3, R: number, r: number, axis: V3, paint: Paint, bone: number = CB.body, seg = 16, sides = 6, arc = 1, from = 0, uRef?: V3): void {
    c = add(c, this.o);
    const [, u, v] = frame(axis, uRef ?? (Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]));
    const full = arc >= 0.999;
    const path = Array.from({ length: seg + 1 }, (_, i) => {
      const th = from + (i / seg) * Math.PI * 2 * arc;
      return add(c, add(scale(u, Math.cos(th) * R), scale(v, Math.sin(th) * R)));
    });
    if (!full) return this.b.tube(path, r, sides, norm(axis), () => paint, () => this.w(bone), true);
    // (A ring of rings: each section in the plane of the radius and the axis; rows run round the section.)
    const secs = path.slice(0, seg).map((p) => {
      const out = norm(sub(p, c));
      return Array.from({ length: sides }, (_, k) => {
        const a = (k / sides) * Math.PI * 2;
        return add(p, add(scale(out, Math.cos(a) * r), scale(norm(axis), Math.sin(a) * r)));
      });
    });
    const grid: V3[][] = [];
    for (let k = 0; k < sides; k++) grid.push(secs.map((s2) => s2[k]));
    grid.push(grid[0]);
    this.b.surface(grid, { paint: () => paint, weight: () => this.w(bone), out: (i, k) => sub(grid[i][k], path[k]) });
  }

  // -------------------------------------------------------------------------------------------
  // On a surface

  /** The point of `on` hit from `from` travelling along `dir` (unit), and the surface's normal there; null = a miss. */
  hit(on: Solid, from: V3, dir: V3, reach = 3): { p: V3; n: V3 } | null {
    // March to the first inside sample, then bisect.
    const N = 48;
    let t0 = 0, t1 = -1;
    for (let i = 1; i <= N; i++) {
      const t = (reach * i) / N;
      if (on.inside(add(from, scale(dir, t)))) {
        t1 = t;
        break;
      }
      t0 = t;
    }
    if (t1 < 0) return null;
    for (let i = 0; i < 18; i++) {
      const m = (t0 + t1) / 2;
      if (on.inside(add(from, scale(dir, m)))) t1 = m;
      else t0 = m;
    }
    const p = add(from, scale(dir, t0));
    return { p, n: on.normal(p) };
  }

  /**
   * A flat shape laid on a solid: `outline` (2D, in the plane through `at` spanned by `ex` / `ey`, counter-clockwise) is
   * projected along `dir` onto `on` and lifted `lift` off it. `rings`: inner rings so it follows a curved surface.
   * The solid is in the charm's built space (before the lift to the bail), like every point a charm's builder gives.
   */
  decal(on: Solid, at: V3, outline: [number, number][], paint: Paint, o: { dir?: V3; ex?: V3; ey?: V3; lift?: number; rings?: number; bone?: number } = {}): void {
    const dir = norm(o.dir ?? [0, 1, 0]);
    const ex = o.ex ?? [1, 0, 0], ey = o.ey ?? [0, 0, 1];
    const lift = o.lift ?? 0.014, rings = o.rings ?? 2, bone = o.bone ?? CB.body;
    const start = sub(at, scale(dir, 1.5));
    const proj = (a: number, b2: number): { p: V3; n: V3 } | null => {
      const h = this.hit(on, add(start, add(scale(ex, a), scale(ey, b2))), dir, 3);
      return h ? { p: add(add(h.p, scale(h.n, lift)), this.o), n: h.n } : null;
    };
    const cx = outline.reduce((s2, p) => s2 + p[0], 0) / outline.length, cy = outline.reduce((s2, p) => s2 + p[1], 0) / outline.length;
    const centre = proj(cx, cy);
    if (!centre) return;
    let prev: ({ p: V3; n: V3 } | null)[] = outline.map(() => centre);
    const w = this.w(bone);
    for (let j = 1; j <= rings; j++) {
      const t = j / rings;
      const ring = outline.map(([a, b2]) => proj(cx + (a - cx) * t, cy + (b2 - cy) * t));
      for (let k = 0; k < outline.length; k++) {
        const k1 = (k + 1) % outline.length;
        const a = prev[k], b2 = prev[k1], c2 = ring[k1], d = ring[k];
        if (!a || !b2 || !c2 || !d) continue;
        if (j > 1) this.b.tri(a.p, b2.p, c2.p, a.n, b2.n, c2.n, paint, w, w, w);
        this.b.tri(a.p, c2.p, d.p, a.n, c2.n, d.n, paint, w, w, w);
      }
      prev = ring;
    }
    // The edge turned down to the surface, so a raised decal has no gap under it from the side (a thin one needs none).
    for (let k = 0; lift > 0.016 && k < outline.length; k++) {
      const k1 = (k + 1) % outline.length;
      const a = prev[k], b2 = prev[k1];
      if (!a || !b2) continue;
      const a0 = sub(a.p, scale(a.n, lift + 0.01)), b0 = sub(b2.p, scale(b2.n, lift + 0.01));
      const e = norm(sub(b2.p, a.p));
      const na = norm(cross(e, a.n)), nb = norm(cross(e, b2.n));
      const outA = dot(na, sub(a.p, centre.p)) < 0 ? scale(na, -1) : na, outB = dot(nb, sub(b2.p, centre.p)) < 0 ? scale(nb, -1) : nb;
      this.b.tri(a.p, b2.p, b0, norm(add(a.n, outA)), norm(add(b2.n, outB)), outB, paint, w, w, w);
      this.b.tri(a.p, b0, a0, norm(add(a.n, outA)), outB, outA, paint, w, w, w);
    }
  }

  /** A raised stroke on a solid along a 2D path (in the decal's plane), `width` wide with round ends. */
  line(on: Solid, at: V3, path: [number, number][], width: number, paint: Paint, o: { dir?: V3; ex?: V3; ey?: V3; lift?: number; bone?: number } = {}): void {
    const hw = width / 2, n = path.length;
    const left: [number, number][] = [], right: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b2 = path[Math.min(n - 1, i + 1)];
      const t = unit2([b2[0] - a[0], b2[1] - a[1]]);
      left.push([path[i][0] - t[1] * hw, path[i][1] + t[0] * hw]);
      right.push([path[i][0] + t[1] * hw, path[i][1] - t[0] * hw]);
    }
    // Round caps: three points round each end.
    const cap = (i: number, sgn: number): [number, number][] => {
      const a = path[i], b2 = path[i + sgn] ?? path[i - sgn];
      const t = unit2([a[0] - b2[0], a[1] - b2[1]]);
      return [-0.5, 0, 0.5].map((f) => {
        const ang = f * Math.PI * 0.6 * sgn;
        const d: [number, number] = [t[0] * Math.cos(ang) - t[1] * Math.sin(ang), t[0] * Math.sin(ang) + t[1] * Math.cos(ang)];
        return [a[0] + d[0] * hw, a[1] + d[1] * hw] as [number, number];
      });
    };
    const outline = [...right, ...cap(n - 1, 1).reverse(), ...left.reverse(), ...cap(0, -1).reverse()];
    this.decal(on, at, orient(outline), paint, { ...o, rings: 1 });
  }

  /** A raised cord on a solid round a 2D outline (a hood's rim round the face); `open`: along a path instead (a shell's spiral). */
  rimOn(on: Solid, at: V3, outline: [number, number][], radius: number | ((i: number) => number), paint: Paint, o: { dir?: V3; ex?: V3; ey?: V3; bone?: number; sides?: number; sink?: number; open?: boolean } = {}): void {
    const dir = norm(o.dir ?? [0, 1, 0]);
    const ex = o.ex ?? [1, 0, 0], ey = o.ey ?? [0, 0, 1];
    const start = sub(at, scale(dir, 1.5));
    const pts: V3[] = [], outs: V3[] = [];
    for (const [a, b2] of outline) {
      const h = this.hit(on, add(start, add(scale(ex, a), scale(ey, b2))), dir, 3);
      if (!h) continue;
      const rad = typeof radius === "number" ? radius : radius(pts.length);
      pts.push(add(h.p, scale(h.n, rad * (1 - (o.sink ?? 0.45)))));
      outs.push(h.n);
    }
    if (pts.length < 4) return;
    const sides = o.sides ?? 6, n = pts.length;
    const rows = pts.map((p, i) => {
      const t = o.open ? norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])) : norm(sub(pts[(i + 1) % n], pts[(i - 1 + n) % n]));
      const u = outs[i], v = norm(cross(t, u));
      const rad = typeof radius === "number" ? radius : radius(i);
      return Array.from({ length: sides }, (_, k) => {
        const a = (k / sides) * Math.PI * 2;
        return add(add(p, this.o), add(scale(u, Math.cos(a) * rad), scale(v, Math.sin(a) * rad)));
      });
    });
    if (o.open) {
      this.b.surface(rows, { paint: () => paint, weight: () => this.w(o.bone ?? CB.body), capStart: paint, capEnd: paint });
      return;
    }
    // Rows run round the cord's section, columns round the outline: closed both ways.
    const grid: V3[][] = [];
    for (let k = 0; k < sides; k++) grid.push(rows.map((r) => r[k]));
    grid.push(grid[0]);
    this.b.surface(grid, { paint: () => paint, weight: () => this.w(o.bone ?? CB.body), out: (i, k) => sub(grid[i][k], add(pts[k], this.o)) });
  }

  // -------------------------------------------------------------------------------------------

  /** A grid of points as a smooth closed-round surface, painted per face from the face's middle (built space). */
  private emit(grid: V3[][], paint: PaintAt, bone: number, capStart: boolean, capEnd: boolean): void {
    const pf = paintFn(paint);
    const rows = grid.map((r) => r.map((p) => add(p, this.o)));
    this.b.surface(rows, {
      paint: (i, k) => pf(mid(grid, i, k), i, k),
      weight: () => this.w(bone),
      capStart: capStart ? pf(grid[0][0], 0, 0) : null,
      capEnd: capEnd ? pf(grid[grid.length - 1][0], grid.length - 2, 0) : null,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 2D outlines (x, z), counter-clockwise seen from the viewer

/** An ellipse. */
export const oval = (rx: number, rz: number, n = 16, cx = 0, cz = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + Math.cos(t) * rx, cz + Math.sin(t) * rz] as [number, number];
  });

/** A rounded rectangle (superellipse, exponent `e`). */
export const pill = (rx: number, rz: number, e = 4, n = 20, cx = 0, cz = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * rx, cz + Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * rz] as [number, number];
  });

/** A heart `w` wide, its notch up, centred on its middle. */
export const heartOutline = (w: number, n = 40): [number, number][] =>
  orient(
    Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3), z = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return [(x / 32) * w, ((z + 2.5) / 32) * w] as [number, number];
    }),
  );

/** A polygon with its corners rounded (Chaikin's corner cutting, `n` rounds: each doubles the points). */
export function roundPoly(o: [number, number][], n = 2, cut = 0.25): [number, number][] {
  for (let r = 0; r < n; r++) {
    const out: [number, number][] = [];
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length];
      out.push([a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut], [a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
    }
    o = out;
  }
  return o;
}

/** A solid from a field that is negative inside it (decals find its surface; the normal is the field's slope). */
export function solidOf(f: (p: V3) => number): Solid {
  return {
    inside: (p) => f(p) < 0,
    normal: (p) => {
      const h = 2e-3, f0 = f(p);
      return norm([f([p[0] + h, p[1], p[2]]) - f0, f([p[0], p[1] + h, p[2]]) - f0, f([p[0], p[1], p[2] + h]) - f0]);
    },
  };
}

/** Counter-clockwise (positive area in x-z seen from -y: x right, z up). */
export function orient(o: [number, number][]): [number, number][] {
  let a = 0;
  for (let i = 0; i < o.length; i++) {
    const p = o[i], q = o[(i + 1) % o.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a >= 0 ? o : [...o].reverse();
}

const unit2 = (v: [number, number]): [number, number] => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
/** An outline drawn toward its centroid by t (0 = itself, 1 = the centroid). */
function lerpOutline(o: [number, number][], t: number): [number, number][] {
  const cx = o.reduce((s, p) => s + p[0], 0) / o.length, cz = o.reduce((s, p) => s + p[1], 0) / o.length;
  return o.map(([x, z]) => [x + (cx - x) * t, z + (cz - z) * t]);
}
/** The middle of grid face (i, k). */
function mid(g: V3[][], i: number, k: number): V3 {
  const K = g[0].length, i1 = Math.min(g.length - 1, i + 1), k1 = (k + 1) % K;
  const a = g[i][k % K], b = g[i][k1], c = g[i1][k1], d = g[i1][k % K];
  return [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
}
/** Catmull-Rom through control points, `sub` samples per span; a repeated point keeps a crease there. */
export function smooth(ctl: [number, number][], sub: number): [number, number][] {
  if (sub <= 1) return ctl;
  const out: [number, number][] = [];
  const n = ctl.length;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = ctl[Math.max(0, i - 1)], p1 = ctl[i], p2 = ctl[i + 1], p3 = ctl[Math.min(n - 1, i + 2)];
    if (p1[0] === p2[0] && p1[1] === p2[1]) continue;
    // A crease: the neighbour beyond a doubled point doesn't bend the span.
    const a = i > 0 && ctl[i - 1][0] === p1[0] && ctl[i - 1][1] === p1[1] ? p1 : p0;
    const d = i + 2 < n && ctl[i + 2][0] === p2[0] && ctl[i + 2][1] === p2[1] ? p2 : p3;
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      out.push([crm(a[0], p1[0], p2[0], d[0], t), crm(a[1], p1[1], p2[1], d[1], t)]);
    }
  }
  out.push(ctl[n - 1]);
  return out;
}
const crm = (p0: number, p1: number, p2: number, p3: number, t: number) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

export { add, cross, dot, len, norm, scale, sub };
export type { Paint, V3 };
