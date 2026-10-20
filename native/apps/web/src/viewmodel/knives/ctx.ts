// Knife building context: knife builders (knives/<id>.ts) emit surfaces in the knife-local frame (types.ts) and this
// maps them into the target mesh's bind space with the right skin weights and the finishUV attribute:
//   first person  (fpCtx): the viewmodel rig's Knife_Handle bind frame; parts can name an extra bone (rig.ts
//                          EXTRA_BONES, e.g. the balisong's Bfly_Blade) and are weighted to it.
//   third person  (tpCtx): the bunny's R_Hand bind frame through the knife's TpSpec, everything on the knife bone
//                          (bunny.Knife: R_Hand's bind, so it follows the hand unless an inspect spins it),
//                          fewer segments (k.seg()).
// Both append to an existing Builder, so hands + knife (or bunny + knife) stay one geometry and one draw call.

import { add, Builder, clamp, cross, dot, len, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "../../player/bunny/builder";
import { KNIFE_BONE, rig as bunnyRig, xform, type V3 } from "../../player/bunny/rig";
import { vmRig } from "../rig";
import { PART, type TpSpec } from "./types";

export const fixed = (color: number): Paint => ({ code: 0, color });
export const ACCENT: Paint = { code: 1 };
export const GLOW: Paint = { code: 2 };
/** The carrot palette (same as the third-person blade, player/bunny/mesh.ts). */
export const CARROT = fixed(0xff7a1a), CARROT_DARK = fixed(0xd95a0c), LEAF = fixed(0x58c64a), LEAF_DARK = fixed(0x2f7d34);

export type Fin = readonly [number, number, number, number];

/**
 * finishUV.w: the wear mask's edge / tip weight 0..1 (same rule as finishes/layout.ts edgeOf): toward the edge(s)
 * (|across| 0.6 -> 1, or the sharp side's `e`) or the tip (along 0.85 -> 1), whichever is more.
 */
export const edgeWeight = (u: number, e: number) => Math.max(smoothstep(0.6, 1, e), smoothstep(0.85, 1, u));
type Part = (typeof PART)[keyof typeof PART];

export interface SurfaceOpts {
  paint: (i: number, k: number) => Paint;
  /** Extra bone (short name) in first person; default Knife_Handle. */
  bone?: string;
  part?: Part;
  /** Blade coordinates per grid point: [along 0..1, across -1..1, edge 0..1] (PART.blade surfaces). */
  fin?: (i: number, k: number) => [number, number, number];
  capStart?: Paint | null;
  capEnd?: Paint | null;
  closed?: boolean;
  flat?: boolean;
  /**
   * Outward reference per grid point (knife-local direction; default: away from the row's centroid). For sections
   * whose centroid is far off-centre (a blade with a groove and a heavy spine), so concave walls still face out.
   */
  out?: (i: number, k: number) => V3;
}

export interface BladeSpec {
  /** Rows (along the blade) and points per ring. */
  n: number;
  m?: number;
  /** Centreline (knife-local) at s = 0 (base) .. 1 (tip). */
  center(s: number): V3;
  /** Half width (across, in the blade plane) and half thickness (along x) at s. */
  width(s: number): number;
  thick(s: number): number;
  /** Edge side along the width direction (cross(tangent, +x)): +1 / -1 single-edged (wedge section), 0 lens / round. */
  edge?: number;
  /** Superellipse exponent of the section (2 = ellipse, higher = flatter faces). */
  ex?: number;
  /** Carrot growth rings (every third row darker, a slight pinch). Default true. */
  bands?: boolean;
  paint?(i: number, k: number): Paint;
  /** Shift of the section centre across the width (units, at s), e.g. a karambit's spine bulge. */
  shift?(s: number): number;
  bone?: string;
  capStart?: Paint | null;
  /** Rotation of each row's points (radians per row): with paint by column it makes spiral stripes (candy cane). */
  twist?: number;
}

const X: V3 = [1, 0, 0];

export class KnifeCtx {
  /** Vertices before this knife (to count its triangles). */
  private v0: number;
  constructor(
    readonly b: Builder,
    readonly view: "fp" | "tp",
    private toModel: (p: V3) => V3,
    private weightOf: (bone?: string) => Wt,
  ) {
    this.v0 = b.vertexCount;
  }

  /** Triangles emitted through this context so far. */
  get tris(): number {
    return (this.b.vertexCount - this.v0) / 3;
  }

  /** Segment count for this view (third person ~60%, at least 5). */
  seg(n: number): number {
    return this.view === "fp" ? n : Math.max(5, Math.round(n * 0.6));
  }

  L(p: V3): V3 {
    return this.toModel(p);
  }

  /** Direction knife-local -> model. */
  D(d: V3): V3 {
    return sub(this.toModel(d), this.toModel([0, 0, 0]));
  }

  w(bone?: string): Wt {
    return this.weightOf(bone);
  }

  /** A smooth surface through rows of knife-local points (Builder.surface), with weights and finish coordinates. */
  surface(rows: V3[][], o: SurfaceOpts): void {
    const m = rows.map((r) => r.map((p) => this.toModel(p)));
    const part = o.part ?? PART.none;
    const W = this.weightOf(o.bone);
    if (o.fin) {
      const map = new Map<string, Fin>();
      const key = (p: V3) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
      m.forEach((r, i) => {
        r.forEach((p, k) => {
          const [u, v, e] = o.fin!(i, k);
          map.set(key(p), [u, v, part, e]);
        });
        // Cap centres (Builder.surface computes the row centroid the same way).
        const c = scale(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length);
        const [u, , e] = o.fin!(i, 0);
        if (!map.has(key(c))) map.set(key(c), [u, 0, part, e]);
      });
      const dflt: Fin = [0, 0, part, 0];
      this.b.finish = (p) => map.get(key(p)) ?? dflt;
    } else {
      const f: Fin = [0, 0, part, 0];
      this.b.finish = () => f;
    }
    const out = o.out;
    this.b.surface(m, { paint: o.paint, weight: () => W, capStart: o.capStart, capEnd: o.capEnd, closed: o.closed, flat: o.flat, out: out ? (i, k) => this.D(out(i, k)) : undefined });
    this.b.finish = null;
  }

  /** A tube along a knife-local polyline (rings perpendicular to the path, closed ends). */
  tube(path: V3[], radius: number | ((i: number) => number), sides: number, ref: V3, paint: (i: number) => Paint, o: { bone?: string; part?: Part; caps?: boolean } = {}): void {
    const rows = path.map((p, i) => {
      const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
      let u = sub(ref, scale(d, dot(ref, d)));
      if (len(u) < 1e-4) u = sub([0, 0, 1], scale(d, d[2]));
      u = norm(u);
      const v = cross(d, u);
      const r = typeof radius === "number" ? radius : radius(i);
      return ring(p, u, v, r, r, sides);
    });
    const caps = o.caps ?? true;
    this.surface(rows, { paint: (i) => paint(i), bone: o.bone, part: o.part, capStart: caps ? paint(0) : null, capEnd: caps ? paint(path.length - 2) : null });
  }

  /**
   * A flat leaf along a knife-local polyline: lens sections `width(i)` wide (across, ⟂ path and `normal`) and
   * `thick` thick (along `normal`), pointed ends.
   */
  leaf(path: V3[], width: (i: number) => number, thick: number, normal: V3, paint: (i: number) => Paint, o: { bone?: string; part?: Part; sides?: number } = {}): void {
    const sides = this.view === "fp" ? (o.sides ?? 8) : 6;
    const rows = path.map((p, i) => {
      const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
      const nn = norm(sub(normal, scale(d, dot(normal, d))));
      const across = cross(d, nn);
      const w = width(i);
      return ring(p, across, nn, w, Math.min(thick, w * 0.6 + 0.01), sides, 1.6);
    });
    this.surface(rows, { paint: (i) => paint(i), bone: o.bone, part: o.part ?? PART.grip, capStart: paint(0), capEnd: paint(path.length - 2) });
  }

  /** A closed torus-like loop along a closed knife-local polyline (no caps). */
  loop(path: V3[], radius: number | ((i: number) => number), sides: number, normal: V3, paint: (i: number) => Paint, o: { bone?: string; part?: Part } = {}): void {
    const n = path.length;
    const rows = [...path, path[0]].map((p, i) => {
      const d = norm(sub(path[(i + 1) % n], path[(i - 1 + n) % n]));
      const u = norm(sub(normal, scale(d, dot(normal, d))));
      const v = cross(d, u);
      const r = typeof radius === "number" ? radius : radius(i % n);
      return ring(p, u, v, r, r, sides);
    });
    this.surface(rows, { paint: (i) => paint(i % n), bone: o.bone, part: o.part });
  }

  /**
   * A blade lofted along a centreline in the knife's y-z plane: lens / wedge sections (x = thickness), carrot growth
   * rings, PART.blade with along / across / edge finish coordinates. Returns the rows (knife-local).
   */
  blade(sp: BladeSpec): V3[][] {
    const n = this.view === "fp" ? sp.n : Math.max(6, Math.round(sp.n * 0.65));
    const m = this.view === "fp" ? (sp.m ?? 14) : Math.max(8, Math.round((sp.m ?? 14) * 0.65));
    const ex = sp.ex ?? 2.2;
    const e = sp.edge ?? 0;
    const bands = sp.bands ?? true;
    const across: number[][] = [];
    const rows: V3[][] = [];
    const tw = sp.twist ?? 0;
    const h = 1e-3;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const c0 = sp.center(s);
      const t = norm(sub(sp.center(Math.min(1, s + h)), sp.center(Math.max(0, s - h))));
      const wd = norm(cross(t, X));
      const pinch = bands && i % 3 === 1 && i < n ? 0.94 : 1;
      const w = sp.width(s) * pinch, th = sp.thick(s) * pinch;
      const sh = sp.shift?.(s) ?? 0;
      const row: V3[] = [];
      const ac: number[] = [];
      for (let k = 0; k < m; k++) {
        const a = (k / m) * Math.PI * 2 + tw * i;
        const sn = Math.sin(a), c = Math.cos(a);
        const cx = Math.sign(c) * Math.pow(Math.abs(c), 2 / ex);
        ac.push(cx);
        const y = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / ex);
        const q = e === 0 ? 1 : 0.1 + 0.9 * Math.pow(clamp(0.5 - 0.5 * e * cx, 0, 1), 0.7);
        row.push(add(add(c0, scale(wd, w * cx + sh)), scale(X, th * y * q)));
      }
      rows.push(row);
      across.push(ac);
    }
    const paint = sp.paint ?? ((i: number) => (bands && i % 3 === 1 ? CARROT_DARK : CARROT));
    this.surface(rows, {
      paint,
      bone: sp.bone,
      part: PART.blade,
      fin: (i, k) => {
        const u = i / n;
        const v = across[i][k];
        return [u, v, edgeWeight(u, e === 0 ? Math.abs(v) : Math.max(0, e * v * 1.1))];
      },
      capStart: sp.capStart === undefined ? CARROT : sp.capStart,
      capEnd: CARROT,
    });
    return rows;
  }
}

