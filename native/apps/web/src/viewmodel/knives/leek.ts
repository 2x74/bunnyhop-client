// Leek Saber (knife-leek, Heirloom; a Supporter knife since v0.0.38): a long, gently curved saber grown from a leek. The blade runs white at the root
// through pale green to a darker green toward the point, with faint lengthwise layer lines; a single edge on the
// convex side. A cupped guard of two leek leaves curling back over the fist's sides (clear of the fingers), an accent
// ferrule, a grip wrapped in pale root fibre, and a tuft of fine roots at the pommel. Original design.
//
// Character: a fencer's sword. The wrist stays firm (state.lock, like the Daikon-tana): the cuts come from the arm,
// point leading with the arm extending through them; the stab is a lunge. The draw raises it to a near-vertical
// carry before it settles.

import { ring, type Paint } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { hump, idleSway, reducedMotion, rise } from "./bayonet";
import { ACCENT, fixed, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { SLIM_THUMB, straightHold } from "./hold";
import { KMAT, PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const EDGE = fixed(0xfcfef6, KMAT.veg);
/** White at the root through to the leek's green at the point: a step per few rows, so it reads as a gradient. */
const SHADES = [0xf4f6ea, 0xeaf3d9, 0xdcedc0, 0xc8e4a2, 0xb1d987, 0x96cb6d, 0x7cbb5a, 0x64a94b].map((c) => fixed(c, KMAT.veg));
const FIBRE = fixed(0xe9dfc2, KMAT.grip), FIBRE_DARK = fixed(0xc9bb94, KMAT.grip), ROOT = fixed(0xd8c9a0, KMAT.veg);
/** Blade from the ferrule to the tip; grip below the guard. */
const B0 = 2.0, B1 = 11.6, G0 = -2.55, G1 = 1.55;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const m = 14;
  k.blade({
    n: 22,
    m,
    // A gentle, even curve toward the spine (+y).
    center: (s) => [0, 0.55 * s * s, B0 + (B1 - B0) * s],
    width: (s) => (s < 0.85 ? 0.42 - 0.08 * s : (0.42 - 0.068) * Math.pow(Math.max(0, (1 - s) / 0.15), 0.7)) + 0.012,
    thick: (s) => 0.11 * (1 - 0.5 * s) + 0.014,
    edge: -1,
    ex: 2.6,
    bands: false,
    // White at the root, through pale green into the leek's green; the edge bevel brighter; layer lines.
    paint: (i, kk): Paint => {
      const a = Math.cos((kk / m) * Math.PI * 2);
      if (a < -0.6) return EDGE;
      const u = i / 22;
      const step = Math.min(SHADES.length - 1, Math.max(0, Math.round((u - 0.18) * 1.25 * (SHADES.length - 1))));
      // Faint lengthwise layer lines: every fourth column a shade deeper.
      return SHADES[Math.min(SHADES.length - 1, step + (kk % 4 === 1 && u > 0.15 ? 1 : 0))];
    },
    capStart: ACCENT,
  });
  k.hilt("fitting", () => {
    const rows = [B0 - 0.42, B0 - 0.38, B0 + 0.02, B0 + 0.08].map((z, i) => ring([0, 0, z], X, Y, [0.16, 0.2, 0.18, 0.14][i], [0.42, 0.48, 0.45, 0.4][i], fp ? 12 : 8, 2.6));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  });
  k.hilt("guard", () => {
    // Two leek leaves from the guard, one each side across the blade's width, curling back toward the pommel and
    // outward (a cup), clear of the fist.
    for (const side of [-1, 1]) {
      const path: V3[] = [];
      const n = fp ? 8 : 5;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        path.push([0, side * (0.3 + 0.8 * Math.sin(t * Math.PI * 0.55)), G1 + 0.3 - 0.42 * t * t]);
      }
      k.leaf(path, (i) => 0.24 * Math.sin(((i + 0.5) / (n + 1)) * Math.PI) + 0.05, 0.05, [1, 0, 0], () => (side > 0 ? LEAF : LEAF_DARK), { part: PART.guard, name: "leaves" });
    }
    const rows = [G1, G1 + 0.05, G1 + 0.32, B0 - 0.4].map((z, i) => ring([0, 0, z], X, Y, [0.26, 0.32, 0.32, 0.2][i], [0.36, 0.44, 0.44, 0.44][i], fp ? 12 : 8, 2.6));
    k.surface(rows, { paint: (i) => (i === 1 ? LEAF_DARK : LEAF), part: PART.guard, capStart: LEAF, capEnd: LEAF });
  });
  k.hilt("handle", () => {
    const n = fp ? 12 : 6;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const w = 1 - 0.06 * Math.sin(t * Math.PI);
      rows.push(ring([0, 0, G0 + (G1 - G0) * t], X, Y, 0.3 * w, 0.4 * w, fp ? 10 : 8, 2.4));
    }
    k.surface(rows, { paint: () => FIBRE_DARK, part: PART.grip, capStart: FIBRE_DARK, capEnd: FIBRE_DARK });
  });
  k.hilt("wrap", () => {
    // A spiral of root fibre over the core (two strands' worth of ribbing).
    const n = fp ? 22 : 10;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const w = (1 - 0.06 * Math.sin(t * Math.PI)) * (fp && i % 2 ? 1.05 : 1.02);
      rows.push(ring([0, 0, G0 + 0.08 + (G1 - G0 - 0.16) * t], X, Y, 0.3 * w, 0.4 * w, fp ? 10 : 8, 2.4, i * 0.35));
    }
    k.surface(rows, { paint: (i, kk) => ((kk + i) % 3 ? FIBRE : FIBRE_DARK), part: PART.grip, capStart: null, capEnd: null });
  });
  k.hilt("pommel", () => {
    const rows = [G0 + 0.02, G0 - 0.08, G0 - 0.2, G0 - 0.26].map((z, i) => ring([0, 0, z], X, Y, [0.3, 0.33, 0.26, 0.12][i], [0.4, 0.44, 0.34, 0.16][i], fp ? 12 : 8, 2.4));
    k.surface(rows, { paint: () => ROOT, part: PART.guard, capStart: ROOT, capEnd: ROOT });
    // A tuft of fine roots.
    const nr = fp ? 7 : 4;
    for (let j = 0; j < nr; j++) {
      const a = ((j + 0.5) / nr - 0.5) * 1.6;
      const path: V3[] = [];
      for (let i = 0; i <= 3; i++) {
        const t = i / 3;
        path.push([0.08 * Math.sin(j * 2.1) * t, Math.sin(a) * 0.55 * t, G0 - 0.24 - Math.cos(a) * 0.55 * t - 0.12 * t * t]);
      }
      k.tube(path, (i) => 0.035 * (1 - i / 4) + 0.01, 4, [1, 0, 0], () => ROOT, { part: PART.guard, name: "roots" });
    }
  });
}

