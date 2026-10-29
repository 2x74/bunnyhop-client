// Candy Cane Shiv (knife-candycane, Golden, winter event): a candy cane sharpened into a shiv. Red / white / mint
// spiral stripes running the whole way, a peppermint-swirl guard, the cane's crook as a hook pommel. Original design.
// pivots.hook is the crook's centre (its spin-about-the-hook inspect).

import { ring, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { fixed, type KnifeCtx } from "./ctx";
import { SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const RED = fixed(0xe02a36, KMAT.lacquer), WHITE = fixed(0xf8f4ee, KMAT.lacquer), MINT = fixed(0x47cf94, KMAT.lacquer);
/** Stripe colour of column k of m (rings are twisted per row, so columns run in spirals): red, white, a mint line. */
const stripe = (k: number, m: number): Paint => {
  const ph = ((k / m) * 2) % 1;
  return ph < 0.36 ? RED : ph > 0.5 && ph < 0.6 ? MINT : WHITE;
};
/** Twist per unit length along the cane (radians / unit). */
const TWIST = 0.85;
/** Shaft: from the crook up to the tip. Crook centre / radius (in the y-z plane, below the grip). */
const S0 = -1.9, B0 = 2.05, B1 = 9.6, R = 0.36, HOOK_R = 0.82;
const HOOK_C: V3 = [0, -HOOK_R, S0];

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const m = fp ? 12 : 10;
  // --- Blade: the cane ground to a point (lens section near the tip).
  k.blade({
    n: 22,
    m,
    twist: (TWIST * (B1 - B0)) / (fp ? 22 : Math.max(6, Math.round(22 * 0.65))),
    center: (s) => [0, 0, B0 + (B1 - B0) * s],
    width: (s) => R * Math.pow(1 - s, 0.7) + 0.012,
    thick: (s) => R * Math.pow(1 - s, 0.7) * (1 - 0.45 * s) + 0.012,
    ex: 2,
    bands: false,
    paint: (_i, kk) => stripe(kk, m),
    capStart: WHITE,
  });
  // --- Peppermint guard: a flat round sweet with red swirl wedges.
  {
    const n = fp ? 32 : 16;
    const disc = (z: number, r: number) => ring([0, 0, z], X, Y, r, r, n);
    const rows = [disc(B0 - 0.36, 0.55), disc(B0 - 0.31, 0.92), disc(B0 - 0.05, 0.92), disc(B0, 0.55)];
    k.surface(rows, { paint: (i, kk) => (i === 1 ? WHITE : Math.floor((kk / n) * 8 + (i === 2 ? 0.5 : 0)) % 2 ? RED : WHITE), part: PART.guard, capStart: WHITE, capEnd: WHITE });
  }
  // --- Grip + crook: the cane continues below the guard and curls round into the hook (one striped tube).
  {
    const path: V3[] = [];
    const ng = fp ? 12 : 6;
    for (let i = 0; i <= ng; i++) path.push([0, 0, B0 - 0.38 + (S0 - (B0 - 0.38)) * (i / ng)]);
    const nh = fp ? 18 : 9;
    for (let i = 1; i <= nh; i++) {
      const a = (i / nh) * Math.PI * 1.08;
      path.push([0, HOOK_C[1] + Math.cos(a) * HOOK_R, HOOK_C[2] - Math.sin(a) * HOOK_R]);
    }
    const arc: number[] = [0];
    for (let i = 1; i < path.length; i++) arc.push(arc[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    const rows = path.map((p, i) => {
      const d = i + 1 < path.length ? [path[i + 1][0] - p[0], path[i + 1][1] - p[1], path[i + 1][2] - p[2]] : [path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      const t: V3 = [d[0] / l, d[1] / l, d[2] / l];
      // In-plane normal (y-z plane) for the ring's second axis.
      const u: V3 = [0, -t[2], t[1]];
      const end = i === path.length - 1 ? 0.8 : 1;
      // Twist continues from the blade's base (arc length from the guard) so the stripes run on unbroken.
      return ring(p, X, u, R * end, R * end, m, 2, -TWIST * arc[i]);
    });
    k.surface(rows, { paint: (_i, kk) => stripe(kk, m), part: PART.grip, capStart: RED, capEnd: WHITE });
  }
}

export const candycane: KnifeDef = {
  id: "candycane",
  cosmeticId: "knife-candycane",
  name: "Candy Cane Shiv",
  rarity: 5,
  blurb: "A sharpened candy cane with a peppermint guard, from the winter event.",
  build,
  pivots: { hook: { p: HOOK_C, axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0], undefined, SLIM_THUMB),
};
