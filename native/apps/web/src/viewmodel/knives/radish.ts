// Radish Kukri (knife-radish, Prize): a forward-bent chopper cut from a radish. The blade drops toward its edge and
// widens into a heavy belly before the point; radish-pink skin on the flats with the white flesh showing on the edge
// bevel (a cut radish) and a small notch at the edge's root. A plain bolster, a beet-dark handle banded with leaf-green
// rings, flaring into a hooked butt with an accent cap. Original design (the shared bayonet loft, bent).
//
// Character: weight forward. The draw lets the blade hang and lifts it level; the slashes chop down and through with
// the weight carrying the arm a little past and a late recovery; the stab is a short downward punch.

import { ring } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { bayonetBlade, hump, idleSway, plate, reducedMotion, rise, type BayonetBladeSpec } from "./bayonet";
import { ACCENT, fixed, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const SKIN = fixed(0xe23a5e, KMAT.veg), SKIN_DARK = fixed(0xb8243f, KMAT.veg), FLESH = fixed(0xfbf1ef, KMAT.veg), FULL = fixed(0xcf2f52, KMAT.veg);
const BEET = fixed(0x5a2230, KMAT.grip), BEET_DARK = fixed(0x431823, KMAT.grip);
/** Handle (butt .. bolster), bolster top, blade tip (along z, before the bend). */
const G0 = -2.35, G1 = 1.3, Q1 = 1.62, TIP = 8.4;

/** The bend: the centre line drops toward the edge (-y) along the blade. */
const drop = (s: number) => -1.45 * Math.pow(s, 1.8);
/** Half width: slim at the bolster, a heavy belly at ~70 %, then into the point. */
const half = (s: number) => (0.3 + 0.3 * Math.pow(Math.sin((Math.PI / 2) * Math.min(1, s / 0.7)), 1.4)) * (s > 0.72 ? Math.pow((1 - s) / 0.28, 0.72) : 1) + 0.012;
/** The notch at the edge's root (a small rounded bite out of the edge, near the bolster). */
const notch = (s: number) => 0.13 * Math.max(0, 1 - Math.abs(s - 0.045) / 0.025);

export const RADISH_BLADE: BayonetBladeSpec = {
  z0: Q1 - 0.02,
  z1: TIP,
  spine: (s) => 0.08 + drop(s) + half(s) * 0.85,
  edge: (s) => 0.08 + drop(s) - half(s) * 1.15 + notch(s),
  thick: (s) => 0.16 - 0.05 * s - 0.08 * rise(s, 0.75, 1),
  grind: -0.15,
  fuller: { s: [0.1, 0.42], c: [0.3, 0.6], depth: 0.3 },
  clip: 0.82,
  rows: 24,
  paint: { steel: SKIN, spine: SKIN_DARK, bevel: FLESH, fuller: FULL },
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  bayonetBlade(k, RADISH_BLADE);
  k.hilt("guard", () => plate(k, [G1, G1 + 0.04, Q1 - 0.04, Q1], [0.3, 0.36, 0.36, 0.3], [0.5, 0.56, 0.56, 0.5], 0.0, ACCENT));
  k.hilt("handle", () => {
    // Waisted under the fingers, flaring into the butt (a kukri's hooked pommel swell), slightly toward the edge side.
    const n = fp ? 14 : 7;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = G0 + (G1 - G0) * t;
      const flare = 1 + 0.32 * Math.pow(Math.max(0, 1 - t / 0.28), 2);
      const waist = 1 - 0.06 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.25) / 0.7)));
      const sc = flare * waist;
      rows.push(ring([0, -0.06 * (flare - 1) * 3, z], X, Y, 0.34 * sc, 0.47 * sc, fp ? 12 : 8, 2.4));
    }
    k.surface(rows, { paint: () => BEET, part: PART.grip, capStart: BEET_DARK, capEnd: BEET_DARK });
  });
  k.hilt("wrap", () => {
    for (const z of [-1.05, 0.0, 0.95]) {
      const rows = [z - 0.08, z - 0.05, z + 0.05, z + 0.08].map((zz, i) => ring([0, 0, zz], X, Y, [0.33, 0.36, 0.36, 0.33][i] * 1.03, [0.45, 0.49, 0.49, 0.45][i] * 1.03, fp ? 12 : 8, 2.4));
      k.surface(rows, { paint: () => LEAF_DARK, part: PART.grip, capStart: null, capEnd: null });
    }
  });
  k.hilt("pommel", () => {
    const rows = [G0 + 0.04, G0 - 0.04, G0 - 0.14, G0 - 0.18].map((z, i) => ring([0, -0.18, z], X, Y, [0.44, 0.47, 0.4, 0.26][i], [0.6, 0.64, 0.55, 0.36][i], fp ? 14 : 8, 2.6));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  });
  k.hilt("fitting", () => {
    // Two rivets through the handle (accent heads on both faces).
    for (const z of [-0.55, 0.5])
      for (const sx of [-1, 1]) {
        const x0 = sx * 0.3, x1 = sx * 0.39;
        k.surface([ring([x0, 0, z], Y, [0, 0, 1], 0.08, 0.08, fp ? 8 : 6), ring([x1, 0, z], Y, [0, 0, 1], 0.065, 0.065, fp ? 8 : 6)], { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
      }
  });
}

export const radish: KnifeDef = withHilt({
  id: "radish",
  cosmeticId: "knife-radish",
  name: "Radish Kukri",
  rarity: 3,
  blurb: "A forward-bent radish chopper with the white flesh on its edge.",
  build,
  pivots: { guard: { p: [0, 0, 1.46], axis: [1, 0, 0] }, balance: { p: [0, -0.5, 4.2], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0.14]),
  pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "idle") return idleSway(s, 1);
    if (action === "draw") {
      // The weight hangs the blade forward as it comes up, the arm lifts it level and it settles.
      s.wrist[0] += k * (8 * hump(t, 0.06, 0.5) - 3 * hump(t, 0.5, 0.8));
      s.arm.o[2] += k * (-0.3 * hump(t, 0.1, 0.5) + 0.2 * hump(t, 0.5, 0.85));
      return;
    }
    if (action === "slash1" || action === "slash2") {
      // A chop: a short cock, down and through from the arm, the weight carrying it a little past, a late recovery.
      const side = action === "slash1" ? 1 : -1;
      const cock = hump(t, 0, 0.16), chop = hump(t, 0.08, 0.38), carry = hump(t, 0.28, 0.75);
      s.lock = 0.45 * hump(t, 0, 0.7);
      s.wrist[0] += k * (-9 * cock + 8 * chop + 3 * carry);
      s.wrist[2] += k * side * 6 * chop;
      s.arm.a[0] += k * (2 * cock - 4 * chop);
      s.arm.o[2] += k * (0.3 * cock - 0.5 * chop - 0.3 * carry);
      return;
    }
    if (action === "stab") {
      // A short downward punch with the belly leading.
      const punch = hump(t, 0.1, 0.5);
      s.arm.o[0] += k * 0.8 * punch;
      s.arm.o[2] += k * -0.4 * punch;
      s.wrist[0] += k * (-6 * hump(t, 0.02, 0.18) + 7 * punch);
    }
  },
  // The guard plate and the rivets (guard), the beet handle with its leaf rings (the second tone), the pommel swell.
  hilt: { guard: "guard", fitting: "guard", handle: "grip", wrap: { role: "grip", alt: [LEAF_DARK] }, pommel: "pommel" },
});
