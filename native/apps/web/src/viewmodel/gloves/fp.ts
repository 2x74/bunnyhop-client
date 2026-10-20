// First-person hands per glove style (loadout.ts GLOVE_STYLE): the hoodie sleeves + the glove, built in code in the
// bind pose of the v_knife_t skeleton (viewmodel/rig.ts) and skinned to its bones like the rest of the viewmodel
// (viewmodel/mesh.ts adds the knife). Every style shares the hand's lofts (palm block, four fingers, thumb: the same
// rings as the original knit glove, so the knife grips, holds.ts' grip solver and the inspects fit every glove) and
// changes what's on them:
//   - per-face paint: colour slot + material (gloves/paint.ts), e.g. a perforated knuckle panel, bare paw fingertips;
//   - small shape changes on the BACK of the hand only (padding, plates), so the palm side that touches a handle
//     stays where the grip solver expects it;
//   - extra parts: straps, cuffs / gauntlets, knuckle plates, finger guards, pads, snaps, wrap tails;
//   - finishUV per vertex: seam distance (stitching), a coordinate along the part, edge wear (gloves/glsl.ts).
// The knit glove (the default) is the original geometry, unchanged. Budget: <= ~10k vertices for both hands + sleeves.
//
// Hand frame (as procedural.ts / knives/hold.ts): `ax` wrist -> knuckles, `wAx` across toward the index finger,
// `palmN` the palm side (thumb side); the back of the hand is -palmN. The hoodie's trim cuff covers the glove up to
// about 0.6 units past the wrist, so straps and short cuffs start there.

