// Third-person gloves on the bunny (player/bunny/mesh.ts), per glove style (loadout.ts GLOVE_STYLE): the LOD twin of
// gloves/fp.ts. The bunny's glove is a palm block, an index block, a middle-ring-pinky block and the thumb, lofted along
// the CS:S player hand bones; every style keeps those lofts (the CS:S grips and the knife twins fit the same) and changes
// paint + material per face (gloves/paint.ts), with a few low-poly extras: cuffs / gauntlets over the sleeve trim,
// straps, the moto knuckle plate, the paw print, wrap tails, the driver's snap. The knit glove is the original geometry.
// Seen at a distance, so: fewer segments, no stitch-only rows; the shader detail is the same as first person.

import { add, blend, Builder, clamp, frame, len, lerp3, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "../../player/bunny/builder";
import { rig as bunnyRig, type V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { dome, emit, strip, type Q } from "./fp";
import { gp, MAT, NO_SEAM, PAL_SLOT, SLOT_G } from "./paint";

const GLOVE: Paint = { code: 3 + PAL_SLOT.glove };
const P = gp;
const B = SLOT_G;

interface TpHand {
  b: Builder;
  hand: number;
  fore: number;
  wr: V3;
  /** Forearm direction (elbow -> wrist), its frame, and its length. */
  d2: V3;
  el: V3;
  L2: number;
  ax: V3;
  wAx: V3;
  /** Palm side (toward the thumb). */
  palmN: V3;
  /** The sin axis of the palm rings (nAx: ±palmN). */
  nAx: V3;
  palmL: number;
  fingers: { names: string[]; hw: number; ht: number; shift: number; path: V3[]; bones: number[] }[];
}

function handOf(b: Builder, side: "L" | "R"): TpHand {
  const r = bunnyRig();
  const at = (n: string) => r.at(`${side}_${n}`);
  const hand = r.bone(`${side}_Hand`), fore = r.bone(`${side}_Forearm`);
  const wr = at("Hand"), el = at("Forearm");
  const f1 = at("Finger1"), f2 = at("Finger2");
  const knuckle = lerp3(f1, f2, 0.62);
  const ax = norm(sub(knuckle, wr));
  const across0 = norm(sub(f1, f2));
  const [, wAx, nAx] = frame(ax, across0);
  const palmN: V3 = dot(nAx, sub(at("Finger0"), wr)) > 0 ? nAx : scale(nAx, -1);
  const fingers = (
    [
      [["Finger1", "Finger11", "Finger12"], 0.62, 0.6, 0],
      [["Finger2", "Finger21", "Finger22"], 1.25, 0.66, -0.55],
      [["Finger0", "Finger01", "Finger02"], 0.62, 0.62, 0],
    ] as const
  ).map(([names, hw, ht, shift]) => {
    const pts = names.map((n) => at(n));
    const last = pts[pts.length - 1];
    const tipDir = norm(sub(last, pts[pts.length - 2]));
    const path = [sub(pts[0], scale(norm(sub(pts[1], pts[0])), 0.7)), ...pts, add(last, scale(tipDir, 1.05))];
    return { names: [...names], hw, ht, shift, path, bones: names.map((n) => r.bone(`${side}_${n}`)) };
  });
  return { b, hand, fore, wr, d2: norm(sub(wr, el)), el, L2: len(sub(wr, el)), ax, wAx, palmN, nAx, palmL: len(sub(knuckle, wr)), fingers };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function palmRows(h: TpHand): [number, number, number][] {
  return [
    [-0.9, 1.25, 0.95],
    [0.1, 1.65, 1.08],
    [h.palmL * 0.5, 1.85, 1.0],
    [h.palmL - 0.2, 1.85, 0.88],
    [h.palmL + 0.45, 1.55, 0.72],
  ];
}

interface PalmSpec {
  seamless?: boolean;
  rows?: number[];
  paint(q: Q): Paint;
  bulge?(q: Q): number;
  wear?(q: Q): number;
}

function profile(h: TpHand, s: number): [number, number] {
  const base = palmRows(h);
  if (s <= base[0][0]) return [base[0][1], base[0][2]];
  for (let i = 0; i + 1 < base.length; i++)
    if (s <= base[i + 1][0]) {
      const t = (s - base[i][0]) / (base[i + 1][0] - base[i][0]);
      return [base[i][1] + (base[i + 1][1] - base[i][1]) * t, base[i][2] + (base[i + 1][2] - base[i][2]) * t];
    }
  const l = base[base.length - 1];
  return [l[1], l[2]];
}

const N_PALM = 14;
/** The palm ring's centre at s (the original's offset across the hand). */
const palmC = (h: TpHand, s: number): V3 => add(add(h.wr, scale(h.ax, s)), scale(h.wAx, -0.25));

function palm(h: TpHand, sp: PalmSpec): void {
  const ss = [...new Set([...palmRows(h).map((r) => r[0]), ...(sp.rows ?? [])])].sort((a, b) => a - b);
  const sgn = dot(h.nAx, h.palmN) > 0 ? 1 : -1;
  const bnOf = (k: number) => -Math.sin((k / N_PALM) * Math.PI * 2) * sgn;
  const acOf = (k: number) => Math.cos((k / N_PALM) * Math.PI * 2);
  const rows = ss.map((s, i) => {
    const [hw, ht] = profile(h, s);
    const c = palmC(h, s);
    const rr = ring(c, h.wAx, h.nAx, hw, ht, N_PALM, 2.6);
    if (!sp.bulge) return rr;
    return rr.map((p, k) => {
      const e = sp.bulge!({ i, s, bn: bnOf(k), ac: acOf(k) });
      return e ? add(p, scale(norm(sub(p, c)), e)) : p;
    });
  });
  const mid = (i: number) => (ss[i] + ss[Math.min(ss.length - 1, i + 1)]) / 2;
  emit(h.b, rows, {
    seamless: sp.seamless,
    paint: (i, k) => sp.paint({ i, s: mid(i), bn: bnOf(k + 0.5), ac: acOf(k + 0.5) }),
    weight: () => [[h.hand, 1]],
    fin: (i, k) => [NO_SEAM, ss[i], sp.wear?.({ i, s: ss[i], bn: bnOf(k), ac: acOf(k) }) ?? 0],
    capStart: sp.paint({ i: 0, s: ss[0], bn: 0, ac: 0 }),
    capEnd: sp.paint({ i: ss.length - 1, s: ss[ss.length - 1], bn: 0.3, ac: 0 }),
  });
}

interface DigitSpec {
  seamless?: boolean;
  /** Quad rows: 0 into the hand, 1 proximal, 2 middle, 3 distal / tip. d: 0 index, 1 middle-ring-pinky, 2 thumb. */
  paint(q: Q, d: number): Paint;
  bulge?(q: Q, d: number): number;
  wear?(q: Q, d: number): number;
}

function digits(h: TpHand, sp: DigitSpec): void {
  h.fingers.forEach((f, d) => {
    const n = f.path.length;
    const M = 10;
    const frames = f.path.map((_, i) => {
      const dir = norm(sub(f.path[Math.min(n - 1, i + 1)], f.path[Math.max(0, i - 1)]));
      const [, u, v] = frame(dir, h.wAx);
      return [u, v] as const;
    });
    const off = (i: number, k: number) => {
      const a = (k / M) * Math.PI * 2;
      const [u, v] = frames[i];
      return norm(add(scale(u, Math.cos(a)), scale(v, Math.sin(a))));
    };
    const bnAt = (i: number, k: number) => -dot(off(i, k), h.palmN);
    const acAt = (i: number, k: number) => dot(off(i, k), h.wAx);
    const A: number[] = [0];
    for (let i = 1; i < n; i++) A.push(A[i - 1] + len(sub(f.path[i], f.path[i - 1])));
    const rows = f.path.map((p, i) => {
      const [u, v] = frames[i];
      const taper = i === n - 1 ? 0.55 : 1;
      const c = add(p, scale(u, f.shift));
      const rr = ring(c, u, v, f.hw * taper, f.ht * taper, M, 2.3);
      if (!sp.bulge) return rr;
      return rr.map((q, k) => {
        const bn = bnAt(i, k);
        if (bn <= 0) return q;
        const e = sp.bulge!({ i, s: A[i], bn, ac: acAt(i, k) }, d) * smoothstep(0, 0.6, bn);
        return e ? add(q, scale(norm(sub(q, c)), e)) : q;
      });
    });
    emit(h.b, rows, {
      seamless: sp.seamless,
      paint: (i, k) => sp.paint({ i, s: (A[i] + A[Math.min(n - 1, i + 1)]) / 2, bn: (bnAt(i, k) + bnAt(i, k + 1)) / 2, ac: (acAt(i, k) + acAt(i, k + 1)) / 2 }, d),
      weight: (i) => (i === 0 ? blend(h.hand, f.bones[0], 0.5) : [[f.bones[Math.min(f.bones.length - 1, i - 1)], 1]]),
      fin: (i, k) => [NO_SEAM, A[i], sp.wear?.({ i, s: A[i], bn: bnAt(i, k), ac: acAt(i, k) }, d) ?? 0],
      capStart: sp.paint({ i: 0, s: 0, bn: 0, ac: 0 }, d),
      capEnd: sp.paint({ i: n - 2, s: A[n - 1], bn: -1, ac: 0 }, d),
    });
  });
}

/** Band round the hand (palm frame) at s values, `grow` over the palm. */
function handBand(h: TpHand, s: number[], grow: (j: number, k: number) => number, paint: Paint, wear = 0.3, N = 12): void {
  const rows = s.map((x, j) => {
    const [hw, ht] = profile(h, x);
    const pts: V3[] = [];
    for (let k = 0; k < N; k++) pts.push(ring(palmC(h, x), h.wAx, h.nAx, hw + grow(j, k), ht + grow(j, k), N, 2.6)[k]);
    return pts;
  });
  emit(h.b, rows, { paint: () => paint, weight: () => [[h.hand, 1]], fin: (j) => [j === 0 || j === s.length - 1 ? 0.12 : NO_SEAM, s[j], wear] });
}

/** Cuff round the forearm: rows [s from the wrist along the forearm (negative = toward the elbow), radius]. */
function cuff(h: TpHand, rows0: [number, number][], paint: Paint, wobble?: (j: number, a: number) => number, N = 12): void {
  const ref: V3 = [0, 1, 0];
  const [, u, v] = frame(h.d2, ref);
  const rows = rows0.map(([s, rad], j) => {
    const c = add(h.wr, scale(h.d2, s));
    const pts = ring(c, u, v, rad * 1.04, rad, N);
    return wobble ? pts.map((p, k) => add(p, scale(norm(sub(p, c)), wobble(j, (k / N) * Math.PI * 2)))) : pts;
  });
  emit(h.b, rows, {
    paint: () => paint,
    weight: (j) => {
      const s = rows0[j][0];
      const t = clamp((s + 0.6) / 1.4, 0, 1);
      return t <= 0 ? [[h.fore, 1]] : [[h.fore, 1 - t * 0.7], [h.hand, t * 0.7]];
    },
    fin: (j) => [j === 1 || j === rows0.length - 2 ? 0.1 : NO_SEAM, rows0[j][0], j === 0 || j === rows0.length - 1 ? 0.7 : 0.15],
  });
}

/** A point on the back of the hand: s along, a across (-1..1), out above the surface. */
function backPoint(h: TpHand, s: number, a: number, out = 0): V3 {
  const [hw, ht] = profile(h, s);
  const y = ht * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(a), 2.6)), 1 / 2.6);
  return add(add(palmC(h, s), scale(h.wAx, a * hw)), scale(h.palmN, -(y + out)));
}

