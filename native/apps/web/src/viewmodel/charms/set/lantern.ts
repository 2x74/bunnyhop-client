// Lantern (charm-lantern): a paper lantern, pleated paper lit from inside in your colourway's accent over dark ribs, between black
// lacquer caps with gold bands, a red tassel on a gold bead.
import { KMAT } from "../../knives/types";
import { ACCENT_GLOW, BRASS, CB, P, type CharmCtx } from "../kit";
import type { CharmDef } from "../meshes";

const BLACK = P(0x25211f), RIB = P(0xb98a34, KMAT.grip), TASSEL = P(0xcf2530, KMAT.grip);

export const lantern: CharmDef = {
  id: "charm-lantern",
  top: 0,
  life: { kind: "lag", at: [0, 0, -1.38], axis: [0, 0, -1], rate: 3.5, amount: 0.6 },
  build(c: CharmCtx) {
    c.turned([[0.1, 0], [0.22, -0.02], [0.265, -0.07], [0.265, -0.14], [0.21, -0.18]], { paint: BLACK, seg: 14, sub: 2 });
    c.torus([0, 0, -0.165], 0.245, 0.034, [0, 0, 1], BRASS, CB.body, 14, 5);
    // The paper: a full oval, pleated in rings over its ribs: the folds' valleys are the ribs' dark lines.
    const N = 13, pitch = 0.13, z0 = -0.18, H = 1.04;
    const prof: [number, number][] = Array.from({ length: N + 1 }, (_, i) => {
      const s = i / N;
      return [0.22 + 0.36 * Math.pow(Math.sin(Math.PI * s), 0.85), z0 - s * H] as [number, number];
    });
    const fold = (z: number) => Math.cos(((z - z0) / pitch) * Math.PI * 2);
    c.turned(prof, { paint: (p) => (fold(p[2]) < -0.8 ? RIB : ACCENT_GLOW), seg: 14, sub: 3, wobble: (_th, z) => 1 + 0.022 * fold(z), capTop: false, capBottom: false });
    c.torus([0, 0, z0 - H - 0.005], 0.245, 0.034, [0, 0, 1], BRASS, CB.body, 14, 5);
    c.turned([[0.21, z0 - H], [0.265, z0 - H - 0.04], [0.265, z0 - H - 0.1], [0.2, z0 - H - 0.15], [0.07, z0 - H - 0.17]], { paint: BLACK, seg: 14, sub: 2 });
    // The tassel (bone 4: it lags): a cord, a gold bead, the threads.
    c.tube([[0, 0, -1.38], [0, 0, -1.5]], 0.024, BRASS, CB.part, 5, [1, 0, 0], false);
    c.ball([0, 0, -1.5], [0.062, 0.062, 0.055], { paint: BRASS, bone: CB.part, seg: 8, rows: 5 });
    c.turned([[0.04, -1.54], [0.075, -1.58], [0.085, -1.72], [0.105, -1.9], [0.105, -1.9], [0.0, -1.9]], { paint: TASSEL, bone: CB.part, seg: 14, sub: 2, wobble: (th) => 1 + 0.07 * Math.cos(th * 7) });
  },
};
