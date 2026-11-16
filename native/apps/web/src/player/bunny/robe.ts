// The Robe (progression.ts ROBE_ITEM; backs.ts builds it through here): a haori, the open-fronted jacket worn over
// clothes, here over the bunny's hoodie. A straight-cut body to mid-thigh, a flat collar band down both front edges and
// round the neck, wide square sleeves that hang below the forearms. Worn open (the fronts hang apart and show the
// hoodie) or tied (left over right, a narrow sash at the waist, the hem drawn in a little).
//
// Built in the bind pose like every back item, one sheet thick: the material draws its inside as the lining
// (robe-fx.ts). It is cut from the body's own dimensions (the torso profile of the build, mesh.ts; the arm bones), so
// one builder fits Model A, Model B, Plush, Bun-E and Tek; ROBE below is what there is to tune.
//
// What each vertex carries for its cloth and its print is in robe-fx.ts's header.

import * as THREE from "three";
import { add, Builder, clamp, cross, frame, hat, len, lerp3, mixW, norm, scale, smoothstep, sub, type Fin, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";
import { torsoPointFor, torsoProfile, type BunnyBody } from "./mesh";
import type { BunnyLook } from "./look";
import type { BackRig } from "../back-fx";
import { ROBE_CODE, ROBE_ROLE, ROBE_S, sleeveFrame, sleeveRadius } from "../robe-fx";

/** The cut (bind space, units; z up, the back toward +y, the bunny's left +x). */
export const ROBE = {
  /** The hem (mid-thigh on the standing bunny: the hips are at 40, the knees at 21.6), and how much higher it is tied
   *  (the sash gathers it). */
  hem: 26.2,
  tiedHem: 0.9,
  /** How square the straight cut is (a superellipse's exponent: 2 a round barrel, higher flatter panels). */
  square: 3.6,
  /** Below this the body's cloth hangs by its own weight (the hoodie's hem; everything under it is on the pelvis). */
  hip: 38,
  /** Open: the cloth is free below the chest; tied: below the sash. */
  release: 52,
  tie: 44.4,
  /** Above this it lies on the hoodie; from here down to `release` it goes out to the straight cut. */
  fitted: 60.5,
  /** The neck edge's height. */
  neck: 63.6,
  /** How far it stands off the hoodie, and the under panel's where the fronts overlap (tied). */
  off: 0.55,
  under: 0.22,
  /** Half the gap between the open fronts, and the collar band's width and thickness. */
  edge: 3.3,
  band: 1.8,
  bandT: 0.16,
  /** Sleeves: radius over the arm, where they start (units along the arm from the shoulder joint, < 0 inside the
   *  shoulder), how far past the elbow they end, how far they hang below the arm's line and the round of their corner. */
  sleeve: { r: 3.85, from: -4.6, past: 6.3, drop: 11.2, corner: 0.9, gap: 0.34 },
  /** The sash (tied): its height and how far it stands off the cloth. */
  sash: 1.5,
} as const;

/** The build's own numbers the cut follows (profile: Model A / Tek, Model B / Bun-E, Plush). */
export const ROBE_FITS: Readonly<Record<"a" | "b" | "plush", { sleeve: number; shoulder: number }>> = {
  a: { sleeve: 1, shoulder: 0 },
  // Model B's sleeves are slimmer and set 0.48 in at the shoulder (mesh.ts).
  b: { sleeve: 0.93, shoulder: 0.48 },
  plush: { sleeve: 1.06, shoulder: 0 },
};

export interface RobeFit {
  profile: "a" | "b" | "plush";
  hood: "up" | "down";
  tied: boolean;
  /** The collar's height from the fit table (backs.ts BACK_FITS) and the profile's lift. */
  neck: number;
}

const WHITE: Paint = { code: 0, color: 0xffffff };

interface Part {
  from: number;
  to: number;
  code: number;
  role: number;
  shade?: (p: V3) => number;
}

/** A superellipse's point at angle th (0 = +x, pi/2 = +y). */
const superAt = (a: number, b: number, cy: number, e: number, th: number): [number, number] => {
  const ca = Math.cos(th), sa = Math.sin(th);
  return [Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e) * a, cy + Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e) * b];
};

