// FROSTRUNE (hilt-frostrune, Supporter, v0.0.43): a heavy worn-iron Norse guard with five Elder Futhark letters cut
// through its faces, lit from inside in frost blue. The inscription is ᚺᛚᚨᚢᛈ, "hlaup" (Old Norse: a leap, a run):
// hagalaz, laguz, ansuz, uruz, perthro (live/material.ts runeD draws them). The iron pommel carries one more, ᚱ raidho
// (the ride, the journey), over a lanyard ring. The grip is braided dark leather (the skin).
//
// Motion (play only): at rest the letters keep a faint light that breathes. Each clean hop in a row wakes the next
// letter; with all five awake a frost-white flare runs along the word once, and the word stays lit while the chain
// lasts. Standing on the ground for a moment lets the letters go back to sleep one by one, last first. Speed lifts
// the whole glow; a hard landing brightens it for a moment.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";

const IRON = 0x5a5e66;
const FROST: [number, number, number] = [0.32, 0.7, 1.0];
const LETTERS = 5;
/** Letter region across the guard's face (fraction of its length). */
const MARGIN = 0.09;

interface Bar {
  zc: number;
  hy: number;
  hx: number;
  hz: number;
}
export function frostBar(a: HiltAnchors): Bar {
  const hy = Math.min(1.45, Math.max(1.12, a.top.hy + 0.16));
  const hx = Math.min(0.75, Math.max(0.24, Math.max(a.top.hx, a.blade.hx) + 0.12));
  const hz = 0.36;
  // A big round guard (a tsuba, a ring) keeps its place: the bar sits on top of it; otherwise the bar replaces it.
  const onTop = a.top.hx > 0.6;
  return { zc: onTop ? a.top.z + hz - 0.04 : a.top.z - 0.02, hy, hx, hz };
}
/** Letter cell centre (y) of letter i on the +x face (the -x face reads the other way). */
const cellY = (b: Bar, i: number, side: number) => side * (-b.hy + 2 * b.hy * (MARGIN + ((1 - 2 * MARGIN) * (i + 0.5)) / LETTERS));

function buildBar(kit: LiveKit, b: Bar): void {
  const N = 30, seg = 28;
  const rows: V3[][] = [];
  const ys: number[] = [];
  for (let i = 0; i <= N; i++) {
    const y = -b.hy + (2 * b.hy * i) / N;
    const end = Math.max(0, (Math.abs(y) / b.hy - 0.72) / 0.28);
    const flare = end * end * (3 - 2 * end);
    // Flared, slightly drooping ends, and a little swell at the middle where the blade leaves it.
    const mid = Math.exp(-((y / (b.hy * 0.28)) ** 2));
    const rz = b.hz * (1 + 0.28 * flare + 0.08 * mid), rx = b.hx * (1 + 0.12 * flare);
    rows.push(sring([0, y, b.zc - 0.06 * flare], [1, 0, 0], [0, 0, 1], rx, rz, seg, 4.5));
    ys.push(y);
  }
  kit.surface(rows, {
    color: IRON,
    mat: MAT.runes,
    capStart: true,
    capEnd: true,
    uvw: (i, k) => {
      const p = rows[i][k % seg];
      const y = ys[i];
      const t = (y + b.hy) / (2 * b.hy);
      const side = Math.abs(p[0]) > b.hx * 0.7 ? Math.sign(p[0]) : 0;
      const tt = side < 0 ? 1 - t : t;
      const cell = ((tt - MARGIN) / (1 - 2 * MARGIN)) * LETTERS;
      const v = (p[2] - b.zc) / (2 * b.hz * 0.8) + 0.5;
      return [side && cell >= 0 && cell <= LETTERS ? cell : -1, v, side];
    },
  });
}