import { add, blend, Builder, clamp, cross, dot, frame, lerp3, len, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { vmRig, type VmRig } from "../rig";
import { gp, MAT, NO_SEAM, PAL_SLOT, SLOT_G } from "./paint";

const S = (slot: number): Paint => ({ code: 3 + slot });
const HOODIE = S(PAL_SLOT.hoodie), TRIM = S(PAL_SLOT.trim), GLOVE = S(PAL_SLOT.glove);
const ACCENT: Paint = { code: 1 };

/** Per-side bone names (the left thumb's middle bone is spelled differently in the CS:S skeleton). */
const SIDES = {
  R: { arm: "Right_Arm", hand: "Right_Hand", wrist: "R_wrist_helper", thumb: ["Right_Thumb01", "Right_Thumb02", "Right_Thumb03"], f: "Right_" },
  L: { arm: "Left_Arm", hand: "Left_Hand", wrist: "L_wrist_helper", thumb: ["Left_Thumb01", "Left_Thumb_02", "Left_Thumb03"], f: "Left_" },
} as const;

/** Finger: name, tube half-size, fingertip length past the last joint (also knives/hold.ts TIP, inspects/clearance.ts). */
export const FINGERS: [string, number, number][] = [
  ["Index", 0.4, 0.92],
  ["Middle", 0.42, 0.98],
  ["Ring", 0.4, 0.92],
  ["Pinky", 0.35, 0.8],
];

/** Palm profile: s along the palm axis (palmL appended at runtime), half width, half thickness. */
const PALM = (palmL: number): [number, number, number][] => [
  [-1.1, 1.3, 0.92],
  [-0.2, 1.42, 0.95],
  [0.5, 1.5, 0.92],
  [palmL * 0.55, 1.62, 0.86],
  [palmL - 0.25, 1.62, 0.74],
  [palmL + 0.3, 1.42, 0.6],
];

const FINGER_R = [1.05, 1.02, 0.98, 0.95, 0.93, 0.9, 0.86, 0.76, 0.42];
const THUMB_R = [0.72, 0.62, 0.5, 0.47, 0.46, 0.43, 0.37, 0.2];

interface Digit {
  thumb: boolean;
  path: V3[];
  /** Ring half sizes per row (u, v). */
  ru: number[];
  rv: number[];
  w: Wt[];
  /** Frame reference per row (u ≈ across the hand). */
  ref: (dir: V3) => V3;
  bones: number[];
}

export interface Hand {
  side: "R" | "L";
  arm: number;
  hand: number;
  twist: number;
  root: V3;
  wrist: V3;
  dA: V3;
  L: number;
  ax: V3;
  wAx: V3;
  palmN: V3;
  palmL: number;
  digits: Digit[];
  /** Forearm frame (the sleeve's rings). */
  fu: V3;
  fv: V3;
}

function handOf(r: VmRig, side: "R" | "L"): Hand {
  const sd = SIDES[side];
  const B = (n: string) => r.bone(n);
  const at = (n: string) => r.at(n);
  const arm = B(sd.arm), hand = B(sd.hand), twist = B(sd.wrist);
  const root = at(sd.arm), wrist = at(sd.hand);
  const dA = norm(sub(wrist, root));
  const L = len(sub(wrist, root));
  const roots = FINGERS.map(([f]) => at(`${sd.f}${f}01`));
  const kc = scale(roots.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / roots.length);
  const ax = norm(sub(kc, wrist));
  const across0 = norm(sub(roots[0], roots[3]));
  const [, wAx, nAx0] = frame(ax, across0);
  const thumbMid = at(sd.thumb[1]);
  const palmN: V3 = dot(nAx0, sub(thumbMid, wrist)) > 0 ? nAx0 : scale(nAx0, -1);
  const palmL = len(sub(kc, wrist));
  const ref: V3 = Math.abs(dA[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const [, fu, fv] = frame(dA, ref);
  const digits: Digit[] = [];
  for (const [f, rad, tipLen] of FINGERS) {
    const names = [1, 2, 3].map((k) => `${sd.f}${f}0${k}`);
    const bones = names.map(B);
    const p = names.map(at);
    const d3 = r.axis(names[2], 0);
    const d1 = norm(sub(p[1], p[0]));
    const tip = add(p[2], scale(d3, tipLen));
    const path: V3[] = [sub(p[0], scale(d1, 0.6)), p[0], lerp3(p[0], p[1], 0.5), p[1], lerp3(p[1], p[2], 0.5), p[2], lerp3(p[2], tip, 0.55), sub(tip, scale(d3, 0.16)), tip];
    const w: Wt[] = [[[hand, 1]], blend(hand, bones[0], 0.5), [[bones[0], 1]], blend(bones[0], bones[1], 0.5), [[bones[1], 1]], blend(bones[1], bones[2], 0.5), [[bones[2], 1]], [[bones[2], 1]], [[bones[2], 1]]];
    digits.push({ thumb: false, path, ru: FINGER_R.map((k) => rad * k * 1.04), rv: FINGER_R.map((k) => rad * k * 0.94), w, ref: () => wAx, bones });
  }
  {
    const bones = sd.thumb.map(B);
    const p = sd.thumb.map(at);
    const d3 = r.axis(sd.thumb[2], 0);
    const tip = add(p[2], scale(d3, 1.02));
    const path: V3[] = [sub(p[0], scale(norm(sub(p[1], p[0])), 0.4)), lerp3(p[0], p[1], 0.45), p[1], lerp3(p[1], p[2], 0.5), p[2], lerp3(p[2], tip, 0.55), sub(tip, scale(d3, 0.16)), tip];
    const w: Wt[] = [[[hand, 0.6], [bones[0], 0.4]], [[bones[0], 1]], blend(bones[0], bones[1], 0.5), [[bones[1], 1]], blend(bones[1], bones[2], 0.5), [[bones[2], 1]], [[bones[2], 1]], [[bones[2], 1]]];
    digits.push({ thumb: true, path, ru: THUMB_R.map((k) => k * 1.05), rv: THUMB_R.map((k) => k * 0.95), w, ref: (dir) => cross(dir, palmN), bones });
  }
  return { side, arm, hand, twist, root, wrist, dA, L, ax, wAx, palmN, palmL, digits, fu, fv };
}

// ---------------------------------------------------------------------------------------------
// Emitting with finishUV (seam, along, PART.glove, wear) per grid point

export type Fin3 = [number, number, number];
const key = (p: V3) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
const PART_GLOVE = 4;

export interface EmitOpts {
  /** Rigid panels have joins, not textile stitching. */
  seamless?: boolean;
  paint: (i: number, k: number) => Paint;
  weight: (i: number, k: number) => Wt;
  /** [extra seam distance, along, wear] per grid point; default no seam / 0 / 0. */
  fin?: (i: number, k: number) => Fin3;
  capStart?: Paint | null;
  capEnd?: Paint | null;
  closed?: boolean;
}

/**
 * Seam distance per grid point: 0 on vertices where neighbouring quads have different paints (a panel edge, a hem),
 * growing with the distance along the grid (so it interpolates linearly across the quads next to the edge).
 */
function paintSeams(rows: V3[][], paint: (i: number, k: number) => Paint, closed: boolean): number[][] {
  const R = rows.length, K = rows[0].length, kq = closed ? K : K - 1;
  const pc = rows.slice(0, -1).map((_, i) => Array.from({ length: kq }, (_, k) => paint(i, k).code));
  const d = rows.map((r, i) =>
    r.map((_, k) => {
      const seen = new Set<number>();
      for (const ii of [i - 1, i]) {
        if (ii < 0 || ii >= R - 1) continue;
        for (const kk of [k - 1, k]) {
          const k2 = closed ? (kk + kq) % kq : kk;
          if (k2 < 0 || k2 >= kq) continue;
          seen.add(pc[ii][k2]);
        }
      }
      return seen.size > 1 ? 0 : (NO_SEAM as number);
    }),
  );
  for (let pass = 0, changed = true; changed && pass < R + K; pass++) {
    changed = false;
    for (let i = 0; i < R; i++)
      for (let k = 0; k < K; k++) {
        const nb: [number, number][] = [[i - 1, k], [i + 1, k], [i, closed ? (k + 1) % K : k + 1], [i, closed ? (k - 1 + K) % K : k - 1]];
        for (const [a, c] of nb) {
          if (a < 0 || a >= R || c < 0 || c >= K) continue;
          const v = d[a][c] + len(sub(rows[a][c], rows[i][k]));
          if (v < d[i][k] - 1e-6) (d[i][k] = v), (changed = true);
        }
      }
  }
  return d.map((r) => r.map((v) => Math.min(NO_SEAM, v)));
}

export function emit(b: Builder, rows: V3[][], o: EmitOpts): void {
  const map = new Map<string, readonly [number, number, number, number]>();
  const fin = o.fin ?? (() => [NO_SEAM, 0, 0] as Fin3);
  const seams = o.seamless ? rows.map(r => r.map(() => NO_SEAM)) : paintSeams(rows, o.paint, o.closed ?? true);
  rows.forEach((r, i) => {
    r.forEach((p, k) => {
      const [s, a, w] = fin(i, k);
      map.set(key(p), [Math.min(s, seams[i][k]), a, PART_GLOVE, w]);
    });
    const c = scale(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length);
    const [, a, w] = fin(i, 0);
    if (!map.has(key(c))) map.set(key(c), [NO_SEAM, a, PART_GLOVE, w]);
  });
  const dflt = [NO_SEAM, 0, PART_GLOVE, 0] as const;
  b.finish = (p) => map.get(key(p)) ?? dflt;
  b.surface(rows, { paint: o.paint, weight: (_, i, k) => o.weight(i, k), capStart: o.capStart, capEnd: o.capEnd, closed: o.closed });
  b.finish = null;
}

/** Arc length along a polyline per point. */
export function arcs(path: V3[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + len(sub(path[i], path[i - 1])));
  return out;
}

/** Seam distance from stitch lines at positions `at` along a part (bands: their edges). */
function seamDist(s: number, at: number[]): number {
  let d = NO_SEAM;
  for (const x of at) d = Math.min(d, Math.abs(s - x));
  return d;
}

// ---------------------------------------------------------------------------------------------
// Parts

/** Per-quad / per-point context for the hand lofts. */
export interface Q {
  /** Row (quad: the lower row). */
  i: number;
  /** Arc length along the part (units) at the row (quad: mid of the two rows). */
  s: number;
  /** Back-ness of the column: 1 = back of the hand, -1 = palm side, 0 = the sides. */
  bn: number;
  /** Across the hand (+ index side) of the column, -1..1. */
  ac: number;
}

export interface PalmSpec {
  seamless?: boolean;
  /** Extra rows (s values) to cut panels at. */
  rows?: number[];
  paint(q: Q): Paint;
  /** Outward push (units) at a point (back-of-hand padding). */
  bulge?(q: Q): number;
  wear?(q: Q): number;
}

/** The palm block (16 columns; the knit glove's rows plus `rows`). */
function palm(b: Builder, h: Hand, sp: PalmSpec): void {
  const base = PALM(h.palmL);
  const prof = (s: number): [number, number] => {
    if (s <= base[0][0]) return [base[0][1], base[0][2]];
    for (let i = 0; i + 1 < base.length; i++) {
      const [s0, w0, t0] = base[i], [s1, w1, t1] = base[i + 1];
      if (s <= s1) {
        const t = (s - s0) / (s1 - s0);
        return [w0 + (w1 - w0) * t, t0 + (t1 - t0) * t];
      }
    }
    const l = base[base.length - 1];
    return [l[1], l[2]];
  };
  const ss = [...new Set([...base.map((r) => r[0]), ...(sp.rows ?? [])])].sort((a, b) => a - b);
  const N = 16;
  const bnOf = (k: number) => -Math.sin((k / N) * Math.PI * 2);
  const acOf = (k: number) => Math.cos((k / N) * Math.PI * 2);
  const rows = ss.map((s, i) => {
    const [hw, ht] = prof(s);
    const c = add(add(h.wrist, scale(h.ax, s)), scale(h.palmN, 0.08));
    const rr = ring(c, h.wAx, h.palmN, hw, ht, N, 2.7);
    if (!sp.bulge) return rr;
    return rr.map((p, k) => {
      const e = sp.bulge!({ i, s, bn: bnOf(k), ac: acOf(k) });
      return e ? add(p, scale(norm(sub(p, c)), e)) : p;
    });
  });
  const mid = (i: number) => (ss[i] + ss[Math.min(ss.length - 1, i + 1)]) / 2;
  emit(b, rows, {
    seamless: sp.seamless,
    paint: (i, k) => sp.paint({ i, s: mid(i), bn: bnOf(k + 0.5), ac: acOf(k + 0.5) }),
    weight: (i) => (ss[i] < 0.3 ? [[h.hand, 0.6], [h.twist, 0.4]] : [[h.hand, 1]]),
    fin: (i, k) => {
      const q = { i, s: ss[i], bn: bnOf(k), ac: acOf(k) };
      return [NO_SEAM, ss[i], sp.wear?.(q) ?? 0];
    },
    capStart: sp.paint({ i: 0, s: ss[0], bn: 0, ac: 0 }),
    capEnd: sp.paint({ i: ss.length - 1, s: ss[ss.length - 1], bn: 0.3, ac: 0 }),
  });
}

export interface DigitSpec {
  seamless?: boolean;
  /** Quad paint; q.i is the quad row (fingers 0 = inside the palm, 1-2 proximal, 3-4 middle, 5-7 distal / tip;
   * thumb 0 = base, 1 metacarpal, 2-3 proximal, 4-6 distal / tip). */
  paint(q: Q, d: number): Paint;
  /** Outward push (units), applied on the back half only (bn > 0) so the grip side keeps its size. */
  bulge?(q: Q, d: number): number;
  /** Uniform radius scale (default 1). */
  scale?: number;
  wear?(q: Q, d: number): number;
}

function digits(b: Builder, h: Hand, sp: DigitSpec): void {
  h.digits.forEach((dg, d) => {
    const n = dg.path.length;
    const A = arcs(dg.path);
    const sc = sp.scale ?? 1;
    const M = 10;
    const centres = dg.path;
    const frames = dg.path.map((c, i) => {
      const dir = norm(sub(dg.path[Math.min(n - 1, i + 1)], dg.path[Math.max(0, i - 1)]));
      const [, u, v] = frame(dir, dg.ref(dir));
      return [u, v] as const;
    });
    // Back-ness of a column: angle offset direction against -palmN.
    const bnAt = (i: number, k: number) => {
      const a = (k / M) * Math.PI * 2;
      const [u, v] = frames[i];
      return -dot(norm(add(scale(u, Math.cos(a)), scale(v, Math.sin(a)))), h.palmN);
    };
    const acAt = (i: number, k: number) => {
      const a = (k / M) * Math.PI * 2;
      const [u, v] = frames[i];
      return dot(norm(add(scale(u, Math.cos(a)), scale(v, Math.sin(a)))), h.wAx);
    };
    const rows = centres.map((c, i) => {
      const [u, v] = frames[i];
      const rr = ring(c, u, v, dg.ru[i] * sc, dg.rv[i] * sc, M, 2.25);
      if (!sp.bulge) return rr;
      return rr.map((p, k) => {
        const bn = bnAt(i, k);
        if (bn <= 0) return p;
        const e = sp.bulge!({ i, s: A[i], bn, ac: acAt(i, k) }, d) * smoothstep(0, 0.6, bn);
        return e ? add(p, scale(norm(sub(p, c)), e)) : p;
      });
    });
    emit(b, rows, {
      seamless: sp.seamless,
      paint: (i, k) => sp.paint({ i, s: (A[i] + A[Math.min(n - 1, i + 1)]) / 2, bn: (bnAt(i, k) + bnAt(i, k + 1)) / 2, ac: (acAt(i, k) + acAt(i, k + 1)) / 2 }, d),
      weight: (i) => dg.w[i],
      fin: (i, k) => {
        const q = { i, s: A[i], bn: bnAt(i, k), ac: acAt(i, k) };
        return [NO_SEAM, A[i], sp.wear?.(q, d) ?? 0];
      },
      capStart: sp.paint({ i: 0, s: 0, bn: 0, ac: 0 }, d),
      capEnd: sp.paint({ i: n - 2, s: A[n - 1], bn: 0, ac: 0 }, d),
    });
  });
}

/** Hand-frame point: s along the palm axis, a across (-1..1 of the half width at s), y out of the back (units). */
function backPoint(h: Hand, s: number, a: number, out = 0): V3 {
  const base = PALM(h.palmL);
  let hw = base[base.length - 1][1], ht = base[base.length - 1][2];
  for (let i = 0; i + 1 < base.length; i++)
    if (s <= base[i + 1][0]) {
      const t = clamp((s - base[i][0]) / (base[i + 1][0] - base[i][0]), 0, 1);
      hw = base[i][1] + (base[i + 1][1] - base[i][1]) * t;
      ht = base[i][2] + (base[i + 1][2] - base[i][2]) * t;
      break;
    }
  // Superellipse (e 2.7) back surface at across a.
  const x = a * hw;
  const y = ht * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(a), 2.7)), 1 / 2.7);
  return add(add(add(h.wrist, scale(h.ax, s)), scale(h.palmN, 0.08 - y - out)), scale(h.wAx, x));
}

