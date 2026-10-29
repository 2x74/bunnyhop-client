// Thornback (knife-thornback, Heirloom, a Supporter item): a big military-style clip-point bayonet. A broad steel blade
// with a saber grind, a fuller on both faces and a row of slanted thorn teeth along the spine, a gunmetal crossguard
// with a muzzle ring (accent) over the spine and a hooked quillon under the edge, a ribbed deep-teal grip and a flat
// pommel cap with a release nub. Original design in the spirit of a sawback bayonet; built in code like every knife
// here (shared pieces in bayonet.ts). Inspects: inspects/bayonets.ts (Thorn Toss -> Double Toss).

import { smoothstep } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, fixed, type KnifeCtx } from "./ctx";
import { attackFlavour, bayonetBlade, bayonetGrip, bayonetHold, hump, idleSway, localXf, palmNormalLocal, plate, reducedMotion, rise, sawback, type BayonetBladeSpec } from "./bayonet";
import { KMAT, PART, type KnifeDef } from "./types";

const GUN = fixed(0x3b434c, KMAT.satin), GRIP = fixed(0x1d4a50, KMAT.grip), GRIP_RIB = fixed(0x2b6870, KMAT.grip), TEETH = fixed(0xaab6bf, KMAT.polished);
/** Grip (pommel end .. guard), crossguard plate, blade tip. */
const G0 = -2.42, G1 = 1.5, Q1 = 1.86, TIP = 9.25;

export const THORNBACK_BLADE: BayonetBladeSpec = {
  z0: Q1 - 0.02,
  z1: TIP,
  // Straight spine to 60 %, then a clear shoulder and a straight, slightly concave clip down to the tip (a little
  // below the centre line).
  spine: (s) => (s < 0.6 ? 0.42 : 0.42 - 0.6 * Math.pow((s - 0.6) / 0.4, 0.85)),
  // A narrow ricasso and choil, the straight edge, then the belly sweeps up to the tip.
  edge: (s) => (s < 0.08 ? -0.5 - 0.24 * smoothstep(0, 0.08, s) : s < 0.64 ? -0.74 : -0.74 + 0.56 * Math.pow((s - 0.64) / 0.36, 2.1)),
  thick: (s) => 0.135 - 0.04 * s - 0.065 * smoothstep(0.72, 1, s),
  grind: -0.2,
  fuller: { s: [0.07, 0.56], c: [0.1, 0.52], depth: 0.5 },
  clip: 0.6,
  rows: 24,
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const along = bayonetBlade(k, THORNBACK_BLADE);
  if (fp) sawback(k, THORNBACK_BLADE, along, 0.1, 0.47, 8, 0.2, TEETH);
  else sawback(k, THORNBACK_BLADE, along, 0.1, 0.47, 5, 0.22, TEETH);
  // --- Crossguard: a gunmetal plate, wider on the edge side; a hooked quillon under the edge; the muzzle ring above
  //     the spine (accent).
  plate(k, [G1, G1 + 0.04, Q1 - 0.04, Q1], [0.36, 0.42, 0.42, 0.36], [0.8, 0.86, 0.86, 0.8], -0.12, GUN);
  {
    const path: V3[] = [];
    const n = fp ? 6 : 4;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      path.push([0, -0.86 - 0.62 * t, 1.68 + 0.42 * t * t]);
    }
    k.tube(path, (i) => 0.17 - 0.035 * (i / n), fp ? 8 : 6, [1, 0, 0], () => GUN, { part: PART.guard });
  }
  {
    const n = fp ? 18 : 10, R = 0.36;
    const c: V3 = [0, 0.74 + R - 0.06, (G1 + Q1) / 2];
    const path: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      path.push([Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]]);
    }
    k.loop(path, 0.1, fp ? 6 : 5, [0, 0, 1], () => ACCENT, { part: PART.guard });
  }
  // --- Ribbed grip and the pommel cap with its release nub.
  bayonetGrip(k, { z0: G0, z1: G1, rx: 0.37, ry: 0.5, cy: -0.04, ribs: 7, a: GRIP, b: GRIP_RIB });
  plate(k, [G0 - 0.53, G0 - 0.44, G0 - 0.04, G0], [0.3, 0.44, 0.44, 0.4], [0.42, 0.6, 0.6, 0.55], -0.04, GUN);
  if (fp) k.tube([[0, 0.5, G0 - 0.24], [0, 0.7, G0 - 0.24]], 0.11, 8, [0, 0, 1], () => ACCENT, { part: PART.guard });
}

export const thornback: KnifeDef = {
  id: "thornback",
  cosmeticId: "knife-thornback",
  name: "Thornback",
  rarity: 4,
  blurb: "A sawback bayonet with a muzzle ring and a row of thorn teeth on its spine.",
  build,
  pivots: { guard: { p: [0, 0, 1.68], axis: [1, 0, 0] }, balance: { p: [0, 0, 3.2], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: bayonetHold([0, 0, 0.12]),
  pose(action, t, s) {
    if (action === "idle") return idleSway(s, 1.1);
    if (action === "draw") {
      // Pulled up with a twirl: the knife rolls a full turn about its own length in the loosened fingers while the
      // wrist flicks up, then a little settle as the fingers clamp.
      const rm = reducedMotion();
      if (!rm) {
        // (Once the fist is up in the frame: the base draw rises from below the screen over its first ~0.2 s.)
        const r = rise(t, 0.16, 0.48);
        const e = 1 - (1 - r) ** 2;
        // The loosened fist lets the grip ride a little off the palm while it turns.
        const off = 0.4 * hump(t, 0.12, 0.54);
        const n = palmNormalLocal(thornback);
        if (e > 0 && e < 1) s.local = localXf(L, [0, 0, 1], -360 * e, [0, 0, 0], [n[0] * off, n[1] * off, n[2] * off]);
        s.loosen = 0.75 * hump(t, 0.12, 0.54);
      }
      const k = rm ? 0.4 : 1;
      // The fist comes up and in a little for the twirl, so it plays in frame.
      s.arm.o[1] += k * 0.8 * hump(t, 0.05, 0.6);
      s.arm.o[2] += k * 1.6 * hump(t, 0.05, 0.6);
      s.wrist[0] += k * (-16 * hump(t, 0, 0.34) + 7 * hump(t, 0.4, 0.75));
      s.wrist[2] += k * 22 * hump(t, 0, 0.42);
      return;
    }
    attackFlavour(action, t, s, { roll: 16, snap: 9, twist: 18 });
  },
};

const L = new Float32Array(12);
