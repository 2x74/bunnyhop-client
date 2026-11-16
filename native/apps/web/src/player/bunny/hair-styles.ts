// Two more wigs beside Space Buns and the Ponytail (v0.0.42; Supporter hats, registered in hats.ts): hair in the
// player's colour, built from locks that are sprung (player/hair-fx.ts: each bends about its own pivot with the
// player's two hair springs and stretches from it for the length slider) and that carry the highlight colour.
//
//   - Spiky Hair: a close cap under bold, chunky spikes with one direction: swept up and back, raked to the bunny's
//     left. A fringe of five spikes over the forehead, a crown of big ones, a ring flicking out round the back of the
//     head, two sideburn spikes. Length = how long the spikes are (the crown most, the fringe least, so it never covers
//     the visor). The spikes are stiff: they flex and ring after a hop, a strafe or a landing.
//   - Long Hair: a centre parting with a curtain fringe swept to either side of the visor, and layered locks hanging
//     round the sides and back to the nape, their ends flicked out. Length = from a short bob to the shoulder blades
//     (back and sides reach the same height at any length; the fringe grows a little). The locks are loose: they lag a
//     turn, stream back with speed, float in the air and settle.
//
// Two builds of each, as the other wigs (hats.ts headwearKey): down (the standard bunny, hood lowered) on the bare
// head; up (Plush, Bun-E) a fringe under the hood rim, marked as a face part for hat-fit.ts, with spikes pushing out
// over the rim, or two long locks hanging out of the opening over the chest.
//
// Fit: everything is placed on the reference head (wigs.ts FACE_C / FACE_R, HOOD_C / HOOD_R, the rim) through
// facePoint / rimPoint / hoodPoint and the tables below (roots as longitude and latitude on the face, directions in
// the head's frame, lengths in units), so a head change is a re-fit of hat-fit.ts and at most these tables.
//
// Bind pose, Source space (z up, the bunny faces -y), skinned to the head bone like every hat.

import * as THREE from "three";
import { add, Builder, cr, frame, len, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import type { V3 } from "./rig";
import { curve, FACE_C, facePoint, finish, fringeUnder, hair, HAIR, headWeight, HI, hiBump as bump, nearestOn, rimPoint, type Hi } from "./wigs";
import { HAIR_CODE } from "../hair-fx";

/** How a lock is sprung: its share of the length slider (G / 4, a whole number 0..8), looseness 0..1, and where along its path it leaves the head (0..1). */
interface Spring { g: number; loose: number; from?: number }
/** The sprung locks of a build: vertex range, pivot, path, for the hairRoot attribute. */
export type Reg = { a: number; b: number; pivot: V3; g: number; path: V3[]; s0: number }[];

const outward = (lon: number, lat: number): V3 => norm(sub(facePoint(lon, lat, 2), facePoint(lon, lat, 0)));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A lock along a path: a lens section `w` across (toward `across`) and `th` deep at t = 0 (root) .. 1 (tip), closed at
 * both ends, `K` round (few: a chunky clump with soft edges). Tone as wigs.ts lockTone: darker at the root, a little
 * lighter toward the tip, the side facing `inward` shaded. Sprung when `spring` is given.
 */
function strand(
  b: Builder,
  reg: Reg,
  path: V3[],
  o: { w: (t: number) => number; th: (t: number) => number; across: V3; tone: number; hi?: Hi; W: Wt; inward?: V3 | null; K?: number; e?: number; spring?: Spring },
): void {
  const n = path.length, K = o.K ?? 10;
  const frames = path.map((_, i) => frame(norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)])), o.across));
  const rows = path.map((p, i) => {
    const [, u, v] = frames[i];
    const t = i / (n - 1);
    return ring(p, u, v, Math.max(0.02, o.w(t)), Math.max(0.02, o.th(t)), K, o.e ?? 2);
  });
  const under = (i: number, k: number) => {
    if (!o.inward) return 0;
    const v = frames[i][2], a = ((k + 0.5) / K) * Math.PI * 2;
    return smoothstep(-0.3, 0.8, Math.sin(a) * (v[0] * o.inward[0] + v[1] * o.inward[1] + v[2] * o.inward[2]));
  };
  const code = o.spring ? HAIR_CODE.lock : -10;
  const paint = (t: number, un: number): Paint => hair(o.tone - 0.1 * (1 - smoothstep(0, 0.4, t)) + 0.045 * smoothstep(0.55, 1, t) - 0.12 * un, code, 0, o.spring?.loose ?? 0);
  const a = b.vertexCount;
  // The highlight's share per vertex (soft edges): where the vertex sits along the lock and across it.
  const hi = o.hi;
  if (hi)
    b.green = (p) => {
      const [i, f] = nearestOn(path, p);
      const j = Math.min(n - 1, i + 1);
      const c = add(path[i], scale(sub(path[j], path[i]), f)), t = (i + f) / (n - 1);
      const u = frames[f < 0.5 ? i : j][1], d = sub(p, c);
      return hi(t, (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / Math.max(0.05, o.w(t)));
    };
  b.surface(rows, { paint: (i, k) => paint((i + 0.5) / (n - 1), under(i, k)), weight: () => o.W, capStart: paint(0, 0), capEnd: paint(1, 0) });
  b.green = null;
  if (o.spring) {
    const at = Math.round((o.spring.from ?? 0) * (n - 1));
    let s0 = 0;
    for (let i = 1; i <= at; i++) s0 += len(sub(path[i], path[i - 1]));
    reg.push({ a, b: b.vertexCount, pivot: path[at], g: o.spring.g, path, s0 });
  }
}

