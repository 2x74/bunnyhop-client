// Heart (charm-heart): a plump cherry-red enamel heart in a gold setting.
import { BRASS, BRASS_SATIN, P, heartOutline, type CharmCtx } from "../kit";
import type { CharmDef } from "../meshes";

const RED = P(0xe3273f);

export const heart: CharmDef = {
  id: "charm-heart",
  // (The cap sits in the notch between the lobes.)
  top: -0.33,
  life: { kind: "beat", at: [0, 0, -0.75], axis: [0, 1, 0], rate: 2.6, amount: 0.07 },
  build(c: CharmCtx) {
    const C: [number, number, number] = [0, 0, -0.68];
    c.plate(heartOutline(1.36, 44), C, { thick: 0.36, bevel: 0.13, rimWidth: 0.045, dome: 0.14, face: RED, rim: BRASS, back: BRASS_SATIN, rings: 5, soft: 0.8 });
  },
};