/** A ring band around the hand (palm frame), s0..s1, `grow` units over the palm surface. */
function handBand(b: Builder, h: Hand, s: number[], grow: (j: number, k: number) => number, paint: (j: number, k: number) => Paint, o: { seams?: number[]; wear?: (j: number) => number; N?: number } = {}): void {
  const base = PALM(h.palmL);
  const N = o.N ?? 16;
  const prof = (x: number): [number, number] => {
    for (let i = 0; i + 1 < base.length; i++)
      if (x <= base[i + 1][0]) {
        const t = clamp((x - base[i][0]) / (base[i + 1][0] - base[i][0]), 0, 1);
        return [base[i][1] + (base[i + 1][1] - base[i][1]) * t, base[i][2] + (base[i + 1][2] - base[i][2]) * t];
      }
    return [base[base.length - 1][1], base[base.length - 1][2]];
  };
  const rows = s.map((x, j) => {
    const [hw, ht] = prof(x);
    const c = add(add(h.wrist, scale(h.ax, x)), scale(h.palmN, 0.08));
    const pts: V3[] = [];
    for (let k = 0; k < N; k++) {
      const g = grow(j, k);
      pts.push(ring(c, h.wAx, h.palmN, hw + g, ht + g, N, 2.7)[k]);
    }
    return pts;
  });
  emit(b, rows, {
    paint,
    weight: (j) => (s[j] < 0.3 ? [[h.hand, 0.6], [h.twist, 0.4]] : [[h.hand, 1]]),
    fin: (j) => [seamDist(s[j], o.seams ?? []), s[j], o.wear?.(j) ?? 0],
  });
}

