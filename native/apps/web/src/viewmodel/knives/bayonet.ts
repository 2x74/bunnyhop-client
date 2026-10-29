// Shared pieces of the two Supporter bayonets (thornback.ts: the big sawback clip point; thistle.ts: the slim spinner):
// the steel blade loft with its finish mask, a ribbed / wrapped grip, the hold, and the per-action flourishes on top
// of the base draw / slash / stab (the base motion and its timing stay the CS:S knife's, so attacks still read the
// same hit windows).
//
// Blade (bayonetBlade): a clip-point blade lofted along z from the guard to the tip, each row a hand-built section
// (knife-local y across, x thickness): the sharp edge at -y, a saber grind (a flat bevel up to the grind line, crisp
// crease), a fuller groove on both faces, a chamfered spine that thins into a false edge along the clip. Creases are
// doubled points (Builder.surface's central-difference normals then break there), so it stays smooth-shaded and
// low-poly yet reads as ground steel.
//
// Finish mask (finishUV, finishes/shader.ts): v = across -1 (edge) .. 1 (spine) of the section's own width, and u
// along the blade integrated so the pattern keeps its aspect: the shader maps (u, v) to pattern units (2.3 + 8.9u,
// v * finRad(u)), so du/dz = finRad(u) / (8.9 * halfWidth(z)) makes one unit along the blade and one unit across it the
// same pattern distance everywhere (the Clover Cleaver's tall slab instead stretches every pattern along). Tip
// (u ~0.95) and outline (|v| = 1, Geode's stone rim) land where every finish expects them.

import { clamp, dot, norm, ring, smoothstep, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import type { VmAction } from "../procedural";
import { edgeWeight, fixed, type KnifeCtx } from "./ctx";
import { handFrame, holdKnife, SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type HoldSpec, type KnifeDef, type KnifeState } from "./types";

export const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
export const STEEL = fixed(0xc9d3da, KMAT.polished), STEEL_DARK = fixed(0x96a3ad, KMAT.polished), BEVEL = fixed(0xf1f5f8, KMAT.polished), FULLER = fixed(0xa7b3bc, KMAT.polished);

/** The carrot blade's half width at u (finishes/shader.ts finRad): pattern units across per unit of v. */
const finRad = (u: number) => 0.8 * Math.pow(Math.max(1 - u, 0), 0.85) + 0.04;

export interface BayonetBladeSpec {
  /** Blade from the guard (z0) to the tip (z1), knife-local z. */
  z0: number;
  z1: number;
  /** Spine / edge y at s (0 guard .. 1 tip). */
  spine(s: number): number;
  edge(s: number): number;
  /** Half thickness at s. */
  thick(s: number): number;
  /** Grind line (section c: -1 edge .. 1 spine) where the edge bevel meets the flat. */
  grind: number;
  /** Fuller: s range and c range on the flat, depth (fraction of the thickness). */
  fuller: { s: [number, number]; c: [number, number]; depth: number };
  /** Where the spine starts thinning into a false edge (s). */
  clip: number;
  rows: number;
  paint?: { steel?: Paint; spine?: Paint; bevel?: Paint; fuller?: Paint };
}

/** The finish's along-coordinate u at s (aspect-preserving; see the header): a table per spec. */
export function finishAlong(sp: BayonetBladeSpec): (s: number) => number {
  const N = 400, L = sp.z1 - sp.z0;
  const tab = new Float32Array(N + 1);
  let u = 0;
  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) / N;
    const hw = Math.max(0.03, (sp.spine(s) - sp.edge(s)) / 2);
    u = Math.min(0.995, u + (finRad(u) / (8.9 * hw)) * (L / N));
    tab[i + 1] = u;
  }
  return (s) => {
    const f = clamp(s, 0, 1) * N, i = Math.min(N - 1, Math.floor(f));
    return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
  };
}

