// Wigs (Supporter hats, progression.ts slot "hat"; registered in hats.ts): hair in the player's colour (loadout.ts
// hairColor; hair faces carry accent -9..-11 and their tone in partColor, player/hat-fx.ts).
//
//   - Space Buns: two wound buns, each tied off with a scrunchie in the colourway's accent.
//   - Ponytail: a high ponytail tied with a scrunchie, swaying as the bunny moves, at the player's length (loadout.ts
//     hairLength: built at 100%, the shader stretches it along PONYTAIL_LINE / PONYTAIL_HEAD_LINE, hat-fx.ts).
//
// Two builds of each (hats.ts headwearKey):
//   - down (the standard bunny, whose hood is lowered for a wig: mesh.ts): a cap of hair over the bare head with a side
//     parting, layered bangs falling to the top of the visor, short locks along the hairline; the buns on top of the
//     head, the ponytail high on the back of it.
//   - up (Plush, Bun-E: their hoods stay up): a fringe under the hood rim, the buns / ponytail on the hood. The fringe is
//     marked as a face part (headwear 2) so hat-fit.ts fits it to their faceplates.
//
// Bind pose, Source space (z up, the bunny faces -y), skinned to the head bone like every hat.

import * as THREE from "three";
import { add, Builder, cr, frame, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";

export const headWeight = (): Wt => [[rig().bone("Head1"), 1]];

/**
 * A hair face: the player's colour at a tone (0.5 = the colour, lower toward the roots / underside, higher a sheen),
 * stored linear in partColor.r. code -10 still, -9 / -11 the swinging ponytails (hat-fx.ts), -12 a sprung lock
 * (hair-fx.ts). `hi` (partColor.g): how much of the player's highlight colour the face takes, 0 none .. 1 all of it
 * (nothing shows until a highlight is picked). `loose` (partColor.b): a sprung lock's looseness.
 */
const c01 = (x: number) => Math.max(0, Math.min(1, x));
export const hair = (tone: number, code = -10, hi = 0, loose = 0): Paint => ({ code, color: new THREE.Color().setRGB(c01(tone), c01(hi), c01(loose), THREE.LinearSRGBColorSpace).getHex() });
/** Tones: the base, a shade for locks that sit under others, a light for the ones on top. */
export const HAIR = { base: 0.5, shade: 0.44, light: 0.555 } as const;
/**
 * Highlights (v0.0.42): a lock's share of the highlight colour at t (0 root .. 1 tip) and x (-1..1 across it), written
 * per vertex (Builder.green), so it has soft edges. The roots stay the base colour, like grown-out dye.
 *   tip     the lock's last part
 *   soft    a lighter touch on the very end
 *   whole   all of the lock from a little way off the root (a spike, a small lock)
 *   strand  a strand of it (at x, w wide) from near the root, widening into the whole end
 */
export type Hi = (t: number, x: number) => number;
const bump = (x: number, at: number, w: number) => Math.max(0, 1 - ((x - at) / w) ** 2);
export const HI = {
  tip: ((t) => smoothstep(0.5, 0.86, t)) as Hi,
  soft: ((t) => 0.7 * smoothstep(0.6, 0.95, t)) as Hi,
  whole: ((t) => smoothstep(0.08, 0.34, t)) as Hi,
  strand: (at: number, w = 0.42): Hi => (t, x) => Math.max(smoothstep(0.08, 0.34, t) * Math.min(1, 1.25 * bump(x, at, w)), 0.85 * smoothstep(0.62, 0.95, t)),
};
export { bump as hiBump };
/** Scrunchies in the colourway's accent (Paint code 1, like the ears' panels). */
const TIE: Paint = { code: 1 };

/** The face (mesh.ts) and the hood (mesh.ts): centres and radii; -y is the face side. */
export const FACE_C: V3 = [0, -0.55, 68.7];
export const FACE_R: V3 = [4.05, 4.35, 4.85];
export const HOOD_C: V3 = [0, 0.55, 69.35];
export const HOOD_R: V3 = [5.55, 6.05, 6.0];

/** A point on the face, `off` out from it: lon 0 = straight ahead (+ toward the bunny's left, +x), lat 0 = the visor. */
export function facePoint(lon: number, lat: number, off: number): V3 {
  const d: V3 = [Math.sin(lon) * Math.cos(lat), -Math.cos(lon) * Math.cos(lat), Math.sin(lat)];
  return [FACE_C[0] + d[0] * (FACE_R[0] + off), FACE_C[1] + d[1] * (FACE_R[1] + off), FACE_C[2] + d[2] * (FACE_R[2] + off)];
}

/** A point on the hood's rim (mesh.ts: the hood opens 0.98 rad round its forward axis); th 0 = the top, + toward +x. */
export function rimPoint(th: number, inset = 0): V3 {
  const [t, u, v] = frame(norm([0, -1, -0.12]), [0, 0, 1]);
  const a = 0.98 - inset;
  const d = add(scale(t, Math.cos(a)), add(scale(u, Math.sin(a) * Math.cos(th)), scale(v, Math.sin(a) * Math.sin(th))));
  return [HOOD_C[0] + d[0] * HOOD_R[0], HOOD_C[1] + d[1] * HOOD_R[1], HOOD_C[2] + d[2] * HOOD_R[2]];
}

/** A point on the hood's surface `off` out from it, from a direction (normalised onto the ellipsoid). */
export function hoodPoint(dir: V3, off: number): { p: V3; n: V3 } {
  const k = 1 / Math.hypot(dir[0] / HOOD_R[0], dir[1] / HOOD_R[1], dir[2] / HOOD_R[2]);
  const s: V3 = add(HOOD_C, scale(dir, k));
  const n = norm([(s[0] - HOOD_C[0]) / HOOD_R[0] ** 2, (s[1] - HOOD_C[1]) / HOOD_R[1] ** 2, (s[2] - HOOD_C[2]) / HOOD_R[2] ** 2]);
  return { p: add(s, scale(n, off)), n };
}

/** Catmull-Rom through control points, n samples. */
export function curve(ctrl: V3[], n: number): V3[] {
  const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const out: V3[] = [];
  for (let s = 0; s < n; s++) {
    const f = (s / (n - 1)) * (ctrl.length - 1);
    const i = Math.min(ctrl.length - 2, Math.floor(f)), t = f - i;
    const [p0, p1, p2, p3] = [P[i], P[i + 1], P[i + 2], P[i + 3]];
    out.push([0, 1, 2].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t * t * t)) as V3);
  }
  return out;
}