export const leek: KnifeDef = withHilt({
  id: "leek",
  cosmeticId: "knife-leek",
  name: "Leek Saber",
  rarity: 4,
  blurb: "A long, curved saber grown from a leek, white at the root, green at the point.",
  build,
  pivots: { guard: { p: [0, 0, 1.7], axis: [1, 0, 0] }, balance: { p: [0, 0, 3.4], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.5 },
  hold: straightHold([0, 0, 0.3], undefined, SLIM_THUMB),
  pose(action, t, s) {
    const k = reducedMotion() ? 0.4 : 1;
    if (action === "idle") return idleSway(s, 0.6);
    const out: Record<string, [number, number]> = { draw: [0.6, 1.0], slash1: [0.55, 0.95], slash2: [0.55, 0.95], stab: [0.7, 1.2] };
    s.lock = 0.7 * rise(t, 0, 0.05) * (1 - rise(t, out[action][0], out[action][1]));
    if (action === "draw") {
      // Raised to a near-upright carry, then lowered into the guard.
      s.arm.a[0] += k * -6 * hump(t, 0.1, 0.7);
      s.arm.o[2] += k * 0.7 * hump(t, 0.1, 0.7);
      return;
    }
    if (action === "slash1" || action === "slash2") {
      // Point leading: the arm extends into the cut and draws back after it.
      const cut = hump(t, 0.04, 0.46);
      s.arm.o[0] += k * 0.7 * cut;
      s.arm.o[2] += k * 0.3 * cut;
      s.arm.a[2] += k * (action === "slash1" ? -18 : -30) * cut;
      return;
    }
    if (action === "stab") {
      // A lunge: the arm reaches well out, the blade level.
      const lunge = hump(t, 0.06, 0.62);
      s.arm.o[0] += k * 1.7 * lunge;
      s.arm.o[2] += k * -0.2 * lunge;
    }
  },
  // The ferrule, the cupped leaf guard and its collar (the collar's rim the second tone), the fibre core and its
  // spiral wrap (the darker fibre the second tone), the root cap (pommel); the root tuft stays the leek's.
  hilt: { fitting: "guard", guard: { role: "guard", alt: [LEAF_DARK] }, leaves: "guard", handle: "grip", wrap: { role: "grip", alt: [FIBRE_DARK] }, pommel: "pommel" },
});
