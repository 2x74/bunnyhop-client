// BLOOM (hilt-bloom, Supporter, v0.0.43): a living vine. A green stem winds up round the top of the grip and over the
// guard, with two leaves at the guard's sides, and a coral flower of five petals cupped round the blade's root, its
// heart faintly lit. Green cord grip (the skin), a seed-pod pommel.
//
// Motion (play only): the leaves hang on springs and sway with your turns and shake on a landing; the flower opens as
// you pick up speed and closes when you stop; an inspect opens it all the way. Petals are one morph (closed to open).

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, kick, spring, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";
import { lanyard, pommelCap } from "./common";

const STEM = 0x3f8f3a;
const LEAF = 0x4fb043;
const PETAL = 0xff5a72;
const PETALS = 5;

function flowerOf(a: HiltAnchors) {
  const zf = (a.top.hx > 0.6 ? a.top.z + 0.05 : a.top.z - 0.05) + 0.1;
  const cy = (a.blade.y0 + a.blade.y1) / 2;
  // The cup's radius round the blade's root.
  const r0 = Math.max(0.22, Math.max(a.blade.hx, (a.blade.y1 - a.blade.y0) / 2) * 0.9 + 0.08);
  return { zf, cy, r0 };
}

/** One petal: rows from base to tip; `open` 0 hugging the blade, 1 spread out and down. */
function petalRows(F: ReturnType<typeof flowerOf>, ang: number, open: number, aspect: number): V3[][] {
  const N = 8, K = 7, L = 1.15 + F.r0 * 0.6, W = 0.42 + F.r0 * 0.3;
  const out: V3 = [Math.cos(ang), Math.sin(ang) * aspect, 0];
  const side: V3 = [-Math.sin(ang), Math.cos(ang) * aspect, 0];
  const rows: V3[][] = [];
  // Lean from the blade's axis: closed ~12 deg, open ~95 deg (past level).
  const lean = 0.2 + 1.45 * open;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    // Curl: the tip turns outward more as it opens.
    const a = lean * (0.6 + 0.6 * u);
    const d = u * L;
    const cx = F.r0 + Math.sin(a) * d * 0.95, cz = Math.cos(a) * d;
    const w = W * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95)) * (1 - 0.15 * u);
    const row: V3[] = [];
    for (let k = 0; k <= K; k++) {
      const v = -1 + (2 * k) / K;
      const cup = 0.12 * w * (1 - v * v) * 3;
      row.push([out[0] * (cx - cup * Math.cos(a)) + side[0] * v * w, F.cy + out[1] * (cx - cup * Math.cos(a)) + side[1] * v * w, F.zf + cz + cup * Math.sin(a)]);
    }
    rows.push(row);
  }
  return rows;
}

function leafRows(base: V3, dir: number, len: number): V3[][] {
  const N = 8, K = 6, rows: V3[][] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const w = 0.28 * Math.sin(Math.PI * Math.min(1, u * 1.05)) * (1 - 0.2 * u);
    const row: V3[] = [];
    for (let k = 0; k <= K; k++) {
      const v = -1 + (2 * k) / K;
      row.push([0.06 * (1 - v * v) - 0.05 * u, base[1] + dir * u * len, base[2] - 0.25 * u * u + v * w]);
    }
    rows.push(row);
  }
  return rows;
}

