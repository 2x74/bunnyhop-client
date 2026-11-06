// Twin Sprouts (knife-sprouts, Heirloom; a Supporter knife since v0.0.38): two slim golden shoots growing from one seed. Twin tines leave a round seed
// bulb side by side and curve gently apart toward their points (each double-edged, with growth rings); a collar of
// two small leaves under the seed; a grip of two strands twisted round a core; a pair of round seed leaves
// (cotyledons) at the pommel. Original design.
//
// Character: playful, in pairs. The draw gives a little back-and-forth wiggle so both tines catch the light; every
// slash has a second, smaller snap after the first (an echo); the inspects are finger spins (the Thistle's), the
// twin points pinwheeling.

import { ring, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { attackFlavour, hump, idleSway, reducedMotion } from "./bayonet";
import { ACCENT, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const GOLD = fixed(0xffb04a, KMAT.veg), GOLD_DARK = fixed(0xe8902a, KMAT.veg), SEED = fixed(0xf4c66a, KMAT.lacquer);
const STRAND = fixed(0x6f8f3a, KMAT.grip), STRAND_DARK = fixed(0x4f6d27, KMAT.grip), CORE = fixed(0x3d5520, KMAT.grip);
/** Tines from the seed to their points; grip below the leaf collar. */
const B0 = 2.05, B1 = 8.0, G0 = -2.2, G1 = 1.3;
/** A tine's centre line: side by side at the seed, curving apart toward the points. */
const tine = (side: number, s: number): V3 => [0, side * (0.24 + 0.36 * s * s), B0 + (B1 - B0) * s];

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  for (const side of [-1, 1]) {
    k.blade({
      n: 16,
      m: 10,
      center: (s) => tine(side, s),
      width: (s) => 0.2 * Math.pow(Math.min(1, (1 - s) / 0.55), 0.8) + 0.012,
      thick: (s) => 0.09 * (1 - 0.6 * s) + 0.012,
      edge: 0,
      ex: 2.2,
      paint: (i): Paint => (i % 3 === 1 ? GOLD_DARK : GOLD),
      capStart: GOLD_DARK,
    });
  }
  k.hilt("guard", () => {
    // The seed: a round bulb the tines grow from.
    const n = fp ? 7 : 4;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI;
      const r = Math.max(0.03, Math.sin(a));
      rows.push(ring([0, 0, G1 + 0.36 + 0.42 * -Math.cos(a)], X, Y, 0.34 * r, 0.52 * r, fp ? 14 : 8, 2));
    }
    k.surface(rows, { paint: () => SEED, part: PART.guard, capStart: SEED, capEnd: SEED });
    // Two small leaves round the seed's base, out along the width.
    for (const side of [-1, 1]) {
      const path: V3[] = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        path.push([0, side * (0.2 + 0.55 * t), G1 + 0.12 + 0.18 * t - 0.12 * t * t]);
      }
      k.leaf(path, (i) => 0.16 * Math.sin(((i + 0.4) / 4.8) * Math.PI) + 0.02, 0.04, [1, 0, 0], () => (side > 0 ? LEAF : LEAF_DARK), { part: PART.guard, name: "seedleaf" });
    }
  });
  k.hilt("handle", () => {
    const n = fp ? 10 : 6;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) rows.push(ring([0, 0, G0 + (G1 - G0) * (i / n)], X, Y, 0.27, 0.36, fp ? 10 : 8, 2.4));
    k.surface(rows, { paint: () => CORE, part: PART.grip, capStart: CORE, capEnd: CORE });
  });
  k.hilt("wrap", () => {
    // Two strands twisted round the core (they make the grip's outside).
    const turns = 2.2, n = fp ? 26 : 12;
    for (const ph of [0, Math.PI]) {
      const path: V3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = ph + t * turns * Math.PI * 2;
        path.push([Math.cos(a) * 0.17, Math.sin(a) * 0.23, G0 + 0.1 + (G1 - G0 - 0.2) * t]);
      }
      k.tube(path, 0.16, fp ? 8 : 5, [0, 0, 1], () => (ph ? STRAND_DARK : STRAND), { part: PART.grip });
    }
  });
  k.hilt("pommel", () => {
    // An accent cap and two round seed leaves.
    const rows = [G0 + 0.02, G0 - 0.08, G0 - 0.16].map((z, i) => ring([0, 0, z], X, Y, [0.3, 0.3, 0.16][i], [0.4, 0.4, 0.2][i], fp ? 12 : 8, 2.4));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
    for (const side of [-1, 1]) {
      const path: V3[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        path.push([0, side * (0.08 + 0.6 * t), G0 - 0.14 - 0.42 * t + 0.25 * t * t]);
      }
      k.leaf(path, (i) => 0.24 * Math.pow(Math.sin(((i + 0.5) / 6) * Math.PI), 0.8) + 0.02, 0.04, [1, 0, 0], () => (side > 0 ? LEAF : LEAF_DARK), { part: PART.guard, name: "seedleaf" });
    }
  });
}

export const sprouts: KnifeDef = withHilt({
  id: "sprouts",
  cosmeticId: "knife-sprouts",
  name: "Twin Sprouts",
  rarity: 4,
  blurb: "Two golden shoots from one seed, curving apart to twin points.",
  build,
  // crook: where it rides on the index finger in its finger spins (under the seed, edge side).
  pivots: { guard: { p: [0, 0, G1 + 0.36], axis: [1, 0, 0] }, crook: { p: [0, -0.62, 1.05], axis: [1, 0, 0] }, balance: { p: [0, 0, 2.8], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0.12], undefined, SLIM_THUMB),
  pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "idle") return idleSway(s, 1);
    if (action === "draw") {
      // A little back-and-forth wiggle of the forearm so both tines catch the light, then still.
      s.arm.a[2] += k * (-14 * hump(t, 0.16, 0.4) + 10 * hump(t, 0.36, 0.62));
      s.arm.o[2] += k * 0.4 * hump(t, 0.06, 0.55);
      return;
    }
    attackFlavour(action, t, s, { roll: 12, snap: 8, twist: 10 });
    if (action === "slash1" || action === "slash2") {
      // The echo: a second, smaller snap after the cut.
      const side = action === "slash1" ? 1 : -1;
      s.wrist[2] += k * side * 5 * hump(t, 0.36, 0.56);
    }
  },
  // The seed bulb (guard), the core and its two twisted strands (the darker strand the second tone), the pommel cap;
  // the seed leaves stay the sprouts'.
  hilt: { guard: "guard", handle: "grip", wrap: { role: "grip", alt: [STRAND_DARK] }, pommel: "pommel" },
});