/** The geometry with its hairRoot attribute (hair-fx.ts): pivot and G + 0.98 t on sprung locks, zeros elsewhere. */
export function sprung(g: THREE.BufferGeometry, reg: Reg): THREE.BufferGeometry {
  const P = g.getAttribute("position");
  const out = new Float32Array(P.count * 4);
  for (const r of reg) {
    const cum = [0];
    for (let i = 1; i < r.path.length; i++) cum.push(cum[i - 1] + len(sub(r.path[i], r.path[i - 1])));
    const free = Math.max(1e-3, cum[cum.length - 1] - r.s0);
    for (let v = r.a; v < r.b; v++) {
      const p: V3 = [P.getX(v), P.getY(v), P.getZ(v)];
      // Where along the path the vertex sits: the nearest point on it.
      const [i, u] = nearestOn(r.path, p);
      const s = cum[i] + u * (cum[i + 1] - cum[i]);
      const t = Math.max(0, Math.min(1, (s - r.s0) / free));
      out.set([r.pivot[0], r.pivot[1], r.pivot[2], r.g + 0.98 * t], v * 4);
    }
  }
  g.setAttribute("hairRoot", new THREE.Float32BufferAttribute(out, 4));
  return g;
}

/**
 * A cap of hair on the bare head from the crown to a hairline (face latitude by |longitude|, eight samples from the
 * front round to the nape), `off` proud of the head, fuller over the crown, its edge rolled under; strands in
 * alternating tones, `part` a darker parting line at that longitude over the front.
 */
