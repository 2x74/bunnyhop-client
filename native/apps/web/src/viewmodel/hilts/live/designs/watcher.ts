// WATCHER (hilt-watcher, Supporter, v0.0.43): a lidded eye set into the root of the blade, looking at you.
//
// The eyeball is a sphere at the blade's root (the blade grows out of its upper lid); the iris is drawn where the
// gaze points (live/material.ts EYE), so the eye can look anywhere without turning any geometry. The lids are two
// fleshy shells that morph between open and shut. A smaller eye sleeps in the pommel above the lanyard ring.
//
// Motion (the viewmodel clock and play only): it looks at the camera, wanders off to look around now and then and
// blinks every few seconds; it glances toward the side you turn to, blinks on a landing (harder landing, longer
// squint), its pupil narrows with speed, and in an inspect the lids pull back and it stares at you.

import { add, scale } from "../../../../player/bunny/builder";
import type { V3 } from "../../../../player/bunny/rig";
import type { HiltAnchors } from "../anchors";
import { approach, type LiveDesign, type PieceCtx } from "../design";
import { ellipsoidRows, MAT, type LiveKit } from "../kit";
import { schedule, hash1 } from "../state";

const SCLERA = 0xd9cfba;
const LID = 0x4a1f3c;
const LID_DARK = 0x2a1024;
const IRIS: [number, number, number] = [0.62, 0.78, 0.16];
/** Lid rims' polar angles (from the eye's top pole, radians): open and shut. */
const UPPER = { open: 0.9, shut: 1.62 };
const LOWER = { open: 2.2, shut: 1.6 };

/** The eye's centre and radius on a knife. */
export function watcherEye(a: HiltAnchors): { c: V3; r: number } {
  const r = Math.min(0.84, Math.max(0.64, a.blade.hx + 0.3));
  return { c: [a.boss.p[0], a.boss.p[1], a.top.z + r * 0.42], r };
}
function pommelEye(a: HiltAnchors): { c: V3; r: number } {
  return { c: [0, a.butt.cy, a.butt.z - 0.12], r: 0.3 };
}

/**
 * One lid shell: rows from its root pole to the rim, the rim rolled in onto the eyeball; dir +1 upper, -1 lower. The
 * rim opens only toward the blade's two faces (±x) and meets the other lid at the sides, so each face shows an almond
 * opening and the ball's sides stay covered. `open` 0 = shut along the whole rim.
 */
function lidRows(c: V3, rE: number, rim: number, shut: number, dir: 1 | -1, seg: number): V3[][] {
  const rows: V3[][] = [];
  const N = 9;
  const pole = dir > 0 ? 0 : Math.PI;
  const rimAt = (th: number) => shut + (rim - shut) * Math.pow(Math.abs(Math.cos(th)), 0.75);
  const shell = (f: number, extra: number, rad: number): V3[] => {
    const out: V3[] = [];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const polar = pole + (rimAt(th) - pole) * f + extra;
      out.push(add(c, [Math.sin(polar) * Math.cos(th) * rad, Math.sin(polar) * Math.sin(th) * rad * 1.04, Math.cos(polar) * rad]));
    }
    return out;
  };
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    // A heavy lid: fuller toward its rim.
    rows.push(shell(f, 0, rE * (1.06 + 0.14 * Math.sin(f * Math.PI * 0.8))));
  }
  // The rim rolls in onto the eyeball.
  rows.push(shell(1, 0.06 * dir, rE * 1.12));
  rows.push(shell(1, 0.1 * dir, rE * 1.0));
  return rows;
}

function buildEye(kit: LiveKit, c: V3, rE: number, pieceU: number, pieceL: number, open: { u: number; l: number }, shut: { u: number; l: number }, bone?: string): void {
  const seg = rE > 0.4 ? 30 : 18;
  // Eyeball: its points' directions from the centre are the eye material's coordinates.
  const ball = ellipsoidRows(c, [rE, rE, rE], [0, 0, 1], [1, 0, 0], seg, rE > 0.4 ? 18 : 10);
  kit.surface(ball, { color: SCLERA, mat: MAT.eye, bone, uvw: (i, k) => scale(add(ball[i][k % seg], scale(c, -1)), 1 / rE) });
  const lidUvw = (n: number) => (i: number, k: number): V3 => [k / seg, Math.min(1, i / (n - 3)), 0];
  const up = lidRows(c, rE, open.u, shut.u, 1, seg), upShut = lidRows(c, rE, shut.u, shut.u, 1, seg);
  kit.surface(up, { color: (i) => (i > 8 ? LID_DARK : LID), mat: MAT.flesh, piece: pieceU, morph: upShut, bone, uvw: lidUvw(up.length) });
  const lo = lidRows(c, rE, open.l, shut.l, -1, seg), loShut = lidRows(c, rE, shut.l, shut.l, -1, seg);
  kit.surface(lo, { color: (i) => (i > 8 ? LID_DARK : LID), mat: MAT.flesh, piece: pieceL, morph: loShut, bone, uvw: lidUvw(lo.length) });
}

