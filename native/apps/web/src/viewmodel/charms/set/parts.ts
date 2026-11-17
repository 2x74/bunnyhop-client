// Parts two charms share: the bunny ears of the Bun and Bun-E (a tall rounded blade with an inset panel on its front).
import { add, scale, type CharmCtx, type Paint, type V3 } from "../kit";

/**
 * An ear from `base` to `tip`: `w` its half width across, `t` its half thickness front to back, `e` its section's
 * squareness (2 round, 4 a hard shell). `inner`: the panel set into its front.
 */
export function ear(c: CharmCtx, base: V3, tip: V3, o: { w: number; t: number; e?: number; paint: Paint; inner: Paint; bone: number; lean?: number }): void {
  const N = 7, K = 8, e = o.e ?? 2;
  const d: V3 = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
  const side = Math.sign(d[0]) || 1;
  const at = (s: number): V3 => add(add(base, scale(d, s)), [side * (o.lean ?? 0.05) * Math.sin(Math.PI * s), 0, 0]);
  const prof = (s: number) => Math.pow(Math.sin(Math.PI * (0.2 + 0.72 * s)), 0.55);
  const sec = (hw: number, ht: number) =>
    Array.from({ length: K }, (_, k) => {
      const a = (k / K) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      return [Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e) * hw, Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e) * ht] as [number, number];
    });
  c.sweep(Array.from({ length: N + 1 }, (_, i) => at(i / N)), (i) => sec(o.w * prof(i / N) + 0.01, o.t * (0.75 + 0.25 * prof(i / N))), { paint: o.paint, bone: o.bone, ref: [1, 0, 0] });
  // The panel: the same blade, narrower and shorter, standing a little proud of the front.
  const M = 5;
  c.sweep(Array.from({ length: M + 1 }, (_, i) => add(at(0.13 + 0.74 * (i / M)), [0, -o.t * 0.72, 0])), (i) => sec(o.w * 0.56 * Math.pow(Math.sin(Math.PI * (0.12 + 0.8 * (i / M))), 0.6) + 0.008, o.t * 0.45), { paint: o.inner, bone: o.bone, ref: [1, 0, 0] });
}
