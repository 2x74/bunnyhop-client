// Carrot Bayonet (knife-bayonet, Market): the plain service bayonet of the garden. A clip-point blade in carrot skin
// (a paler peeled edge bevel, a fuller, a darker spine), a leaf-green crossguard with a carrot-slice muzzle ring over
// the spine, a ribbed green grip and a flat pommel with a sprig of carrot top. Original design (the shared bayonet
// loft, knives/bayonet.ts).
//
// Character: dependable, drill-square. The draw is brisk (up, the flat turned to you once, settled), the swings are a
// straight soldier's wrist, the stab is a bayonet's thrust (more reach, from the shoulder).

import type { V3 } from "../../player/bunny/rig";
import { attackFlavour, bayonetBlade, bayonetGrip, bayonetHold, hump, idleSway, plate, reducedMotion, rise, type BayonetBladeSpec } from "./bayonet";
import { ACCENT, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { KMAT, PART, type KnifeDef } from "./types";

const SKIN = fixed(0xff7a1a, KMAT.veg), SPINE = fixed(0xe0600e, KMAT.veg), PEEL = fixed(0xffa04c, KMAT.veg), LINE = fixed(0xf06c14, KMAT.veg);
const GREEN = fixed(0x2f7d34, KMAT.satin), GRIP = fixed(0x2c6a31, KMAT.grip), GRIP_RIB = fixed(0x3f8c43, KMAT.grip);
/** Grip (pommel end .. guard), crossguard, blade tip. */
const G0 = -2.3, G1 = 1.4, Q1 = 1.76, TIP = 8.7;

export const CARROT_BAYONET_BLADE: BayonetBladeSpec = {
  z0: Q1 - 0.02,
  z1: TIP,
  // Straight spine to 62 %, then a clean clip down to the tip.
  spine: (s) => (s < 0.62 ? 0.38 : 0.38 - 0.5 * Math.pow((s - 0.62) / 0.38, 0.9)),
  edge: (s) => (s < 0.06 ? -0.44 - 0.16 * rise(s, 0, 0.06) : s < 0.66 ? -0.6 : -0.6 + 0.46 * Math.pow((s - 0.66) / 0.34, 2)),
  thick: (s) => 0.125 - 0.035 * s - 0.06 * rise(s, 0.72, 1),
  grind: -0.18,
  fuller: { s: [0.06, 0.55], c: [0.12, 0.5], depth: 0.45 },
  clip: 0.62,
  rows: 22,
  paint: { steel: SKIN, spine: SPINE, bevel: PEEL, fuller: LINE },
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  bayonetBlade(k, CARROT_BAYONET_BLADE);
  k.hilt("guard", () => {
    // Crossguard: a flat leaf-green plate, longer on the edge side.
    plate(k, [G1, G1 + 0.04, Q1 - 0.04, Q1], [0.32, 0.38, 0.38, 0.32], [0.74, 0.8, 0.8, 0.74], -0.1, GREEN);
    // Muzzle ring over the spine: a carrot slice (orange torus, a paler core).
    const n = fp ? 18 : 10, R = 0.34;
    const c: V3 = [0, 0.72 + R - 0.06, (G1 + Q1) / 2];
    const path: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      path.push([Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]]);
    }
    k.loop(path, 0.1, fp ? 6 : 5, [0, 0, 1], () => SKIN, { part: PART.guard, name: "slice" });
  });
  k.hilt("handle", () => bayonetGrip(k, { z0: G0, z1: G1, rx: 0.35, ry: 0.48, cy: -0.04, ribs: 6, a: GRIP, b: GRIP_RIB, name: "handle" }));
  k.hilt("fitting", () => plate(k, [G1 - 0.06, G1 - 0.02, G1 + 0.02], [0.3, 0.36, 0.34], [0.44, 0.52, 0.5], -0.04, ACCENT, PART.guard, 2.4));
  k.hilt("pommel", () => {
    plate(k, [G0 - 0.4, G0 - 0.32, G0 - 0.04, G0], [0.28, 0.4, 0.4, 0.36], [0.4, 0.56, 0.56, 0.5], -0.04, GREEN);
    // A sprig of carrot top off the butt: three small leaves.
    for (const [a, l] of [[-0.5, 0.9], [0, 1.15], [0.5, 0.85]] as const) {
      const path: V3[] = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        path.push([0.04 * a * t, -0.04 + Math.sin(a) * l * t, G0 - 0.38 - Math.cos(a) * l * t + 0.08 * t * t]);
      }
      k.leaf(path, (i) => 0.13 * Math.sin(((i + 0.4) / 4.8) * Math.PI) + 0.02, 0.04, [1, 0, 0], () => (a ? LEAF : LEAF_DARK), { part: PART.guard, name: "sprig" });
    }
  });
}

export const carrotBayonet: KnifeDef = withHilt({
  id: "bayonet",
  cosmeticId: "knife-bayonet",
  name: "Carrot Bayonet",
  rarity: 2,
  blurb: "The garden's service bayonet: a carrot clip point with a muzzle ring.",
  build,
  pivots: { guard: { p: [0, 0, 1.58], axis: [1, 0, 0] }, balance: { p: [0, 0, 2.9], axis: [1, 0, 0] }, crook: { p: [0, -0.8, 1.15], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: bayonetHold([0, 0, 0.12]),
  pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "idle") return idleSway(s, 1);
    if (action === "draw") {
      // Up briskly, the forearm turns the flat to you once, and it settles square.
      s.arm.a[2] += k * -22 * hump(t, 0.12, 0.56);
      s.arm.o[2] += k * 0.6 * hump(t, 0.06, 0.5);
      s.wrist[0] += k * 3 * hump(t, 0.5, 0.75);
      return;
    }
    if (action === "stab") {
      // A bayonet's thrust: the arm drives it from the shoulder, the wrist firm.
      const thrust = hump(t, 0.08, 0.55);
      s.lock = 0.6 * hump(t, 0, 0.8);
      s.arm.o[0] += k * 1.3 * thrust;
      s.wrist[2] += k * 8 * thrust;
      return;
    }
    attackFlavour(action, t, s, { roll: 12, snap: 8, twist: 14 });
  },
  // Crossguard and the accent ferrule (guard), the ribbed grip (the ribs the second tone), the pommel plate; the
  // carrot-slice muzzle ring and the carrot-top sprig stay the bayonet's.
  hilt: { guard: "guard", fitting: "guard", handle: { role: "grip", alt: [GRIP_RIB] }, pommel: "pommel" },
});