/** A cuff around the forearm (the sleeve's frame), rows [s along the forearm from the arm root, radius]. */
function cuff(b: Builder, h: Hand, rows0: [number, number][], paint: (j: number, k: number) => Paint, o: { N?: number; seamless?: boolean; seams?: number[]; wear?: (j: number) => number; wobble?: (j: number, a: number) => number } = {}): void {
  const N = o.N ?? 16;
  const rows = rows0.map(([s, rad], j) => {
    const c = add(h.root, scale(h.dA, s));
    const pts = ring(c, h.fu, h.fv, rad * 0.86, rad * 0.84, N, 2.15);
    if (!o.wobble) return pts;
    return pts.map((p, k) => add(p, scale(norm(sub(p, c)), o.wobble!(j, (k / N) * Math.PI * 2))));
  });
  emit(b, rows, {
    seamless: o.seamless,
    paint,
    weight: (j) => {
      const s = rows0[j][0];
      const t = clamp((s - (h.L - 3.2)) / 3.4, 0, 1);
      const hd = smoothstep(h.L - 0.2, h.L + 1.6, s) * 0.55;
      return t <= 0 ? [[h.arm, 1]] : [[h.arm, (1 - 0.45 * t) * (1 - hd)], [h.twist, 0.45 * t * (1 - hd)], [h.hand, hd]];
    },
    fin: (j) => [seamDist(rows0[j][0], o.seams ?? []), rows0[j][0], o.wear?.(j) ?? 0],
  });
}

/** A low dome (pad, snap, rivet, guard): centre on the surface, normal out, radii (a along `t`, c across), height. */
export function dome(b: Builder, c: V3, n: V3, t: V3, ra: number, rc: number, ht: number, paint: Paint, w: Wt, N = 8, mat = { seam: NO_SEAM, wear: 0 }): void {
  const [, u0] = frame(n, t);
  const v0 = cross(n, u0);
  const sink = 0.07;
  const rows = [
    ring(sub(c, scale(n, sink)), u0, v0, ra, rc, N),
    ring(add(c, scale(n, ht * 0.62)), u0, v0, ra * 0.86, rc * 0.86, N),
    ring(add(c, scale(n, ht)), u0, v0, ra * 0.45, rc * 0.45, N),
  ];
  emit(b, rows, { paint: () => paint, weight: () => w, fin: (i) => [i === 0 ? 0.02 : mat.seam, i, mat.wear], capEnd: paint });
}

/** A flat strip (strap tab, wrap tail): path, half width, thickness, normal per point. */
export function strip(b: Builder, path: V3[], hw: (i: number) => number, th: number, nrm: (i: number) => V3, paint: Paint, w: (i: number) => Wt, wear = 0): void {
  const rows = path.map((p, i) => {
    const d = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
    const nn = norm(sub(nrm(i), scale(d, dot(nrm(i), d))));
    const ac = cross(d, nn);
    return ring(p, ac, nn, hw(i), th, 6, 3);
  });
  const A = arcs(path);
  emit(b, rows, { paint: () => paint, weight: (i) => w(i), fin: (i) => [NO_SEAM, A[i], wear * (i / (path.length - 1))], capStart: paint, capEnd: paint });
}

// ---------------------------------------------------------------------------------------------
// Sleeve (every style) and the original knit glove

