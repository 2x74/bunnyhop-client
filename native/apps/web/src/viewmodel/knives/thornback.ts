// Thornback (knife-thornback, Heirloom, a Supporter item): a big clip-point bayonet grown from a rose stem (v0.0.41:
// it was a steel sawback). The broad blade is one great thorn, stem green at the guard deepening to crimson and a dark
// tip, with five rose thorns hooked back along its spine; a green calyx for a crossguard with a ring (accent) over the
// spine and a thorn quillon under the edge, a ribbed stem-green grip and a rose hip for a pommel, its dried crown the
// accent. Same blade profile, grip and animations as before. Built in code like every knife here (shared pieces in
// bayonet.ts). Inspects: inspects/bayonets.ts (Thorn Toss -> Double Toss).

import { ring, smoothstep } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, fixed, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { attackFlavour, bayonetBlade, bayonetGrip, bayonetHold, hump, idleSway, localXf, palmNormalLocal, plate, ramp, reducedMotion, rise, sawback, X, Y, type BayonetBladeSpec } from "./bayonet";
import { KMAT, PART, type KnifeDef } from "./types";

/** The thorn from the stem's green to its dark tip (a step per few rows); its paler edge; its spine and groove. */
const THORN = ramp([0x5a9440, 0x8a7a3a, 0xb84a3c, 0xbb2f3d, 0xab2639, 0x961f34, 0x7d182e, 0x64122a], KMAT.veg);
const THORN_EDGE = ramp([0x8fbf6e, 0xb39f66, 0xd4776a, 0xd7626c, 0xcb5a68, 0xb95062, 0xa4485a, 0x8e3f52], KMAT.veg);
const THORN_SPINE = fixed(0x5a1226, KMAT.veg), THORN_GROOVE = fixed(0x7a1a2e, KMAT.veg);
const CALYX = LEAF_DARK, QUILLON = fixed(0x8f1d30, KMAT.veg), GRIP = fixed(0x2f6b34, KMAT.grip), GRIP_RIB = fixed(0x3f8a44, KMAT.grip), TEETH = fixed(0x8f1d30, KMAT.veg), HIP = fixed(0xd2402e, KMAT.lacquer);
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
  paint: { spine: THORN_SPINE, fuller: THORN_GROOVE },
  paintAt: (face, s) => (face === "steel" ? THORN(s) : face === "bevel" ? THORN_EDGE(s) : null),
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const along = bayonetBlade(k, THORNBACK_BLADE);
  // Rose thorns along the spine, hooked back toward the guard: five big ones, not a saw's row of teeth.
  sawback(k, THORNBACK_BLADE, along, 0.09, 0.5, fp ? 5 : 4, 0.34, TEETH);
  // --- Crossguard: a green calyx, wider on the edge side; a thorn quillon under the edge; the ring above the spine
  //     (accent).
  k.hilt("guard", () => plate(k, [G1, G1 + 0.04, Q1 - 0.04, Q1], [0.36, 0.42, 0.42, 0.36], [0.8, 0.86, 0.86, 0.8], -0.12, CALYX, PART.guard, 3.2, "guard"));
  {
    const path: V3[] = [];
    const n = fp ? 6 : 4;
    // A rose thorn, not a bar: a broad base that sweeps forward toward the tip and tapers to a point.
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      path.push([0, -0.84 - 0.56 * t + 0.06 * t * t, 1.66 + 0.78 * t * t]);
    }
    k.hilt("guard", () => k.tube(path, (i) => 0.2 * (1 - i / n) ** 0.9 + 0.02, fp ? 8 : 6, [1, 0, 0], () => QUILLON, { part: PART.guard, name: "guard" }));
  }
  {
    const n = fp ? 18 : 10, R = 0.36;
    const c: V3 = [0, 0.74 + R - 0.06, (G1 + Q1) / 2];
    const path: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      path.push([Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]]);
    }
    k.hilt("fitting", () => k.loop(path, 0.1, fp ? 6 : 5, [0, 0, 1], () => ACCENT, { part: PART.guard, name: "muzzle" }));
  }
  // --- Ribbed stem grip and the rose hip: a round red fruit where the pommel cap was, its dried crown (accent) at the
  //     end, about the cap's size (the same room in the hand).
  k.hilt("handle", () => bayonetGrip(k, { z0: G0, z1: G1, rx: 0.37, ry: 0.5, cy: -0.04, ribs: 7, a: GRIP, b: GRIP_RIB }));
  k.hilt("pommel", () => plate(k, [G0 - 0.6, G0 - 0.52, G0 - 0.3, G0 - 0.08, G0], [0.18, 0.32, 0.43, 0.4, 0.36], [0.22, 0.42, 0.58, 0.54, 0.48], -0.04, HIP, PART.guard, 2.2, "pommel"));
  {
    // The crown: five short dried sepals round the hip's end.
    const n = fp ? 10 : 5;
    const rows = [G0 - 0.56, G0 - 0.66, G0 - 0.8].map((z, i) =>
      ring([0, -0.04, z], X, Y, [0.16, 0.2, 0.05][i], [0.2, 0.25, 0.06][i], n, 2).map((p, j): V3 => {
        const f = i === 1 ? 1 + 0.5 * Math.cos(5 * ((j / n) * Math.PI * 2)) : 1;
        return [p[0] * f, (p[1] + 0.04) * f - 0.04, p[2]];
      }),
    );
    k.hilt("fitting", () => k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: null, capEnd: ACCENT, name: "nub" }));
  }
}

export const thornback: KnifeDef = withHilt({
  id: "thornback",
  cosmeticId: "knife-thornback",
  name: "Thornback",
  rarity: 4,
  blurb: "A bayonet grown from a rose stem: one great thorn with five more along its spine, and a rose hip for a pommel.",
  build,
  // The calyx crossguard with its thorn quillon, the ring, the ribbed grip (the ribs the second tone), the rose hip
  // and its crown.
  hilt: { guard: "guard", muzzle: { role: "guard", alt: [ACCENT] }, grip: { role: "grip", alt: [GRIP_RIB] }, pommel: "pommel", nub: { role: "pommel", alt: [ACCENT] } },
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
});

const L = new Float32Array(12);