/**
 * A lock of hair along a path: a lens-shaped section `width` across (toward `across`) and `thick` deep, both functions
 * of t = 0 (root) .. 1 (tip), closed at both ends. tone(t, under): the tone along it, `under` for the side facing `in`.
 */
function lock(b: Builder, path: V3[], width: (t: number) => number, thick: (t: number) => number, across: V3, tone: (t: number, under: number) => Paint, W: Wt, inward: V3 | null = null, hi: Hi | null = null): void {
  const n = path.length, K = 16;
  const frames = path.map((p, i) => {
    const d = norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
    return frame(d, across);
  });
  const rows = path.map((p, i) => {
    const [, u, v] = frames[i];
    const t = i / (n - 1);
    return ring(p, u, v, Math.max(0.02, width(t)), Math.max(0.02, thick(t)), K, 2);
  });
  // How much a face looks toward `inward` (0..1): shaded gradually round the section, so no hard panel edges.
  const under = (i: number, k: number) => {
    if (!inward) return 0;
    const v = frames[i][2], a = ((k + 0.5) / K) * Math.PI * 2;
    return smoothstep(-0.3, 0.8, Math.sin(a) * (v[0] * inward[0] + v[1] * inward[1] + v[2] * inward[2]));
  };
  // The highlight's share, per vertex (so a streak has soft edges): where the vertex sits along the lock and across it.
  if (hi)
    b.green = (p) => {
      const [i, f] = nearestOn(path, p);
      const j = Math.min(n - 1, i + 1), t = (i + f) / (n - 1);
      const c = add(path[i], scale(sub(path[j], path[i]), f)), u = frames[f < 0.5 ? i : j][1], d = sub(p, c);
      return hi(t, (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / Math.max(0.05, width(t)));
    };
  b.surface(rows, { paint: (i, k) => tone(i / (n - 2), under(i, k)), weight: () => W, capStart: tone(0, 0), capEnd: tone(1, 0) });
  b.green = null;
}

/** The segment of a path nearest a point, and how far along it (0..1). */
export function nearestOn(path: V3[], p: V3): [number, number] {
  let best = Infinity, at = 0, f = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const ab = sub(path[i + 1], path[i]), l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    const u = Math.max(0, Math.min(1, ((p[0] - path[i][0]) * ab[0] + (p[1] - path[i][1]) * ab[1] + (p[2] - path[i][2]) * ab[2]) / l2));
    const q = add(path[i], scale(ab, u));
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best) (best = d), (at = i), (f = u);
  }
  return [at, f];
}

