// Snail (charm-snail): a side-on snail looking toward the middle of the screen: a domed orange shell with a raised
// spiral on each face, a cream body with its head up, two eyes on stalks.
import { KMAT } from "../../knives/types";
import { BLUSH, CB, INK, P, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const SHELL = P(0xf59a3c), SWIRL = P(0xb9541b), BODY = P(0xf3e6c8, KMAT.veg), STALK = P(0xd9c59c, KMAT.veg);

export const snail: CharmDef = {
  id: "charm-snail",
  top: -0.085,
  life: { kind: "bob", at: [-0.56, 0, -0.74], axis: [0, 1, 0], rate: 0.7, amount: 0.14 },
  build(c: CharmCtx) {
    // The shell: a fat lens on its edge, a spiral cord wound from its rim to its middle on both faces.
    const S: V3 = [0.03, 0, -0.6];
    const shell = c.ball(S, [0.52, 0.52, 0.29], { paint: SHELL, axis: [0, 1, 0], uRef: [1, 0, 0], seg: 20, rows: 10, ez: 2.3 });
    const N = 30, turns = 2.1;
    for (const sy of [-1, 1]) {
      const path: [number, number][] = Array.from({ length: N + 1 }, (_, i) => {
        const t = i / N, a = -Math.PI * 0.62 - t * turns * Math.PI * 2, r = 0.455 * Math.pow(1 - t, 0.85) + 0.02;
        return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
      });
      c.rimOn(shell, [S[0], sy * 0.3, S[2]], path, (i) => 0.042 - 0.02 * (i / N), SWIRL, { dir: [0, -sy, 0], ex: [-sy, 0, 0], open: true, sides: 4, sink: 0.5 });
    }
    // The body: a soft foot under the shell, flat beneath, its tail to the right, its neck rising to the head at the left.
    const path: V3[] = [[0.66, 0, -1.2], [0.5, 0, -1.19], [0.25, 0, -1.17], [-0.05, 0, -1.17], [-0.32, 0, -1.14], [-0.5, 0, -1.02], [-0.57, 0, -0.86], [-0.58, 0, -0.74]];
    const wide = [0.03, 0.12, 0.2, 0.22, 0.2, 0.17, 0.155, 0.15], high = [0.025, 0.07, 0.11, 0.12, 0.125, 0.14, 0.15, 0.15];
    const K = 10;
    c.sweep(path, (i) => Array.from({ length: K }, (_, k) => {
      const t = (k / K) * Math.PI * 2, s = Math.sin(t);
      // (Across the path, v points down along the foot: its underside is the flat one.)
      return [Math.cos(t) * wide[i], s * high[i] * (s > 0 && i < 5 ? 0.5 : 1)] as [number, number];
    }), { paint: BODY });
    const head = c.ball([-0.585, 0, -0.71], [0.17, 0.16, 0.165], { paint: BODY, seg: 12, rows: 8 });
    // A smile and a blush on the side you see (and the other).
    for (const sy of [-1, 1]) {
      c.line(head, [-0.66, sy * 0.3, -0.74], [[-0.05, 0.02], [-0.02, -0.008], [0.02, -0.008], [0.05, 0.016]], 0.022, INK, { dir: [0, -sy, 0], ex: [sy, 0, 0], lift: 0.008 });
      c.decal(head, [-0.55, sy * 0.3, -0.76], [[0.035, 0], [0, 0.024], [-0.035, 0], [0, -0.024]], BLUSH, { dir: [0, -sy, 0], ex: [sy, 0, 0], rings: 1, lift: 0.008 });
    }
    // Eye stalks (bone 4: they bob), an eye on each.
    for (const sy of [-1, 1]) {
      c.tube([[-0.6, sy * 0.07, -0.6], [-0.65, sy * 0.1, -0.44], [-0.69, sy * 0.12, -0.3]], 0.03, STALK, CB.part, 6, [1, 0, 0]);
      c.ball([-0.695, sy * 0.125, -0.27], [0.062, 0.062, 0.062], { paint: INK, bone: CB.part, seg: 8, rows: 5 });
    }
  },
};