function skullCap(b: Builder, W: Wt, line: number[], off: number, o: { part?: number; streak?: (lon: number) => number } = {}): (lon: number) => number {
  const hairline = (lon: number) => cr(line, (Math.min(1, Math.abs(wrap(lon)) / Math.PI)) * (line.length - 1));
  const standoff = (lon: number, s: number) => off + 0.22 * (1 - s) ** 1.5 + 0.05 * Math.sin(lon * 13 + 2 * Math.sin(lon * 5)) * smoothstep(0.15, 0.7, s) * (1 - smoothstep(0.92, 1, s));
  const K = 60, R = 14;
  const rows: V3[][] = [];
  for (let i = 0; i <= R; i++) {
    const s = (i / R) ** 0.85;
    rows.push(Array.from({ length: K }, (_, k) => {
      const lon = (k / K) * Math.PI * 2;
      return facePoint(lon, Math.PI / 2 - (Math.PI / 2 - hairline(lon)) * s, standoff(lon, s));
    }));
  }
  rows.push(Array.from({ length: K }, (_, k) => {
    const lon = (k / K) * Math.PI * 2;
    return facePoint(lon, hairline(lon) + 0.03, 0.06);
  }));
  // Highlight streaks through the cap: per vertex, from its longitude and how far down from the crown it is.
  if (o.streak) {
    const streak = o.streak;
    b.green = (p) => {
      const lon = Math.atan2(p[0] - FACE_C[0], -(p[1] - FACE_C[1]));
      const lat = Math.asin(Math.max(-1, Math.min(1, (p[2] - FACE_C[2]) / (4.85 + off + 0.2))));
      return streak(lon) * smoothstep(0.3, 0.62, (Math.PI / 2 - lat) / Math.max(0.2, Math.PI / 2 - hairline(lon)));
    };
  }
  b.surface(rows, {
    closed: true,
    paint: (i, k) => {
      const lon = ((k + 0.5) / K) * Math.PI * 2, s = i / R;
      const part = o.part !== undefined && Math.abs(wrap(lon - o.part)) < 0.07 && s < 0.55 ? -0.13 : 0;
      return hair(HAIR.base - 0.03 + 0.02 * Math.cos(lon * 11) - 0.09 * smoothstep(0.55, 1, s) + part);
    },
    weight: () => W,
    out: (i, k) => sub(rows[i][k], FACE_C),
  });
  b.green = null;
  return hairline;
}

// ---------------------------------------------------------------------------------------------
// Spiky Hair

/** The way the spikes are swept: back, up and to the bunny's left (+x), as if it had been running into the wind. */
const SWEEP: V3 = norm([0.3, 0.72, 0.62]);
/** Width along a spike: broad at the foot, a long taper to a point. A spike is a flat clump, about a third as deep as wide. */
const spikeW = (w: number) => (t: number) => w * Math.pow(Math.max(0, 1 - t ** 1.3), 0.8) + 0.03;
const SPIKE_DEPTH = 0.38;
/** Highlights: every spike's tip, and a few whole spikes streaked. */
const spikeHi = (streak: boolean): Hi => (streak ? HI.whole : HI.tip);

/**
 * A free spike: from a root on the cap (sunk into it), `length` along its direction, the tip flicking away from the
 * head. [lon, lat, length, width, out, sweep, flow, tone, streak?]: the direction is the head's outward normal there *
 * out + SWEEP * sweep + the way hair falls from the crown (down the head's surface) * flow.
 */
