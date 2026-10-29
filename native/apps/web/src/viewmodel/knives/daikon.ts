// Daikon-tana (knife-daikon, Heirloom): a short katana grown from a daikon radish. A long white blade with a gentle
// curve toward the spine (pale green near the collar like a daikon's shoulder, faint root rings), an accent habaki, a
// lobed radish-leaf tsuba, a diamond-wrapped grip and two daikon leaves sprouting from the pommel cap. Original design.

import { add, ring, scale, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, fixed, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const DAIKON = fixed(0xf4f1e8, KMAT.veg), DAIKON_RING = fixed(0xe2ddcf, KMAT.veg), DAIKON_SHOULDER = fixed(0xd5e8b8, KMAT.veg), DAIKON_EDGE = fixed(0xffffff, KMAT.veg);
const WRAP = fixed(0x2c5e33, KMAT.grip), SAME = fixed(0xeae2cc, KMAT.grip);
/** Blade from the habaki to the tip; grip below the tsuba. */
const B0 = 2.45, B1 = 12.2, G0 = -2.7, G1 = 1.75;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Blade: single-edged (edge toward -y, the convex side), curving toward the spine; a kissaki-style point.
  const m = 14;
  k.blade({
    n: 20,
    m,
    center: (s) => [0, 0.42 * s * s, B0 + (B1 - B0) * s],
    width: (s) => (s < 0.86 ? 0.5 - 0.1 * s : (0.5 - 0.086) * Math.pow(Math.max(0, (1 - s) / 0.14), 0.65)) + 0.012,
    thick: (s) => 0.13 * (1 - 0.55 * s) + 0.015,
    shift: (s) => (s > 0.86 ? 0.12 * ((s - 0.86) / 0.14) : 0),
    edge: -1,
    ex: 2.8,
    bands: false,
    paint: (i, kk): Paint => {
      const a = Math.cos((kk / m) * Math.PI * 2);
      if (a < -0.55) return DAIKON_EDGE; // the bright edge bevel (hamon)
      if (i < 3) return DAIKON_SHOULDER;
      return i % 4 === 2 ? DAIKON_RING : DAIKON;
    },
    capStart: ACCENT,
  });
  // --- Habaki (blade collar).
  {
    const rows = [B0 - 0.42, B0 - 0.38, B0 + 0.02, B0 + 0.08].map((z, i) => ring([0, 0, z], X, Y, [0.17, 0.21, 0.19, 0.15][i], [0.5, 0.56, 0.52, 0.47][i], fp ? 12 : 8, 2.6));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  // --- Tsuba: a lobed radish leaf (five lobes), flat, green with a darker rim.
  {
    const n = fp ? 30 : 15;
    const outline = (z: number, sc: number): V3[] => {
      const pts: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = (1.3 + 0.26 * Math.cos(5 * a) + 0.07 * Math.cos(10 * a)) * sc;
        pts.push([Math.cos(a) * r * 0.82, Math.sin(a) * r - 0.08, z]);
      }
      return pts;
    };
    const rows = [outline(G1 + 0.02, 0.8), outline(G1 + 0.05, 1), outline(G1 + 0.24, 1), outline(G1 + 0.27, 0.8)];
    k.surface(rows, { paint: (i) => (i === 1 ? LEAF_DARK : LEAF), part: PART.guard, capStart: LEAF, capEnd: LEAF });
    // Leaf veins: a thin accent ring on each face.
    for (const z of [G1 + 0.005, G1 + 0.295]) {
      const v = outline(z, 0.55).filter((_, i) => i % 2 === 0);
      k.loop(v, 0.035, 3, [0, 0, 1], () => LEAF_DARK, { part: PART.guard });
    }
  }
  // --- Grip (tsuka): oval, diamond wrap (ito over same), slightly waisted.
  {
    const n = fp ? 11 : 7;
    const seg = 8;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = G0 + (G1 - G0) * t;
      const w = 1 - 0.07 * Math.sin(t * Math.PI);
      rows.push(ring([0, 0, z], X, Y, 0.34 * w, 0.46 * w, seg, 2.4, i % 2 ? Math.PI / seg : 0));
    }
    k.surface(rows, { paint: (i, kk) => ((i + kk) % 2 ? WRAP : SAME), part: PART.grip, capStart: WRAP, capEnd: WRAP });
  }
  // --- Kashira (pommel cap) and two daikon leaves.
  {
    const rows = [G0 - 0.28, G0 - 0.22, G0 + 0.02].map((z, i) => ring([0, 0, z], X, Y, [0.22, 0.33, 0.36][i], [0.3, 0.45, 0.48][i], fp ? 12 : 8, 2.4));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
    for (const side of [-1, 1]) {
      const path: V3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        path.push(add([0.1 * side * t, side * 0.55 * t, G0 - 0.25 - 1.5 * t], scale([-0.4, 0, 0], t * t)));
      }
      k.leaf(path, (i) => 0.26 * Math.sin(((i + 0.3) / 6.6) * Math.PI) + 0.02, 0.05, [1, 0, 0], () => (side > 0 ? LEAF : LEAF_DARK));
    }
  }
}

export const daikon: KnifeDef = {
  id: "daikon",
  cosmeticId: "knife-daikon",
  name: "Daikon-tana",
  rarity: 4,
  blurb: "A short katana grown from a daikon, with a radish-leaf tsuba.",
  build,
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.55 },
  hold: straightHold([0, 0, 0.3], undefined, SLIM_THUMB),
};
