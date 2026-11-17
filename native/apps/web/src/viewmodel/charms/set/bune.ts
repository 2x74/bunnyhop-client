// Bun-E (charm-bune): the staff bot's head: a white helmet, the black glass of its face with the amber band and its
// two lit eyes, a small smile, the amber rings on its sides, hard-shell ears with amber panels on dark joints.
import { KMAT } from "../../knives/types";
import { CB, P, add, oval, pill, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";
import { ear } from "./parts";

const SHELL = P(0xf5f0e6), SHADE = P(0xd6cebf), GLASS = P(0x15161b), AMBER = P(0xffb22c), LIT = P(0xfff1b8), JOINT = P(0x3b3e47, KMAT.satin);

export const bune: CharmDef = {
  id: "charm-bune",
  top: -0.275,
  life: { kind: "blink", at: [0, -0.5, -0.83], axis: [0, 0, 1], rate: 4.2, amount: 0.15 },
  build(c: CharmCtx) {
    const helmet = c.ball([0, 0, -0.85], [0.58, 0.54, 0.58], { paint: SHELL, seg: 20, rows: 12 });
    // The glass, a bevel round it.
    const at: V3 = [0, -0.4, -0.88];
    c.decal(helmet, at, pill(0.42, 0.4, 2.7, 24), GLASS, { rings: 3, lift: 0.012 });
    c.rimOn(helmet, at, pill(0.436, 0.416, 2.7, 24), 0.04, SHADE, { sides: 5 });
    // The amber band and the eyes lit on it (bone 4: they blink), the smile.
    c.decal(helmet, add(at, [0, 0, 0.05]), pill(0.405, 0.1, 3.4, 20), AMBER, { rings: 2, lift: 0.028 });
    for (const sx of [-1, 1]) {
      const eye = oval(0.085, 0.048, 10).map(([x, z]) => [x * 0.96 + sx * z * 0.28, z * 0.96 - sx * x * 0.28] as [number, number]);
      c.decal(helmet, add(at, [sx * 0.17, 0, 0.05]), eye, LIT, { rings: 1, lift: 0.042, bone: CB.part });
    }
    c.line(helmet, add(at, [0, 0, -0.17]), [[-0.075, 0.02], [-0.04, -0.008], [0, -0.018], [0.04, -0.008], [0.075, 0.02]], 0.03, AMBER, { lift: 0.028 });
    // The rings on its sides, a white hub in each.
    for (const sx of [-1, 1]) {
      c.torus([sx * 0.555, 0, -0.85], 0.16, 0.042, [1, 0, 0], AMBER, CB.body, 12, 5);
      c.ball([sx * 0.565, 0, -0.85], [0.125, 0.125, 0.06], { paint: SHELL, axis: [1, 0, 0], seg: 10, rows: 4 });
    }
    // The ears: hard shells on dark joints.
    for (const sx of [-1, 1]) {
      c.ball([sx * 0.262, 0.03, -0.37], [0.13, 0.1, 0.07], { paint: JOINT, axis: [sx * 0.17, 0, 1], seg: 8, rows: 4 });
      ear(c, [sx * 0.27, 0.03, -0.36], [sx * 0.42, 0.03, 0.42], { w: 0.15, t: 0.085, e: 3.2, paint: SHELL, inner: AMBER, bone: CB.body, lean: 0.03 });
    }
  },
};
