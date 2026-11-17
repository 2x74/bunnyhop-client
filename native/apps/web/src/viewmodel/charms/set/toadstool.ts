// Toadstool (charm-toadstool): a red cap with a rolled rim and raised white spots, pale gills, a stout stalk with a
// skirt and a small face.
import { KMAT } from "../../knives/types";
import { BLUSH, INK, P, add, oval, scale, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const CAP = P(0xdd3a2d), GILL = P(0xe9d9b8, KMAT.veg), STALK = P(0xf6ecd8, KMAT.veg), SKIRT = P(0xfbf6ea, KMAT.veg), SPOT = P(0xfdfaf2);

export const toadstool: CharmDef = {
  id: "charm-toadstool",
  top: 0,
  build(c: CharmCtx) {
    // The cap: a dome down to a rolled rim, then in under it to the gills.
    const cap = c.turned([[0.07, 0], [0.3, -0.035], [0.5, -0.14], [0.63, -0.31], [0.67, -0.47], [0.63, -0.57], [0.5, -0.585], [0.32, -0.55], [0.19, -0.52]], { paint: (p) => (p[2] < -0.52 && Math.hypot(p[0], p[1]) < 0.6 ? GILL : CAP), seg: 20, sub: 2, capBottom: false });
    const stalk = c.turned([[0.19, -0.5], [0.185, -0.7], [0.2, -0.95], [0.27, -1.18], [0.3, -1.31], [0.25, -1.41], [0.11, -1.46], [0, -1.47]], { paint: STALK, seg: 14, sub: 2, capTop: false });
    c.turned([[0.18, -0.67], [0.3, -0.75], [0.33, -0.8], [0.25, -0.8], [0.18, -0.77]], { paint: SKIRT, seg: 14, sub: 2, capTop: false, capBottom: false });
    // Spots: round the dome, and two on top.
    const spots: [number, number, number][] = [[0, -0.3, 0.125], [-58, -0.37, 0.095], [52, -0.24, 0.085], [112, -0.34, 0.115], [178, -0.27, 0.1], [-122, -0.29, 0.105], [-22, -0.47, 0.06], [80, -0.46, 0.055], [-160, -0.46, 0.06]];
    for (const [deg, z, r] of spots) {
      const a = (deg * Math.PI) / 180;
      const out: V3 = [Math.sin(a), -Math.cos(a), 0];
      c.decal(cap, add(scale(out, 0.5), [0, 0, z]), oval(r, r * 1.08, 10), SPOT, { dir: scale(out, -1), ex: [Math.cos(a), Math.sin(a), 0], lift: 0.018, rings: r > 0.09 ? 2 : 1 });
    }
    c.decal(cap, [0.14, 0.1, 0], oval(0.11, 0.1, 12), SPOT, { dir: [0, 0, -1], ex: [1, 0, 0], ey: [0, 1, 0], lift: 0.018 });
    c.decal(cap, [-0.2, -0.16, 0], oval(0.075, 0.07, 10), SPOT, { dir: [0, 0, -1], ex: [1, 0, 0], ey: [0, 1, 0], lift: 0.018 });
    // The face on the stalk.
    for (const sx of [-1, 1]) {
      c.decal(stalk, [sx * 0.095, -0.3, -1.04], oval(0.034, 0.048, 10), INK, { rings: 1, lift: 0.008 });
      c.decal(stalk, [sx * 0.17, -0.3, -1.13], oval(0.04, 0.026, 8), BLUSH, { rings: 1, lift: 0.006 });
    }
    c.line(stalk, [0, -0.3, -1.13], [[-0.045, 0.012], [-0.02, -0.008], [0.02, -0.008], [0.045, 0.012]], 0.024, INK, { lift: 0.008 });
  },
};