/** Lofts the blade (PART.blade with the finish mask). Returns `along` (s -> finish u) for parts on the blade (a saw). */
export function bayonetBlade(k: KnifeCtx, sp: BayonetBladeSpec): (s: number) => number {
  const fp = k.view === "fp";
  const along = finishAlong(sp);
  const P = { steel: STEEL, spine: STEEL_DARK, bevel: BEVEL, fuller: FULLER, ...sp.paint };
  // Half profile (+x side) from the edge to the spine: c, thickness factor, a crease (doubled point), in the fuller.
  // Third person drops the fuller and the creases (smaller, farther).
  type Pt = { c: number; t: number; crease?: boolean; fuller?: number };
  const [f0, f1] = sp.fuller.c;
  const half: Pt[] = fp
    ? [
        { c: sp.grind, t: 1, crease: true },
        { c: f0, t: 1, crease: true },
        { c: f0 + (f1 - f0) * 0.3, t: 1, fuller: 1 },
        { c: f0 + (f1 - f0) * 0.7, t: 1, fuller: 1 },
        { c: f1, t: 1, crease: true },
        { c: 0.86, t: 1, crease: true },
        { c: 1, t: 0.6, crease: true },
      ]
    : [
        { c: sp.grind, t: 1 },
        { c: 0.86, t: 1 },
        { c: 1, t: 0.6 },
      ];
  // Columns of one row: the edge apex, the +x side up, then the -x side back down (closed ring).
  const cols: { c: number; side: number; p: Pt | null }[] = [{ c: -1, side: 0, p: null }];
  for (const p of half) for (let d = 0; d < (p.crease ? 2 : 1); d++) cols.push({ c: p.c, side: 1, p });
  for (let j = half.length - 1; j >= 0; j--) for (let d = 0; d < (half[j].crease ? 2 : 1); d++) cols.push({ c: half[j].c, side: -1, p: half[j] });
  // Face paint between column k and k+1: the edge bevel (touching the apex), the spine (chamfers and top), the fuller,
  // the flat.
  const facePaint = cols.map((cc, kk) => {
    const nx = cols[(kk + 1) % cols.length];
    if (cc.side === 0 || nx.side === 0) return P.bevel;
    const lo = Math.min(cc.c, nx.c);
    if (lo >= 0.86 - 1e-6) return P.spine;
    if (fp && lo >= f0 - 1e-6 && lo < f1 - 1e-6) return P.fuller;
    return P.steel;
  });
  const n = fp ? sp.rows : Math.max(8, Math.round(sp.rows * 0.6));
  const rows: V3[][] = [];
  const fins: [number, number, number][][] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const z = sp.z0 + (sp.z1 - sp.z0) * s;
    const yS = sp.spine(s), yE = sp.edge(s);
    const mid = (yS + yE) / 2, hw = Math.max(0.006, (yS - yE) / 2);
    const th = Math.max(0.006, sp.thick(s));
    // The fuller tapers to a point at both ends (narrower and shallower: a deliberate run-out, no pinched dents); the
    // spine chamfer thins into a false edge past the clip.
    const [fs0, fs1] = sp.fuller.s;
    const gw = smoothstep(fs0, fs0 + 0.1, s) * (1 - smoothstep(fs1 - 0.14, fs1, s));
    const fd = sp.fuller.depth * Math.sqrt(gw);
    const cm = (f0 + f1) / 2;
    const fe = 1 - 0.8 * smoothstep(sp.clip, sp.clip + 0.12, s);
    const u = along(s);
    const row: V3[] = [];
    const fr: [number, number, number][] = [];
    for (const cc of cols) {
      const c = fp && cc.p && cc.c >= f0 - 1e-6 && cc.c <= f1 + 1e-6 ? cm + (cc.c - cm) * (0.04 + 0.96 * gw) : cc.c;
      let tx = 0;
      if (cc.p) {
        tx = cc.p.t;
        if (cc.p.fuller) tx *= 1 - fd;
        if (cc.c >= 0.99) tx *= fe;
        else if (cc.c > 0.5) tx *= 0.55 + 0.45 * fe;
      }
      row.push([cc.side * th * tx, mid + c * hw, z]);
      fr.push([u, c, edgeWeight(u, Math.max(0, -c * 1.1))]);
    }
    rows.push(row);
    fins.push(fr);
  }
  // Normals face out by side (+x / -x faces, the edge apex down, the spine top up): the row centroid sits toward the
  // heavy spine, which would turn the fuller's lower wall inside out.
  const outRef = cols.map((cc): V3 => (cc.side === 0 ? [0, -1, 0] : [cc.side, cc.c >= 0.99 ? 0.6 : 0, 0]));
  k.surface(rows, { paint: (_i, kk) => facePaint[kk], part: PART.blade, fin: (i, kk) => fins[i][kk], capStart: null, capEnd: null, out: (_i, kk) => outRef[kk] });
  return along;
}

