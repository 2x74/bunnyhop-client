// Finger / blade clearance for inspect authoring (dev tool + unit tests; nothing in the game imports it). The hand and
// the carrot are approximated by capsules built from the posed bones, with the radii of viewmodel/mesh.ts and the
// carrot recipe (knives/carrot.ts): fingers and thumb per segment, the palm as three capsules along the palm axis,
// the cuff around the wrist. The blade, guard and leaves are always checked; the grip only while the clip says the
// knife is out of the fist (InspectClip.free), since holding it means touching it.
//
// clearance(W) -> the smallest surface gap (units; < 0 = interpenetration) and the pair that has it.

import type { Arm, V3 } from "./kit";
import { add, col, mul, norm, pos, sub } from "./kit";

interface Capsule {
  a: V3;
  b: V3;
  r: number;
  name: string;
}

function segDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  // Closest points between two segments (Ericson, Real-Time Collision Detection 5.1.9).
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s = 0, t = 0;
  const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
  if (a <= 1e-9 && e <= 1e-9) s = t = 0;
  else if (a <= 1e-9) t = Math.min(1, Math.max(0, f / e));
  else if (e <= 1e-9) s = Math.min(1, Math.max(0, -c / a));
  else {
    const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
    const den = a * e - b * b;
    s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
    t = (b * s + f) / e;
    if (t < 0) (t = 0), (s = Math.min(1, Math.max(0, -c / a)));
    else if (t > 1) (t = 1), (s = Math.min(1, Math.max(0, (b - c) / a)));
  }
  const c1 = add(p1, mul(d1, s)), c2 = add(p2, mul(d2, t));
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
}

const FINGER_R: Record<string, [number, number]> = { index: [0.42, 0.92], middle: [0.44, 0.98], ring: [0.42, 0.92], pinky: [0.37, 0.8] };

/** Hand capsules (fingers, thumb, palm, cuff) from the posed bones. */
export function handCapsules(W: Float32Array, arm: Arm): Capsule[] {
  const out: Capsule[] = [];
  for (const f of ["index", "middle", "ring", "pinky"] as const) {
    const [r, tipLen] = FINGER_R[f];
    const c = arm.fingers[f];
    const j = c.map((i) => pos(W, i));
    const tip = add(j[2], mul(norm(col(W, c[2], 0)), tipLen));
    out.push({ a: j[0], b: j[1], r, name: `${f}1` }, { a: j[1], b: j[2], r: r * 0.95, name: `${f}2` }, { a: j[2], b: tip, r: r * 0.88, name: `${f}3` });
  }
  {
    const c = arm.fingers.thumb;
    const j = c.map((i) => pos(W, i));
    const tip = add(j[2], mul(norm(col(W, c[2], 0)), 1.02));
    out.push({ a: j[0], b: j[1], r: 0.62, name: "thumb1" }, { a: j[1], b: j[2], r: 0.48, name: "thumb2" }, { a: j[2], b: tip, r: 0.42, name: "thumb3" });
  }
  const h = arm.frame(W);
  // Palm: a rounded block (mesh.ts: half width ~1.3-1.6, half thickness ~0.6-0.95), three capsules along the palm axis.
  for (const k of [-0.8, 0, 0.8]) {
    const base = add(add(h.wrist, mul(h.w, k)), mul(h.n, 0.08));
    out.push({ a: add(base, mul(h.ax, -0.6)), b: add(base, mul(h.ax, h.palmL - 0.1)), r: 0.82, name: `palm${k}` });
  }
  // Cuff (trim) and sleeve around the wrist / forearm.
  out.push({ a: add(h.wrist, mul(h.fore, -6)), b: add(h.wrist, mul(h.fore, 0.35)), r: 2.1, name: "cuff" });
  return out;
}

/** Carrot capsules (knife-local z along the blade) from the Knife_Handle bone. */
export function carrotCapsules(W: Float32Array, arm: Arm, withGrip: boolean): Capsule[] {
  const k = arm.kb;
  const o = pos(W, k);
  const x = col(W, k, 0), z = col(W, k, 2);
  const at = (zz: number, xx = 0): V3 => add(add(o, mul(z, zz)), mul(x, xx));
  const y = col(W, k, 1);
  const rim = (a: number): V3 => add(at(1.95, 0.62 * Math.cos(a)), mul(y, 0.88 * Math.sin(a)));
  const out: Capsule[] = [
    // Guard: a thick elliptical disc (semi-axes 0.92 x 1.22, 0.7 thick): a hub plus a ring of eight tubes.
    { a: at(1.65), b: at(2.25), r: 0.72, name: "guard" },
    ...Array.from({ length: 8 }, (_, i) => ({ a: rim((i * Math.PI) / 4), b: rim(((i + 1) * Math.PI) / 4), r: 0.34, name: "guard" })),
    { a: at(2.5), b: at(4.4), r: 0.72, name: "blade1" },
    { a: at(4.4), b: at(6.6), r: 0.55, name: "blade2" },
    { a: at(6.6), b: at(8.8), r: 0.38, name: "blade3" },
    { a: at(8.8), b: at(11.0), r: 0.2, name: "blade4" },
    { a: at(-2.5), b: at(-4.4, -0.5), r: 0.35, name: "leaves" },
  ];
  if (withGrip) out.push({ a: at(-2.2), b: at(1.5), r: 0.5, name: "grip" });
  return out;
}

export interface Clearance {
  gap: number;
  a: string;
  b: string;
}

/** Gap per (knife part, hand part) pair, "guard/thumb3" -> units. */
export function pairGaps(W: Float32Array, arm: Arm, withGrip: boolean): Map<string, number> {
  const hand = handCapsules(W, arm);
  const knife = carrotCapsules(W, arm, withGrip);
  const out = new Map<string, number>();
  for (const kc of knife)
    for (const hc of hand) {
      const key = `${kc.name}/${hc.name}`;
      const g = segDist(kc.a, kc.b, hc.a, hc.b) - kc.r - hc.r;
      if (!(g >= (out.get(key) ?? Infinity))) out.set(key, g);
    }
  return out;
}

/** Smallest gap between the carrot and the hand (units, < 0 = they intersect). */
export function clearance(W: Float32Array, arm: Arm, withGrip: boolean): Clearance {
  let best: Clearance = { gap: Infinity, a: "", b: "" };
  for (const [k, g] of pairGaps(W, arm, withGrip))
    if (g < best.gap) {
      const [a, b] = k.split("/");
      best = { gap: g, a, b };
    }
  return best;
}

/**
 * New contact against a reference pose (the held rest): per pair, how far the gap falls below min(0, the reference
 * gap). The hold itself has contacts (fingers on the grip, the thumb over the guard); an inspect may keep those but
 * must not add any. Returns the worst pair; gap >= 0 means no new interpenetration.
 */
export function newContact(W: Float32Array, arm: Arm, withGrip: boolean, ref: Map<string, number>): Clearance {
  let best: Clearance = { gap: Infinity, a: "", b: "" };
  for (const [k, g] of pairGaps(W, arm, withGrip)) {
    const e = g - Math.min(0, ref.get(k) ?? 0);
    if (e < best.gap) {
      const [a, b] = k.split("/");
      best = { gap: e, a, b };
    }
  }
  return best;
}