function sleeve(b: Builder, h: Hand, until = Infinity): void {
  const L = h.L;
  const st: [number, number, number][] = [
    [-14, 2.55, 0],
    [-7, 2.45, 0],
    [-2, 2.35, 0],
    [2, 2.22, 0],
    [L - 3.2, 2.0, 0],
    [L - 1.35, 1.9, 0],
    [L - 1.15, 2.12, 1],
    [L - 0.2, 2.16, 1],
    [L + 0.35, 2.1, 1],
    [L + 0.62, 1.78, 1],
  ].filter((r) => r[0] <= until) as [number, number, number][];
  const rows = st.map(([s, rad], i) => {
    const k = i === 5 ? 0.97 : 1;
    return ring(add(h.root, scale(h.dA, s)), h.fu, h.fv, rad * 0.86 * k, rad * 0.84 * k, 18, 2.15);
  });
  b.surface(rows, {
    paint: (i) => (st[i][2] ? TRIM : HOODIE),
    weight: (_, i) => {
      const s = st[i][0];
      const t = Math.max(0, Math.min(1, (s - (L - 3.2)) / 3.4));
      return t <= 0 ? [[h.arm, 1]] : [[h.arm, 1 - 0.45 * t], [h.twist, 0.45 * t]];
    },
    capStart: HOODIE,
    capEnd: st[st.length - 1][2] ? TRIM : HOODIE,
  });
}

function knit(b: Builder, h: Hand): void {
  const { wrist, ax, wAx, palmN, palmL, hand, twist } = h;
  const palmRows = PALM(palmL);
  const rows = palmRows.map(([s, hw, ht]) => ring(add(add(wrist, scale(ax, s)), scale(palmN, 0.08)), wAx, palmN, hw, ht, 16, 2.7));
  b.surface(rows, {
    paint: () => GLOVE,
    weight: (_, i) => (palmRows[i][0] < 0.3 ? [[hand, 0.6], [twist, 0.4]] : [[hand, 1]]),
    capStart: GLOVE,
    capEnd: GLOVE,
  });
  // Accent strap across the back of the glove (the bunny's accent, like the hoodie stripes), lying on the back surface
  // just past the sleeve's trim cuff, its ends tucked into the sides (v0.0.5 had it at 0.18 palmL under the trim's
  // narrowing end, floating off the back: its ends stuck out through the trim and past the hand's sides).
  const s0 = palmL * 0.3;
  const strap: V3[] = [];
  for (let k = 0; k <= 6; k++) strap.push(backPoint(h, s0, -0.9 + (1.8 * k) / 6, 0.02));
  b.tube(strap, 0.17, 6, ax, () => ACCENT, () => [[hand, 0.75], [twist, 0.25]]);
  for (const dg of h.digits) {
    const n = dg.path.length;
    const rr = dg.path.map((c, i) => {
      const dir = norm(sub(dg.path[Math.min(n - 1, i + 1)], dg.path[Math.max(0, i - 1)]));
      const [, u, v] = frame(dir, dg.ref(dir));
      return ring(c, u, v, dg.ru[i], dg.rv[i], 10, 2.25);
    });
    b.surface(rr, { paint: () => GLOVE, weight: (_, i) => dg.w[i], capStart: GLOVE, capEnd: GLOVE });
  }
}

// ---------------------------------------------------------------------------------------------
// Styles

const P = gp;
const B = SLOT_G;
const isTip = (q: Q, d: number) => (d < 4 ? q.i >= 5 : q.i >= 4);
const isProx = (q: Q, d: number) => (d < 4 ? q.i >= 1 && q.i <= 2 : q.i >= 2 && q.i <= 3);
/** Knuckle-ish wear: the back of the knuckle rows and the fingertips. */
const digitWear = (q: Q, d: number) => Math.max(isTip(q, d) ? 0.4 + 0.6 * smoothstep(0.85, 1, q.s / 4.2) : 0, q.bn > 0.6 && (d < 4 ? q.i === 1 || q.i === 3 : q.i === 2) ? 0.7 : 0);
const palmWear = (h: Hand) => (q: Q) => (q.bn > 0.55 && q.s > h.palmL - 0.4 ? 0.8 : 0);

type StyleFn = (b: Builder, h: Hand) => void;

/** Sport: neoprene shell, a padded back panel with an accent stripe, vented finger-side panels, a velcro strap. */
const sport: StyleFn = (b, h) => {
  const L = h.palmL;
  const p0 = 1.38, p1 = L - 0.2, st0 = L * 0.62, st1 = L * 0.72;
  palm(b, h, {
    rows: [p0, st0, st1, p1],
    paint: (q) => {
      if (q.bn > 0.42 && q.s > p0 && q.s < p1) return q.s > st0 && q.s < st1 ? P(B.tips, MAT.knit) : P(B.fingers, MAT.rubber);
      if (q.bn < -0.55 && q.s > p0) return P(B.fingers, MAT.rubber);
      return P(B.base, MAT.knit);
    },
    bulge: (q) => (q.bn > 0.3 && q.s > p0 && q.s < p1 ? 0.13 * smoothstep(0.3, 0.75, q.bn) * smoothstep(p0, p0 + 0.35, q.s) * smoothstep(p1, p1 - 0.35, q.s) : 0),
    wear: palmWear(h),
  });
  digits(b, h, {
    paint: (q, d) => {
      if (Math.abs(q.bn) < 0.42 && q.i >= 1 && !isTip(q, d)) return P(B.fingers, MAT.perf);
      if (d === 4 && q.i <= 1 && q.bn < -0.2) return P(B.fingers, MAT.rubber);
      return P(B.base, MAT.knit);
    },
    wear: digitWear,
  });
  // Velcro wrist strap: a band just past the trim cuff, its tab lapping over the back toward the pinky side.
  handBand(b, h, [0.6, 0.68, 1.2, 1.28], (j) => (j === 0 || j === 3 ? 0.06 : 0.13), () => P(B.strap, MAT.knit), { seams: [0.68, 1.2], wear: (j) => (j === 0 || j === 3 ? 0.6 : 0) });
  const tab: V3[] = [0.15, -0.2, -0.55, -0.82].map((a) => backPoint(h, 0.94, a, 0.17));
  strip(b, tab, (i) => (i === 3 ? 0.22 : 0.27), 0.05, () => scale(h.palmN, -1), P(B.tips, MAT.knit), () => [[h.hand, 1]], 0.5);
};