export const bloom: LiveDesign = {
  id: "hilt-bloom",
  build(kit, a) {
    const F = flowerOf(a);
    // The vine: a stem spiralling up the grip's top three turns, ending under the flower.
    const z0 = a.grip.z1 - 1.2, z1 = F.zf;
    const rx = Math.max(0.3, a.grip.hx + 0.06), ry = Math.max(0.36, a.grip.hy + 0.06);
    const path: V3[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48, th = t * Math.PI * 2 * 2.2;
      path.push([Math.cos(th) * rx, a.grip.cy + Math.sin(th) * ry, z0 + (z1 - z0) * t]);
    }
    kit.tube(path, 0.055, 7, [0, 0, 1], { color: STEM, mat: MAT.leaf, uvw: (i) => [i / 48, 0, 0] });
    // The cup the petals grow from.
    const cup: V3[][] = [];
    for (let i = 0; i <= 3; i++) cup.push(sring([0, F.cy, F.zf - 0.14 + 0.06 * i], [1, 0, 0], [0, 1, 0], F.r0 * (1 + 0.15 * i), F.r0 * (1 + 0.15 * i), 18));
    kit.surface(cup, { color: STEM, mat: MAT.leaf, capStart: true, uvw: (i, k) => [i / 3, -1 + (2 * k) / 18, 0] });
    // Petals (piece 3, one morph from shut to open).
    const aspect = 1.0;
    for (let p = 0; p < PETALS; p++) {
      const ang = (p / PETALS) * Math.PI * 2 + 0.3;
      const shut = petalRows(F, ang, 0, aspect), open = petalRows(F, ang, 1, aspect);
      kit.surface(shut, { color: PETAL, mat: MAT.petal, piece: 3, closed: false, morph: open, uvw: (i, k) => [i / 8, -1 + (2 * k) / 7, 0] });
    }
    // The heart: a few pollen beads, faintly lit (channel 4).
    for (let p = 0; p < 6; p++) {
      const t = (p / 6) * Math.PI * 2;
      kit.ellipsoid([Math.cos(t) * F.r0 * 0.8, F.cy + Math.sin(t) * F.r0 * 0.8, F.zf + 0.06], [0.05, 0.05, 0.05], [0, 0, 1], [1, 0, 0], 8, 5, { color: 0xffd25a, mat: MAT.emit, piece: 4 });
    }
    kit.sprite([0, F.cy, F.zf + 0.1], { color: 0xffb060, size: 0.5, channel: 4 });
    // Leaves (pieces 1, 2) at the guard's sides.
    const ly = Math.max(0.35, a.grip.hy + 0.05);
    kit.surface(leafRows([0, a.grip.cy + ly, F.zf - 0.2], 1, 1.0), { color: LEAF, mat: MAT.leaf, piece: 1, closed: false, uvw: (i, k) => [i / 8, -1 + (2 * k) / 6, 0] });
    kit.surface(leafRows([0, a.grip.cy - ly, F.zf - 0.3], -1, 0.85), { color: LEAF, mat: MAT.leaf, piece: 2, closed: false, uvw: (i, k) => [i / 8, -1 + (2 * k) / 6, 0] });
    const bottom = pommelCap(kit, a, { H: 0.5, color: 0x7a5a2a, mat: MAT.glossy, sides: 0, e: 2 });
    lanyard(kit, a, bottom, STEM, MAT.leaf);
  },
  animate(s, c, dt) {
    const m = c.mem;
    const F = flowerOf(c.a);
    const target = s.still ? 0.5 : Math.min(1, 0.12 + 0.95 * s.speed01 + s.inspect);
    m.open = s.still ? target : approach(m.open ?? 0.12, target, target > (m.open ?? 0) ? 2.2 : 1.1, dt);
    c.morph(3, m.open);
    if (!s.still && (m.lands ?? 0) !== s.lands) {
      m.lands = s.lands;
      kick(m, "l1", -3 * s.landHard - 1);
      kick(m, "l2", 3 * s.landHard + 1);
    }
    const sway = s.still ? 0 : 0.35 * Math.tanh(s.turn / 300);
    const l1 = s.still ? 0 : spring(m, "l1", sway + 0.05 * Math.sin(s.t * 1.3), 1.8, 0.25, dt);
    const l2 = s.still ? 0 : spring(m, "l2", -sway + 0.05 * Math.sin(s.t * 1.1 + 1), 1.6, 0.25, dt);
    const ly = Math.max(0.35, c.a.grip.hy + 0.05);
    c.piece(1, [0, c.a.grip.cy + ly, F.zf - 0.2], [1, 0, 0], l1);
    c.piece(2, [0, c.a.grip.cy - ly, F.zf - 0.3], [1, 0, 0], l2);
    c.chan(4, [1, 0.75, 0.4], 0.12 + 0.35 * m.open);
    c.chan(3, [1, 0.75, 0.4], 0.2 + 0.6 * m.open);
  },
};