/**
 * The straight cut for a torso profile: the ellipse that clears the hoodie everywhere from the chest down to its hem
 * (its widest, its furthest forward and furthest back, wherever each is).
 */
export function robeEnvelope(profile: ReturnType<typeof torsoProfile>): { a: number; b: number; cy: number; e: number } {
  let a = 0, front = 0, back = 0;
  for (const [z, ra, rb, c] of profile) {
    if (z > ROBE.release + 4) continue;
    a = Math.max(a, ra);
    front = Math.max(front, rb - c);
    back = Math.max(back, rb + c);
  }
  return { a, b: (front + back) / 2, cy: (back - front) / 2, e: ROBE.square };
}

export function buildRobe(f: RobeFit): { geometry: THREE.BufferGeometry; rig: BackRig; triangles: number } {
  const look: BunnyLook = f.profile === "plush" ? "plush" : "bunny";
  const body: BunnyBody = f.profile === "b" ? "feminine" : "classic";
  const prof = torsoProfile(look, body);
  const env = robeEnvelope(prof);
  const fit = ROBE_FITS[f.profile];
  const r = rig();
  const B = (n: string) => r.bone(n);
  const b = new Builder();
  const parts: Part[] = [];
  const tied = f.tied, down = f.hood === "down";
  const NECK = f.neck, HEM = ROBE.hem + (tied ? ROBE.tiedHem : 0);
  const REL = tied ? ROBE.tie : ROBE.release;

  // --- The body's surface -----------------------------------------------------------------------
  /** 0 on the hoodie .. 1 on the straight cut, by height. Tied: the cloth lies on the body down to the sash, and the
   *  skirt below it stops a little short of the straight cut (the hem drawn in). */
  const cut = (z: number) => (tied ? 0.82 * smoothstep(ROBE.tie - 0.5, ROBE.tie - 9, z) : smoothstep(ROBE.fitted, ROBE.release, z));
  /** With the hood down the lowered hood and the hanging ears lie over the top of the back: the cloth goes under them. */
  // (As the Cape does since the fit pass: flat on the hoodie from z 53 up, under the hood and the ears' tips.)
  const under = (x: number, y: number, z: number) => (down && y > 2.5 ? smoothstep(9.6, 8.0, Math.abs(x)) * smoothstep(52.4, 54.4, z) : 0);
  const at = (z: number, th: number, off: number): V3 => {
    const p = torsoPointFor(Math.max(z, prof[0][0]), th, off, prof);
    const k = cut(z);
    const [ex, ey] = superAt(env.a + off, env.b + off, env.cy, env.e, th);
    let x = p[0] + (ex - p[0]) * k, y = p[1] + (ey - p[1]) * k;
    if (tied) {
      // Gathered under the sash: small folds either side of it, none under it.
      const g = Math.exp(-(((z - ROBE.tie) / 3.6) ** 2)) * smoothstep(0.7, 2.2, Math.abs(z - ROBE.tie));
      const o = norm([x, (y - env.cy) * 1.6, 0]);
      const fold = 0.22 * g * Math.cos(th * 13);
      (x += o[0] * fold), (y += o[1] * fold);
    }
    const u = under(x, y, z);
    if (u > 0) {
      const q = torsoPointFor(z, th, 0.24, prof);
      (x += (q[0] - x) * u), (y += (q[1] - y) * u);
    }
    return [x, y, z];
  };
  /** The angle (front half: -pi .. 0) where the surface at height z is at x. */
  const thFront = (z: number, x: number, off: number): number => {
    let lo = -Math.PI + 0.02, hi = -0.02;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (at(z, mid, off)[0] > x) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  // The front edges (x at height z). Open: straight down either side of the middle. Tied: the left front crosses over
  // to the right hip, the right front under it.
  const zt = (z: number) => clamp((NECK - z) / (NECK - ROBE.tie), 0, 1);
  const edgeL = (z: number) => (tied ? (z >= ROBE.tie ? ROBE.edge + 0.4 + (-7.2 - ROBE.edge - 0.4) * Math.pow(zt(z), 0.9) : -7.2 - 0.6 * ((ROBE.tie - z) / (ROBE.tie - HEM))) : ROBE.edge + 0.35 * smoothstep(58, NECK, z));
  const edgeR = (z: number) => (tied ? -(ROBE.edge + 0.4) + (2.6 + ROBE.edge + 0.4) * Math.pow(zt(z), 0.9) : -edgeL(z));
  /** How far off the hoodie at (height, angle) for a side's panel: the under panel sits in where the fronts overlap. */
  const offOf = (side: number, z: number, th: number): number => {
    if (!tied) return ROBE.off;
    const front = smoothstep(-0.2, -0.75, Math.sin(th));
    if (side > 0) return ROBE.off + 0.3 * front;
    const x = at(z, th, ROBE.off)[0];
    return ROBE.off - (ROBE.off - ROBE.under) * smoothstep(edgeL(z) - 2.4, edgeL(z) - 0.6, x) * front;
  };

  // Units round the straight cut from the middle of the back (the print's coordinate), by angle.
  const ARC_N = 720;
  const arcTable = new Float64Array(ARC_N + 1);
  {
    let prev = superAt(env.a + ROBE.off, env.b + ROBE.off, env.cy, env.e, Math.PI / 2);
    for (let i = 1; i <= ARC_N; i++) {
      const th = Math.PI / 2 - (i / ARC_N) * Math.PI * 1.5;
      const p = superAt(env.a + ROBE.off, env.b + ROBE.off, env.cy, env.e, th);
      arcTable[i] = arcTable[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      prev = p;
    }
  }
  /** `turn`: radians round from the middle of the back toward the bunny's left (negative: toward its right). */
  const arc = (turn: number): number => {
    const t = clamp((Math.abs(turn) / (Math.PI * 1.5)) * ARC_N, 0, ARC_N), i = Math.min(ARC_N - 1, Math.floor(t));
    return Math.sign(turn) * (arcTable[i] + (arcTable[i + 1] - arcTable[i]) * (t - i));
  };

  const pelvis = B("Pelvis"), spine = B("Spine"), spine1 = B("Spine1"), spine2 = B("Spine2"), spine4 = B("Spine4"), neck = B("Neck1");
  /** How much a point of the body rides on a thigh: the fronts below the hips (in front of each leg). */
  const thighOf = (p: V3): number => {
    // As the hoodie's own hem follows them (mesh.ts torsoW), so the two move together; and wholly below the hips.
    const hem = smoothstep(48, 40, p[2]) * smoothstep(0.3, 3.4, Math.abs(p[0])) * (0.25 * smoothstep(5.5, 2.5, p[1]) + 0.65 * smoothstep(1, -4.5, p[1]));
    return Math.max(hem, smoothstep(42.5, 33.5, p[2]) * smoothstep(1.2, -3.2, p[1] - env.cy));
  };
  /** The hoodie's weights (as backs.ts), the fronts below the hips on the thighs. */
  const W = (p: V3): Wt => {
    const sp = hat(p[2], [[39, pelvis], [44.5, spine], [48.8, spine1], [54, spine2], [60.5, spine4], [64.5, spine4], [66.5, neck]]);
    const ax = Math.abs(p[0]);
    const cl = smoothstep(4.5, 9.5, ax) * smoothstep(55, 60.5, p[2]) * 0.6;
    const ua = smoothstep(8.2, 10.4, ax) * smoothstep(57.5, 61, p[2]) * 0.25;
    const th = thighOf(p), l = smoothstep(-1.4, 1.4, p[0]);
    return mixW([sp, 1 - cl - ua - th], [[[B(`${p[0] >= 0 ? "L" : "R"}_Clavicle`), 1]], cl], [[[B(`${p[0] >= 0 ? "L" : "R"}_UpperArm`), 1]], ua], [[[B("L_Thigh"), 1]], th * l], [[[B("R_Thigh"), 1]], th * (1 - l)]);
  };
  /** A body point's cloth data: [U, V, door, thigh]. `turn` as arc()'s; `door`: 0..1 toward a free front edge. */
  const bodyFin = (p: V3, turn: number, door: number): Fin => [arc(turn), p[2], tied ? 0 : door, thighOf(p)];

  // Over the shoulders the hoodie's sleeves rise out of its body (mesh.ts: the sleeve's cap, turned in toward the neck).
  // The cloth goes over them: each cap as a few balls on the sleeve's line, the cloth kept `off` outside them and moving
  // with the sleeve there.
  // (Bun-E, which wears Model B's cut, has a ball for a shoulder: supporter.ts robotBody.)
  const CAP: [number, number][] = [[-3.6, 1.9], [-3.0, 2.4], [-2.3, 2.8], [-1.6, 3.05]];
  const caps = ([1, -1] as const).map((sx) => {
    const side = sx > 0 ? "L" : "R";
    const sh = r.at(`${side}_UpperArm`), el = r.at(`${side}_Forearm`);
    const dir = norm(lerp3(norm(sub(el, sh)), norm([sx, 0, -0.3]), 0.75));
    const scaleR = (f.profile === "plush" ? 1.06 : f.profile === "b" ? 0.82 : 1) * 1.04;
    return { sx, w: [[B(`${side}_UpperArm`), 0.6], [B(`${side}_Clavicle`), 0.4]] as Wt, balls: [...CAP.map(([sv, rad]) => ({ c: add(add(sh, scale(dir, sv)), [-sx * fit.shoulder, 0, 0]) as V3, r: rad * scaleR })), ...(f.profile === "b" ? [{ c: add(sh, [sx * 0.35, 0, 0.5]) as V3, r: 3.15 }] : [])] };
  });
  /** p pushed out over the sleeve caps, and how far it went (0..1 of the cloth's stand-off). */
  const overCaps = (p: V3, off: number): { p: V3; k: number; w: Wt | null } => {
    let q = p, moved = 0, w: Wt | null = null;
    for (const cap of caps)
      for (let pass = 0; pass < 2; pass++)
        for (const ball of cap.balls) {
          const d = sub(q, ball.c), l = len(d), need = ball.r + off;
          if (l < need && l > 1e-6) (moved += need - l), (q = add(ball.c, scale(d, need / l))), (w = cap.w);
        }
    return { p: q, k: clamp(moved / 0.8, 0, 1), w };
  };

  // --- The body: one sheet from the right front edge round the back to the left front edge ----------------------------
  const zs: number[] = [];
  for (let z = HEM; z < REL - 0.01; z += (REL - HEM) / Math.round((REL - HEM) / 1.5)) zs.push(z);
  for (let z = REL; z < NECK - 0.01; z += (NECK - REL) / Math.round((NECK - REL) / 1.25)) zs.push(z);
  zs.push(NECK);
  const K = 24;
  const edges = new Map<string, number>();
  const edgeAngle = (z: number, side: number): number => {
    const key = `${side}|${z.toFixed(4)}`;
    let th = edges.get(key);
    if (th === undefined) edges.set(key, (th = side > 0 ? thFront(z, edgeL(z), ROBE.off) : thFront(z, edgeR(z), ROBE.off)));
    return th;
  };
  /** The sheet's column k (-K .. K, 0 the middle of the back) at height z: the point, its turn, its door weight. */
  const column = (z: number, k: number): { p: V3; turn: number; door: number; th: number; off: number; cap: { k: number; w: Wt | null } } => {
    const side = k >= 0 ? 1 : -1, t = Math.abs(k) / K;
    // The neck edge dips toward the front (round the base of the neck), so the fronts start a little lower.
    const thEdge = edgeAngle(z, side);
    // (Left: pi/2 down through 0 to its edge; right: pi/2 up through pi to its edge, the same angle one turn on.)
    const span = side > 0 ? Math.PI / 2 - thEdge : thEdge + 2 * Math.PI - Math.PI / 2;
    const turn = side * span * t;
    const th = Math.PI / 2 - turn;
    const off = offOf(side, z, th);
    const cap = overCaps(at(z, th, off), off);
    const p = cap.p;
    // The door: the quarter from the side seam to the free edge.
    const door = smoothstep(Math.PI * 0.5, span, Math.abs(turn));
    return { p, turn, door, th, off, cap };
  };
  // The neck edge: lower at the front (it comes down round the neck to the fronts).
  const rowZ = (i: number, k: number) => (i === zs.length - 1 ? NECK - 1.5 * smoothstep(0.5, 1, Math.abs(k) / K) : zs[i]);
  const cols = Array.from({ length: 2 * K + 1 }, (_, j) => j - K);
  const grid = zs.map((_, i) => cols.map((k) => column(rowZ(i, k), k)));
  // Soft folds down the back below the waist, deeper toward the hem (and their shade).
  const foldAt = (p: V3, turn: number): number => {
    const s = clamp((REL - p[2]) / (REL - HEM), 0, 1);
    const u = turn / (Math.PI / 2);
    return Math.pow(s, 1.4) * (0.26 * Math.exp(-(((u - 0.42) / 0.16) ** 2)) + 0.32 * Math.exp(-(((u + 0.36) / 0.2) ** 2)) + 0.14 * Math.exp(-(((u - 1.25) / 0.14) ** 2)) + 0.14 * Math.exp(-(((u + 1.3) / 0.14) ** 2)));
  };
  const outOf = (p: V3): V3 => norm([p[0] / (env.a * env.a), (p[1] - env.cy) / (env.b * env.b), 0]);
  const rows = grid.map((row) => row.map((c) => add(c.p, scale(outOf(c.p), foldAt(c.p, c.turn)))));
  const start = b.vertexCount;
  b.surface(rows, {
    closed: false,
    paint: () => WHITE,
    weight: (p, i, k) => (grid[i][k].cap.w ? mixW([W(p), 1 - grid[i][k].cap.k], [grid[i][k].cap.w!, grid[i][k].cap.k]) : W(p)),
    out: (i, k) => outOf(rows[i][k]),
    fin: (i, k) => bodyFin(rows[i][k], grid[i][k].turn, grid[i][k].door),
  });
  parts.push({
    from: start,
    to: b.vertexCount,
    code: ROBE_CODE.body,
    role: ROBE_ROLE.cloth,
    // Shade in the valleys beside the folds, and under the sash.
    shade: (p) => {
      const s = clamp((REL - p[2]) / (REL - HEM), 0, 1);
      const turn = Math.atan2(p[0], p[1] - env.cy);
      const u = turn / (Math.PI / 2);
      const valley = Math.exp(-(((u - 0.1) / 0.14) ** 2)) + Math.exp(-(((u + 0.72) / 0.14) ** 2)) + Math.exp(-(((u - 0.78) / 0.14) ** 2));
      return clamp(0.34 * Math.pow(s, 1.1) * valley * (p[1] > env.cy ? 1 : 0) + (tied ? 0.5 * Math.exp(-(((p[2] - ROBE.tie + 1.6) / 1.1) ** 2)) : 0), 0, 1);
    },
  });

  // --- The collar band: up the right front edge, round the neck, down the left ------------------------------------------
  {
    const path: { p: V3; n: V3; across: V3; turn: number; door: number }[] = [];
    const push = (i: number, j: number) => {
      const p = rows[i][j], n = outOf(p);
      // Across the band: along the sheet, away from the free edge.
      const jn = j === 0 ? 1 : j === 2 * K ? 2 * K - 1 : j;
      const along: V3 = j === 0 || j === 2 * K ? norm(sub(rows[i][jn], p)) : [0, 0, -1];
      path.push({ p, n, across: along, turn: grid[i][j].turn, door: grid[i][j].door });
    };
    for (let i = 0; i < zs.length; i++) push(i, 0);
    for (let j = 1; j < 2 * K; j++) push(zs.length - 1, j);
    for (let i = zs.length - 1; i >= 0; i--) push(i, 2 * K);
    const Wb = ROBE.band, T = ROBE.bandT;
    const secs = path.map((q) => {
      // It folds over the edge: a little past it, then back over the cloth; proud of the cloth by its thickness.
      const o = add(q.p, scale(q.across, -0.2));
      return [add(o, scale(q.n, T)), add(add(o, scale(q.across, Wb)), scale(q.n, T)), add(add(o, scale(q.across, Wb)), scale(q.n, 0.04)), add(o, scale(q.n, -0.1))];
    });
    const s0 = b.vertexCount;
    b.surface(secs, { closed: true, paint: () => WHITE, weight: (p) => W(p), flat: false, out: (i, k) => (k < 2 ? path[i].n : scale(path[i].n, -1)), capStart: WHITE, capEnd: WHITE, fin: (i, k) => bodyFin(secs[i][k % 4], path[i].turn, path[i].door) });
    parts.push({ from: s0, to: b.vertexCount, code: ROBE_CODE.body, role: ROBE_ROLE.band });
  }

  // --- The sash and its knot (tied) --------------------------------------------------------------------------------------
  if (tied) {
    const N = 56, H = ROBE.sash;
    const ringAt = (z: number, extra: number) => Array.from({ length: N }, (_, k) => {
      const th = Math.PI / 2 - (k / N) * Math.PI * 2;
      return at(z, th, ROBE.off + 0.3 + extra);
    });
    const zc = ROBE.tie;
    const secs = [ringAt(zc - H / 2, 0.02), ringAt(zc - H / 2 + 0.25, 0.26), ringAt(zc + H / 2 - 0.25, 0.26), ringAt(zc + H / 2, 0.02)];
    const s0 = b.vertexCount;
    const turnOf = (p: V3) => Math.atan2(p[0], p[1] - env.cy);
    b.surface(secs, { closed: true, paint: () => WHITE, weight: (p) => W(p), out: (i, k) => outOf(secs[i][k]), fin: (i, k) => bodyFin(secs[i][k % N], turnOf(secs[i][k % N]), 0) });
    // The knot, a little to the bunny's right of the middle (over the crossed fronts), and its two short ends.
    const kx = -2.2;
    const kth = thFront(zc, kx, ROBE.off + 0.5);
    const kp = at(zc, kth, ROBE.off + 0.75), kn = outOf(kp);
    const [, ku, kv] = frame(kn, [0, 0, 1]);
    const knot = b.ellipsoidRows(kp, [1.05, 1.05, 1.05], kn, ku, 10, 5).map((row) => row.map((q): V3 => add(kp, add(add(scale(kv, (q[0] - kp[0]) * kv[0] + (q[1] - kp[1]) * kv[1] + (q[2] - kp[2]) * kv[2]), scale(ku, ((q[0] - kp[0]) * ku[0] + (q[1] - kp[1]) * ku[1] + (q[2] - kp[2]) * ku[2]) * 0.82)), scale(kn, ((q[0] - kp[0]) * kn[0] + (q[1] - kp[1]) * kn[1] + (q[2] - kp[2]) * kn[2]) * 0.5)))));
    b.surface(knot, { paint: () => WHITE, weight: (p) => W(p), fin: (i, k) => bodyFin(knot[i][k % 10], turnOf(kp), 0) });
    for (const [dx, lenE] of [[-0.75, 4.6], [0.7, 3.6]] as const) {
      const pathE: V3[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5, z = zc - 0.4 - t * lenE;
        const th = thFront(z, kx + dx * (1 + 1.1 * t), ROBE.off + 0.5);
        pathE.push(at(z, th, ROBE.off + 0.55 + 0.25 * Math.sin(Math.PI * t)));
      }
      const secsE = pathE.map((p, i) => {
        const n = outOf(p);
        const d = norm(sub(pathE[Math.min(5, i + 1)], pathE[Math.max(0, i - 1)]));
        const a = norm(cross(n, d)), hw = 0.62 + 0.12 * (i / 5);
        return [add(add(p, scale(a, hw)), scale(n, 0.14)), add(add(p, scale(a, -hw)), scale(n, 0.14)), add(add(p, scale(a, -hw)), scale(n, -0.1)), add(add(p, scale(a, hw)), scale(n, -0.1))];
      });
      b.surface(secsE, { closed: true, paint: () => WHITE, weight: (p) => W(p), out: (i, k) => (k < 2 ? outOf(pathE[i]) : scale(outOf(pathE[i]), -1)), capEnd: WHITE, fin: (i, k) => bodyFin(secsE[i][k % 4], turnOf(pathE[i]), 0) });
    }
    parts.push({ from: s0, to: b.vertexCount, code: ROBE_CODE.body, role: ROBE_ROLE.band });
  }

  // --- The sleeves -----------------------------------------------------------------------------------------------------
  const Rs = ROBE.sleeve.r * fit.sleeve, DROP = ROBE.sleeve.drop;
  let sleeveLen = 0;
  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const clav = B(`${side}_Clavicle`), up = B(`${side}_UpperArm`), fore = B(`${side}_Forearm`);
    const sh = r.at(`${side}_UpperArm`), el = r.at(`${side}_Forearm`), wr = r.at(`${side}_Hand`);
    const d1 = norm(sub(el, sh)), d2 = norm(sub(wr, el));
    const L1 = len(sub(el, sh));
    const S0 = ROBE.sleeve.from, S1 = L1 + ROBE.sleeve.past;
    sleeveLen = S1 - S0;
    // The arm's line, as the hoodie's sleeve runs (mesh.ts): turned in toward the neck above the joint.
    const capDir = norm([sx, 0, -0.3]);
    const pos = (s: number): V3 => {
      const c: V3 = s < 0 ? add(sh, scale(norm(lerp3(d1, capDir, 0.75)), s)) : s <= L1 ? add(sh, scale(d1, s)) : add(el, scale(d2, s - L1));
      c[0] -= sx * fit.shoulder * (1 - smoothstep(0, L1 + 6, s));
      return c;
    };
    const { side: h0, up: u0 } = sleeveFrame(sx);
    // How far it hangs at s: a round of the arm at the shoulder, then at once the sleeve's full drop (a rectangle: its
    // bottom edge straight along the arm, its outer corner all but square).
    const C = ROBE.sleeve.corner;
    const radius = (s: number) => sleeveRadius(s, Rs);
    const depth = (s: number) => {
      const full = radius(s) + (DROP - radius(s)) * smoothstep(0.3, 3.4, s);
      const e = s - (S1 - C);
      return e > 0 ? full - (C - Math.sqrt(Math.max(0, C * C - e * e))) : full;
    };
    // Half its width at drop D: round under the arm for the first radius (fitted to it), then a flat double sheet, thin
    // as cloth, down to its bottom seam.
    const half = (D: number, dep: number, R: number) => {
      const round = R * Math.sqrt(Math.max(0, 1 - Math.min(1, D / R) ** 2));
      if (dep <= R * 1.05) return Math.max(round, 0.02);
      const flat = (ROBE.sleeve.gap / 2) * Math.sqrt(Math.max(0, 1 - (D / dep) ** 8)) * smoothstep(R * 1.05, R * 1.5, dep);
      return Math.max(round, flat, 0.02);
    };
    const NS = 15, NA = 5, NH = 8;
    const ss = Array.from({ length: NS + 1 }, (_, i) => S0 + (S1 - S0) * Math.pow(i / NS, 0.92));
    // Round the section from the bottom of one side, over the arm, to the bottom of the other: [l, u, D] per point.
    const section = (s: number): [number, number, number][] => {
      const dep = depth(s), R = radius(s), out: [number, number, number][] = [];
      const drops = Array.from({ length: NH }, (_, j) => (j < 4 ? R * [0.38, 0.7, 0.92, 1.12][j] : R * 1.12 + (dep - R * 1.12) * ((j - 3) / (NH - 4))) * Math.min(1, dep / (R * 1.12)));
      for (let j = NH - 1; j >= 0; j--) out.push([-half(drops[j], dep, R), 0, drops[j]]);
      for (let j = 0; j <= 2 * NA; j++) {
        const phi = -Math.PI / 2 + (j / (2 * NA)) * Math.PI;
        out.push([R * Math.sin(phi), R * Math.cos(phi), 0]);
      }
      for (let j = 0; j < NH; j++) out.push([half(drops[j], dep, R), 0, drops[j]]);
      return out;
    };
    const secs = ss.map(section);
    // (As robe-fx.ts draws it: the first radius of the drop square to the arm, the rest straight down.)
    const place = (c: V3, q: [number, number, number], R: number): V3 => {
      const round = Math.min(q[2], R), u = q[1] - round;
      return [c[0] + h0[0] * q[0] + u0[0] * u, c[1] + h0[1] * q[0] + u0[1] * u, c[2] + h0[2] * q[0] + u0[2] * u - (q[2] - round)];
    };
    const cen = ss.map(pos);
    const pts = secs.map((sec, i) => sec.map((q) => place(cen[i], q, radius(ss[i]))));
    const armW = (s: number): Wt => {
      const w = hat(s, [[0.5, up], [L1 - 1.8, up], [L1 + 1.8, fore]]);
      const c = smoothstep(2.5, -2.6, s) * 0.45;
      return mixW([w, 1 - c], [[[clav, 1]], c]);
    };
    // The opening's edge: the collar band's colour, a narrow band of it.
    const BAND_COLS = 2;
    for (const [role, i0, i1] of [[ROBE_ROLE.cloth, 0, NS - BAND_COLS], [ROBE_ROLE.band, NS - BAND_COLS, NS]] as const) {
      const s0 = b.vertexCount;
      b.surface(pts.slice(i0, i1 + 1), {
        closed: false,
        paint: () => WHITE,
        weight: (_p, i) => armW(ss[i0 + i]),
        out: (i, k) => {
          const q = secs[i0 + i][k], R = radius(ss[i0 + i]);
          return q[2] > R ? scale(h0, Math.sign(q[0])) : add(scale(h0, q[0]), scale(u0, q[1] - q[2]));
        },
        fin: (i, k) => [secs[i0 + i][k][0], secs[i0 + i][k][1], secs[i0 + i][k][2], (ss[i0 + i] - S0) / ROBE_S],
        // (Closed where it starts, inside the shoulder.)
        capStart: i0 === 0 ? WHITE : null,
      });
      parts.push({ from: s0, to: b.vertexCount, code: ROBE_CODE.sleeve, role });
    }
  }

  // --- Its attributes --------------------------------------------------------------------------------------------------
  const g = b.geometry();
  const P = g.getAttribute("position"), F = g.getAttribute("finishUV"), C = g.getAttribute("partColor") as THREE.BufferAttribute;
  const n = P.count;
  const fx = new Float32Array(n * 4);
  for (const part of parts)
    for (let i = part.from; i < part.to; i++) {
      const shade = part.shade ? 0.45 * clamp(part.shade([P.getX(i), P.getY(i), P.getZ(i)]), 0, 1) : 0;
      fx[i * 4] = part.code + shade;
      fx[i * 4 + 2] = F.getW(i);
      fx[i * 4 + 3] = part.role;
      C.setXYZ(i, F.getX(i), F.getY(i), F.getZ(i));
    }
  g.deleteAttribute("finishUV");
  g.setAttribute("backfx", new THREE.Float32BufferAttribute(fx, 4));
  // (Plain shading as headwear goes: robe-fx.ts shades its cloth itself.)
  g.setAttribute("headwear", new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 50), 60);
  const rigOf: BackRig = { pivot: [0, env.cy, REL], axis: [REL - HEM, ROBE.hip, arc(Math.PI / 2)], robe: { drop: DROP, sleeve: sleeveLen, radius: Rs, from: ROBE.sleeve.from } };
  g.userData.backRig = rigOf;
  return { geometry: g, rig: rigOf, triangles: n / 3 };
}

/** Where a sleeve's swing is read from (bind space, on the left arm's line; mirror x): the middle of the forearm's part. */
export function sleeveAnchor(): { bone: string; at: V3 } {
  const r = rig();
  const el = r.at("L_Forearm"), wr = r.at("L_Hand");
  return { bone: "Forearm", at: lerp3(el, wr, 0.3) };
}
