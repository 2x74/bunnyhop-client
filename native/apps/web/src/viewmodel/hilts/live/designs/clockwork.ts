// ESCAPEMENT (hilt-clockwork, Supporter, v0.0.43): an open brass watch movement as the guard. A round brass case sits
// at the blade's root with both faces open; on each, a balance wheel (rim, three spokes, a ruby at its hub) swings
// back and forth, an escape wheel with fifteen teeth steps round one tooth per swing, a small gear turns with it. Steel
// screws, rubies, a walnut grip (the skin).
//
// Motion (play only): the balance swings about once a second; speed winds it up to about three; a landing knocks it into
// a wider swing that settles; an inspect winds it. The escape wheel steps on each swing's turn, with a short ease.
// The phase is integrated from dt, so it never jumps; at rest it is the same at any frame rate.

import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, type LiveDesign } from "../design";
import { MAT, sring, type LiveKit } from "../kit";
import { lanyard, pommelCap } from "./common";

const BRASS = 0xd9a54a;
const BRASS_DARK = 0x9c7230;
const STEEL = 0x5a6a8c;
const RUBY = 0xc0123a;
const TEETH = 15;

function caseOf(a: HiltAnchors) {
  const R = Math.min(0.92, Math.max(0.68, a.top.hy * 0.55 + 0.25));
  const hx = Math.min(0.7, Math.max(0.2, a.blade.hx + 0.1));
  const zc = (a.top.hx > 0.6 ? a.top.z + 0.1 : a.top.z - 0.1) + R * 0.6;
  return { R, hx, zc, cy: (a.blade.y0 + a.blade.y1) / 2 };
}
/** Wheel centres on the face (y, z offsets from the case centre). */
const BAL = (R: number): [number, number] => [0.02 * R, 0.3 * R];
const ESC = (R: number): [number, number] => [-0.38 * R, -0.34 * R];
const GEAR = (R: number): [number, number] => [0.36 * R, -0.4 * R];

/** A flat disc / ring in a face plane (x = const), points as (y, z) about c. */
function faceRing(kit: LiveKit, x: number, c: [number, number], r0: number, r1: number, seg: number, o: { color: number; mat: number; piece?: number; th?: number; teeth?: number }): void {
  const th = o.th ?? 0.03;
  const prof = (k: number, r: number) => {
    const t = (k / seg) * Math.PI * 2;
    let rr = r;
    if (o.teeth && r === r1) rr = r1 * (1 + 0.16 * (((k * o.teeth) / seg) % 1 < 0.5 ? 1 : 0));
    return [c[0] + Math.cos(t) * rr, c[1] + Math.sin(t) * rr] as [number, number];
  };
  const rows: V3[][] = [];
  const sx = Math.sign(x) || 1;
  // Inner edge, front face, outer edge: a short flat washer.
  for (const [r, dx] of [[r0, -th], [r0, 0], [r1, 0], [r1, -th]] as [number, number][]) {
    const row: V3[] = [];
    for (let k = 0; k < seg; k++) {
      const [y, z] = prof(k, r);
      row.push([x + sx * dx, y, z]);
    }
    rows.push(row);
  }
  kit.surface(rows, { color: o.color, mat: o.mat, piece: o.piece, flat: !!o.teeth, out: (i, k) => (i === 1 || i === 2 ? [sx, 0, 0] : [0, Math.cos((k / seg) * Math.PI * 2) * (i === 0 ? -1 : 1), Math.sin((k / seg) * Math.PI * 2) * (i === 0 ? -1 : 1)]), uvw: (i, k) => [rows[i][k % seg][1], rows[i][k % seg][2], 0] });
}