/** Tone along a lock: darker at the root, the lock's own tone along it, lighter toward the tip; the underside shaded. */
const lockTone = (base: number, code = -10) => (t: number, under: number): Paint =>
  hair(base - 0.1 * (1 - smoothstep(0, 0.4, t)) + 0.04 * smoothstep(0.55, 1, t) - 0.12 * under, code);

/** The fringe under the hood rim (hood up): an underlayer and wide locks falling onto the top of the visor. */
function fringeHood(b: Builder, W: Wt): void {
  fringeUnder(b, W);
  // Locks: [rim angle (rad), sideways sweep at the tip (rad of face longitude), lat of the tip, width, tone].
  const LOCKS: [number, number, number, number, number][] = [
    [-0.92, -0.05, 0.5, 1.0, HAIR.shade],
    [-0.62, 0.06, 0.4, 1.15, HAIR.base],
    [-0.31, 0.12, 0.35, 1.2, HAIR.base],
    [0.0, 0.14, 0.34, 1.2, HAIR.light],
    [0.31, 0.13, 0.36, 1.2, HAIR.base],
    [0.62, 0.1, 0.42, 1.1, HAIR.base],
    [0.92, 0.06, 0.52, 1.0, HAIR.shade],
  ];
  LOCKS.forEach(([th, sweep, tipLat, w, tone], j) => {
    const top = rimPoint(th, 0);
    const lon = Math.atan2(top[0] - FACE_C[0], -(top[1] - FACE_C[1])) * 0.92;
    const root = facePoint(lon, 1.12 - 0.12 * Math.abs(th), 0.3);
    const mid = facePoint(lon + sweep * 0.45, (tipLat + 1.0) / 2 + 0.04, 0.48);
    const tip = facePoint(lon + sweep, tipLat, 0.42);
    // Highlights: the two locks either side of the middle streaked, the outer pair tipped.
    const hi = j === 2 || j === 4 ? HI.strand(j === 2 ? 0.2 : -0.2, 0.5) : j === 0 || j === 6 ? HI.tip : null;
    lock(b, curve([root, mid, tip], 14), (t) => w * Math.sqrt(Math.max(0, 1 - t ** 3)) * (1 - 0.15 * t), (t) => 0.26 * (1 - 0.4 * t), [Math.cos(lon), Math.sin(lon), 0], lockTone(tone), W, scale(norm(sub(mid, FACE_C)), -1), hi);
  });
}

