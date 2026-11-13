// Thistle (knife-thistle, Heirloom, a Supporter item): a slim, straight clip-point bayonet made to spin, grown from a
// thistle (v0.0.41: its blade and crossguard were plain steel). The narrow blade is a thistle leaf: sage green paling
// toward the point, a white midrib where the fuller is, four small prickles on the spine near the guard. A collar of
// green bracts for a crossguard, a spine either side where the stubs were, a plum cord-wrapped grip and, for a pommel,
// the thistle head: a bulb of bracts and a purple brush that flares open. Same blade profile, grip and animations as
// before; shared pieces in bayonet.ts. Inspects: inspects/bayonets.ts (Pinwheel -> Backspin), its draw is a quick
// pinwheel over the open fingers.

import { ring, smoothstep, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { attackFlavour, bayonetBlade, bayonetGrip, bayonetHold, hump, idleSway, localXf, palmNormalLocal, plate, ramp, reducedMotion, rise, sawback, X, Y, type BayonetBladeSpec } from "./bayonet";
import { KMAT, PART, type KnifeDef } from "./types";

const WRAP = fixed(0x5b2a6e, KMAT.grip), WRAP_DARK = fixed(0x45215a, KMAT.grip), TUFT = fixed(0xb46ad8, KMAT.veg), TUFT_DARK = fixed(0x8442b0, KMAT.veg), TUFT_TIP = fixed(0xd9a6f2, KMAT.veg);
/** The leaf from the guard to the point (a step per few rows), its paler edge, its dark spine, the white midrib, the prickles. */
const SAGE = ramp([0x5f8f66, 0x6c9a70, 0x7aa67b, 0x8ab287, 0x9cbe95, 0xb0caa4, 0xc5d6b6, 0xd9e2c9], KMAT.veg);
const SAGE_EDGE = ramp([0x9fc2a2, 0xa8c9aa, 0xb2d0b2, 0xbdd7bb, 0xc9dec5, 0xd5e5d0, 0xe1ecdc, 0xecf2e7], KMAT.veg);
const SAGE_SPINE = fixed(0x47744f, KMAT.veg), MIDRIB = fixed(0xf1f5e6, KMAT.veg), PRICKLE = fixed(0xe9e2b0, KMAT.veg);
const G0 = -2.25, G1 = 1.3, Q0 = 1.42, Q1 = 1.74, TIP = 8.2;

export const THISTLE_BLADE: BayonetBladeSpec = {
  z0: Q1 - 0.02,
  z1: TIP,
  spine: (s) => (s < 0.68 ? 0.3 : 0.3 - 0.36 * Math.pow((s - 0.68) / 0.32, 0.9)),
  edge: (s) => (s < 0.06 ? -0.34 - 0.08 * smoothstep(0, 0.06, s) : s < 0.7 ? -0.42 : -0.42 + 0.36 * Math.pow((s - 0.7) / 0.3, 2)),
  thick: (s) => 0.112 - 0.03 * s - 0.055 * smoothstep(0.75, 1, s),
  grind: -0.08,
  fuller: { s: [0.05, 0.48], c: [0.16, 0.5], depth: 0.45 },
  clip: 0.64,
  rows: 22,
  paint: { spine: SAGE_SPINE, fuller: MIDRIB },
  paintAt: (face, s) => (face === "steel" ? SAGE(s) : face === "bevel" ? SAGE_EDGE(s) : null),
};

/** A star section (n points, `lobes` spikes of relative depth d) for the thistle head. */
function star(z: number, r: number, n: number, lobes: number, d: number, phase: number): V3[] {
  return ring([0, -0.04, z], X, Y, r, r, n, 2, phase).map((p) => {
    const a = Math.atan2(p[1] + 0.04, p[0]) - phase;
    const f = 1 + d * Math.cos(lobes * a);
    return [p[0] * f, (p[1] + 0.04) * f - 0.04, p[2]] as V3;
  });
}

/** An oval star section for the bract collar: `star` stretched to (rx, ry) about the grip's axis. */
function ovalStar(z: number, rx: number, ry: number, n: number, lobes: number, d: number, phase: number): V3[] {
  return star(z, 1, n, lobes, d, phase).map((p): V3 => [p[0] * rx, (p[1] + 0.04) * ry - 0.06, p[2]]);
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const along = bayonetBlade(k, THISTLE_BLADE);
  // Four small prickles on the spine near the guard (a leaf's, not a saw's): they stop well short of the clip.
  sawback(k, THISTLE_BLADE, along, 0.07, 0.4, fp ? 4 : 3, 0.13, PRICKLE);
  // --- Crossguard: a collar of bracts, their points turned up toward the blade, in the plain plate's place and size;
  //     a long spine each side where the round stubs were; an accent ferrule under it.
  {
    const n = fp ? 20 : 10;
    const rows = [
      ovalStar(Q0, 0.3, 0.6, n, 10, 0.0, 0),
      ovalStar(Q0 + 0.06, 0.36, 0.66, n, 10, 0.06, 0),
      ovalStar(Q1 - 0.04, 0.37, 0.68, n, 10, 0.16, 0),
      ovalStar(Q1 + 0.1, 0.24, 0.5, n, 10, 0.3, 0),
    ];
    k.hilt("guard", () => k.surface(rows, { paint: (i): Paint => (i === 1 ? LEAF : LEAF_DARK), part: PART.guard, capStart: LEAF_DARK, capEnd: LEAF_DARK, name: "guard" }));
  }
  for (const side of [-1, 1]) {
    const y0 = side * 0.58 - 0.06, z = (Q0 + Q1) / 2;
    k.hilt("guard", () => k.tube([[0, y0, z], [0, y0 + side * 0.2, z + 0.02], [0, y0 + side * 0.36, z + 0.07], [0, y0 + side * 0.46, z + 0.13]], (i) => [0.14, 0.12, 0.07, 0.02][i], fp ? 8 : 6, [1, 0, 0], () => LEAF, { part: PART.guard, name: "guard" }));
  }
  k.hilt("fitting", () => plate(k, [G1 - 0.02, G1 + 0.04, Q0 - 0.01, Q0 + 0.02], [0.31, 0.37, 0.37, 0.33], [0.42, 0.5, 0.5, 0.46], -0.04, ACCENT, PART.guard, 2.4, "ferrule"));
  // --- Cord-wrapped grip.
  k.hilt("wrap", () => bayonetGrip(k, { z0: G0, z1: G1, rx: 0.33, ry: 0.44, cy: -0.04, ribs: 7, a: WRAP, b: WRAP_DARK, wrap: true }));
  // --- Thistle-head pommel: a bulb of bracts, then the purple brush flaring open past it.
  {
    const n = fp ? 16 : 10;
    // The bulb: two tiers of pointed bracts, the second set between the first.
    const cup = [
      star(G0 + 0.04, 0.3, n, 8, 0.0, 0),
      star(G0 - 0.1, 0.4, n, 8, 0.14, 0),
      star(G0 - 0.26, 0.46, n, 8, 0.24, 0),
      star(G0 - 0.4, 0.44, n, 8, 0.2, Math.PI / 8),
      star(G0 - 0.54, 0.34, n, 8, 0.28, Math.PI / 8),
      star(G0 - 0.62, 0.24, n, 8, 0.1, Math.PI / 8),
    ];
    k.hilt("pommel", () => k.surface(cup, { paint: (i): Paint => (i % 2 ? LEAF : LEAF_DARK), part: PART.guard, capStart: LEAF_DARK, capEnd: null, name: "cup" }));
    // The brush: florets standing out of the bulb and flaring wider to a ragged, open end (a thistle in flower, not a
    // bud); about the old tuft's reach.
    const tuft = [
      star(G0 - 0.58, 0.22, n, 8, 0.08, 0),
      star(G0 - 0.76, 0.3, n, 8, 0.2, 0),
      star(G0 - 0.98, 0.44, n, 8, 0.3, 0),
      star(G0 - 1.2, 0.56, n, 8, 0.42, 0),
      star(G0 - 1.26, 0.3, n, 8, 0.3, 0),
    ];
    k.hilt("pommel", () => k.surface(tuft, { paint: (i): Paint => (i === 3 ? TUFT_TIP : i % 2 ? TUFT : TUFT_DARK), part: PART.guard, capStart: null, capEnd: TUFT_TIP }));
  }
}

const L = new Float32Array(12);
const PIVOT: V3 = [0, 0, Q0];

export const thistle: KnifeDef = withHilt({
  id: "thistle",
  cosmeticId: "knife-thistle",
  name: "Thistle",
  rarity: 4,
  blurb: "A slim bayonet grown from a thistle: a leaf for a blade, a flower for a pommel, balanced to spin round your fingers.",
  build,
  // The bract collar and its spines (guard), the ferrule (second tone), the cord grip (the darker cord the second
  // tone), the bulb of bracts under the thistle head (pommel); the purple brush stays the thistle's.
  hilt: { guard: "guard", ferrule: { role: "guard", alt: [ACCENT] }, grip: { role: "grip", alt: [WRAP_DARK] }, cup: { role: "pommel", alt: [LEAF] } },
  // guard: the draw's pinwheel; crook: where it rides on the index finger in its finger spins (under the guard stub).
  pivots: { guard: { p: PIVOT, axis: [1, 0, 0] }, crook: { p: [0, -0.88, 1.0], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: bayonetHold([0, 0, 0.18]),
  pose(action, t, s) {
    if (action === "idle") return idleSway(s, 1);
    if (action === "draw") {
      // Comes up already spinning: the fingers open, the knife hops off the palm and turns once flat over the
      // fingers (about the palm normal, through the guard), lands and the fist closes on it.
      const rm = reducedMotion();
      if (!rm) {
        const n = palmNormalLocal(thistle);
        // (Once the hand is up in the frame: the base draw rises from below the screen over its first ~0.2 s.)
        // An even turn (no fast middle), so the pinwheel reads.
        const e = Math.min(1, Math.max(0, (t - 0.16) / 0.26));
        const h = 2.7 * (rise(t, 0.1, 0.19) - rise(t, 0.42, 0.5));
        if (h > 0 || (e > 0 && e < 1)) s.local = localXf(L, n, -360 * e, PIVOT, [n[0] * h, n[1] * h, n[2] * h]);
        s.loosen = rise(t, 0.06, 0.13) * (1 - rise(t, 0.44, 0.54));
      }
      const k = rm ? 0.4 : 1;
      // The hand comes up and in a little for the pinwheel, so it plays in frame.
      s.arm.o[1] += k * 0.8 * hump(t, 0.05, 0.62);
      s.arm.o[2] += k * 1.8 * hump(t, 0.05, 0.62);
      s.wrist[0] += k * (-10 * hump(t, 0, 0.3) + 6 * hump(t, 0.46, 0.8));
      return;
    }
    // Its own attack language: light and quick, all wrist. The slash whips through with the wrist alone (the arm stays
    // quieter than the heavier bayonets) and flicks back past centre at the end; the stab is a straight fencer's lunge,
    // edge level, the arm reaching forward instead of turning the blade.
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "slash1" || action === "slash2") {
      const side = action === "slash1" ? 1 : -1;
      const whip = hump(t, 0.04, 0.3), back = hump(t, 0.28, 0.62);
      s.wrist[1] += k * side * (14 * whip - 7 * back);
      s.wrist[2] += k * side * (6 * whip - 3 * back);
      s.wrist[0] += k * -4 * hump(t, 0, 0.12);
    } else if (action === "stab") {
      const lunge = hump(t, 0.1, 0.62);
      s.arm.o[0] += k * 1.4 * lunge;
      s.wrist[0] += k * (-3 * hump(t, 0.02, 0.2) + 4 * lunge);
    } else attackFlavour(action, t, s, { roll: 12, snap: 7, twist: 14 });
  },
});
