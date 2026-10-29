// Golden Carrot (knife-golden, Golden: hold a WR): the carrot blade cast in polished gold. Bright gold growth rings
// (they read as glowing bands), a gold guard with a crown of six little leaf points, gold pommel leaves, a deep green
// grip. Same silhouette and hold as the carrot, so the carrot's v_knife_t / procedural motion fits it as is.

import { ring } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { buildCarrotFp, buildCarrotTp, carrot, type CarrotPalette } from "./carrot";
import { fixed, type KnifeCtx } from "./ctx";
import { KMAT, PART, type KnifeDef } from "./types";

const GOLD = fixed(0xffc23a, KMAT.polished), GOLD_RING = fixed(0xfff3b0, KMAT.veg), GOLD_DARK = fixed(0xd9901a, KMAT.polished), GRIP = fixed(0x1f4a2a, KMAT.grip);
const PALETTE: CarrotPalette = { blade: GOLD, ring: GOLD_RING, grip: GRIP, guard: GOLD_DARK, leaf: GOLD, leafDark: GOLD_DARK };

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  if (!fp) return buildCarrotTp(k, PALETTE);
  buildCarrotFp(k, PALETTE);
  // Crown on the guard: six small leaf points leaning out toward the blade.
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2 + Math.PI / 6;
    const d: V3 = [Math.cos(a) * 0.8, Math.sin(a), 0];
    const path: V3[] = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const r = 0.95 + 0.3 * t;
      path.push([d[0] * r, d[1] * r, 2.15 + 0.75 * t]);
    }
    k.leaf(path, (i) => 0.15 * (1 - i / 3.4) + 0.02, 0.05, [d[0], d[1], 0], () => (j % 2 ? GOLD : GOLD_DARK), { part: PART.guard });
  }
  // A gold band round the grip's middle.
  const rows = [-0.45, -0.3, -0.15].map((z, i) => ring([0, 0, z], [1, 0, 0], [0, 1, 0], [0.5, 0.56, 0.5][i], [0.55, 0.62, 0.55][i], 12));
  k.surface(rows, { paint: () => GOLD, part: PART.guard, capStart: GOLD, capEnd: GOLD });
}

export const golden: KnifeDef = {
  id: "golden",
  cosmeticId: "knife-golden",
  name: "Golden Carrot",
  rarity: 5,
  blurb: "The carrot blade in polished gold, held by world record holders.",
  build,
  tp: carrot.tp,
};
