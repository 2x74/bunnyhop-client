// Pieces several living hilts share.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { sring, type LiveKit } from "../kit";

/** The lanyard ring under a pommel whose lowest point is `z` (the charm's anchor is its centre; returned). */
export function lanyard(kit: LiveKit, a: HiltAnchors, z: number, color: number, mat: number): V3 {
  const r = 0.17;
  const c: V3 = [0, a.butt.cy, z - r + 0.04];
  const ring: V3[] = [];
  for (let k = 0; k <= 18; k++) {
    const t = (k / 18) * Math.PI * 2;
    ring.push([0, c[1] + Math.cos(t) * r, c[2] + Math.sin(t) * r]);
  }
  kit.tube(ring, 0.045, 8, [1, 0, 0], { color, mat, bone: a.buttBone, capStart: false, capEnd: false });
  kit.anchors.pommel = c;
  return c;
}

/**
 * A cap over the knife's butt: rows from its bottom (a rounded end) up to where it meets the grip, `H` tall, as wide as
 * the grip plus a margin; `sides` 0 = round, else faceted with that many sides. Returns its bottom z.
 */
export function pommelCap(kit: LiveKit, a: HiltAnchors, o: { H: number; color: number; mat: number; sides?: number; e?: number; uvw?: (p: V3, f: number) => V3; piece?: number }): number {
  const zb = a.butt.z, cy = a.butt.cy;
  const ry = Math.max(0.42, a.grip.hy + 0.1), rx = Math.max(0.3, a.grip.hx + 0.07);
  const seg = o.sides || 24, N = 10;
  const rows: V3[][] = [];
  const fs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    let r = Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, f / 0.5)) ** 2));
    r *= 1 - 0.25 * Math.max(0, (f - 0.6) / 0.4);
    rows.push(sring([0, cy, zb - o.H + 0.05 + o.H * f], [1, 0, 0], [0, 1, 0], rx * Math.max(r, 0.03), ry * Math.max(r, 0.03), seg, o.e ?? 2, o.sides ? Math.PI / seg : 0));
    fs.push(f);
  }
  kit.surface(rows, { color: o.color, mat: o.mat, bone: a.buttBone, capEnd: true, flat: !!o.sides, piece: o.piece, uvw: o.uvw ? (i, k) => o.uvw!(rows[i][k % seg], fs[i]) : undefined });
  return zb - o.H + 0.05;
}