/** The fringe's underlayer (hood up): hair over the upper face from under the rim to just above the visor, so no face shows between locks. */
export function fringeUnder(b: Builder, W: Wt): void {
  const LON = 1.12, K = 28, R = 10;
  const edge = (lon: number) => 0.5 + 0.14 * (lon / LON) ** 2;
  const under = Array.from({ length: R + 1 }, (_, i) =>
    Array.from({ length: K + 1 }, (_, k) => {
      const lon = -LON + (2 * LON * k) / K;
      return facePoint(lon, 1.2 + (edge(lon) - 1.2) * (i / R), 0.3);
    }),
  );
  b.surface(under, { closed: false, paint: () => hair(HAIR.shade), weight: () => W, out: (i, k) => sub(under[i][k], FACE_C) });
}

// ---------------------------------------------------------------------------------------------
// Hood down: hair on the bare head.

/** Where the hair ends round the head (face latitude) by |longitude|: high on the forehead, down the sides behind the
 * visor's ends, to the nape. */
const HAIRLINE = [0.72, 0.68, 0.54, 0.22, -0.18, -0.4, -0.5, -0.54];
const hairline = (lon: number) => cr(HAIRLINE, (Math.min(1, Math.abs(Math.atan2(Math.sin(lon), Math.cos(lon))) / Math.PI)) * (HAIRLINE.length - 1));
/** The cap's standoff from the head: fuller over the crown, strand ridges running down from it. */
const capOff = (lon: number, s: number) => 0.5 + 0.26 * (1 - s) ** 1.5 + 0.06 * Math.sin(lon * 13 + 2 * Math.sin(lon * 5)) * smoothstep(0.15, 0.7, s) * (1 - smoothstep(0.92, 1, s));
/** A point on the cap: s = 0 the crown .. 1 the hairline. */
const capPoint = (lon: number, s: number, extra = 0): V3 => {
  const lat = Math.PI / 2 - (Math.PI / 2 - hairline(lon)) * s;
  return facePoint(lon, lat, capOff(lon, s) + extra);
};

/** The parting (face longitude, toward the bunny's left) the bangs fall away from. */
const PART = 0.32;
/**
 * Highlight streaks through the cap and the curtain under it: a few strands round the sides and back (longitudes, rad;
 * none over the forehead, where the bangs carry their own), each a strand or two of the cap's 72 wide.
 */
const STREAKS: [number, number][] = [[1.75, 0.1], [2.5, 0.12], [3.3, 0.09], [3.95, 0.12], [4.5, 0.1]];
const capStreak = (lon: number) => Math.max(0, ...STREAKS.map(([at, w]) => Math.min(1, 1.3 * bump(Math.atan2(Math.sin(lon - at), Math.cos(lon - at)), 0, w))));

