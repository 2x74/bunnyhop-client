// Carrot (charm-carrot): a stubby carrot with a rounded shoulder and a blunt tip, a few growth creases, three plump
// leaves round its bail.
import { KMAT } from "../../knives/types";
import { CB, P, add, scale, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const ORANGE = P(0xff7d1c, KMAT.veg), CREASE = P(0xd9560c, KMAT.veg), LEAF = P(0x55c24c, KMAT.veg), LEAF_DARK = P(0x36983b, KMAT.veg);

export const carrot: CharmDef = {
  id: "charm-carrot",
  top: 0,
  life: { kind: "lag", at: [0, 0, -0.02], axis: [0, 0, 1], rate: 4, amount: 0.4 },
  build(c: CharmCtx) {
    const body = c.turned([[0.11, 0], [0.27, -0.02], [0.38, -0.1], [0.43, -0.26], [0.41, -0.5], [0.34, -0.8], [0.25, -1.08], [0.16, -1.3], [0.08, -1.43], [0, -1.48]], { paint: ORANGE, seg: 16, sub: 2 });
    // Growth creases: short strokes round it at uneven heights.
    const creases: [number, number, number][] = [[-10, -0.3, 0.3], [25, -0.58, 0.24], [-20, -0.86, 0.22], [10, -1.1, 0.16], [120, -0.4, 0.28], [150, -0.75, 0.22], [105, -1.02, 0.16], [-125, -0.34, 0.26], [-100, -0.66, 0.24], [-140, -0.95, 0.18], [190, -0.24, 0.24], [60, -0.24, 0.22]];
    for (const [deg, z, len] of creases) {
      const a = (deg * Math.PI) / 180;
      const out: V3 = [Math.sin(a), -Math.cos(a), 0];
      c.line(body, add(scale(out, 0.3), [0, 0, z]), [[-len / 2, 0.012], [-len / 6, -0.006], [len / 6, -0.006], [len / 2, 0.012]], 0.034, CREASE, { dir: scale(out, -1), ex: [Math.cos(a), Math.sin(a), 0], lift: 0.006 });
    }
    // Leaves (bone 4: they lag the swing): two fanned to the sides, a shorter one behind, each a plump pointed blade.
    const leaf = (tilt: number, back: number, len: number, w: number, paint: typeof LEAF) => {
      const dir: V3 = [Math.sin(tilt), back, Math.cos(tilt)];
      const N = 8;
      const path = Array.from({ length: N + 1 }, (_, i) => {
        const s = i / N;
        // (Bending outward as it rises.)
        return add([Math.sin(tilt) * 0.13, back * 0.2, -0.04], add(scale(dir, len * s), [Math.sin(tilt) * 0.1 * s * s, 0, -0.05 * s * s]));
      });
      const K = 8;
      c.sweep(path, (i) => {
        const s = i / N, half = w * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * s)), 0.75) * (1 - 0.25 * s) + 0.012, thick = 0.05 * (1 - 0.6 * s) + 0.012;
        return Array.from({ length: K }, (_, k) => {
          const t = (k / K) * Math.PI * 2;
          return [Math.cos(t) * half, Math.sin(t) * thick] as [number, number];
        });
      }, { paint, bone: CB.part, ref: [Math.cos(tilt), 0, -Math.sin(tilt)] });
    };
    leaf(0, 0.55, 0.42, 0.13, LEAF_DARK);
    leaf(-0.72, 0.05, 0.56, 0.15, LEAF);
    leaf(0.72, 0.05, 0.56, 0.15, LEAF);
  },
};
