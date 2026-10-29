// Furrow (stand-in for the rifles: ak47 and the other assault rifles, guns/index.ts GUN_STAND_IN): the garden rifle.
// A moss-dark receiver over a walnut handguard bound with two bands of twine, a walnut stock, a sprout for a front
// sight, and its magazine is a big curved carrot (ridged, tapering to a point) that the left hand swaps in a reload.
// Same grip, trigger and hand hold as the Hedgerow. Original design: no real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a dark steel receiver with a seam under its top cover, rivets and a front block,
// the bolt face in the port, a blued barrel, walnut (grain, satin) handguard, grip and stock with a steel buttplate,
// twine that reads woven, the carrot's ridges; a steel trigger that swings back (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { ball, box, groove, guard, lathe, pins, plate, rod, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { V3 } from "../../../player/bunny/rig";
import type { GunDef } from "../types";

const RECV = fixed(0x3f4436), RECV_DARK = fixed(0x2a2e25, "dark"), WOOD = fixed(0x9a6a3e, "wood"), WOOD_DARK = fixed(0x744c2a, "wood"), TWINE = fixed(0xd8c08a, "grip");
const STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x707782, "metal"), BORE = fixed(0x101114), CARROT = fixed(0xff7a1a), CARROT_DARK = fixed(0xd65e14), SPROUT = fixed(0x58c64a);
const SEAM = fixed(0x1e211a, "dark"), RIVET = fixed(0x8a9080, "metal"), LIP = fixed(0x6e785c);
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.55, 0, -0.35];

/** Barrel axis height. */
const BZ = 1.2;
const RAKE = (22 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.3];
const GRIP_LEN = 3.4, GRIP_DEPTH = 1.75;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
/** The carrot magazine: where it meets the receiver, its axis (down and a little forward), its length. */
const MAG0: V3 = [4.35, 0, -0.3];
const MAG_AX: V3 = [0.415, 0, -0.91];
const MAG_N: [number, number] = [0.91, 0.415];
const magAt = (t: number, s = 0): P2 => [MAG0[0] + MAG_AX[0] * t + MAG_N[0] * s, MAG0[2] + MAG_AX[2] * t + MAG_N[1] * s];

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Receiver: a long block, a top cover, the ejection port on the right, the charging handle on the left.
  slab(k, [[-0.8, -0.35], [6.4, -0.35], [6.5, 1.75], [-0.6, 1.75], [-0.9, 1.2]], -0.62, 0.62, { paint: RECV, part: PART.blade, round: 0.14, bevel: 0.1 });
  box(k, [2.8, 0, 1.82], [3.0, 0.36, 0.08], { paint: RECV_DARK, round: 0.04 });
  box(k, [3.0, -0.63, 1.1], [0.8, 0.03, 0.28], { paint: RECV_DARK, bevel: 0.01 });
  box(k, [4.6, 0.63, 1.15], [0.95, 0.03, 0.1], { paint: RECV_DARK, bevel: 0.01 });
  rod(k, [4.6, 0.6, 1.15], [4.6, 1.05, 1.15], 0.1, { paint: STEEL_LIGHT, bone: "Slide" });
  ball(k, [4.6, 1.15, 1.15], [0.18, 0.18, 0.18], { paint: STEEL_LIGHT, bone: "Slide", sides: 8 });
  box(k, [0.15, 0, 1.97], [0.18, 0.3, 0.14], { paint: RECV_DARK });
  if (fp) {
    // The top cover's seam, rivets and the front block on both flanks, the bolt face in the port (rides the bolt).
    for (const y of [-0.62, 0.62]) groove(k, -0.55, 6.2, 1.5, y, { paint: SEAM, lip: LIP });
    pins(k, [[0.2, 1.05], [0.8, 1.05], [5.3, 0.25], [5.9, 0.25]], 0.62, 0.085, { paint: RIVET, h: 0.04 });
    for (const y of [-0.63, 0.63]) plate(k, [6.15, y, 0.7], [0.22, 0.012, 0.42], { paint: RECV_DARK });
    plate(k, [2.85, -0.655, 1.1], [0.36, 0.012, 0.18], { paint: STEEL_LIGHT, bone: "Slide" });
  }
  // --- Barrel and its muzzle, the sprout sight.
  lathe(k, [[6.4, 0.36], [19.2, 0.32], [19.2, 0.42], [20.5, 0.42], [20.5, 0.2], [20.2, 0.2]], { c: [0, BZ], paint: (i) => (i >= 4 ? BORE : i >= 2 ? RECV_DARK : STEEL), sides: 12, part: PART.blade });
  k.tube([[18.4, 0, BZ + 0.3], [18.45, 0, BZ + 0.8]], 0.06, 6, [1, 0, 0], () => SPROUT);
  for (const s of [-1, 1]) k.leaf([[18.45, 0, BZ + 0.76], [18.45 + s * 0.25, 0, BZ + 0.96], [18.45 + s * 0.5, 0, BZ + 1.02]], (i) => [0.04, 0.14, 0.04][i] ?? 0.04, 0.03, [0, 1, 0], () => SPROUT, { part: PART.none });
  // --- Handguard: walnut round the barrel, two bands of twine.
  slab(k, [[6.5, -0.5], [13.2, -0.4], [13.45, 0.6], [13.2, 1.7], [6.5, 1.7]], -0.72, 0.72, { paint: WOOD, part: PART.grip, round: 0.3, bevel: 0.16 });
  for (const x of [7.2, 12.6]) slab(k, [[x - 0.22, -0.56], [x + 0.22, -0.54], [x + 0.22, 1.76], [x - 0.22, 1.76]], -0.77, 0.77, { paint: TWINE, round: 0.12, bevel: 0.05 });
  // --- Guard, trigger, the walnut grip, the stock and its pad.
  guard(k, [[3.5, -0.35], [3.4, -1.3], [2.2, -1.45], [1.4, -1.2], [1.35, -0.65]], 0.14, { paint: RECV, open: true });
  trigger(k, TRIGGER, 0.67, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 1.0), [1.25, -0.5], along(b0, 1.1, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.6, 0.6, { paint: WOOD, part: PART.grip, round: 0.25, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 0.6, 0.3), along(b0, 0.6, GRIP_DEPTH - 0.3), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: WOOD_DARK, part: PART.grip, round: 0.15, bevel: 0.02 });
  slab(k, [[-0.85, 1.6], [-8.6, 1.2], [-8.8, -1.7], [-7.6, -1.8], [-2.6, -0.9], [-0.9, -0.4]], -0.58, 0.58, { paint: WOOD, round: 0.3, bevel: 0.15 });
  box(k, [-8.85, 0, -0.25], [0.22, 0.6, 1.5], { paint: RECV_DARK, round: 0.18 });
  // --- The carrot magazine (Mag bone): two slabs along its curve, darker ridges, a point at the bottom.
  slab(k, [magAt(0, -0.62), magAt(0, 0.62), magAt(2.3, 0.62), magAt(2.3, -0.62)], -0.42, 0.42, { paint: CARROT, bone: "Mag", round: 0.2, bevel: 0.12 });
  slab(k, [magAt(2.2, -0.62), magAt(2.2, 0.62), magAt(3.5, 0.75), magAt(4.45, 0.3), magAt(4.5, 0.05), magAt(3.6, -0.35)], -0.4, 0.4, { paint: CARROT, bone: "Mag", round: 0.25, bevel: 0.12 });
  if (fp) for (const t of [0.9, 1.9, 2.9, 3.7]) {
    const w = t > 3 ? 0.5 : 0.66;
    slab(k, [magAt(t - 0.05, -w), magAt(t - 0.05, w), magAt(t + 0.05, w), magAt(t + 0.05, -w)], -0.45, 0.45, { paint: CARROT_DARK, bone: "Mag", round: 0, bevel: 0.02 });
  }
}