/** The cap of hair over the head, its edge rolled under at the hairline, short locks along the sides and the nape. */
function cap(b: Builder, W: Wt, nape: boolean): void {
  const K = 72, R = 18;
  // The curtain's reach round the head (see below): where it hangs, the cap's edge keeps the curtain's tone, so there's no
  // line where one meets the other.
  const A0 = Math.PI * 0.34, A1 = Math.PI * 1.66;
  const covered = (lon: number) => smoothstep(A0 - 0.1, A0 + 0.2, lon) * (1 - smoothstep(A1 - 0.2, A1 + 0.1, lon));
  const rows: V3[][] = [];
  for (let i = 0; i <= R; i++) rows.push(Array.from({ length: K }, (_, k) => capPoint((k / K) * Math.PI * 2, (i / R) ** 0.85)));
  // Rolled under at the edge, so it has thickness.
  rows.push(Array.from({ length: K }, (_, k) => {
    const lon = (k / K) * Math.PI * 2;
    return facePoint(lon, hairline(lon) + 0.03, 0.08);
  }));
  // Highlight streaks (per vertex): by longitude, from a third of the way down from the crown.
  const lonLat = (p: V3): [number, number] => [Math.atan2(p[0] - FACE_C[0], -(p[1] - FACE_C[1])), Math.asin(Math.max(-1, Math.min(1, (p[2] - FACE_C[2]) / (FACE_R[2] + 0.6))))];
  b.green = (p) => {
    const [lon, lat] = lonLat(p);
    return capStreak(lon) * smoothstep(0.3, 0.62, (Math.PI / 2 - lat) / Math.max(0.2, Math.PI / 2 - hairline(lon)));
  };
  b.surface(rows, {
    closed: true,
    // Strands in alternating tones, darker toward the edge (it's in the cap's shadow) and along the parting.
    paint: (i, k) => {
      const lon = ((k + 0.5) / K) * Math.PI * 2;
      const s = i / R;
      const part = Math.abs(Math.atan2(Math.sin(lon - PART), Math.cos(lon - PART))) < 0.06 && s < 0.5 ? -0.12 : 0;
      return hair(HAIR.base + 0.02 * Math.cos(lon * 11) - 0.1 * smoothstep(0.6, 1, s) * (1 - 0.8 * covered(lon)) + part);
    },
    weight: () => W,
    out: (i, k) => sub(rows[i][k], FACE_C),
  });
  b.green = null;
  // The hair falling below the hairline at the sides and back: one continuous curtain (no stepped locks) from under
  // the cap, hanging a little off the head as it narrows, its edge cut into soft points. With a ponytail the back is
  // pulled up into the tie, so the curtain is short there.
  const KC = 120, RC = 10;
  const teeth = 15;
  const length = (lon: number) => {
    const a = Math.abs(Math.atan2(Math.sin(lon), Math.cos(lon)));
    const back = smoothstep(2.2, 2.9, a);
    return (nape ? 0.4 - 0.08 * back : 0.4 - 0.3 * back) - 0.06 * smoothstep(1.4, 1.1, a);
  };
  const edgeLat = (lon: number) => {
    const f = ((lon - A0) / (A1 - A0)) * teeth;
    const tri = Math.abs(f - Math.round(f)) * 2; // 0 at a point, 1 between
    return hairline(lon) - length(lon) + 0.13 * Math.pow(tri, 1.6) * smoothstep(0, 0.08, length(lon));
  };
  const curtain: V3[][] = [];
  for (let i = 0; i <= RC; i++) {
    const f = i / RC;
    curtain.push(Array.from({ length: KC + 1 }, (_, k) => {
      const lon = A0 + ((A1 - A0) * k) / KC;
      const top = hairline(lon) + 0.3;
      const lat = top + (edgeLat(lon) - top) * f;
      const hang = Math.max(0, hairline(lon) - lat);
      return facePoint(lon, lat, capOff(lon, 0.85) - 0.12 + 0.18 * f + 0.9 * hang * hang + 0.012 * Math.sin(lon * 23) * f);
    }));
  }
  // Highlights: the cap's streaks run on down it, and its points take a touch.
  b.green = (p) => {
    const [l0, lat] = lonLat(p), lon = l0 < 0 ? l0 + Math.PI * 2 : l0;
    const top = hairline(lon) + 0.3;
    return Math.max(capStreak(lon), 0.7 * smoothstep(0.6, 1, (top - lat) / Math.max(0.05, top - edgeLat(lon))));
  };
  b.surface(curtain, {
    closed: false,
    paint: (i, k) => {
      const lon = A0 + ((k + 0.5) / KC) * (A1 - A0);
      // From the cap edge's tone at the top (its 11-strand ripple included) to a shade darker at the points.
      return hair(HAIR.base - 0.02 - 0.05 * smoothstep(0.4, 1, i / RC) + 0.02 * Math.cos(lon * 11));
    },
    weight: () => W,
    out: (i, k) => sub(curtain[i][k], FACE_C),
  });
  b.green = null;
  // Its inside (seen from below / behind the visor's ends), a shade darker.
  const inside = curtain.map((row) => row.map((q) => add(q, scale(norm(sub(q, FACE_C)), -0.08))));
  b.surface(inside, { closed: false, paint: () => hair(HAIR.shade - 0.06), weight: () => W, out: (i, k) => sub(FACE_C, inside[i][k]) });
}