function buildPommel(kit: LiveKit, a: HiltAnchors): V3 {
  const zb = a.butt.z, cy = a.butt.cy;
  const ry = Math.max(0.5, a.grip.hy + 0.1), rx = Math.max(0.3, a.grip.hx + 0.06);
  const N = 14, seg = 26, H = 0.62;
  const rows: V3[][] = [];
  const fs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    let r = Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, f / 0.62)) ** 2));
    r *= 1 - 0.42 * Math.max(0, (f - 0.62) / 0.38) ** 1.5;
    r = Math.max(r, 0.02);
    rows.push(sring([0, cy, zb - H + 0.04 + H * f], [1, 0, 0], [0, 1, 0], rx * r, ry * r, seg, 2.6));
    fs.push(f);
  }
  kit.surface(rows, {
    color: IRON,
    mat: MAT.runes,
    bone: a.buttBone,
    capEnd: true,
    uvw: (i, k) => {
      const p = rows[i][k % seg];
      const side = Math.abs(p[0]) > rx * 0.55 ? Math.sign(p[0]) : 0;
      const u = (p[1] - cy) / (ry * 1.1) + 0.5;
      return [side ? 5 + (side > 0 ? u : 1 - u) : -1, (fs[i] - 0.12) / 0.62, side];
    },
  });
  // The lanyard ring.
  const rc: V3 = [0, cy, zb - H - 0.12];
  const ring: V3[] = [];
  for (let k = 0; k <= 18; k++) {
    const t = (k / 18) * Math.PI * 2;
    ring.push([0, cy + Math.cos(t) * 0.17, rc[2] + Math.sin(t) * 0.17]);
  }
  kit.tube(ring, 0.05, 8, [1, 0, 0], { color: IRON, mat: MAT.iron, bone: a.buttBone, capStart: false, capEnd: false });
  kit.anchors.pommel = rc;
  return [0, cy, zb - H + 0.3];
}

export const frostrune: LiveDesign = {
  id: "hilt-frostrune",
  build(kit, a) {
    const b = frostBar(a);
    buildBar(kit, b);
    // A soft light over each letter on both faces (channels 1..5), and the pommel's (channel 6).
    for (const side of [1, -1])
      for (let i = 0; i < LETTERS; i++) kit.sprite([side * (b.hx + 0.04), cellY(b, i, side), b.zc], { color: 0x5cb8ff, size: 0.42, channel: 1 + i });
    const pc = buildPommel(kit, a);
    for (const side of [1, -1]) kit.sprite([side * (Math.max(0.3, a.grip.hx + 0.06) + 0.04), pc[1], pc[2]], { color: 0x5cb8ff, size: 0.3, channel: 6, bone: a.buttBone });
  },
  animate(s, c, dt) {
    const m = c.mem;
    const breath = 0.5 + 0.5 * Math.sin((s.t * Math.PI * 2) / 5.5);
    const rest = 0.1 + 0.05 * breath;
    const boost = 0.22 * s.speed01 + 0.25 * s.landHard * Math.max(0, 1 - s.sinceLand / 0.4);
    // The flare: once each time the chain reaches the whole word.
    if (s.chain >= LETTERS && (m.flareChainT ?? -1) !== s.chainT && s.chain === LETTERS) {
      m.flareChainT = s.chainT;
      m.flareT = s.t;
    }
    const fe = s.t - (m.flareT ?? -1e9);
    const lv: number[] = [];
    for (let i = 0; i <= LETTERS; i++) {
      let target: number;
      if (s.still) target = 0.5;
      else if (i < LETTERS) {
        const awake = s.chain >= i + 1;
        // Going back to sleep: last letter first, one every 0.12 s after the chain ended.
        const hold = !awake && s.chain === 0 && s.t - s.chainT < (LETTERS - 1 - i) * 0.12 && (m["l" + i] ?? 0) > 0.5;
        target = awake || hold ? 0.78 : rest;
        target = Math.min(1, target + boost);
        target += 0.9 * Math.exp(-(((fe - i * 0.07) / 0.09) ** 2));
      } else target = Math.min(1, 0.22 + 0.15 * breath + 0.5 * Math.min(1, s.chain / LETTERS) + boost);
      const cur = m["l" + i] ?? rest;
      const v = s.still ? target : approach(cur, target, target > cur ? 16 : 3.2, dt);
      m["l" + i] = v;
      lv.push(v);
    }
    c.live(2, lv[0], lv[1], lv[2], lv[3]);
    c.live(3, lv[4], lv[5], 0, LETTERS);
    c.chan(0, FROST, 1);
    for (let i = 0; i <= LETTERS; i++) c.chan(1 + i, FROST, 0.04 + 0.62 * Math.min(1.5, lv[i]));
  },
};