const tip = (q: Q) => q.i >= 3;
const palmWear = (h: TpHand) => (q: Q) => (q.bn > 0.55 && q.s > h.palmL - 0.4 ? 0.8 : 0);
const digitWear = (q: Q) => (tip(q) ? 0.6 : q.bn > 0.6 && q.i === 1 ? 0.6 : 0);
const back = (h: TpHand) => scale(h.palmN, -1);

type StyleFn = (h: TpHand) => void;

const sport: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, {
    rows: [1.0, L - 0.1],
    paint: (q) => (q.bn > 0.42 && q.s > 1.0 && q.s < L - 0.1 ? P(B.fingers, MAT.rubber) : q.bn < -0.55 && q.s > 1.0 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.knit)),
    bulge: (q) => (q.bn > 0.4 && q.s > 1.0 && q.s < L - 0.1 ? 0.12 : 0),
    wear: palmWear(h),
  });
  digits(h, { paint: (q) => (Math.abs(q.bn) < 0.4 && q.i >= 1 && !tip(q) ? P(B.fingers, MAT.perf) : P(B.base, MAT.knit)), wear: digitWear });
  handBand(h, [-0.45, -0.35, 0.75, 0.85], (j) => (j === 0 || j === 3 ? 0.08 : 0.16), P(B.strap, MAT.knit));
};