/** Bangs: thick locks from the parting, over the forehead, ending in curled points on the top edge of the visor. */
function bangs(b: Builder, W: Wt): void {
  // [tip longitude, tip latitude, half width, tone, how far it sweeps sideways from the parting]: uneven, the ones on
  // the wide side of the parting swept across the forehead, the outer ones framing the face beside the visor. Drawn
  // back to front so the front ones lie over.
  const LOCKS: [number, number, number, number, number][] = [
    [-1.24, 0.02, 0.6, HAIR.shade, 0.2],
    [1.22, 0.1, 0.58, HAIR.shade, 0.15],
    [-0.98, 0.33, 0.8, HAIR.base, 0.5],
    [0.96, 0.43, 0.72, HAIR.base, 0.25],
    [-0.7, 0.4, 0.9, HAIR.shade, 0.6],
    [0.7, 0.36, 0.78, HAIR.light, 0.3],
    [-0.42, 0.34, 0.95, HAIR.base, 0.7],
    [0.5, 0.42, 0.7, HAIR.base, 0.2],
    [-0.12, 0.39, 0.9, HAIR.light, 0.75],
    [0.16, 0.33, 0.85, HAIR.base, 0.55],
  ];
  LOCKS.forEach(([lonT, latT, w, tone, sweep], j) => {
    const side = lonT < PART ? -1 : 1;
    // Highlights: the two face-framing locks beside the visor, and one lock of the fringe each side of the parting.
    const hi = j < 2 ? HI.whole : j === 5 || j === 6 ? HI.strand(j === 5 ? 0.25 : -0.25, 0.5) : null;
    // From the parting the lock lifts a little over the cap, falls, and curls out at its tip. Swept locks start nearer
    // the parting and travel across; the others start above where they end.
    const lonR = PART + (lonT - PART) * (1 - sweep) * 0.8 + side * 0.08;
    const root = facePoint(lonR, 1.2, capOff(lonR, 0.2) - 0.18);
    const crest = facePoint(lonR + (lonT - lonR) * 0.4, 0.96, capOff(lonT, 0.4) + 0.24);
    const fall = facePoint(lonT - side * 0.05 * sweep, latT + 0.2, 0.8);
    const tip = facePoint(lonT + side * 0.06, latT, 0.6);
    const curl = facePoint(lonT + side * 0.1, latT - 0.03, 0.8);
    const path = curve([root, crest, fall, tip, curl], 20);
    const across: V3 = [Math.cos(lonT), Math.sin(lonT), 0];
    lock(b, path, (t) => w * (0.7 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.3))) * Math.sqrt(Math.max(0, 1 - t ** 4)) + 0.03, (t) => 0.34 * (1 - 0.55 * t) + 0.04, across, lockTone(tone), W, scale(norm(sub(fall, FACE_C)), -1), hi);
  });
}

/** A scrunchie: a ruffled ring round `axis` at c, in the colourway's accent. */
function scrunchie(b: Builder, c: V3, axis: V3, r: number, W: Wt, thick = 0.4): void {
  const [, u, v] = frame(axis, [0, 0, 1]);
  const N = 40;
  const path: V3[] = Array.from({ length: N + 1 }, (_, k) => {
    const a = (k / N) * Math.PI * 2;
    return add(c, add(scale(u, Math.cos(a) * r), scale(v, Math.sin(a) * r)));
  });
  b.tube(path, (i) => thick + 0.06 * Math.cos(i * 1.6), 10, axis, () => TIE, () => W, false);
}