const magPoint = (t: number): V3 => [MAG0[0] + MAG_AX[0] * t, 0, MAG0[2] + MAG_AX[2] * t];

export const furrow: GunDef = {
  id: "ak47",
  name: "Furrow",
  archetype: "Rifle",
  blurb: "A walnut garden rifle fed from a carrot.",
  cls: "rifle",
  build,
  // The Hedgerow's grip and support hold (same grip profile, a handguard of the same depth).
  right: {
    o: [-1.03, 0.0, -0.49],
    up: [-0.2, 0, 0.98],
    fwd: [0.965, 0.174, 0.197],
    index: { c: [16, 34, 20], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [12, 10, 6], spread: -10 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  left: {
    o: [9.9, 0.0, -0.05],
    up: [1, 0, 0],
    fwd: [0.0, -0.848, 0.53],
    index: { c: [60, 80, 60] },
    middle: { c: [64, 84, 64] },
    ring: { c: [68, 86, 64] },
    pinky: { c: [72, 86, 64] },
    thumb: { c: [14, 40, 40], spread: -6 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.2,
  },
  places: {
    mag: { o: magPoint(3.0), up: [-MAG_AX[0], 0, -MAG_AX[2]], fwd: [MAG_N[0], 0, MAG_N[1]] },
    rack: { o: [4.6, 2.0, 1.15], up: [0, 0, 1], fwd: [1, 0, 0] },
  },
  frame: { o: [16, -6.2, -6.0], a: [-1, 4, -4] },
  trigger: TRIGGER,
  elbows: { R: [8, -18, -18], L: [24, -6, -26] },
  wrist: { L: 34 },
  muzzle: [20.6, 0, BZ],
  eject: { p: [3.0, -0.7, 1.1], dir: [-0.15, -0.9, 0.4] },
  shell: "smg",
  mag: { p: MAG0, out: MAG_AX },
  timing: { cycle: 0.1, ammo: 30, reload: 2.5, draw: 1.0 },
  recoil: { kick: 2.6, back: 0.5, roll: 0.8, settle: 320, slide: 1.0, slideTime: 0.07 },
  sounds: { fire: "gun_furrow_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", slide: "gun_bolt" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