type Spike = [lon: number, lat: number, length: number, width: number, out: number, sweep: number, flow: number, tone: number, streak?: 1];
/** The crown: the big ones, up and back. */
const CROWN: Spike[] = [
  [0.05, 1.2, 4.4, 2.2, 0.45, 1.0, 0, HAIR.light, 1],
  [1.0, 0.98, 4.0, 2.1, 0.55, 0.85, 0, HAIR.base],
  [-0.95, 1.0, 3.8, 2.0, 0.55, 0.85, 0, HAIR.base],
  [2.2, 1.06, 4.6, 2.2, 0.45, 0.95, 0, HAIR.light],
  [-2.15, 1.08, 4.3, 2.1, 0.45, 0.95, 0, HAIR.base, 1],
  [3.12, 1.22, 5.0, 2.3, 0.3, 1.0, 0, HAIR.light],
];
/** Round the back of the head: lying along it, away from the crown, their tips lifting off. */
const BACK: Spike[] = [
  [2.45, 0.66, 3.6, 2.1, 0.42, 0.3, 0.8, HAIR.base],
  [-2.5, 0.64, 3.5, 2.1, 0.42, 0.3, 0.8, HAIR.shade],
  [3.2, 0.6, 3.9, 2.3, 0.4, 0.3, 0.85, HAIR.base, 1],
  [1.72, 0.56, 3.0, 1.9, 0.5, 0.25, 0.75, HAIR.shade],
  [-1.76, 0.58, 2.9, 1.9, 0.5, 0.25, 0.75, HAIR.base],
];
/** The nape: shorter, down the neck and out. */
const NAPE: Spike[] = [
  [2.72, 0.05, 2.5, 1.75, 0.32, 0.05, 0.95, HAIR.shade],
  [-2.78, 0.05, 2.4, 1.75, 0.32, 0.05, 0.95, HAIR.shade],
  [3.2, -0.04, 2.7, 1.9, 0.3, 0.05, 1.0, HAIR.base],
  [2.12, 0.12, 2.2, 1.6, 0.4, 0.02, 0.9, HAIR.shade],
  [-2.18, 0.12, 2.2, 1.6, 0.4, 0.02, 0.9, HAIR.shade],
];
/**
 * The fringe: spikes lying over the forehead, each from the front of the cap to a tip on the top of the visor.
 * [tip longitude, tip latitude, width, tone, streak?]; they rake toward the bunny's left as they fall.
 */
const FRINGE: [number, number, number, number, (1 | 0)?][] = [
  [-1.02, 0.3, 1.5, HAIR.shade],
  [-0.54, 0.38, 1.75, HAIR.base],
  [-0.08, 0.25, 1.95, HAIR.light, 1],
  [0.4, 0.4, 1.7, HAIR.base],
  [0.86, 0.31, 1.5, HAIR.shade],
];
const SPIKY_LINE = [0.8, 0.74, 0.56, 0.2, -0.16, -0.36, -0.46, -0.5];

function freeSpike(b: Builder, reg: Reg, W: Wt, [lon, lat, length, width, out, sweep, flow, tone, streak]: Spike, spring: Spring, k = 1): void {
  const n = outward(lon, lat);
  const fall = norm(sub(facePoint(lon, lat - 0.06, 0), facePoint(lon, lat, 0)));
  const dir = norm(add(add(scale(n, out), scale(SWEEP, sweep)), scale(fall, flow)));
  const root = facePoint(lon, lat, 0.2);
  const L = length * k;
  // Leaves along the head and turns into its direction; the tip flicks: up for the crown's, away from the head for the rest.
  const flick: V3 = flow > 0.3 ? scale(n, 0.26 * L) : [0, 0, 0.14 * L];
  const path = curve([sub(root, scale(dir, 0.45)), add(root, scale(dir, 0.3 * L)), add(root, add(scale(dir, 0.7 * L), scale(flick, 0.25))), add(root, add(scale(dir, L), flick))], 9);
  // Flat side out: across the spike runs round the head.
  const across = norm([-n[1], n[0], 0.001]);
  const w = spikeW(width * k);
  strand(b, reg, path, { w, th: (t) => SPIKE_DEPTH * w(t) + 0.02, across, tone, hi: spikeHi(!!streak), W, inward: scale(n, -1), K: 10, e: 1.7, spring: { ...spring, from: 0.12 } });
}