const driver: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, {
    rows: [-0.4, 1.2, L * 0.62],
    paint: (q) => (q.bn > 0.5 && q.s > -0.4 && q.s < 1.2 ? P(B.paw, MAT.fuzz) : q.bn > 0.35 && q.s > L * 0.62 ? P(B.base, MAT.perf) : q.s < -0.4 ? P(B.strap, MAT.leather) : P(B.base, MAT.leather)),
    wear: palmWear(h),
  });
  digits(h, { paint: (q, d) => (q.bn > 0.35 && q.i === 1 ? P(B.base, MAT.perf) : P(d === 2 ? B.base : B.fingers, MAT.leather)), wear: digitWear });
  const tab: V3[] = [-0.75, 0, 0.75].map((a) => backPoint(h, 0.4, a, 0.04));
  strip(h.b, tab, () => 0.3, 0.06, () => back(h), P(B.strap, MAT.leather), () => [[h.hand, 1]], 0.4);
  dome(h.b, backPoint(h, 0.4, 0.4, 0.1), back(h), h.ax, 0.2, 0.2, 0.1, P(B.detail, MAT.metal), [[h.hand, 1]], 6);
};

const wraps: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, { rows: [-0.4, L * 0.62], paint: (q) => (q.s < -0.4 ? P(B.paw, MAT.fuzz) : P(B.base, MAT.wrap)), bulge: (q) => (q.s > -0.4 ? 0.06 + (q.bn > 0.4 && q.s > L * 0.62 ? 0.1 : 0) : 0), wear: palmWear(h) });
  digits(h, { paint: (q, d) => ((d === 2 ? q.i <= 1 : q.i <= 1) ? P(B.fingers, MAT.wrap) : P(B.paw, MAT.fuzz)), bulge: (q) => (q.i <= 1 ? 0.07 : 0), wear: (q) => (q.i === 2 ? 0.8 : 0) });
  handBand(h, [-0.55, -0.45, 0.35, 0.45], (j) => (j === 0 || j === 3 ? 0.1 : 0.22), P(B.strap, MAT.wrap), 0.4);
  for (const [a, l] of [
    [-0.92, 2.4],
    [-0.7, 1.8],
  ] as const) {
    const st = backPoint(h, 0, a, 0.2);
    const path: V3[] = [0, 0.33, 0.66, 1].map((t) => add(add(add(st, scale(h.ax, -l * t * 0.35)), scale(h.wAx, -l * t * 0.6)), scale(h.palmN, 0.7 * l * t * t)));
    strip(h.b, path, (i) => 0.3 - i * 0.03, 0.05, () => h.wAx, P(B.base, MAT.wrap), () => [[h.hand, 1]], 0.9);
  }
};