/** Driver: thin leather, perforated knuckles, an open back over the wrist closed by a snap tab, a rolled hem. */
const driver: StyleFn = (b, h) => {
  const L = h.palmL;
  const o0 = 0.62, o1 = 1.45, k0 = L * 0.62;
  palm(b, h, {
    rows: [o0, o1, k0],
    paint: (q) => {
      if (q.bn > 0.5 && q.s > o0 - 0.05 && q.s < o1) return P(B.paw, MAT.fuzz);
      if (q.bn > 0.35 && q.s > k0) return P(B.base, MAT.perf);
      if (q.s < o0) return P(B.strap, MAT.leather);
      return P(B.base, MAT.leather);
    },
    wear: palmWear(h),
  });
  digits(b, h, {
    scale: 0.97,
    paint: (q, d) => {
      if (q.bn > 0.35 && isProx(q, d)) return P(B.base, MAT.perf);
      if (isTip(q, d) && q.bn < -0.3) return P(B.tips, MAT.leather);
      return P(d === 4 ? B.base : B.fingers, MAT.leather);
    },
    wear: digitWear,
  });
  // Snap tab across the opening and the snap.
  const tab: V3[] = [-0.78, -0.4, 0, 0.4, 0.78].map((a) => backPoint(h, 1.05, a, 0.035));
  strip(b, tab, (i) => (i === 0 || i === 4 ? 0.2 : 0.24), 0.045, () => scale(h.palmN, -1), P(B.strap, MAT.leather), () => [[h.hand, 1]], 0.4);
  dome(b, backPoint(h, 1.05, 0.38, 0.09), scale(h.palmN, -1), h.ax, 0.16, 0.16, 0.09, P(B.detail, MAT.metal), [[h.hand, 1]], 8);
  // Rolled hem at the wrist (just out of the trim cuff).
  handBand(b, h, [0.5, 0.58, 0.68], (j) => (j === 1 ? 0.09 : 0.04), () => P(B.strap, MAT.leather), { wear: () => 0.5 });
};

/** Hand wraps: cloth wound round the wrist, palm and knuckles, bare paw fingertips, two loose tails. */
const wraps: StyleFn = (b, h) => {
  const L = h.palmL;
  palm(b, h, {
    rows: [0.62, L * 0.62],
    paint: (q) => (q.s < 0.6 ? P(B.paw, MAT.fuzz) : P(B.base, MAT.wrap)),
    bulge: (q) => (q.s > 0.6 ? 0.05 + (q.bn > 0.4 && q.s > L * 0.62 ? 0.09 * smoothstep(0.4, 0.8, q.bn) : 0) : 0),
    wear: palmWear(h),
  });
  digits(b, h, {
    paint: (q, d) => ((d < 4 ? q.i <= 2 : q.i <= 1) ? P(B.fingers, MAT.wrap) : P(B.paw, MAT.fuzz)),
    bulge: (q, d) => ((d < 4 ? q.i <= 3 : q.i <= 2) ? 0.06 : 0),
    wear: (q, d) => ((d < 4 ? q.i === 3 : q.i === 2) ? 0.8 : 0),
  });
  // Wrist wrap (tape colour), thicker turns.
  handBand(b, h, [0.5, 0.58, 0.82, 0.9, 1.15, 1.25], (j) => [0.08, 0.2, 0.2, 0.15, 0.17, 0.08][j], () => P(B.strap, MAT.wrap), { seams: [0.86], wear: (j) => (j === 0 || j === 5 ? 0.7 : 0.2) });
  // Tails from the pinky side of the wrist wrap, flying off it and hanging down.
  for (const [a, l, dz] of [
    [-0.95, 1.5, 0.0],
    [-0.8, 1.15, 0.22],
  ] as const) {
    const st = backPoint(h, 0.95 + dz, a, 0.16);
    const path: V3[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      path.push(add(add(add(st, scale(h.ax, -l * t * 0.35)), scale(h.wAx, -l * t * 0.6)), scale(h.palmN, 0.7 * l * t * t)));
    }
    strip(b, path, (i) => 0.24 - i * 0.02, 0.035, () => h.wAx, P(B.base, MAT.wrap), (i) => (i < 2 ? [[h.hand, 1]] : [[h.hand, 0.6], [h.twist, 0.4]]), 0.9);
  }
};