/** First person: knife-local = the viewmodel rig's Knife_Handle bind frame; parts weighted to Knife_Handle or an extra bone. */
export function fpCtx(b: Builder): KnifeCtx {
  const r = vmRig();
  const kb = r.bone("Knife_Handle");
  const K = r.bind.subarray(kb * 12, kb * 12 + 12);
  return new KnifeCtx(b, "fp", (p) => xform(K, 0, p), (bone) => [[bone ? r.bone(bone) : kb, 1]]);
}

/** The carrot's third-person placement (player/bunny/mesh.ts): grip through the fist, blade forward-down. */
export const TP_CARROT: TpSpec = { o: [2.05, -1.45, 3.1], z: [0.53, 0.1, -0.84], y: [0, 1, 0], s: 1.6 };

/** Third person: knife-local -> the bunny's R_Hand bind frame through `tp`, everything on the knife bone (bunny.Knife). */
export function tpCtx(b: Builder, tp: TpSpec = TP_CARROT): KnifeCtx {
  const r = bunnyRig();
  const hand = r.bone("R_Hand");
  const H = r.bind.subarray(hand * 12, hand * 12 + 12);
  // Skinned to the bunny's knife bone (R_Hand's bind; it follows the hand except while an inspect spins the knife).
  const kb = r.index(KNIFE_BONE);
  const z = norm(tp.z);
  const y = norm(sub(tp.y, scale(z, dot(tp.y, z))));
  const x = cross(y, z);
  const s = tp.s;
  const W: Wt = [[kb >= 0 ? kb : hand, 1]];
  return new KnifeCtx(
    b,
    "tp",
    (p) => xform(H, 0, add(tp.o, add(add(scale(x, p[0] * s), scale(y, p[1] * s)), scale(z, p[2] * s)))),
    () => W,
  );
}
