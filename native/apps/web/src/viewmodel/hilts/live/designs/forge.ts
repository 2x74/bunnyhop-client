// FORGE (hilt-ember, Supporter, v0.0.43): a hammered, blackened steel guard and collar split by cracks of banked heat
// (live/material.ts CRACKS), a faceted pommel cracked the same way, a charcoal leather grip (the skin).
//
// Motion (play only): the heat breathes on a slow 4 s cycle between dull red and orange; speed heats it toward yellow;
// a landing flashes it a little brighter and throws a few sparks up off the guard that rise, slow and fade; at rest a
// lone ember drifts up now and then. Sparks are positions in closed form from the landing's time (no stepping), so any
// frame rate shows the same spark at the same moment.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";
import { hash1, schedule } from "../state";
import { lanyard, pommelCap } from "./common";

const STEEL = 0x2e2a28;
const SPARKS = 10;
const BURST = 7;
const EMBER: [number, number, number] = [1.0, 0.45, 0.1];

function guardOf(a: HiltAnchors) {
  const hy = Math.min(1.3, Math.max(0.95, a.top.hy + 0.12));
  const hx = Math.min(0.72, Math.max(0.24, Math.max(a.top.hx, a.blade.hx) + 0.1));
  const onTop = a.top.hx > 0.6;
  return { zc: onTop ? a.top.z + 0.2 : a.top.z - 0.04, hy, hx, hz: 0.26 };
}
const sparkFrom = (a: HiltAnchors): V3 => {
  const g = guardOf(a);
  return [0, 0, g.zc + g.hz + 0.05];
};

export const forge: LiveDesign = {
  id: "hilt-ember",
  build(kit, a) {
    const g = guardOf(a);
    // The guard: an eight-sided hammered bar, thickest at the middle, its ends drawn out and turned up a little.
    const N = 20, rows: V3[][] = [];
    for (let i = 0; i <= N; i++) {
      const t = -1 + (2 * i) / N, y = t * g.hy;
      const w = 1 - 0.45 * Math.abs(t) ** 2;
      rows.push(sring([0, y, g.zc + 0.1 * t * t], [1, 0, 0], [0, 0, 1], g.hx * (0.75 + 0.25 * w), g.hz * w, 8, 2, Math.PI / 8));
    }
    kit.surface(rows, { color: STEEL, mat: MAT.cracks, flat: true, capStart: true, capEnd: true, uvw: (i, k) => rows[i][k % 8] });
    // The collar round the blade's root, above the guard.
    const cr: V3[][] = [];
    const bx = Math.max(0.2, a.blade.hx + 0.1), by = Math.max(0.3, a.blade.hy * 0.85 + 0.1);
    for (let i = 0; i <= 5; i++) {
      const f = i / 5, z = g.zc + g.hz * 0.7 + 0.45 * f;
      const s = 1 - 0.2 * f + 0.08 * Math.sin(f * Math.PI);
      cr.push(sring([0, (a.blade.y0 + a.blade.y1) / 2, z], [1, 0, 0], [0, 1, 0], bx * s, by * s, 8, 2, Math.PI / 8));
    }
    kit.surface(cr, { color: STEEL, mat: MAT.cracks, flat: true, capStart: true, capEnd: true, uvw: (i, k) => cr[i][k % 8] });
    const bottom = pommelCap(kit, a, { H: 0.5, color: STEEL, mat: MAT.cracks, sides: 8, uvw: (p) => p });
    lanyard(kit, a, bottom, STEEL, MAT.iron);
    // The heat's glow over the guard (channel 1) and the sparks (pieces / channels 2..11), each a hot core in a halo.
    kit.sprite([0, 0, g.zc], { color: 0xff6a1a, size: g.hy * 1.25, channel: 1 });
    const p0 = sparkFrom(a);
    for (let i = 0; i < SPARKS; i++) {
      kit.sprite(p0, { color: 0xffd08a, size: 0.05, channel: 2 + i, gain: 2.2 });
      kit.sprite(p0, { color: 0xff6a1a, size: 0.16, channel: 2 + i });
    }
  },
  animate(s, c, dt) {
    const m = c.mem;
    const breath = 0.5 + 0.5 * Math.sin((s.t * Math.PI * 2) / 4);
    const flash = s.landHard * Math.max(0, 1 - s.sinceLand / 0.6);
    const target = s.still ? 0.55 : 0.3 + 0.22 * breath + 0.55 * s.speed01 + 0.3 * flash;
    m.heat = s.still ? target : approach(m.heat ?? target, target, 3, dt);
    c.live(0, m.heat, s.still ? 0 : s.t * 0.15, 0, 0);
    c.chan(1, EMBER, 0.05 + 0.13 * m.heat);
    // Sparks: a burst on each landing (the first BURST), lone embers on a 2..4 s schedule (the rest).
    for (let i = 0; i < SPARKS; i++) {
      let age = -1, seed = 0, life = 0.9;
      if (s.still) age = -1;
      else if (i < BURST) {
        age = s.sinceLand;
        seed = s.lands * 31 + i;
        life = 0.55 + 0.45 * hash1(seed * 3 + 1);
      } else {
        const sc = schedule(s.t + i * 0.77, 2, 4, 50 + i);
        age = s.t + i * 0.77 - sc.at;
        seed = sc.i * 17 + i * 101;
        life = 1.6;
      }
      if (age < 0 || age > life || (i < BURST && s.lands === 0)) {
        c.chan(2 + i, EMBER, 0);
        continue;
      }
      const h = (k: number) => hash1(seed * 7 + k) - 0.5;
      const burst = i < BURST;
      const v: V3 = burst ? [h(1) * 1.6, h(2) * 2.2, 1.2 + (h(3) + 0.5) * 1.8] : [h(1) * 0.3, h(2) * 0.5, 0.45 + (h(3) + 0.5) * 0.3];
      // Rising embers slow down (drag), drift a little.
      const k = 2.2, e = (1 - Math.exp(-k * age)) / k;
      const p: V3 = [v[0] * e, v[1] * e + 0.08 * Math.sin(age * 5 + seed), v[2] * e + (burst ? -0.25 * age * age : 0.05 * age)];
      c.piece(2 + i, [0, 0, 0], [0, 0, 1], 0, 1, p);
      const f = age / life;
      c.chan(2 + i, [1, 0.55 + 0.35 * (1 - f), 0.2], (burst ? 1.0 : 0.6) * (1 - f) * (1 - f) * Math.min(1, age / 0.04));
    }
  },
};