export const clockwork: LiveDesign = {
  id: "hilt-clockwork",
  build(kit, a) {
    const C = caseOf(a);
    const { R, hx, zc, cy } = C;
    // The case: a short brass drum about x, its rim thick, both faces open (a back plate inside, darker).
    const rows: V3[][] = [];
    const seg = 28;
    for (const [x, r] of [[-hx - 0.04, R * 0.9], [-hx - 0.06, R], [-hx + 0.02, R * 1.04], [hx - 0.02, R * 1.04], [hx + 0.06, R], [hx + 0.04, R * 0.9]] as [number, number][]) {
      const row: V3[] = [];
      for (let k = 0; k < seg; k++) {
        const t = (k / seg) * Math.PI * 2;
        row.push([x, cy + Math.cos(t) * r, zc + Math.sin(t) * r]);
      }
      rows.push(row);
    }
    kit.surface(rows, { color: BRASS, mat: MAT.brass, closed: true, out: (i, k) => [0, Math.cos((k / seg) * Math.PI * 2), Math.sin((k / seg) * Math.PI * 2)], uvw: (i, k) => [rows[i][k % seg][1] * 0.3, rows[i][k % seg][0], 0] });
    for (const side of [1, -1]) {
      const x = side * (hx - 0.01);
      // The plate (dark brass, grained), then the wheels in front of it.
      faceRing(kit, x - side * 0.02, [cy, zc], 0.0, R * 0.92, seg, { color: BRASS_DARK, mat: MAT.brass, th: 0.01 });
      const bal = BAL(R), esc = ESC(R), gear = GEAR(R);
      const at = (p: [number, number]): [number, number] => [cy + p[0], zc + p[1]];
      // Balance (piece 1): rim + spokes + hub ruby.
      const rb = R * 0.42;
      faceRing(kit, x + side * 0.05, at(bal), rb * 0.84, rb, 32, { color: BRASS, mat: MAT.polished, piece: 1, th: 0.04 });
      for (let sp = 0; sp < 3; sp++) {
        const t = (sp / 3) * Math.PI * 2 + 0.3;
        const c0 = at(bal);
        const path: V3[] = [[x + side * 0.04, c0[0], c0[1]], [x + side * 0.04, c0[0] + Math.cos(t) * rb * 0.86, c0[1] + Math.sin(t) * rb * 0.86]];
        kit.tube(path, 0.022, 6, [1, 0, 0], { color: BRASS, mat: MAT.polished, piece: 1 });
      }
      kit.ellipsoid([x + side * 0.06, at(bal)[0], at(bal)[1]], [0.05, 0.05, 0.05], [1, 0, 0], [0, 1, 0], 10, 6, { color: RUBY, mat: MAT.jewel, piece: 1 });
      // Escape wheel (piece 2): toothed.
      faceRing(kit, x + side * 0.03, at(esc), R * 0.08, R * 0.3, TEETH * 4, { color: STEEL, mat: MAT.polished, piece: 2, teeth: TEETH, th: 0.03 });
      kit.ellipsoid([x + side * 0.05, at(esc)[0], at(esc)[1]], [0.04, 0.04, 0.04], [1, 0, 0], [0, 1, 0], 8, 5, { color: RUBY, mat: MAT.jewel, piece: 2 });
      // Small gear (piece 3).
      faceRing(kit, x + side * 0.025, at(gear), R * 0.06, R * 0.22, 40, { color: BRASS, mat: MAT.polished, piece: 3, teeth: 10, th: 0.03 });
      // Screws round the plate.
      for (let sc = 0; sc < 4; sc++) {
        const t = (sc / 4) * Math.PI * 2 + Math.PI / 4;
        kit.ellipsoid([x, cy + Math.cos(t) * R * 0.8, zc + Math.sin(t) * R * 0.8], [0.04, 0.05, 0.05], [1, 0, 0], [0, 1, 0], 8, 4, { color: STEEL, mat: MAT.polished });
      }
    }
    // A brass collar from the case down onto the grip, and a brass pommel.
    const col: V3[][] = [];
    for (let i = 0; i <= 3; i++) col.push(sring([0, a.grip.cy, zc - R - 0.25 + 0.1 * i], [1, 0, 0], [0, 1, 0], Math.max(0.24, a.grip.hx + 0.06), Math.max(0.34, a.grip.hy + 0.06), 20));
    kit.surface(col, { color: BRASS, mat: MAT.polished, capStart: true, capEnd: true });
    const bottom = pommelCap(kit, a, { H: 0.4, color: BRASS, mat: MAT.polished, sides: 12 });
    lanyard(kit, a, bottom, BRASS, MAT.polished);
    // A faint warm glint on each ruby set (channel 4).
    kit.sprite([hx + 0.08, cy + BAL(R)[0], zc + BAL(R)[1]], { color: 0xff3050, size: 0.14, channel: 4 });
    kit.sprite([-hx - 0.08, cy + BAL(R)[0], zc + BAL(R)[1]], { color: 0xff3050, size: 0.14, channel: 4 });
  },
  animate(s, c, dt) {
    const m = c.mem;
    const C = caseOf(c.a);
    const freq = s.still ? 0 : 0.9 + 2.0 * s.speed01 + 1.2 * s.inspect;
    // Trapezoid: the phase is the integral of the rate, the same at any frame rate.
    m.ph = (m.ph ?? 0) + dt * (freq + (m.f ?? freq)) / 2;
    m.f = freq;
    if (!s.still && (m.lands ?? 0) !== s.lands) {
      m.lands = s.lands;
      m.kick = Math.max(m.kick ?? 0, 0.5 + 0.8 * s.landHard);
    }
    m.kick = approach(m.kick ?? 0, 0, 1.6, dt);
    const amp = s.still ? 0.6 : 0.85 + (m.kick ?? 0);
    const bal = Math.sin(m.ph * Math.PI * 2) * amp;
    // The escape wheel advances one tooth each half swing, eased over the first fifth of it.
    const half = m.ph * 2;
    const n = Math.floor(half), f = half - n;
    const step = n + Math.min(1, f / 0.2) ** 2 * (3 - 2 * Math.min(1, f / 0.2));
    const esc = (-step * Math.PI * 2) / TEETH;
    const at = (p: [number, number]): V3 => [0, C.cy + p[0], C.zc + p[1]];
    c.piece(1, at(BAL(C.R)), [1, 0, 0], bal);
    c.piece(2, at(ESC(C.R)), [1, 0, 0], esc);
    c.piece(3, at(GEAR(C.R)), [1, 0, 0], (-esc * TEETH) / 10 * 0.73);
    c.chan(4, [1, 0.25, 0.35], 0.12 + 0.1 * Math.abs(Math.cos(m.ph * Math.PI * 2)));
  },
};