/** A bun: a ball of hair at c (out along n) with a lock wound round it, tied at its foot with a scrunchie. */
function bun(b: Builder, c: V3, n: V3, R: number, W: Wt, twist: number): void {
  const [, u, v] = frame(n, [1, 0, 0]);
  const ball = b.ellipsoidRows(c, [R, R, R], n, u, 28, 16);
  // Lit from the top: the crown a shade lighter than the foot.
  // Highlights: the bun's top (the hair wound up last is the ends), fading out down its sides.
  b.green = (p) => 1 - smoothstep(0.2, 0.52, Math.acos(Math.max(-1, Math.min(1, ((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]) / R))) / Math.PI);
  b.surface(ball, { paint: (i) => hair(HAIR.base + 0.08 * (1 - i / 16) - 0.08 * (i / 16)), weight: () => W, out: (i, k) => sub(ball[i][k], c) });
  b.green = null;
  // The wound lock: a spiral from the foot to the crown, mostly sunk into the ball so it shows as soft grooves.
  const turns = 2.4, S = 110;
  const wind = Array.from({ length: S }, (_, s): V3 => {
    const f = s / (S - 1);
    const a = Math.PI * (0.76 - 0.72 * f);
    const az = twist * f * turns * Math.PI * 2;
    return add(c, scale(add(scale(n, Math.cos(a)), add(scale(u, Math.sin(a) * Math.cos(az)), scale(v, Math.sin(a) * Math.sin(az)))), R * 0.92));
  });
  lock(b, wind, (t) => 0.42 * (1 - 0.5 * t), () => 0.2, n, () => hair(HAIR.shade), W, null, (t) => smoothstep(0.45, 0.8, t));
  scrunchie(b, add(c, scale(n, -R * 0.8)), n, R * 0.62, W, 0.28);
}

/**
 * A ponytail at `root` (out along n): a full body and outer locks parting at the tip, each lock along `main` (offsets
 * from the root), faces in `code` so the shader swings them about the root; the scrunchie still.
 */
function tail(b: Builder, W: Wt, root: V3, n: V3, main: V3[], code: number, scale1 = 1): void {
  const pts = tailLine(root, n, main);
  const body = (t: number) => scale1 * (1.15 * Math.sqrt(Math.max(0, 1 - t ** 2.2)) * (1 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.8))) + 0.05);
  const inward = scale(n, -1);
  // Highlights: the tail's last part, and two of its outer locks streaked from the tie.
  lock(b, curve(pts, 24), body, (t) => body(t) * 0.82, [1, 0, 0], lockTone(HAIR.base, code), W, inward, HI.tip);
  for (const [dx, dy, dz, tone, streak] of [[-0.7, -0.15, 0.25, HAIR.shade, 0], [0.7, -0.05, 0.1, HAIR.light, 1], [0.1, 0.6, -0.4, HAIR.light, 1], [-0.15, -0.6, -0.8, HAIR.shade, 0]] as const) {
    const path = pts.map((p, i): V3 => add(p, scale([dx, dy, dz], scale1 * Math.min(1, i / 3) * (0.6 + 0.4 * (i / 5)))));
    path[path.length - 1] = add(path[path.length - 1], [dx * 0.7, 0, -0.3 + dz * 0.5]);
    lock(b, curve(path, 24), (t) => scale1 * (0.7 * Math.sqrt(Math.max(0, 1 - t ** 2)) + 0.05), (t) => scale1 * (0.5 * Math.sqrt(Math.max(0, 1 - t ** 2)) + 0.05), [1, 0, 0], lockTone(tone, code), W, inward, streak ? HI.whole : HI.tip);
  }
  scrunchie(b, root, n, 1.05 * scale1, W);
}

