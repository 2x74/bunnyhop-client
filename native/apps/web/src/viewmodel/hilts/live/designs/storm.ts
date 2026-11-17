// STORMFORK (hilt-storm, Supporter, v0.0.43): two dark iron prongs rise from a squat guard on either side of the blade,
// banded in copper, each tipped with a small charged bead; from each tip a thin arc of violet-white light reaches across
// to the blade's edge. Slate rubber grip (the skin), iron pommel.
//
// The arcs never blink: each is a chain of soft points that crawls (its bend wanders on smooth noise of the clock), always
// faintly there. Speed brightens and quickens it; a landing sends a brighter, wider discharge that fades over about a
// third of a second. All closed-form in the clock and the landing's time.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";
import { lanyard, pommelCap } from "./common";

const IRON = 0x34373e;
const COPPER = 0xc8754a;
const ARC: [number, number, number] = [0.72, 0.6, 1.0];
/** Points per arc (pieces / channels 2..6 and 7..11). */
const DOTS = 5;

function forkOf(a: HiltAnchors) {
  const onTop = a.top.hx > 0.6;
  const zg = onTop ? a.top.z + 0.12 : a.top.z - 0.02;
  const y1 = a.blade.y1 + 0.62, y0 = a.blade.y0 - 0.62;
  const H = 1.6;
  return { zg, y0, y1, H, tip: (side: number): V3 => [0, side > 0 ? y1 - 0.12 : y0 + 0.12, zg + H], edge: (side: number): V3 => [0, side > 0 ? a.blade.y1 : a.blade.y0, zg + H * 0.62] };
}

/** Smooth noise of one variable (sum of sines with incommensurate rates). */
const wobble = (t: number, k: number) => Math.sin(t * 1.7 + k * 2.1) * 0.55 + Math.sin(t * 2.9 + k * 4.3) * 0.3 + Math.sin(t * 5.3 + k * 1.3) * 0.15;

export const storm: LiveDesign = {
  id: "hilt-storm",
  build(kit, a) {
    const f = forkOf(a);
    // Guard: a squat iron bar spanning both prongs.
    const N = 16, rows: V3[][] = [];
    const hx = Math.min(0.7, Math.max(0.22, Math.max(a.top.hx, a.blade.hx) + 0.08));
    for (let i = 0; i <= N; i++) {
      const y = f.y0 - 0.1 + ((f.y1 - f.y0 + 0.2) * i) / N;
      rows.push(sring([0, y, f.zg], [1, 0, 0], [0, 0, 1], hx, 0.2, 16, 3));
    }
    kit.surface(rows, { color: IRON, mat: MAT.iron, capStart: true, capEnd: true, uvw: (i, k) => [rows[i][k % 16][1], rows[i][k % 16][2], 0] });
    for (const side of [1, -1]) {
      const base: V3 = [0, side > 0 ? f.y1 : f.y0, f.zg + 0.1];
      const tip = f.tip(side);
      const path: V3[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        // Up, bowing outward, then curling in toward the blade at the top.
        path.push([0, base[1] + (tip[1] - base[1]) * t * t + side * 0.18 * Math.sin(t * Math.PI), base[2] + (tip[2] - base[2]) * t]);
      }
      kit.tube(path, (i) => 0.13 * (1 - (i / 12) * 0.6), 10, [1, 0, 0], { color: (i) => (i === 3 || i === 7 ? COPPER : IRON), mat: MAT.satin });
      // Copper bands as their own rings.
      for (const bi of [3, 7]) {
        const p = path[bi], q = path[bi + 1];
        const d: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const l = Math.hypot(d[0], d[1], d[2]);
        const ring: V3[] = [];
        for (let k = 0; k <= 3; k++) ring.push([p[0] + (d[0] / l) * k * 0.05, p[1] + (d[1] / l) * k * 0.05, p[2] + (d[2] / l) * k * 0.05]);
        kit.tube(ring, 0.13 * (1 - (bi / 12) * 0.6) + 0.025, 12, [1, 0, 0], { color: COPPER, mat: MAT.polished });
      }
      // The charged bead (channel 1) with its own light.
      kit.ellipsoid(tip, [0.11, 0.11, 0.11], [0, 0, 1], [1, 0, 0], 12, 8, { color: 0xb8a8ff, mat: MAT.emit, piece: 1 });
      kit.sprite(tip, { color: 0x9a7cff, size: 0.32, channel: 1 });
      // The arc's points (moved per frame).
      for (let j = 0; j < DOTS; j++) {
        const ch = (side > 0 ? 2 : 7) + j;
        kit.sprite([0, 0, 0], { color: 0xffffff, size: 0.09, channel: ch, gain: 1.5 });
        kit.sprite([0, 0, 0], { color: 0x8a6cff, size: 0.22, channel: ch });
      }
    }
    const bottom = pommelCap(kit, a, { H: 0.42, color: IRON, mat: MAT.iron, e: 3 });
    lanyard(kit, a, bottom, COPPER, MAT.polished);
  },
  animate(s, c, dt) {
    const m = c.mem;
    const f = forkOf(c.a);
    const dis = s.still ? 0 : s.landHard * Math.max(0, 1 - s.sinceLand / 0.35) * (s.lands > 0 ? 1 : 0);
    const level = s.still ? 0.45 : approach(m.lv ?? 0.3, 0.28 + 0.5 * s.speed01, 4, dt);
    m.lv = level;
    // The arc's own clock runs faster with speed (integrated, so it never jumps).
    m.ph = (m.ph ?? 0) + dt * (s.still ? 0 : 1 + 2.2 * s.speed01 + 4 * dis);
    c.chan(1, ARC, 0.35 + 0.5 * level + 0.8 * dis);
    for (const side of [1, -1]) {
      const a0 = f.tip(side), a1 = f.edge(side);
      for (let j = 0; j < DOTS; j++) {
        const t = (j + 0.5) / DOTS;
        const k = side * 10 + j;
        // The bend: zero at both ends, wandering in x (toward / away from the viewer) and along the arc's normal.
        const env = Math.sin(t * Math.PI);
        const amp = (0.09 + 0.14 * dis) * env;
        const p: V3 = [
          a0[0] + (a1[0] - a0[0]) * t + wobble(m.ph, k) * amp * 1.4,
          a0[1] + (a1[1] - a0[1]) * t + wobble(m.ph * 1.3, k + 5) * amp * 0.6,
          a0[2] + (a1[2] - a0[2]) * t + wobble(m.ph * 0.9, k + 9) * amp + 0.12 * env,
        ];
        const ch = (side > 0 ? 2 : 7) + j;
        c.piece(ch, [0, 0, 0], [0, 0, 1], 0, 1, p);
        // Brightness flows along the arc slowly, so it reads as current rather than a still line.
        const flow = 0.75 + 0.25 * Math.sin(m.ph * 3 - j * 1.2 + side);
        c.chan(ch, ARC, (0.22 + 0.6 * level + 1.2 * dis) * flow);
      }
    }
  },
};