function fringeSpikes(b: Builder, reg: Reg, W: Wt, topLat: number, k = 1): void {
  for (const [lonT, latT, width, tone, streak] of FRINGE) {
    // From the cap's front, lifting off the forehead, down to the visor's top edge; raked: the root sits to the right of the tip.
    const lonR = lonT * 0.72 - 0.2;
    const root = facePoint(lonR, topLat, 0.35);
    const crest = facePoint(lonR + (lonT - lonR) * 0.35, topLat - 0.2, 1.05 * k);
    const fall = facePoint(lonT - 0.05, latT + 0.2, 0.95 * k);
    const tip = facePoint(lonT + 0.04, latT, 0.6);
    const path = curve([root, crest, fall, tip], 10);
    const w = spikeW(width * k);
    strand(b, reg, path, { w, th: (t) => SPIKE_DEPTH * w(t) + 0.04, across: [Math.cos(lonT), Math.sin(lonT), 0], tone, hi: spikeHi(!!streak), W, inward: scale(outward(lonT, latT + 0.2), -1), K: 10, e: 1.7, spring: { g: 1, loose: 0.3, from: 0.2 } });
  }
}

export function spikyDown(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight(), reg: Reg = [];
  skullCap(b, W, SPIKY_LINE, 0.42);
  for (const s of NAPE) freeSpike(b, reg, W, s, { g: 2, loose: 0.4 });
  for (const s of BACK) freeSpike(b, reg, W, s, { g: 3, loose: 0.3 });
  for (const s of CROWN) freeSpike(b, reg, W, s, { g: 4, loose: 0.22 });
  // Sideburns: a short spike in front of each ear's place, pointing down and a little forward.
  for (const side of [-1, 1]) {
    const path = curve([facePoint(side * 1.5, 0.5, 0.3), facePoint(side * 1.42, 0.22, 0.75), facePoint(side * 1.3, -0.12, 0.6), facePoint(side * 1.22, -0.34, 0.5)], 8);
    const w = spikeW(1.3);
    strand(b, reg, path, { w, th: (t) => SPIKE_DEPTH * w(t) + 0.03, across: [Math.cos(side * 1.4), Math.sin(side * 1.4), 0], tone: HAIR.shade, hi: HI.tip, W, inward: scale(outward(side * 1.4, 0.1), -1), K: 10, e: 1.75, spring: { g: 1, loose: 0.35, from: 0.25 } });
  }
  fringeSpikes(b, reg, W, 0.98);
  return sprung(finish(b, null), reg);
}

/** Hood up: the fringe under the rim (a face part), and three spikes pushing out over the top of the rim, tall enough to show over the hood from behind. */
export function spiky(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight(), reg: Reg = [];
  fringeUnder(b, W);
  fringeSpikes(b, reg, W, 1.1, 0.8);
  const face = b.vertexCount;
  // [rim angle, length, width, tone]: up and forward out of the hood, raked like the rest.
  for (const [th, length, width, tone, streak] of [[-0.44, 3.5, 1.9, HAIR.base, 0], [0.02, 4.5, 2.2, HAIR.light, 1], [0.48, 3.8, 2.0, HAIR.base, 0]] as const) {
    const root = add(rimPoint(th, 0.12), [0, 0.5, -0.35]);
    const dir = norm([0.22 + Math.sin(th) * 0.5, -0.62, 0.75]);
    const path = curve([root, add(root, scale(dir, 0.45 * length)), add(root, add(scale(dir, 0.8 * length), [0, 0.1, 0.15 * length])), add(root, add(scale(dir, length), [0.1, 0.35 * length, 0.3 * length]))], 9);
    const w = spikeW(width);
    strand(b, reg, path, { w, th: (t) => SPIKE_DEPTH * w(t) + 0.03, across: [1, 0, 0], tone, hi: spikeHi(!!streak), W, inward: [0, 1, -0.5], K: 10, e: 1.7, spring: { g: 3, loose: 0.25, from: 0.3 } });
  }
  return sprung(finish(b, face), reg);
}

// ---------------------------------------------------------------------------------------------
// Long Hair

const LONG_LINE = [0.8, 0.74, 0.58, 0.26, -0.12, -0.36, -0.48, -0.52];
/** The parting: just off the middle, toward the bunny's left. */
const LONG_PART = 0.07;
/** Where the hanging locks end at the built length (z): about the jaw and the nape. */
const HANG_Z = 64.0;
/** Width along a hanging lock: full through its length, a blunt point at its end. */
const hangW = (w: number) => (t: number) => w * (0.8 + 0.3 * Math.sin(Math.PI * Math.min(1, t * 1.1))) * Math.pow(Math.max(0, 1 - t ** 2.6), 0.75) + 0.04;

