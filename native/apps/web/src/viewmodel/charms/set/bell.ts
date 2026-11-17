// Bell (charm-bell): a polished brass hand bell, crown, shoulder and a flared thick lip, two engraved bands, its
// clapper showing below.
import { KMAT } from "../../knives/types";
import { BRASS, BRASS_DARK, CB, P, type CharmCtx } from "../kit";
import type { CharmDef } from "../meshes";

const INSIDE = P(0x6e4c1a, KMAT.satin), CLAPPER = P(0xb9852e, KMAT.polished);

export const bell: CharmDef = {
  id: "charm-bell",
  top: 0,
  life: { kind: "lag", at: [0, 0, -0.5], axis: [0, 0, -1], rate: 5, amount: 0.7 },
  build(c: CharmCtx) {
    // Outside from the crown down to the lip, round its thick edge and back up the inside.
    const prof: [number, number][] = [[0.08, 0], [0.17, -0.035], [0.19, -0.1], [0.145, -0.17], [0.29, -0.24], [0.4, -0.37], [0.445, -0.6], [0.475, -0.85], [0.55, -1.04], [0.655, -1.19], [0.69, -1.26], [0.675, -1.31], [0.61, -1.305], [0.545, -1.2], [0.45, -1.0], [0.38, -0.72], [0.22, -0.52]];
    c.turned(prof, {
      paint: (p) => {
        const r = Math.hypot(p[0], p[1]), z = p[2];
        // (The inside: within the wall's outer radius at that height.)
        const inside = z < -0.5 && r < 0.44 + Math.max(0, -z - 0.85) * 0.62 - 0.03 && z > -1.3;
        if (inside) return INSIDE;
        return Math.abs(z + 0.47) < 0.03 || Math.abs(z + 1.0) < 0.03 ? BRASS_DARK : BRASS;
      },
      seg: 20,
      sub: 2,
    });
    // The clapper on its rod (bone 4: it swings late).
    c.tube([[0, 0, -0.5], [0, 0, -1.28]], 0.03, CLAPPER, CB.part, 6, [1, 0, 0]);
    c.ball([0, 0, -1.38], [0.13, 0.13, 0.13], { paint: CLAPPER, bone: CB.part, seg: 10, rows: 6 });
  },
};