const moto: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, {
    rows: [0.9, L * 0.66],
    paint: (q) => (q.bn > 0.4 && q.s > 0.9 && q.s < L * 0.66 ? P(B.fingers, MAT.rubber) : q.bn < -0.5 && q.s > 0.9 ? P(B.fingers, MAT.leather) : P(B.base, MAT.knit)),
    bulge: (q) => (q.bn > 0.4 && q.s > 0.9 && q.s < L * 0.66 ? 0.1 : 0),
    wear: palmWear(h),
  });
  digits(h, { paint: (q) => (q.bn > 0.35 && q.i === 1 ? P(B.tips, MAT.plate) : q.bn > 0.35 && q.i === 2 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.knit)), bulge: (q) => (q.i === 1 ? 0.1 : 0), wear: digitWear });
  // Knuckle plate.
  const path: V3[] = [];
  for (let i = 0; i <= 4; i++) path.push(backPoint(h, L - 0.1, -0.85 + (1.7 * i) / 4, 0.12));
  const rows = path.map((p, i) => {
    const d = norm(sub(path[Math.min(4, i + 1)], path[Math.max(0, i - 1)]));
    const nn = norm(sub(back(h), scale(d, dot(back(h), d))));
    const along = norm([d[1] * nn[2] - d[2] * nn[1], d[2] * nn[0] - d[0] * nn[2], d[0] * nn[1] - d[1] * nn[0]]);
    return ring(p, along, nn, 0.6, 0.22, 6, 2.6);
  });
  emit(h.b, rows, { paint: () => P(B.tips, MAT.plate), weight: () => [[h.hand, 1]], fin: (i) => [NO_SEAM, i * 0.4, i === 0 || i === 4 ? 0.8 : 0.3], capStart: P(B.tips, MAT.plate), capEnd: P(B.tips, MAT.plate) });
  cuff(h, [
    [-2.1, 2.84],
    [-1.95, 2.96],
    [-0.5, 2.96],
    [0.2, 2.5],
    [0.45, 2.2],
  ], P(B.strap, MAT.leather));
  cuff(h, [
    [-1.5, 2.99],
    [-1.2, 3.07],
    [-0.9, 3.0],
  ], P(B.tips, MAT.rubber));
};

