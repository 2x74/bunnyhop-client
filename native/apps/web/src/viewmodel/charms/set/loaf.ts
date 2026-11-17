// Loaf (charm-loaf): a grey-and-white cat sitting as a loaf (an original cat): a round head on a soft loaf of a body,
// a white bib and muzzle, tabby marks, its paws tucked, its tail round its side with a tip that flicks.
import { KMAT } from "../../knives/types";
import { CB, GLINT, INK, P, WHITE, oval, type CharmCtx, type V3 } from "../kit";
import type { CharmDef } from "../meshes";

const FUR = P(0x8f949e, KMAT.veg), FUR_DARK = P(0x5c616b, KMAT.veg), PINK = P(0xf2a3ae, KMAT.veg), NOSE = P(0xe57d8f), BIB = P(0xf7f4ee, KMAT.veg);

export const loaf: CharmDef = {
  id: "charm-loaf",
  top: -0.135,
  life: { kind: "flick", at: [-0.63, -0.22, -1.32], axis: [0, 0, 1], rate: 2.3, amount: 0.5 },
  build(c: CharmCtx) {
    // The loaf and the head on its front.
    const body = c.ball([0, 0.06, -1.02], [0.6, 0.47, 0.4], { paint: FUR, seg: 20, rows: 10, e: 2.5, ez: 2.3 });
    const H: V3 = [0, -0.1, -0.5];
    const head = c.ball(H, [0.45, 0.4, 0.38], { paint: FUR, seg: 18, rows: 11 });
    // Ears: soft triangles, pink inside.
    const K = 8;
    for (const sx of [-1, 1]) {
      const base: V3 = [sx * 0.26, -0.08, -0.26], tip: V3 = [sx * 0.37, -0.08, 0.1];
      const path = (a: number, b: number, n: number, dy: number): V3[] => Array.from({ length: n + 1 }, (_, i) => {
        const s = a + ((b - a) * i) / n;
        return [base[0] + (tip[0] - base[0]) * s, base[1] + dy, base[2] + (tip[2] - base[2]) * s] as V3;
      });
      const sec = (hw: number, ht: number) => Array.from({ length: K }, (_, k) => [Math.cos((k / K) * Math.PI * 2) * hw, Math.sin((k / K) * Math.PI * 2) * ht] as [number, number]);
      c.sweep(path(0, 1, 5, 0), (i) => sec(0.17 * Math.pow(1 - i / 5, 0.8) + 0.012, 0.085 * (1 - 0.6 * (i / 5)) + 0.008), { paint: FUR, ref: [1, 0, 0] });
      c.sweep(path(0.12, 0.72, 3, -0.07), (i) => sec(0.1 * Math.pow(1 - i / 3, 0.8) + 0.008, 0.03), { paint: PINK, ref: [1, 0, 0] });
    }
    // The face: a white muzzle, a pink nose, a small mouth, two dark eyes with a glint, three tabby marks.
    const at: V3 = [0, -0.4, -0.6];
    c.decal(head, at, oval(0.175, 0.12, 14), BIB, { rings: 2, lift: 0.01 });
    c.decal(head, [0, -0.4, -0.545], [[-0.042, 0.02], [-0.02, -0.022], [0.02, -0.022], [0.042, 0.02], [0, 0.03]], NOSE, { rings: 1, lift: 0.022 });
    c.line(head, [0, -0.4, -0.6], [[-0.075, -0.012], [-0.04, -0.04], [0, -0.008], [0.04, -0.04], [0.075, -0.012]], 0.02, INK, { lift: 0.022 });
    for (const sx of [-1, 1]) {
      c.decal(head, [sx * 0.19, -0.4, -0.47], oval(0.05, 0.063, 10), INK, { rings: 1, lift: 0.01 });
      c.decal(head, [sx * 0.19 - 0.015, -0.4, -0.45], oval(0.017, 0.017, 6), GLINT, { rings: 1, lift: 0.02 });
    }
    for (const x of [-0.1, 0, 0.1]) c.line(head, [x, -0.4, -0.25], [[0, 0.05], [0, 0], [0, -0.05 - (x === 0 ? 0.02 : 0)]], 0.04, FUR_DARK, { lift: 0.008 });
    // The bib on its chest, the paws tucked under it, tabby bands over its back.
    c.decal(body, [0, -0.4, -1.0], oval(0.25, 0.23, 16), BIB, { rings: 2, lift: 0.01 });
    for (const sx of [-1, 1]) c.ball([sx * 0.19, -0.4, -1.36], [0.13, 0.11, 0.07], { paint: BIB, seg: 10, rows: 5 });
    for (const x of [-0.24, 0, 0.24]) c.line(body, [x, 0.6, -0.86], [[0, 0.17], [0, 0], [0, -0.17]], 0.07, FUR_DARK, { dir: [0, -1, 0], ex: [-1, 0, 0], lift: 0.008 });
    // The tail round its left side to the front (its tip on bone 4: it flicks).
    const sec = (r: number) => Array.from({ length: 8 }, (_, k) => [Math.cos((k / 8) * Math.PI * 2) * r, Math.sin((k / 8) * Math.PI * 2) * r] as [number, number]);
    const tail: V3[] = [[-0.4, 0.38, -1.26], [-0.58, 0.2, -1.28], [-0.66, -0.02, -1.3], [-0.63, -0.22, -1.32]];
    c.sweep(tail, (i) => sec(0.09 - i * 0.004), { paint: FUR, ref: [0, 0, 1] });
    c.sweep([[-0.63, -0.22, -1.32], [-0.54, -0.38, -1.33], [-0.4, -0.47, -1.33]], (i) => sec(0.078 - i * 0.012), { paint: FUR_DARK, bone: CB.part, ref: [0, 0, 1] });
  },
};
