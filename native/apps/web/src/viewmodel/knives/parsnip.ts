// Parsnip Stiletto (knife-parsnip, Market): a needle grown from a parsnip. A long, slim, four-sided blade in cream
// parsnip skin with faint growth rings, tapering to a needle point; short slim quillons that curl back like root hairs;
// a round, slim grip in pale tan banded with darker rings; a small leafy parsnip top as the pommel. Original design.
//
// Character: precise and quick. Small, exact motions: the draw tips the point toward the centre of the screen for a
// moment (checking it), the swings are short flicks, the stab is a fast, straight jab that snaps back.

import { ring, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { attackFlavour, hump, idleSway, reducedMotion } from "./bayonet";
import { ACCENT, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const PARSNIP = fixed(0xefe2b8, KMAT.veg), PARSNIP_RING = fixed(0xdccb98, KMAT.veg), PARSNIP_EDGE = fixed(0xfbf5e2, KMAT.veg);
const TAN = fixed(0xc9a874, KMAT.grip), TAN_DARK = fixed(0x8a6a3e, KMAT.grip);
/** Blade from the ferrule to the tip; grip below the quillons. */
const B0 = 1.62, B1 = 9.3, G0 = -2.2, G1 = 1.26;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const m = 8;
  // A square (diamond) section: ex 1 makes the superellipse a rhombus, the corners are the four edges.
  k.blade({
    n: 18,
    m,
    center: (s) => [0, 0, B0 + (B1 - B0) * s],
    width: (s) => 0.24 * Math.pow(1 - s, 0.85) + 0.012,
    thick: (s) => 0.17 * Math.pow(1 - s, 0.85) + 0.01,
    edge: 0,
    ex: 1.05,
    bands: false,
    paint: (i, kk): Paint => (kk % 2 === 0 ? PARSNIP_EDGE : i % 4 === 2 ? PARSNIP_RING : PARSNIP),
    capStart: ACCENT,
  });
  k.hilt("fitting", () => {
    const rows = [B0 - 0.2, B0 - 0.14, B0 + 0.02, B0 + 0.06].map((z, i) => ring([0, 0, z], X, Y, [0.17, 0.22, 0.2, 0.16][i], [0.2, 0.26, 0.24, 0.19][i], fp ? 12 : 8, 2.4));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  });
  k.hilt("guard", () => {
    // Quillons: two slim curls off the guard, back toward the grip like root hairs (out along y).
    for (const side of [-1, 1]) {
      const path: V3[] = [];
      const n = fp ? 7 : 4;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        path.push([0, side * (0.12 + 0.6 * t), G1 + 0.26 - 0.14 * t * t]);
      }
      k.tube(path, (i) => 0.08 * (1 - (0.55 * i) / n) + 0.02, fp ? 7 : 5, [1, 0, 0], () => ACCENT, { part: PART.guard });
    }
    const rows = [G1, G1 + 0.05, G1 + 0.3, B0 - 0.2].map((z, i) => ring([0, 0, z], X, Y, [0.2, 0.25, 0.25, 0.17][i], [0.22, 0.28, 0.28, 0.2][i], fp ? 12 : 8, 2.4));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  });
  k.hilt("handle", () => {
    // Slim round grip, a slight swell under the palm.
    const n = fp ? 12 : 6;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const r = 1 + 0.06 * Math.sin(Math.PI * t);
      rows.push(ring([0, 0, G0 + (G1 - G0) * t], X, Y, 0.28 * r, 0.31 * r, fp ? 12 : 8, 2.2));
    }
    k.surface(rows, { paint: () => TAN, part: PART.grip, capStart: TAN, capEnd: TAN });
  });
  k.hilt("wrap", () => {
    // Darker rings banding the grip (stand proud of it).
    for (const z of [-1.7, -0.9, -0.1, 0.7]) {
      const rows = [z - 0.07, z - 0.04, z + 0.04, z + 0.07].map((zz, i) => ring([0, 0, zz], X, Y, [0.29, 0.31, 0.31, 0.29][i] * 1.06, [0.32, 0.34, 0.34, 0.32][i] * 1.06, fp ? 12 : 8, 2.2));
      k.surface(rows, { paint: () => TAN_DARK, part: PART.grip, capStart: null, capEnd: null });
    }
  });
  k.hilt("pommel", () => {
    // The parsnip's crown and a small leafy top.
    const rows = [G0 + 0.02, G0 - 0.1, G0 - 0.24, G0 - 0.3].map((z, i) => ring([0, 0, z], X, Y, [0.28, 0.3, 0.22, 0.1][i], [0.31, 0.33, 0.24, 0.11][i], fp ? 12 : 8, 2.2));
    k.surface(rows, { paint: () => PARSNIP_RING, part: PART.guard, capStart: PARSNIP_RING, capEnd: PARSNIP_RING });
    for (const a of [-0.45, 0.05, 0.5]) {
      const path: V3[] = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        path.push([0.06 * Math.sign(a) * t, Math.sin(a) * 0.75 * t, G0 - 0.28 - Math.cos(a) * 0.75 * t]);
      }
      k.leaf(path, (i) => 0.12 * Math.sin(((i + 0.4) / 4.8) * Math.PI) + 0.015, 0.04, [1, 0, 0], () => (a > 0 ? LEAF : LEAF_DARK), { part: PART.guard, name: "top" });
    }
  });
}

export const parsnip: KnifeDef = withHilt({
  id: "parsnip",
  cosmeticId: "knife-parsnip",
  name: "Parsnip Stiletto",
  rarity: 2,
  blurb: "A needle-thin stiletto grown from a parsnip.",
  build,
  // crook: where it rides on the index finger in a finger spin (under the quillon, edge side); tip: the needle's point.
  pivots: { guard: { p: [0, 0, G1 + 0.2], axis: [1, 0, 0] }, crook: { p: [0, -0.62, 1.0], axis: [1, 0, 0] }, balance: { p: [0, 0, 2.6], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: straightHold([0, 0, 0.12], undefined, SLIM_THUMB),
  pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "idle") return idleSway(s, 0.8);
    if (action === "draw") {
      // Up quickly, then the point dips toward the middle of the screen for a beat (checked) and lifts back.
      s.wrist[1] += k * 9 * hump(t, 0.3, 0.72);
      s.wrist[0] += k * 5 * hump(t, 0.3, 0.72);
      return;
    }
    if (action === "stab") {
      // Fast and straight: out and back, nothing turns.
      const jab = hump(t, 0.06, 0.32);
      s.arm.o[0] += k * 1.3 * jab;
      s.wrist[0] += k * 3 * jab;
      return;
    }
    // Short flicks: less roll, less snap than the heavier blades.
    attackFlavour(action, t, s, { roll: 8, snap: 6, twist: 6 });
  },
  // The ferrule and the root-hair quillons (guard), the tan grip with its darker bands (the second tone), the
  // parsnip crown (pommel); the leafy top stays the parsnip's.
  hilt: { fitting: "guard", guard: "guard", handle: "grip", wrap: { role: "grip", alt: [TAN_DARK] }, pommel: "pommel" },
});