const specialist: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, {
    rows: [0.9, L - 0.35],
    paint: (q) => (q.bn > 0.35 && q.s > L - 0.35 ? P(B.tips, MAT.rubber) : q.bn < -0.45 && q.s > 0.9 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.leather)),
    bulge: (q) => (q.bn > 0.35 && q.s > L - 0.35 ? 0.09 : 0),
    wear: palmWear(h),
  });
  digits(h, { paint: (q) => (tip(q) ? P(B.paw, MAT.fuzz) : q.bn < -0.3 && q.i >= 1 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.leather)), wear: (q) => (q.i === 2 ? 0.9 : 0) });
  cuff(h, [
    [-2.6, 2.84],
    [-2.45, 2.98],
    [-0.9, 2.94],
    [0.2, 2.5],
    [0.45, 2.2],
  ], P(B.strap, MAT.leather));
  cuff(h, [
    [-1.5, 2.96],
    [-1.4, 3.05],
    [-0.6, 3.0],
    [-0.5, 2.92],
  ], P(B.fingers, MAT.velcro));
};

const paws: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, { paint: () => P(B.base, MAT.fuzz), bulge: (q) => (q.bn > 0.2 ? 0.05 : 0) });
  digits(h, { paint: (q) => (tip(q) && q.bn < -0.2 ? P(B.tips, MAT.rubber) : P(B.fingers, MAT.fuzz)), bulge: () => 0.05 });
  dome(h.b, backPoint(h, L * 0.42, 0, 0.02), back(h), h.ax, 0.78, 0.66, 0.16, P(B.tips, MAT.rubber), [[h.hand, 1]], 8);
  for (const a of [-0.55, 0, 0.55]) dome(h.b, backPoint(h, L * 0.8 - Math.abs(a) * 0.3, a, 0.02), back(h), h.ax, 0.3, 0.27, 0.12, P(B.tips, MAT.rubber), [[h.hand, 1]], 6);
  // Palm pad (seen when the hand is open).
  dome(h.b, add(palmC(h, L * 0.45), scale(h.palmN, profile(h, L * 0.45)[1] + 0.02)), h.palmN, h.ax, 0.75, 0.65, 0.12, P(B.tips, MAT.rubber), [[h.hand, 1]], 8);
  handBand(h, [-0.65, -0.45, 0.05, 0.45, 0.6], (j, k) => [0.08, 0.35, 0.42, 0.32, 0.08][j] + (j > 0 && j < 4 ? 0.1 * Math.sin(k * 2.1 + j) : 0), P(B.strap, MAT.fuzz), 0, 14);
};

