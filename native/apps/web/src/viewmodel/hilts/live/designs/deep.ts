// DEEPWATER (hilt-deep, Supporter, v0.0.43): a deep-sea hilt. The guard is a pair of dark teal fins (scaled, edged
// paler, a row of light spots along each, live/material.ts SCALES); from the spine side of the blade's root a thin
// stalk curls up and over with a glowing lure bulb at its end, as an anglerfish carries one. Navy leather grip (the
// skin), a pearly pommel.
//
// Motion (play only): the lure hangs on a spring and lags behind your turns and strafes, dips and bobs on a landing; its
// light breathes slowly. The fin spots light in a slow wave that travels along them, quicker with speed.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, kick, spring, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";
import { lanyard, pommelCap } from "./common";

const FIN = 0x1c4a58;
const STALK = 0x24343c;
const LURE: [number, number, number] = [0.45, 1.0, 0.8];

function lureOf(a: HiltAnchors) {
  const zg = a.top.hx > 0.6 ? a.top.z + 0.1 : a.top.z - 0.05;
  // The stalk rises from the spine (the blade's -y side), arches out and over.
  const base: V3 = [0, a.blade.y0 - 0.08, zg + 0.15];
  return { zg, base, bulb: [0, a.blade.y0 - 0.55, zg + 1.25] as V3 };
}

function fin(kit: LiveKit, a: HiltAnchors, side: number, zg: number): void {
  // A fan from the blade's root out sideways and a little down: rows outward (u 0..1), points across the fan.
  const R = 9, K = 9;
  const y0 = side > 0 ? a.blade.y1 : a.blade.y0;
  const span = Math.max(0.85, a.top.hy - Math.abs(y0) + 0.35);
  const rows: V3[][] = [];
  for (let i = 0; i <= R; i++) {
    const u = i / R;
    const row: V3[] = [];
    for (let k = 0; k <= K; k++) {
      const v = -1 + (2 * k) / K;
      // Fan: wide at mid-length, rays curving back; thin, a slight ripple through its thickness.
      const w = 0.32 * Math.sin(Math.PI * Math.min(1, u * 0.85 + 0.15)) + 0.05;
      row.push([0.04 * Math.sin(v * 3 + u * 4) * u, y0 + side * span * u, zg + v * w - 0.18 * u * u]);
    }
    rows.push(row);
  }
  kit.surface(rows, { color: FIN, mat: MAT.scales, closed: false, uvw: (i, k) => [i / R, -1 + (2 * k) / K, 0] });
}

export const deep: LiveDesign = {
  id: "hilt-deep",
  build(kit, a) {
    const L = lureOf(a);
    // A collar where the fins meet, round the blade's root.
    const cr: V3[][] = [];
    const bx = Math.max(0.18, a.blade.hx + 0.08), by = Math.max(0.28, (a.blade.y1 - a.blade.y0) / 2 + 0.06), cy = (a.blade.y0 + a.blade.y1) / 2;
    for (let i = 0; i <= 4; i++) cr.push(sring([0, cy, L.zg - 0.12 + 0.1 * i], [1, 0, 0], [0, 1, 0], bx * (1 - 0.06 * i), by * (1 - 0.06 * i), 20));
    kit.surface(cr, { color: FIN, mat: MAT.scales, capStart: true, capEnd: true, uvw: (i, k) => [k / 20, 0, 0] });
    fin(kit, a, 1, L.zg);
    fin(kit, a, -1, L.zg);
    // The lure (piece 1, swung about its base): stalk + bulb, the bulb self-lit (channel 1) with its halo.
    const path: V3[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      path.push([0.05 * Math.sin(t * 3), L.base[1] + (L.bulb[1] - L.base[1]) * Math.sin(t * Math.PI * 0.5) ** 1.5, L.base[2] + (L.bulb[2] + 0.18 - L.base[2]) * Math.sin(t * Math.PI * 0.62) / Math.sin(Math.PI * 0.62)]);
    }
    kit.tube(path, (i) => 0.045 * (1 - (i / 14) * 0.55), 8, [1, 0, 0], { color: STALK, mat: MAT.glossy, piece: 1 });
    kit.ellipsoid(L.bulb, [0.14, 0.14, 0.17], [0, 0, 1], [1, 0, 0], 16, 10, { color: 0xbfffe8, mat: MAT.emit, piece: 1 });
    kit.sprite(L.bulb, { color: 0x58ffc8, size: 0.62, channel: 1 });
    kit.sprite(L.bulb, { color: 0xe8fff4, size: 0.14, channel: 1, gain: 1.5 });
    const bottom = pommelCap(kit, a, { H: 0.45, color: 0x9fd8d0, mat: MAT.glossy });
    lanyard(kit, a, bottom, STALK, MAT.glossy);
  },
  animate(s, c, dt) {
    const m = c.mem;
    const L = lureOf(c.a);
    // Spring targets: lean against the turn (about the knife's z), back with speed changes, down on a landing.
    if (!s.still && (m.lands ?? 0) !== s.lands) {
      m.lands = s.lands;
      kick(m, "pitch", -2.2 * s.landHard - 0.6);
    }
    const yawT = s.still ? 0 : -0.5 * Math.tanh(s.turn / 300);
    const pitchT = s.still ? 0 : 0.18 * s.speed01;
    const yaw = s.still ? 0 : spring(m, "yaw", yawT, 1.4, 0.22, dt);
    const pitch = s.still ? 0 : spring(m, "pitch", pitchT, 1.7, 0.2, dt);
    // Swing about the stalk's base: pitch about the knife's x (over the blade and back), then yaw about its z.
    c.piece2(1, L.base, [1, 0, 0], pitch, [0, 0, 1], yaw);
    const breath = 0.5 + 0.5 * Math.sin((s.t * Math.PI * 2) / 3.2);
    m.glow = s.still ? 0.7 : approach(m.glow ?? 0.6, 0.55 + 0.3 * breath + 0.25 * s.speed01, 5, dt);
    c.chan(1, LURE, m.glow);
    m.wave = (m.wave ?? 0) + dt * (s.still ? 0 : 1.1 + 3 * s.speed01);
    c.live(0, m.wave, s.still ? 0.9 : 0.8 + 0.4 * s.speed01, 6, 0);
    c.chan(0, LURE, 1);
  },
};