/**
 * The curtain fringe: three locks a side from the parting, sweeping out over the forehead and down beside the visor.
 * [tip longitude (mirrored), tip latitude, width, tone, how far out the lock stands at its crest, streak?]
 */
const CURTAIN: [number, number, number, number, number, (1 | 0)?][] = [
  [1.42, -0.52, 1.15, HAIR.shade, 0.75],
  [1.2, -0.16, 1.3, HAIR.base, 0.95, 1],
  [0.86, 0.2, 1.35, HAIR.light, 1.1],
];

/** `reach` / `squash`: the tips' latitudes are drawn toward `reach` by `squash` (1 = as the table has them); `lift`: how far the locks stand off. */
function curtainFringe(b: Builder, reg: Reg, W: Wt, o: { top: number; reach: number; squash: number; lift: number }): void {
  for (const side of [1, -1]) {
    for (const [lonT0, latT0, width, tone, stand, streak] of CURTAIN) {
      // (The bunny's right side is combed a little flatter and shorter, so the two curtains aren't mirror images.)
      const lonT = side * lonT0 * (side > 0 ? 1 : 0.96), latT = o.reach + (latT0 - o.reach) * o.squash + (side > 0 ? 0 : 0.05);
      const lonR = LONG_PART + side * (0.06 + 0.12 * (lonT0 - 0.86));
      const root = facePoint(lonR, o.top, 0.4);
      const crest = facePoint(lonR + (lonT - lonR) * 0.3, o.top - 0.22, stand * o.lift + 0.3);
      const brow = facePoint(lonR + (lonT - lonR) * 0.72, Math.max(latT + 0.42, 0.52), stand * o.lift);
      const fall = facePoint(lonT - side * 0.03, latT + 0.22, 0.72 * o.lift);
      const tip = facePoint(lonT + side * 0.05, latT, 0.62 * o.lift);
      const path = curve([root, crest, brow, fall, tip], 16);
      const w = hangW(width);
      strand(b, reg, path, { w, th: (t) => 0.36 * (1 - 0.5 * t) + 0.05, across: [Math.cos(lonT), Math.sin(lonT), 0], tone, hi: streak ? HI.strand(side * 0.25, 0.5) : HI.soft, W, inward: scale(outward(lonT, latT + 0.3), -1), K: 12, spring: { g: 1, loose: 0.5, from: 0.5 } });
    }
  }
}

