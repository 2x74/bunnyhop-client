// Frog (charm-frog): a round frog facing you: eyes on top, a wide smile, a pale belly, its toes tucked under.
import { KMAT } from "../../knives/types";
import { BLUSH, CB, INK, P, WHITE, oval, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const GREEN = P(0x5fc24e, KMAT.veg), DARK = P(0x3c8f36, KMAT.veg), BELLY = P(0xdaf0b4, KMAT.veg), MOUTH = P(0x245220);

export const frog: CharmDef = {
  id: "charm-frog",
  top: -0.34,
  life: { kind: "blink", at: [0, -0.4, -0.42], axis: [0, 0, 1], rate: 3.6, amount: 0.12 },
  build(c: CharmCtx) {
    const B: V3 = [0, 0, -0.86];
    // The body: wider than tall, its underside flattened.
    const body = c.ball(B, [0.6, 0.47, 0.5], { paint: GREEN, seg: 20, rows: 12 });
    // Legs folded at its sides, the front toes under its chin.
    for (const sx of [-1, 1]) {
      c.ball([sx * 0.47, 0.06, -1.1], [0.17, 0.27, 0.2], { paint: DARK, seg: 10, rows: 6 });
      c.ball([sx * 0.3, -0.33, -1.3], [0.16, 0.13, 0.065], { paint: DARK, seg: 10, rows: 5 });
    }
    // Belly, smile, nostrils, a blush.
    c.decal(body, [0, -0.4, -1.03], oval(0.34, 0.25, 18), BELLY, { rings: 2, lift: 0.01 });
    c.line(body, [0, -0.4, -0.72], [[-0.3, 0.035], [-0.2, -0.005], [-0.08, -0.03], [0.08, -0.03], [0.2, -0.005], [0.3, 0.035]], 0.034, MOUTH, { lift: 0.012 });
    for (const sx of [-1, 1]) {
      c.decal(body, [sx * 0.045, -0.4, -0.6], oval(0.016, 0.014, 6), MOUTH, { rings: 1, lift: 0.01 });
      c.decal(body, [sx * 0.39, -0.4, -0.8], oval(0.062, 0.04, 10), BLUSH, { rings: 1, lift: 0.01 });
    }
    // The eyes: domes on top, a white on each, the pupils on bone 4 (they blink).
    for (const sx of [-1, 1]) {
      const E: V3 = [sx * 0.3, -0.03, -0.44];
      const dome = c.ball(E, [0.225, 0.21, 0.225], { paint: GREEN, seg: 14, rows: 8 });
      c.decal(dome, [E[0], -0.4, E[2] + 0.01], oval(0.14, 0.15, 14), WHITE, { rings: 2, lift: 0.012 });
      c.decal(dome, [E[0] - sx * 0.02, -0.4, E[2] + 0.01], oval(0.068, 0.088, 12), INK, { rings: 1, lift: 0.026, bone: CB.part });
    }
  },
};