/** A sawback along the spine: slanted teeth from s0 to s1 (PART.blade, painted as the spine, finish v 0.62 -> 1). */
export function sawback(k: KnifeCtx, sp: BayonetBladeSpec, along: (s: number) => number, s0: number, s1: number, teeth: number, height: number, paint: Paint): void {
  const rows: V3[][] = [];
  const fin: [number, number, number][] = [];
  const steps = teeth * 2;
  for (let i = 0; i <= steps; i++) {
    // Valleys at even rows, peaks at odd ones: thorns, swept back toward the guard (the tip 22 % into its tooth).
    const ss = s0 + ((s1 - s0) * (Math.floor(i / 2) + (i % 2 ? 0.22 : 0))) / teeth;
    const z = sp.z0 + (sp.z1 - sp.z0) * ss;
    const y = sp.spine(ss);
    const tw = sp.thick(ss) * 0.5;
    const h = i % 2 ? height : 0.012;
    rows.push([[tw, y - 0.05, z], [tw, y + h, z], [-tw, y + h, z], [-tw, y - 0.05, z]]);
    fin.push([along(ss), 1, 0.4]);
  }
  // Finish v: the teeth's roots sit well inside the blade's rim (0.62), their tips on the outline (1), so a rim-following
  // finish (Geode's stone and agate bands) runs round every tooth instead of stopping at the spine line.
  k.surface(rows, { paint: () => paint, part: PART.blade, fin: (i, kk) => [fin[i][0], kk === 0 || kk === 3 ? 0.62 : 1, fin[i][2]], flat: true, capStart: paint, capEnd: paint });
}

/**
 * Oval grip from z0 to z1 (half sizes rx, ry, centre y cy): ribs (every other row swells), a palm swell, rounded ends.
 * `wrap`: a diamond cord wrap instead (rows alternate their phase, faces alternate colours).
 */
export function bayonetGrip(k: KnifeCtx, o: { z0: number; z1: number; rx: number; ry: number; cy?: number; ribs: number; a: Paint; b: Paint; wrap?: boolean }): void {
  const fp = k.view === "fp";
  const n = fp ? o.ribs * 2 : Math.max(6, o.ribs);
  const seg = fp ? 12 : 8;
  const rows: V3[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = o.z0 + (o.z1 - o.z0) * t;
    // Palm swell toward the pommel third, slightly narrower under the guard.
    const sw = 1 + 0.07 * Math.sin(Math.PI * clamp((t - 0.05) / 0.75, 0, 1)) - 0.05 * smoothstep(0.85, 1, t);
    // Ribs: every other row swells. Wrap: the cord rows stand proud of the core rows (diamonds with relief).
    const rib = fp && i % 2 === 1 && i < n ? (o.wrap ? 1.05 : 1.07) : 1;
    rows.push(ring([0, o.cy ?? 0, z], X, Y, o.rx * sw * rib, o.ry * sw * rib, seg, 2.4, o.wrap && i % 2 ? Math.PI / seg : 0));
  }
  k.surface(rows, {
    paint: (i, kk) => (o.wrap ? ((i + kk) % 2 ? o.a : o.b) : i % 2 ? o.b : o.a),
    part: PART.grip,
    capStart: o.a,
    capEnd: o.a,
  });
}

/** A plate (crossguard / pommel cap): superellipse sections at the given z rows (rx, ry per row), centre y cy. */
export function plate(k: KnifeCtx, zs: number[], rx: number[], ry: number[], cy: number, paint: Paint, part: (typeof PART)[keyof typeof PART] = PART.guard, ex = 3.2): void {
  const fp = k.view === "fp";
  const seg = fp ? 20 : 10;
  // First person: each chamfer becomes a rounded bevel (a row between, pushed out along the arc), so the plate's edges
  // catch a soft highlight instead of a hard crease.
  const Z: number[] = [], RX: number[] = [], RY: number[] = [];
  zs.forEach((z, i) => {
    if (fp && i > 0 && Math.abs(rx[i] - rx[i - 1]) + Math.abs(ry[i] - ry[i - 1]) > 0.02) {
      const round = (a: number, b: number) => a + (b - a) * (b > a ? 0.72 : 0.28);
      Z.push((zs[i - 1] + z) / 2), RX.push(round(rx[i - 1], rx[i])), RY.push(round(ry[i - 1], ry[i]));
    }
    Z.push(z), RX.push(rx[i]), RY.push(ry[i]);
  });
  const rows = Z.map((z, i) => ring([0, cy, z], X, Y, RX[i], RY[i], seg, ex));
  k.surface(rows, { paint: () => paint, part, capStart: paint, capEnd: paint });
}

