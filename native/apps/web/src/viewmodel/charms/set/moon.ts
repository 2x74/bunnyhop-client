// Moon (charm-moon): a fat cream crescent, asleep: a closed eye, a blush, a small smile.
import { BLUSH, CB, INK, P, oval, solidOf, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const MOON = P(0xf8e8a8), SHADE = P(0xefd98a);

export const moon: CharmDef = {
  id: "charm-moon",
  top: -0.02,
  life: { kind: "rock", at: [0, 0, 0], axis: [0, 1, 0], rate: 0.35, amount: 0.1 },
  build(c: CharmCtx) {
    // A crescent open to the right: a lens-shaped section carried round an arc, fat in the middle, drawn out to the horns.
    const C: V3 = [0.17, 0, -0.78], R = 0.5;
    const a0 = Math.PI * 0.27, a1 = Math.PI * 1.73, N = 34;
    const wide = (s: number) => 0.02 + 0.31 * Math.pow(Math.sin(Math.PI * s), 0.8);
    const deep = (s: number) => 0.03 + 0.2 * Math.pow(Math.sin(Math.PI * s), 0.5);
    const path = Array.from({ length: N + 1 }, (_, i) => {
      const a = a0 + (i / N) * (a1 - a0);
      return [C[0] + Math.cos(a) * R, C[1], C[2] + Math.sin(a) * R] as V3;
    });
    const K = 14;
    c.sweep(path, (i) => Array.from({ length: K }, (_, k) => {
      const t = (k / K) * Math.PI * 2;
      return [Math.cos(t) * deep(i / N), Math.sin(t) * wide(i / N)] as [number, number];
    }), { paint: (p) => (Math.hypot(p[0] - C[0], p[2] - C[2]) < R - 0.02 ? SHADE : MOON), bone: CB.part });
    // The same crescent as a solid, for the face laid on it.
    const on = solidOf((p) => {
      const a = Math.atan2(p[2] - C[2], p[0] - C[0]);
      const s = ((a < 0 ? a + Math.PI * 2 : a) - a0) / (a1 - a0);
      if (s <= 0.01 || s >= 0.99) return 1;
      const rho = Math.hypot(p[0] - C[0], p[2] - C[2]) - R;
      return (rho * rho) / (wide(s) * wide(s)) + (p[1] * p[1]) / (deep(s) * deep(s)) - 1;
    });
    const at: V3 = [-0.33, -0.3, -0.72];
    c.line(on, at, Array.from({ length: 7 }, (_, i) => [-0.115 + (0.23 * i) / 6, -0.045 * Math.sin((Math.PI * i) / 6)] as [number, number]), 0.045, INK, { bone: CB.part });
    c.decal(on, [-0.36, -0.3, -0.93], oval(0.085, 0.055, 12), BLUSH, { bone: CB.part, rings: 1 });
    c.line(on, [-0.21, -0.3, -1.0], Array.from({ length: 5 }, (_, i) => [-0.06 + (0.12 * i) / 4, -0.03 * Math.sin((Math.PI * i) / 4)] as [number, number]), 0.035, INK, { bone: CB.part });
  },
};