/** The geometry; with `face` set, the first `face` vertices (the fringe) are marked as face parts (hat-fit.ts). */
export function finish(b: Builder, face: number | null): THREE.BufferGeometry {
  const g = b.geometry();
  const n = g.getAttribute("position").count;
  g.setAttribute("headwear", new THREE.Float32BufferAttribute(Float32Array.from({ length: n }, (_, i) => (face !== null && i < face ? 2 : 1)), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 70), 60);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Hood up (Plush / Bun-E)

export function spaceBuns(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  fringeHood(b, W);
  const face = b.vertexCount;
  for (const side of [-1, 1]) {
    // On the hood's top, forward of and outside the ear roots (EAR.base x 2.25, y 1.35), so the ears stay free.
    const { p, n } = hoodPoint(norm([side * 0.55, -0.42, 0.72]), 0);
    const R = 1.9;
    bun(b, add(p, scale(n, R * 0.98)), n, R, W, side);
  }
  return finish(b, face);
}

/** A ponytail's centreline: just out from the tie, then through `main` (offsets from the root). */
const tailLine = (root: V3, n: V3, main: V3[]): V3[] => [add(root, scale(n, 0.2)), ...main.map((d) => add(root, d))];

/** Bind-space root of the hood ponytail (its scrunchie) on the back of the hood; it sways about this point (hat-fx.ts). */
export const PONYTAIL_C: V3 = hoodPoint(norm([0, 0.62, 0.78]), 0.25).p;
const PONY_MAIN_HOOD: V3[] = [[0, 1.5, 1.0], [0, 3.2, 0.5], [0, 4.2, -1.8], [0, 4.4, -4.6], [0, 4.0, -7.4]];
/** The hood ponytail's centreline (six points; the shader stretches the tail along it for hairLength, hat-fx.ts). */
export const PONYTAIL_LINE: V3[] = tailLine(PONYTAIL_C, hoodPoint(norm([0, 0.62, 0.78]), 0).n, PONY_MAIN_HOOD);

export function ponytail(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  fringeHood(b, W);
  const face = b.vertexCount;
  const { n } = hoodPoint(norm([0, 0.62, 0.78]), 0);
  tail(b, W, PONYTAIL_C, n, PONY_MAIN_HOOD, -9);
  return finish(b, face);
}

// ---------------------------------------------------------------------------------------------
// Hood down (the standard bunny)

export function spaceBunsDown(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  cap(b, W, true);
  for (const side of [-1, 1]) {
    // High on the head, either side of the crown, a little back.
    const lon = side * 1.62, lat = 0.92;
    const p = facePoint(lon, lat, capOff(lon, 0.3));
    const n = norm(sub(facePoint(lon, lat, 2), facePoint(lon, lat, 0)));
    const R = 1.75;
    bun(b, add(p, scale(n, R * 0.82)), n, R, W, side);
  }
  bangs(b, W);
  return finish(b, null);
}

/** Bind-space root of the head ponytail (its scrunchie), high on the back of the head (hat-fx.ts sways it about this). */
const PONY_LAT = 0.86;
export const PONYTAIL_HEAD_C: V3 = facePoint(Math.PI, PONY_LAT, 0.95);
const PONY_HEAD_N: V3 = norm(sub(facePoint(Math.PI, PONY_LAT, 2), facePoint(Math.PI, PONY_LAT, 0)));
const PONY_MAIN_HEAD: V3[] = [[0, 1.3, 1.1], [0, 3.1, 1.0], [0, 4.7, -0.9], [0, 5.6, -3.6], [0, 5.9, -6.6]];
/** The head ponytail's centreline (as PONYTAIL_LINE). */
export const PONYTAIL_HEAD_LINE: V3[] = tailLine(PONYTAIL_HEAD_C, PONY_HEAD_N, PONY_MAIN_HEAD);

export function ponytailDown(): THREE.BufferGeometry {
  const b = new Builder(), W = headWeight();
  cap(b, W, false);
  // Up and back from the tie, then falling clear of the lowered hood behind the neck.
  tail(b, W, PONYTAIL_HEAD_C, PONY_HEAD_N, PONY_MAIN_HEAD, -11, 1.05);
  bangs(b, W);
  return finish(b, null);
}