/** Moto: padded textile shell, a hard knuckle plate and finger guards, padded fingers, a long cuff with a strap. */
const moto: StyleFn = (b, h) => {
  const L = h.palmL;
  const p0 = 1.0, p1 = L * 0.66;
  palm(b, h, {
    rows: [p0, p1],
    paint: (q) => {
      if (q.bn > 0.4 && q.s > p0 && q.s < p1) return P(B.fingers, MAT.rubber);
      if (q.bn < -0.5 && q.s > p0) return P(B.fingers, MAT.leather);
      return P(B.base, MAT.knit);
    },
    bulge: (q) => (q.bn > 0.3 && q.s > p0 && q.s < p1 ? 0.1 * smoothstep(0.3, 0.7, q.bn) * smoothstep(p0, p0 + 0.3, q.s) * smoothstep(p1, p1 - 0.3, q.s) : 0),
    wear: palmWear(h),
  });
  digits(b, h, {
    paint: (q, d) => (q.bn > 0.35 && (d < 4 ? q.i === 3 || q.i === 4 : q.i === 3) ? P(B.fingers, MAT.rubber) : P(B.base, MAT.knit)),
    bulge: (q, d) => ((d < 4 ? q.i >= 3 && q.i <= 4 : q.i === 3) ? 0.06 : 0),
    wear: digitWear,
  });
  // Knuckle plate: a hard shell across the back of the knuckles.
  {
    const s = L - 0.12;
    const path: V3[] = [];
    for (let i = 0; i <= 6; i++) path.push(backPoint(h, s, -0.86 + (1.72 * i) / 6, 0.1));
    const rows = path.map((p, i) => {
      const d = norm(sub(path[Math.min(6, i + 1)], path[Math.max(0, i - 1)]));
      const nn = norm(sub(scale(h.palmN, -1), scale(d, dot(scale(h.palmN, -1), d))));
      const along = norm(cross(nn, d));
      return ring(p, along, nn, 0.5, 0.17, 8, 3.2);
    });
    emit(b, rows, { paint: () => P(B.tips, MAT.plate), weight: () => [[h.hand, 1]], fin: (i, k) => [k === 0 || k === 4 ? 0.12 : NO_SEAM, i * 0.3, i === 0 || i === 6 ? 0.8 : 0.35], capStart: P(B.tips, MAT.plate), capEnd: P(B.tips, MAT.plate) });
  }
  // Finger guards on the proximal segments (and the thumb's).
  for (const dg of h.digits) {
    const [i0, i1] = dg.thumb ? [2, 4] : [1, 3];
    const c = lerp3(dg.path[i0], dg.path[i1], 0.55);
    const dir = norm(sub(dg.path[i1], dg.path[i0]));
    const n0 = norm(sub(scale(h.palmN, -1), scale(dir, dot(scale(h.palmN, -1), dir))));
    // The thumb's back is its side away from the fingers (its frame's u axis is ⟂ the palm normal).
    const side = dg.thumb ? norm(add(n0, scale(norm(cross(dir, h.palmN)), dot(cross(dir, h.palmN), h.wAx) > 0 ? -THUMB_TWIST : THUMB_TWIST))) : n0;
    dome(b, add(c, scale(side, (dg.thumb ? dg.ru[i0 + 1] : dg.rv[2]) * 0.92)), side, dir, dg.thumb ? 0.5 : 0.42, 0.3, 0.14, P(B.tips, MAT.plate), [[dg.bones[dg.thumb ? 1 : 0], 1]], 6, { seam: NO_SEAM, wear: 0.6 });
  }
  // Long cuff over the sleeve, with a strap round it.
  const L0 = h.L;
  cuff(b, h, [
    [L0 - 1.45, 2.14],
    [L0 - 1.3, 2.26],
    [L0 + 0.1, 2.3],
    [L0 + 0.5, 2.18],
    [L0 + 0.68, 1.96],
  ], () => P(B.strap, MAT.leather), { N: 16, seams: [L0 - 1.3, L0 + 0.5], wear: (j) => (j === 0 || j === 4 ? 0.8 : 0.15) });
  cuff(b, h, [
    [L0 - 0.75, 2.33],
    [L0 - 0.45, 2.41],
    [L0 - 0.15, 2.34],
  ], () => P(B.tips, MAT.rubber), { N: 16, seams: [L0 - 0.6, L0 - 0.3], wear: () => 0.3 });
};

/** Specialist: tactical fingerless, rubber palm grip, a reinforced knuckle strip, a gauntlet cuff with a pull tab. */
const specialist: StyleFn = (b, h) => {
  const L = h.palmL;
  const k0 = L - 0.35;
  palm(b, h, {
    rows: [1.0, L * 0.5, k0],
    paint: (q) => {
      if (q.bn > 0.35 && q.s > k0) return P(B.tips, MAT.rubber);
      if (q.bn < -0.45 && q.s > 1.0) return P(B.fingers, MAT.rubber);
      if (q.bn > 0.6 && q.s > L * 0.5) return P(B.fingers, MAT.knit);
      return P(B.base, MAT.leather);
    },
    bulge: (q) => (q.bn > 0.3 && q.s > k0 ? 0.08 * smoothstep(0.3, 0.7, q.bn) : 0),
    wear: palmWear(h),
  });
  digits(b, h, {
    paint: (q, d) => {
      if (isTip(q, d)) return P(B.paw, MAT.fuzz);
      if (q.bn < -0.3 && q.i >= 1) return P(B.fingers, MAT.rubber);
      return P(B.base, MAT.leather);
    },
    wear: (q, d) => ((d < 4 ? q.i === 4 : q.i === 3) ? 0.9 : digitWear(q, d)),
  });
  // Gauntlet cuff, a velcro strap round it, the pull tab off its top edge.
  const L0 = h.L;
  cuff(b, h, [
    [L0 - 1.9, 2.2],
    [L0 - 1.75, 2.36],
    [L0 - 0.6, 2.3],
    [L0 + 0.3, 2.2],
    [L0 + 0.5, 2.12],
    [L0 + 0.68, 1.96],
  ], () => P(B.strap, MAT.leather), { seams: [L0 - 1.75, L0 + 0.5], wear: (j) => (j <= 1 ? 0.8 : 0.1) });
  cuff(b, h, [
    [L0 - 1.0, 2.31],
    [L0 - 0.95, 2.4],
    [L0 - 0.2, 2.34],
    [L0 - 0.15, 2.25],
  ], () => P(B.fingers, MAT.velcro), { seams: [L0 - 0.95, L0 - 0.2] });
  {
    const c0 = add(h.root, scale(h.dA, L0 - 1.75));
    const out = scale(h.fv, -1);
    const path: V3[] = [0, 0.35, 0.7].map((t) => add(add(c0, scale(out, 2.36 * 0.84 - 0.02)), scale(h.dA, -t)));
    strip(b, path, () => 0.3, 0.05, () => out, P(B.tips, MAT.rubber), () => [[h.arm, 1]], 0.6);
  }
};

