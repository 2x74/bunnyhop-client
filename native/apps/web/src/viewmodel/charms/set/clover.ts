// Clover (charm-clover): a four-leaf clover, green enamel leaves in a gold setting, a short gold stem.
import { BRASS, BRASS_SATIN, P, orient, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const GREEN = P(0x2fa64f);

/** Four heart-shaped leaves on the diagonals, each notched at its tip. */
function outline(R: number, n = 64): [number, number][] {
  return orient(
    Array.from({ length: n }, (_, i) => {
      const th = (i / n) * Math.PI * 2;
      // The angle from the nearest leaf's middle (the diagonals).
      const d = ((((th - Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
      const lobe = Math.pow(Math.cos(2 * d), 0.3);
      const notch = 1 - 0.2 * Math.exp(-(d * d) / (0.13 * 0.13));
      const rr = R * (0.16 + 0.84 * lobe) * notch;
      return [Math.cos(th) * rr, Math.sin(th) * rr] as [number, number];
    }),
  );
}

export const clover: CharmDef = {
  id: "charm-clover",
  // (The cap sits in the valley between the two upper leaves.)
  top: -0.5,
  build(c: CharmCtx) {
    const C: V3 = [0, 0, -0.74];
    c.plate(outline(0.74), C, { thick: 0.28, bevel: 0.09, rimWidth: 0.04, dome: 0.08, face: GREEN, rim: BRASS, back: BRASS_SATIN, rings: 4 });
    // The stem: out of the lower valley, curling to the right.
    c.tube([[0, 0, -0.9], [0.01, 0, -1.12], [0.06, 0, -1.34], [0.17, 0, -1.52], [0.32, 0, -1.62]], (i) => 0.085 - i * 0.008, BRASS, undefined, 8, [0, 1, 0]);
  },
};