export function longDown(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight(), reg: Reg = [];
  // Highlight streaks through the cap continue down the locks under them (every third lock of the upper layer).
  const N = 13, A0 = 1.32, A1 = Math.PI * 2 - 1.32;
  const lonOf = (j: number, n: number) => A0 + ((A1 - A0) * j) / (n - 1);
  const streaked = (j: number) => j % 3 === 1;
  const hairline = skullCap(b, W, LONG_LINE, 0.5, { part: LONG_PART, streak: (lon) => Math.max(0, ...Array.from({ length: N }, (_, j) => (streaked(j) ? bump(wrap(lon - lonOf(j, N) - (j % 2 ? 0.07 : -0.07)), 0, 0.09) : 0))) });
  // Hanging locks, two layers. The upper one starts high on the cap and lies on it, so the hair is one surface from
  // the crown to the ends; the under one fills between its locks, closer to the neck. Uneven ends, flicked out.
  for (const layer of [0, 1]) {
    const n = layer ? N : N - 1;
    for (let j = 0; j < n; j++) {
      const lon = layer ? lonOf(j, N) : lonOf(j + 0.5, N);
      const back = smoothstep(1.5, 2.6, Math.abs(wrap(lon)));
      const edge = hairline(lon);
      const o: V3 = [Math.sin(lon), -Math.cos(lon), 0];
      const up = layer ? 1.05 : 0.5;
      // (The root is sunk in the cap; the lock comes out of it on the way down.)
      const root = facePoint(lon, Math.min(1.3, edge + up), 0.18);
      const high = facePoint(lon, edge + up * 0.5, 0.5 + 0.34 * layer);
      const pivot = facePoint(lon, edge + 0.06, 0.52 + 0.36 * layer);
      // Down to the built length, leaning out a little and back over the collar.
      const uneven = layer ? [0.1, -0.55, 0.35, -0.2, 0.5, -0.4][j % 6] : 0.55;
      const drop = pivot[2] - HANG_Z + uneven;
      const lean = 0.3 + 0.45 * back + 0.25 * layer;
      const at = (f: number, out: number): V3 => [pivot[0] + o[0] * out, pivot[1] + o[1] * out + 0.55 * back * f, pivot[2] - drop * f];
      const path = curve([root, high, pivot, at(0.45, lean * 0.5), at(0.82, lean * 0.8), at(1, lean + 0.75)], 16);
      const w = hangW(layer ? 1.3 : 1.2);
      // Back and sides reach the same height at every length: the sides are longer as built, so they take less of the slider.
      const g = Math.max(2, Math.min(4, Math.round(4 * ((2.9 + 1.3 * (1 - back)) / drop) * 1.1)));
      const tone = layer ? [HAIR.base, HAIR.light, HAIR.base, HAIR.shade][j % 4] : HAIR.shade - 0.02;
      strand(b, reg, path, { w, th: (t) => 0.38 * (1 - 0.5 * t) + 0.05, across: [Math.cos(lon), Math.sin(lon), 0], tone, hi: layer && streaked(j) ? HI.strand(j % 2 ? 0.3 : -0.3) : layer ? HI.soft : undefined, W, inward: scale(o, -1), K: 10, spring: { g, loose: 0.72 + 0.28 * back - 0.12 * (1 - layer), from: 0.4 } });
    }
  }
  curtainFringe(b, reg, W, { top: 1.14, reach: 0, squash: 1, lift: 1 });
  return sprung(finish(b, null), reg);
}

/** Hood up: the curtain fringe under the rim (a face part), and a long lock each side hanging out of the hood over the chest. */
export function long(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight(), reg: Reg = [];
  fringeUnder(b, W);
  curtainFringe(b, reg, W, { top: 1.12, reach: 0.34, squash: 0.25, lift: 0.5 });
  const face = b.vertexCount;
  for (const side of [1, -1]) {
    for (const [dx, length, width, tone, streak] of [[0, 6.2, 1.1, HAIR.base, 1], [0.55, 5.0, 0.9, HAIR.shade, 0]] as const) {
      // From inside the opening beside the visor's end, out over the rim's lower side, then down in front of the shoulder.
      const rim = rimPoint(side * 2.05);
      const root = facePoint(side * (1.02 - 0.1 * dx), -0.12, 0.45);
      const over: V3 = [rim[0] * 0.86 - side * dx * 0.7, rim[1] - 0.75, rim[2] + 0.35];
      const path = curve([root, over, add(over, [side * 0.25, -0.45, -0.38 * length]), add(over, [side * 0.4, -0.5, -0.78 * length]), add(over, [side * 0.75, -0.75, -length])], 14);
      const w = hangW(width);
      strand(b, reg, path, { w, th: (t) => 0.42 * (1 - 0.4 * t) + 0.05, across: [1, 0, 0], tone, hi: streak ? HI.strand(0.2, 0.5) : HI.soft, W, inward: [0, 1, 0], K: 10, spring: { g: 3, loose: 0.9, from: 0.25 } });
    }
  }
  return sprung(finish(b, face), reg);
}
