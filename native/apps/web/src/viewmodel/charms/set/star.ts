// Star (charm-star): a chunky five-point star with rounded points, cast gold with a warm enamel face.
import { KMAT } from "../../knives/types";
import { BRASS, BRASS_SATIN, P, roundPoly, type CharmCtx } from "../kit";
import type { CharmDef } from "../meshes";

const ENAMEL = P(0xffcf3f, KMAT.lacquer);

/** Five points, the first straight up: corners R out, r in, rounded. */
const outline = (R: number, r: number): [number, number][] =>
  roundPoly(
    Array.from({ length: 10 }, (_, i) => {
      const a = Math.PI / 2 + (i / 10) * Math.PI * 2, rr = i % 2 ? r : R;
      return [Math.cos(a) * rr, Math.sin(a) * rr] as [number, number];
    }),
    2,
    0.2,
  );

export const star: CharmDef = {
  id: "charm-star",
  top: -0.05,
  life: { kind: "spin", at: [0, 0, 0], axis: [0, 0, 1], rate: 5.5, amount: 1.4 },
  build(c: CharmCtx) {
    c.plate(outline(0.8, 0.4), [0, 0, -0.74], { thick: 0.3, bevel: 0.11, rimWidth: 0.05, dome: 0.1, face: ENAMEL, rim: BRASS, back: BRASS_SATIN, rings: 5 });
  },
};