/** Paw Pads: fuzzy mitts, a paw print on the back, toe-bean fingertips, a fluffy cuff. */
const paws: StyleFn = (b, h) => {
  const L = h.palmL;
  palm(b, h, {
    paint: () => P(B.base, MAT.fuzz),
    bulge: (q) => (q.bn > 0.2 ? 0.04 : 0),
  });
  digits(b, h, {
    paint: (q, d) => (isTip(q, d) && (q.bn < -0.25 || q.i >= (d < 4 ? 7 : 6)) ? P(B.tips, MAT.rubber) : P(B.fingers, MAT.fuzz)),
    bulge: () => 0.05,
  });
  // Paw print: main pad + four toe beans on the back of the hand.
  const back = scale(h.palmN, -1);
  dome(b, backPoint(h, L * 0.42, 0.04, 0.02), back, h.ax, 0.62, 0.52, 0.13, P(B.tips, MAT.rubber), [[h.hand, 1]], 10);
  for (const [s, a, r] of [
    [L * 0.75, -0.6, 0.21],
    [L * 0.82, -0.2, 0.23],
    [L * 0.82, 0.22, 0.23],
    [L * 0.75, 0.62, 0.21],
  ] as const)
    dome(b, backPoint(h, s, a, 0.02), back, h.ax, r * 1.15, r, 0.1, P(B.tips, MAT.rubber), [[h.hand, 1]], 8);
  // Fluffy cuff: scalloped, two puffy rows.
  handBand(b, h, [0.45, 0.6, 0.85, 1.1, 1.22], (j, k) => [0.06, 0.26, 0.32, 0.24, 0.06][j] + (j > 0 && j < 4 ? 0.07 * Math.sin(k * 2.1 + j) : 0), () => P(B.strap, MAT.fuzz), { N: 18 });
};

/** Garden: canvas, rubber-dipped fingertips and palm, an elastic cuff band. */
const garden: StyleFn = (b, h) => {
  const L = h.palmL;
  palm(b, h, {
    rows: [L * 0.45],
    paint: (q) => (q.bn < -0.5 && q.s > L * 0.45 ? P(B.tips, MAT.rubber) : P(B.base, MAT.canvas)),
    wear: palmWear(h),
  });
  digits(b, h, {
    paint: (q, d) => ((d < 4 ? q.i >= 4 : q.i >= 3) ? P(B.tips, MAT.rubber) : P(B.fingers, MAT.canvas)),
    wear: digitWear,
  });
  handBand(b, h, [0.5, 0.58, 1.1, 1.18], (j) => (j === 0 || j === 3 ? 0.06 : 0.13), () => P(B.strap, MAT.knit), { seams: [0.58, 1.1], wear: (j) => (j === 3 ? 0.6 : 0.1) });
};

/** Plush's soft charcoal hands, cream piping and a seam across the back. */
const plush: StyleFn = (b, h) => {
  palm(b, h, {
    rows: [h.palmL * .45, h.palmL * .45 + .09],
    paint: q => q.s > h.palmL * .45 && q.s < h.palmL * .45 + .09 && q.bn > .35
      ? P(B.strap, MAT.canvas) : P(B.base, MAT.fuzz),
    bulge: q => q.bn > .2 ? .04 : 0,
  });
  digits(b, h, { paint: () => P(B.fingers, MAT.fuzz), bulge: () => .05 });
  handBand(b, h, [.5, .6, 1.1, 1.2], j => j === 0 || j === 3 ? .04 : .16,
    () => P(B.tips, MAT.fuzz));
  // Short cross-stitches following the padded back, away from the grip surface.
  for (const a of [-.6, -.3, 0, .3, .6]) {
    const path = [backPoint(h, h.palmL * .45 - .12, a, .05), backPoint(h, h.palmL * .45 + .17, a, .05)];
    strip(b, path, () => .025, .025, () => scale(h.palmN, -1), P(B.detail, MAT.canvas), () => [[h.hand, 1]]);
  }
};

/** Bun-E's ceramic hand shells with exposed black finger hinges and gold perimeter. */
const bune: StyleFn = (b, h) => {
  palm(b, h, {
    seamless: true,
    rows: [.55, .66, h.palmL * .72, h.palmL * .72 + .08],
    paint: q => {
      if (q.bn < -.25 || q.s < .55) return P(B.fingers, MAT.rubber);
      if (q.s < .66 || (q.s > h.palmL * .72 && q.s < h.palmL * .72 + .08)) return P(B.tips, MAT.metal);
      return P(B.base, MAT.plate);
    },
  });
  digits(b, h, {
    seamless: true,
    paint: (q, d) => {
      const joint = d < 4 ? q.i === 0 || q.i === 3 || q.i === 5 : q.i === 0 || q.i === 2 || q.i === 4;
      return joint || q.bn < -.35 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.plate);
    },
  });
};

/** Matching forearms belong to the glove, so they also work with other outfits. */
function supporterSleeve(b: Builder, h: Hand, robot: boolean): void {
  const L = h.L;
  if (robot) {
    cuff(b, h, [[-14,2.3],[-7,2.25],[-2,2.15],[2,2.0],[L-3.2,1.85],[L-1.5,1.7],[L-.8,1.45],[L+.35,1.45]],
      j => j >= 6 ? P(B.fingers, MAT.rubber) : j === 5 ? P(B.tips, MAT.metal) : P(B.base, MAT.plate), { seamless: true });
  } else {
    cuff(b, h, [[-14,2.55],[-7,2.45],[-2,2.35],[2,2.22],[L-3.2,2.0],[L-1.35,1.9],[L-1.15,2.12],[L-.2,2.16],[L+.35,2.1],[L+.62,1.78]],
      j => P(j >= 5 ? B.strap : B.tips, MAT.fuzz));
  }
}

/** How far the thumb guard turns from the back of the hand toward the thumb's outer (camera) side. */
const THUMB_TWIST = -2.5;

const STYLES: Record<Exclude<GloveStyleId, "knit">, StyleFn> = { sport, driver, wraps, moto, specialist, paws, garden, plush, bune };

/** Styles whose cuff covers the sleeve's trim (the trim rows under it aren't built). */
const LONG_CUFF: Partial<Record<GloveStyleId, number>> = { moto: -1.3, specialist: -1.3 };

/** Both hands + sleeves in a glove style (the knit glove: the original geometry). */
export function buildFpHands(b: Builder, style: GloveStyleId = "knit"): void {
  const r = vmRig();
  for (const side of ["R", "L"] as const) {
    const h = handOf(r, side);
    const cut = LONG_CUFF[style];
    if (style === "plush" || style === "bune") supporterSleeve(b, h, style === "bune");
    else sleeve(b, h, cut !== undefined ? h.L + cut : Infinity);
    if (style === "knit") knit(b, h);
    else STYLES[style](b, h);
  }
}