const garden: StyleFn = (h) => {
  const L = h.palmL;
  palm(h, { rows: [L * 0.45], paint: (q) => (q.bn < -0.5 && q.s > L * 0.45 ? P(B.tips, MAT.rubber) : P(B.base, MAT.canvas)), wear: palmWear(h) });
  digits(h, { paint: (q) => (q.i >= 2 ? P(B.tips, MAT.rubber) : P(B.fingers, MAT.canvas)), bulge: (q) => (q.i >= 2 ? 0.04 : 0), wear: digitWear });
  handBand(h, [-0.55, -0.45, 0.35, 0.45], (j) => (j === 0 || j === 3 ? 0.08 : 0.17), P(B.strap, MAT.knit));
};

const plush: StyleFn = h => {
  palm(h, { paint: () => P(B.base, MAT.fuzz), bulge: q => q.bn > .2 ? .04 : 0 });
  digits(h, { paint: () => P(B.fingers, MAT.fuzz), bulge: () => .05 });
  handBand(h, [-.55,-.45,.35,.45], j => j === 0 || j === 3 ? .08 : .17, P(B.tips, MAT.fuzz));
};

const bune: StyleFn = h => {
  palm(h, { seamless: true, rows: [.5,.65], paint: q => q.bn < -.25 ? P(B.fingers, MAT.rubber) : q.s > .5 && q.s < .65 ? P(B.tips, MAT.metal) : P(B.base, MAT.plate) });
  digits(h, { seamless: true, paint: q => q.i === 1 || q.bn < -.35 ? P(B.fingers, MAT.rubber) : P(B.base, MAT.plate) });
};

const STYLES: Record<Exclude<GloveStyleId, "knit">, StyleFn> = { sport, driver, wraps, moto, specialist, paws, garden, plush, bune };

/** The original knit glove (palette glove slot), exactly as player/bunny/mesh.ts always built it. */
function knit(h: TpHand): void {
  const rows = palmRows(h).map(([s, hw, ht]) => ring(palmC(h, s), h.wAx, h.nAx, hw, ht, 14, 2.6));
  h.b.surface(rows, { paint: () => GLOVE, weight: () => [[h.hand, 1]], capStart: GLOVE, capEnd: GLOVE });
  for (const f of h.fingers) {
    const n = f.path.length;
    const rowsF = f.path.map((p, i) => {
      const d = norm(sub(f.path[Math.min(n - 1, i + 1)], f.path[Math.max(0, i - 1)]));
      const [, u, v] = frame(d, h.wAx);
      const taper = i === n - 1 ? 0.55 : 1;
      return ring(add(p, scale(u, f.shift)), u, v, f.hw * taper, f.ht * taper, 10, 2.3);
    });
    h.b.surface(rowsF, {
      paint: () => GLOVE,
      weight: (_, i) => (i === 0 ? blend(h.hand, f.bones[0], 0.5) : [[f.bones[Math.min(f.bones.length - 1, i - 1)], 1]]),
      capStart: GLOVE,
      capEnd: GLOVE,
    });
  }
}

/** One gloved hand of the bunny in a style (called by player/bunny/mesh.ts after the sleeve). */
export function buildTpGlove(b: Builder, side: "L" | "R", style: GloveStyleId = "knit"): void {
  const h = handOf(b, side);
  if (style === "knit") knit(h);
  else STYLES[style](h);
}
