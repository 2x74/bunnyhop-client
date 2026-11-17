// Duck (charm-duck): a bath duck seen from its side, looking toward the middle of the screen: a plump body with its
// tail up, a round head, a flat orange bill, a wing pressed into each side. It hangs from its back.
import { CB, GLINT, INK, P, oval, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const YELLOW = P(0xffd43a), WING = P(0xf4b81c), BILL = P(0xff8a1f);

export const duck: CharmDef = {
  id: "charm-duck",
  top: -0.3,
  life: { kind: "bob", at: [-0.3, 0, -0.5], axis: [0, 1, 0], rate: 0.55, amount: 0.1 },
  build(c: CharmCtx) {
    // The body: an egg lying down, its tail (to the right) swept up, its underside flattened to sit.
    const B: V3 = [0.05, 0, -0.74];
    const shape = (p: V3): V3 => {
      const x = p[0] - B[0];
      let z = p[2];
      if (x > 0.12) z += 0.85 * Math.pow(x - 0.12, 1.6);
      if (z < -1.02) z = -1.02 + (z + 1.02) * 0.4;
      return [p[0], p[1] * (1 - 0.3 * Math.max(0, x - 0.15)), z];
    };
    c.ball(B, [0.6, 0.45, 0.42], { paint: YELLOW, seg: 20, rows: 12, warp: shape });
    // A wing pressed into each side (laid on the plain egg: the shaping barely moves it there).
    const egg = c.ball(B, [0.6, 0.45, 0.42], { paint: YELLOW, ghost: true });
    for (const sy of [-1, 1]) {
      const wing: [number, number][] = Array.from({ length: 16 }, (_, i) => {
        const t = (i / 16) * Math.PI * 2;
        // A teardrop, its point toward the tail.
        const r = 0.19 * (1 + 0.4 * Math.cos(t)) * (1 - 0.15 * Math.cos(2 * t));
        return [(-0.04 + Math.cos(t) * r * 1.1) * sy, Math.sin(t) * r * 0.8] as [number, number];
      });
      c.decal(egg, [B[0], sy * 0.3, B[2] + 0.02], wing, WING, { dir: [0, -sy, 0], ex: [sy, 0, 0], lift: 0.034, rings: 2 });
    }
    // The head (bone 4: it bobs), the bill, an eye on each side.
    const H: V3 = [-0.4, 0, -0.26];
    const head = c.ball(H, [0.32, 0.31, 0.31], { paint: YELLOW, bone: CB.part, seg: 16, rows: 10 });
    c.ball([H[0] - 0.33, 0, H[2] - 0.07], [0.19, 0.17, 0.065], { paint: BILL, bone: CB.part, seg: 14, rows: 7, warp: (p) => [p[0], p[1], p[2] + 0.25 * Math.pow(Math.max(0, H[0] - 0.3 - p[0]), 1.4)] });
    for (const sy of [-1, 1]) {
      const at: V3 = [H[0] - 0.1, sy * 0.3, H[2] + 0.07];
      c.decal(head, at, oval(0.052, 0.062, 12), INK, { dir: [0, -sy, 0], ex: [sy, 0, 0], bone: CB.part, rings: 1, lift: 0.01 });
      c.decal(head, [at[0] - 0.014, at[1], at[2] + 0.02], oval(0.018, 0.018, 8), GLINT, { dir: [0, -sy, 0], ex: [sy, 0, 0], bone: CB.part, rings: 1, lift: 0.02 });
    }
  },
};
