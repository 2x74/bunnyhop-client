// Glove-style collision capsules for the first-person clearance checks (inspects/audit.ts `glove` option, unit test
// apps/api/test/glove-clearance.test.ts): what each style adds OUTSIDE the shared hand lofts (gloves/fp.ts): wrist
// straps / bands, gauntlet cuffs, the moto knuckle plate, the wrap tails. The hand lofts themselves are the same for
// every style (the finger capsules the audit already checks), so these are the only parts a knife could newly hit.
// Built from the posed bones like the audit's finger segments; radii from fp.ts (a little generous).

import type { GloveStyleId } from "../../loadout";
import type { VmRig } from "../rig";

export interface GloveCapsule {
  name: string;
  a: number[];
  b: number[];
  r: number;
  /**
   * Radius of what was already there under the glove part (the palm, the sleeve's trim cuff): the check counts only
   * the shell the glove adds (depth clamped to r - base), since the knife's relation to the bare hand / sleeve is the
   * hold's business, not the glove's.
   */
  base: number;
  /**
   * Exact depth of a point in the part (units, > 0 = inside), for parts a capsule fits badly: the hand bands are a
   * thin shell round the palm over a short stretch of it, where a capsule round the palm's section would reach far
   * down the palm and into the fist. When set, the audit uses it instead of the capsule (a, b, r stay as a bound).
   */
  depth?(p: ArrayLike<number>): number;
}

type V = [number, number, number];
const P = (W: ArrayLike<number>, i: number): V => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Hand bands per style (gloves/fp.ts handBand calls): growth over the palm (with the paws' scallops), s range. */
const BAND: Record<GloveStyleId, [number, number, number] | null> = {
  knit: null,
  plush: [.16, .5, 1.2],
  bune: null,
  sport: [0.2, 0.6, 1.28],
  driver: [0.12, 0.5, 0.68],
  wraps: [0.25, 0.5, 1.25],
  moto: null,
  specialist: null,
  paws: [0.39, 0.45, 1.22],
  garden: [0.18, 0.5, 1.18],
};

/** gloves/fp.ts PALM: half width / half thickness of the palm block at s (superellipse, exponent 2.7). */
function palmAt(s: number, palmL: number): [number, number] {
  const rows: [number, number, number][] = [[-1.1, 1.3, 0.92], [-0.2, 1.42, 0.95], [0.5, 1.5, 0.92], [palmL * 0.55, 1.62, 0.86], [palmL - 0.25, 1.62, 0.74], [palmL + 0.3, 1.42, 0.6]];
  if (s <= rows[0][0]) return [rows[0][1], rows[0][2]];
  for (let i = 0; i + 1 < rows.length; i++)
    if (s <= rows[i + 1][0]) {
      const t = (s - rows[i][0]) / (rows[i + 1][0] - rows[i][0]);
      return [rows[i][1] + (rows[i + 1][1] - rows[i][1]) * t, rows[i][2] + (rows[i + 1][2] - rows[i][2]) * t];
    }
  const l = rows[rows.length - 1];
  return [l[1], l[2]];
}

/** Right-hand glove capsules for a style in the posed skeleton W (empty for knit). */
export function gloveCapsules(W: ArrayLike<number>, r: VmRig, style: GloveStyleId): GloveCapsule[] {
  if (style === "knit") return [];
  const wrist = P(W, r.bone("Right_Hand"));
  const roots = (["Index", "Middle", "Ring", "Pinky"] as const).map((f) => P(W, r.bone(`Right_${f}01`)));
  const kc = mul(roots.reduce((s, p) => add(s, p), [0, 0, 0] as V), 0.25);
  const ax = norm(sub(kc, wrist));
  let w = sub(roots[0], roots[3]);
  w = norm(sub(w, mul(ax, dot(w, ax))));
  let n = cross(ax, w);
  if (dot(n, sub(P(W, r.bone("Right_Thumb02")), wrist)) < 0) n = mul(n, -1);
  const palmL = Math.hypot(...sub(kc, wrist));
  const fore = norm(sub(wrist, P(W, r.bone("Right_Arm"))));
  const at = (s: number, a: number, out: number): V => add(add(add(wrist, mul(ax, s)), mul(w, a)), mul(n, 0.08 - out));
  const out: GloveCapsule[] = [];
  const band = BAND[style];
  // Straps / bands round the hand just past the sleeve trim: a shell `grow` thick round the palm block between s0 and s1
  // (exact depth in the hand frame; the capsule across the palm is only its bound).
  if (band) {
    const [grow, s0, s1] = band;
    const c0 = add(wrist, mul(n, 0.08));
    out.push({
      name: "glove:band",
      a: at((s0 + s1) / 2, -1.05, 0),
      b: at((s0 + s1) / 2, 1.05, 0),
      r: 0.92 + grow + (s1 - s0) / 2,
      base: 0.92,
      depth(p) {
        const d: V = [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]];
        const s = dot(d, ax);
        if (s < s0 - 0.04 || s > s1 + 0.04) return 0;
        const [hw, ht] = palmAt(s, palmL);
        const a = Math.abs(dot(d, w)), y = Math.abs(dot(d, n));
        const rho = Math.pow(Math.pow(a / (hw + grow), 2.7) + Math.pow(y / (ht + grow), 2.7), 1 / 2.7);
        // Depth below the band's outer surface (along the section's smaller radius), never more than its thickness.
        return Math.min(grow, (1 - rho) * (ht + grow));
      },
    });
  }
  if (style === "moto" || style === "specialist") {
    // Gauntlet cuff over the sleeve (radius ~2.3 * 0.86), tapering onto the hand.
    // It ends with the sleeve's trim (0.62 past the wrist), a little over it.
    out.push({ name: "glove:cuff", a: add(wrist, mul(fore, -1.9)), b: add(wrist, mul(fore, 0.68)), r: 2.18, base: 1.82 });
  }
  if (style === "moto") out.push({ name: "glove:plate", a: at(palmL - 0.12, -1.2, 0.96), b: at(palmL - 0.12, 1.2, 0.96), r: 0.32, base: 0 });
  if (style === "wraps")
    // Two tails off the pinky side of the wrist wrap, flying off it and hanging down.
    out.push({ name: "glove:tail", a: at(0.95, -1.4, 0.9), b: add(at(0.95, -1.4, 0.9), add(add(mul(ax, -0.55), mul(w, -0.9)), mul(n, 1.05))), r: 0.28, base: 0 });
  return out;
}