export const watcher: LiveDesign = {
  id: "hilt-watcher",
  build(kit, a) {
    const { c, r } = watcherEye(a);
    buildEye(kit, c, r, 1, 2, { u: UPPER.open, l: LOWER.open }, { u: UPPER.shut, l: LOWER.shut });
    // A faint violet aura behind the eye (channel 3), a glint of the iris's own light (channel 4).
    kit.sprite(c, { color: 0x8a4cff, size: r * 2.6, channel: 3 });
    // The pommel: a small eye asleep, and the lanyard ring under it.
    const pe = pommelEye(a);
    buildEye(kit, pe.c, pe.r, 5, 6, { u: 1.38, l: 1.84 }, { u: 1.62, l: 1.6 }, a.buttBone);
    const ring: V3[] = [];
    const rc: V3 = [0, a.butt.cy, a.butt.z - 0.12 - pe.r - 0.16];
    for (let k = 0; k <= 16; k++) {
      const t = (k / 16) * Math.PI * 2;
      ring.push([rc[0], rc[1] + Math.cos(t) * 0.16, rc[2] + Math.sin(t) * 0.16]);
    }
    kit.tube(ring, 0.045, 8, [1, 0, 0], { color: LID_DARK, mat: MAT.polished, bone: a.buttBone, capStart: false, capEnd: false });
    kit.anchors.pommel = rc;
  },
  animate(s, c, dt) {
    const m = c.mem;
    const still = s.still;
    // Blink: every 4..8 s on the clock; a landing squints (longer for a harder landing); speed narrows a little.
    let w = 0;
    if (!still) {
      const b = schedule(s.t, 4, 8, 11);
      const e = s.t - b.at;
      const blink = e < 0.07 ? e / 0.07 : e < 0.11 ? 1 : e < 0.27 ? 1 - (e - 0.11) / 0.16 : 0;
      const ld = 0.12 + 0.28 * s.landHard, le = s.sinceLand;
      const land = le < 0.05 ? (le / 0.05) * (0.55 + 0.45 * s.landHard) : le < 0.05 + ld ? (0.55 + 0.45 * s.landHard) * (1 - (le - 0.05) / ld) : 0;
      w = Math.max(blink, land, 0.18 * s.speed01);
      w = w * (1 - s.inspect) - 0.42 * s.inspect;
    }
    c.morph(1, w);
    c.morph(2, w * 0.85);
    // The sleeping pommel eye: shut, a twitch now and then (it opens a crack in an inspect).
    const tw = still ? 0 : (() => {
      const b = schedule(s.t, 5, 11, 29);
      const e = s.t - b.at;
      return e < 0.6 ? Math.sin((e / 0.6) * Math.PI) * 0.25 : 0;
    })();
    c.morph(5, 1 - tw - (still ? 0 : 0.45 * s.inspect));
    c.morph(6, 1 - tw * 0.5 - (still ? 0 : 0.3 * s.inspect));
    // Pupil: 0.2 rad at rest, narrower with speed and in an inspect.
    m.pupil = still ? 0.21 : approach(m.pupil ?? 0.21, 0.22 - 0.07 * s.speed01 - 0.06 * s.inspect, 6, dt);
    // Gaze offsets (camera right / up, radians): saccades to a new spot every 2..5 s, held; the turn pulls it sideways.
    let ox = 0, oy = 0;
    if (!still) {
      const sc = schedule(s.t, 2, 5, 3);
      // Every third look is straight at you.
      const at = hash1(sc.i * 31 + 5) < 0.34 ? 0 : 1;
      ox = at * (hash1(sc.i * 13 + 1) - 0.5) * 1.3;
      oy = at * (hash1(sc.i * 17 + 2) - 0.5) * 0.7;
      ox = ox * (1 - s.inspect) - 0.55 * Math.tanh(s.turn / 260);
      oy *= 1 - s.inspect;
    }
    m.gx = approach(m.gx ?? 0, ox, 22, dt);
    m.gy = approach(m.gy ?? 0, oy, 22, dt);
    const ins = still ? 0 : s.inspect;
    c.live(1, IRIS[0], IRIS[1], IRIS[2], 0.32 + 0.25 * ins);
    c.live(2, 0.5, 0, 0, 0);
    c.chan(3, 0x8a4cff, 0.09 + 0.12 * ins);
  },
  look(cam, c) {
    const m = c.mem;
    const { c: e } = watcherEye(c.a);
    let d: V3 = [cam.pos[0] - e[0], cam.pos[1] - e[1], cam.pos[2] - e[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / l, d[1] / l, d[2] / l];
    const gx = m.gx ?? 0, gy = m.gy ?? 0;
    const g: V3 = [d[0] + cam.right[0] * gx + cam.up[0] * gy, d[1] + cam.right[1] * gx + cam.up[1] * gy, d[2] + cam.right[2] * gx + cam.up[2] * gy];
    c.live(0, g[0], g[1], g[2], m.pupil ?? 0.21);
  },
};
