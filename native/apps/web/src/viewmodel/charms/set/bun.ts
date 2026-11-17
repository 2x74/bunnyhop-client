// Bun (charm-bun): the game's bunny as the mascot draws it: the hood and ears in your colourway, the dark face in the
// hood's opening, the accent visor across it with two cream eyes, a small mouth, the hood's drawstrings.
import { KMAT } from "../../knives/types";
import { ACCENT, CB, FACE, HOODIE, P, add, oval, pill, type CharmCtx, type Paint, type V3 } from "../kit";
import type { CharmDef } from "../meshes";
import { ear } from "./parts";

/** The colourway's trim (palette slot 1: the hood's rim), the eyes' cream. */
const TRIM: Paint = { code: 4, mat: KMAT.lacquer };
const EYE = P(0xfff3d2);

export const bun: CharmDef = {
  id: "charm-bun",
  top: -0.285,
  life: { kind: "lag", at: [0, 0, -0.38], axis: [0, 0, 1], rate: 3.2, amount: 0.4 },
  build(c: CharmCtx) {
    const hood = c.ball([0, 0, -0.86], [0.6, 0.54, 0.58], { paint: HOODIE, seg: 20, rows: 12 });
    // The face in the hood's opening, the opening's rim standing round it.
    const at: V3 = [0, -0.4, -0.9];
    c.decal(hood, at, oval(0.42, 0.4, 24), FACE, { rings: 3, lift: 0.012 });
    c.rimOn(hood, at, oval(0.44, 0.42, 24), 0.052, TRIM, { sides: 5 });
    // The visor, its eyes, the mouth under it.
    c.decal(hood, add(at, [0, 0, 0.05]), pill(0.395, 0.105, 3.4, 20), ACCENT, { rings: 2, lift: 0.028 });
    for (const sx of [-1, 1]) c.decal(hood, add(at, [sx * 0.17, 0, 0.05]), oval(0.068, 0.078, 10), EYE, { rings: 1, lift: 0.042 });
    c.decal(hood, add(at, [0, 0, -0.19]), oval(0.046, 0.04, 8), ACCENT, { rings: 1, lift: 0.028 });
    // Ears (bone 4: they flop late), the accent panels set in their fronts.
    for (const sx of [-1, 1]) ear(c, [sx * 0.25, 0.03, -0.4], [sx * 0.39, 0.03, 0.42], { w: 0.155, t: 0.085, paint: HOODIE, inner: ACCENT, bone: CB.part });
    // The drawstrings: two short cords from under the opening, a cream tip on each.
    for (const sx of [-1, 1]) {
      const h = c.hit(hood, [sx * 0.11, -1.5, -1.33], [0, 1, 0]);
      if (!h) continue;
      const p = add(h.p, [0, -0.02, 0]);
      c.tube([p, add(p, [sx * 0.012, -0.01, -0.1]), add(p, [sx * 0.02, 0, -0.2])], 0.027, ACCENT, CB.body, 6, [1, 0, 0]);
      c.ball(add(p, [sx * 0.022, 0, -0.225]), [0.036, 0.036, 0.045], { paint: EYE, seg: 6, rows: 4 });
    }
  },
};