/** The bayonets' hold: the straight hammer grip (edge toward the knuckles), slim thumb over the index. */
export const bayonetHold = (o: V3): HoldSpec => straightHold(o, undefined, SLIM_THUMB);

// ---------------------------------------------------------------------------------------------
// Motion helpers for the knives' pose() (draw / slash / stab flourishes on top of the base action)

/** prefers-reduced-motion (through globalThis: the API's tests typecheck this without the DOM lib). */
let motionQuery: { matches: boolean } | null | undefined;
export const reducedMotion = (): boolean => {
  if (motionQuery === undefined) {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    motionQuery = typeof mm === "function" ? mm("(prefers-reduced-motion: reduce)") : null;
  }
  return !!motionQuery?.matches;
};

export const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** 0 -> 1 over [a, b] (smoothstep). */
export const rise = (t: number, a: number, b: number) => sm((t - a) / (b - a));
/** A soft bump: 0 outside [a, b], 1 at the middle. */
export const hump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);

/** Rotation about a knife-local axis through a knife-local pivot, then a knife-local offset: KnifeState.local. */
export function localXf(out: Float32Array, axis: V3, deg: number, pivot: V3, move: V3 = [0, 0, 0]): Float32Array {
  const a = norm(axis), r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  const [x, y, z] = a;
  out[0] = t * x * x + c, out[1] = t * x * y - s * z, out[2] = t * x * z + s * y;
  out[4] = t * x * y + s * z, out[5] = t * y * y + c, out[6] = t * y * z - s * x;
  out[8] = t * x * z - s * y, out[9] = t * y * z + s * x, out[10] = t * z * z + c;
  // p' = R (p - pivot) + pivot + move
  for (let i = 0; i < 3; i++) out[i * 4 + 3] = pivot[i] - (out[i * 4] * pivot[0] + out[i * 4 + 1] * pivot[1] + out[i * 4 + 2] * pivot[2]) + move[i];
  return out;
}

/** The palm normal (out of the palm, the side the fingers curl to) in a knife's own frame, from its hold. */
const palmN = new Map<string, V3>();
export function palmNormalLocal(def: KnifeDef): V3 {
  let v = palmN.get(def.id);
  if (v) return v;
  const spec = def.hold!;
  const h = handFrame(spec);
  const K = holdKnife(h, spec, def);
  const xs: V3 = [K[0], K[4], K[8]], ys: V3 = [K[1], K[5], K[9]], zs: V3 = [K[2], K[6], K[10]];
  v = norm([dot(h.n, xs), dot(h.n, ys), dot(h.n, zs)]);
  palmN.set(def.id, v);
  return v;
}

/** Slash / stab flavour shared by both: the wrist leads the edge into the cut and follows through. */
export function attackFlavour(action: VmAction, t: number, s: KnifeState, k: { roll: number; snap: number; twist: number }): void {
  if (action === "slash1" || action === "slash2") {
    const side = action === "slash1" ? 1 : -1;
    // Cock the wrist back in the wind-up (0 - 0.08), snap through the cut (0.08 - 0.2), ease out by 0.6.
    const cock = hump(t, 0, 0.16), snap = hump(t, 0.08, 0.42);
    s.wrist[0] += -6 * cock + k.snap * snap;
    s.wrist[2] += side * (k.roll * snap - 8 * cock);
  } else if (action === "stab") {
    // Turn the blade flat for the thrust (edge level), a small twist at full reach, back.
    const flat = rise(t, 0.12, 0.34) * (1 - rise(t, 0.62, 1.0));
    const tw = hump(t, 0.36, 0.7);
    s.wrist[2] += k.twist * flat + 10 * tw;
    s.wrist[0] += -4 * hump(t, 0.05, 0.3);
  }
}

/** Tiny idle sway (a slow figure-eight of the wrist): wall-clock driven so the idle's restarts never pop it. */
export function idleSway(s: KnifeState, amp: number): void {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  const now = ((perf?.now() ?? 0) / 1000) % 3600;
  const a = amp * (reducedMotion() ? 0.4 : 1);
  s.wrist[0] += a * Math.sin(now * 1.3);
  s.wrist[1] += a * 0.6 * Math.sin(now * 0.65 + 0.8);
}

