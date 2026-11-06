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
import { coat } from "../camo-zones";
import type { V3 } from "../../../player/bunny/rig";
import type { GunDef, SilencerSpec } from "../types";

const RECV = coat(fixed(0x3f4436), "upper"), RECV_DARK = fixed(0x2a2e25, "dark"), WOOD = coat(fixed(0x9a6a3e, "wood"), "lower"), WOOD_DARK = coat(fixed(0x744c2a, "wood"), "lower", 0.82), TWINE = fixed(0xd8c08a, "grip");
const STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x707782, "metal"), BORE = fixed(0x101114), CARROT = fixed(0xff7a1a), CARROT_DARK = fixed(0xd65e14), SPROUT = fixed(0x58c64a);
const SEAM = fixed(0x1e211a, "dark"), RIVET = fixed(0x8a9080, "metal"), LIP = coat(fixed(0x6e785c), "upper", 1.2);
/**
 * The trigger's pivot (top of its blade, gun-local): tight in front of the grip's thin upper part, where the firing
 * index's pad rests on it (v0.0.37: guns/hold.ts solveTriggerIndex; the bunny's short fingers on a deep grip couldn't
 * reach a trigger further out).
 */
const TRIGGER: [number, number, number] = [0.3, 0, -0.42];

/** Barrel axis height. */
const BZ = 1.2;
const RAKE = (22 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.3];
const GRIP_LEN = 3.4, GRIP_DEPTH = 1.75;
/** The stock's side profile (receiver end at the top, round to the butt; the buttplate caps x < -8.7). */
const STOCK: P2[] = [[-0.85, 1.6], [-2.9, 1.2], [-6.2, 1.36], [-8.75, 1.12], [-8.82, -1.6], [-8.2, -1.86], [-4.4, -1.18], [-0.9, -0.4]];
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
  // A short guard round the trigger, open at the back where it meets the grip's swell.
  guard(k, [[1.65, -0.35], [1.58, -1.26], [0.85, -1.42], [0.3, -1.36]], 0.14, { paint: RECV, open: true });
  trigger(k, TRIGGER, 0.55, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  // The grip: thin at the top (the firing index runs along it to the trigger), full depth below the guard where the
  // other three fingers wrap it (a palm swell), as two slabs (a notched outline doesn't cap as one).
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 0.35), [0.1, -0.45], [-0.08, -0.98], along(b0, 0.8, -0.05)], -0.6, 0.6, { paint: WOOD, part: PART.grip, round: 0.18, bevel: 0.14 });
  slab(k, [along(b0, 0.7, -0.05), [-0.12, -0.92], along(b0, 0.85, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.6, 0.6, { paint: WOOD, part: PART.grip, round: 0.25, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 1.3, 0.3), along(b0, 1.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: WOOD_DARK, part: PART.grip, round: 0.15, bevel: 0.02 });
  // The stock: a slim wrist behind the receiver, a gentle comb, a rounded heel and toe, the belly sweeping down to the
  // butt (v0.0.37 polish: it was a straight-sided box).
  slab(k, STOCK, -0.58, 0.58, { paint: WOOD, round: [0.3, 0.7, 1.2, 0.5, 0.3, 0.6, 1.2, 0.3], bevel: 0.17 });
  slab(k, [[-8.72, 1.0], [-9.02, 0.95], [-9.08, -1.5], [-8.62, -1.78]], -0.6, 0.6, { paint: RECV_DARK, round: 0.16, bevel: 0.08 });
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
  // v0.0.38 (Astra QA): the palm on the pistol grip (it sat up at the receiver, the fingers came out through it and
  // the stock); fitted with tools/viewmodel/gun-grip-fit.ts. The index rests toward the trigger (guns/hold.ts).
  right: {
    o: [-0.56, 0.0, -2.55],
    up: [-0.375, 0, 0.927],
    fwd: [0.927, 0.0, 0.375],
    index: { c: [16, 34, 20], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [12, 10, 6], spread: -10 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    triggerRest: true,
    seat: -0.02,
  },
  // v0.0.38 gun grips: the support hand turned so the handguard runs across its palm (knuckles 18 deg forward, 30 up),
  // its elbow down, back and in where that leaves the wrist near neutral (about 10 deg extension, 8 ulnar): the forearm
  // comes up diagonally from the bottom of the screen and does the holding, instead of standing straight under the
  // handguard with the wrist bent back 42 deg. The firing elbow likewise sits in line with a pistol-grip wrist.
  left: {
    o: [9.9, 0.0, -0.05],
    up: [0.976, 0.195, -0.098],
    fwd: [0.218, -0.873, 0.436],
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
  elbows: { R: [6.85, -10.55, -15.6], L: [20.5, 1.7, -13.65] },
  muzzle: [20.6, 0, BZ],
  eject: { p: [3.0, -0.7, 1.1], dir: [-0.15, -0.9, 0.4] },
  shell: "smg",
  mag: { p: MAG0, out: MAG_AX },
  timing: { cycle: 0.1, ammo: 30, reload: 2.5, draw: 1.0 },
  recoil: { kick: 2.6, back: 0.5, roll: 0.8, settle: 320, slide: 1.0, slideTime: 0.07 },
  sounds: { fire: "gun_furrow_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", slide: "gun_bolt" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};

// --- The M4A1 (physics v25: its silencer is simulated, research/WEAPONS.md): the Furrow with a screw-on suppressor.
// Original design: a matte moss-olive tube, a walnut collar of eight flats where the hand turns it (each turn reads),
// two twine bands like the handguard's, a dark steel nose. It screws onto the muzzle device's front face.

const CAN = coat(fixed(0x4a5638), "lower"), CAN_DARK = fixed(0x343d28, "dark");
/** Where the can's rear face seats (the muzzle device's front), the thread's length, the can's length and radius. */
const SIL_SEAT = 20.5, SIL_THREAD = 0.5, SIL_L = 6.2, SIL_R = 0.66;

function buildSuppressor(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const x0 = SIL_SEAT;
  const o = { c: [0, BZ] as [number, number], bone: "Sil" };
  // Collar: eight walnut flats (the hand's purchase), rounded into the tube.
  lathe(k, [[x0, SIL_R - 0.12], [x0 + 0.07, SIL_R - 0.02], [x0 + 0.35, SIL_R + 0.03], [x0 + 0.75, SIL_R + 0.03], [x0 + 1.05, SIL_R + 0.03], [x0 + 1.14, SIL_R - 0.04]], { ...o, paint: WOOD, cap: WOOD_DARK, part: PART.grip, sides: 8, phase: Math.PI / 8 });
  // Tube: rows every 0.5 so the grip solver and the audits see where a finger rests (within the triangle budget).
  const body: [number, number][] = [];
  for (let x = x0 + 1.1; x <= x0 + SIL_L - 0.5; x += fp ? 0.5 : 5) body.push([x, SIL_R]);
  body.push([x0 + SIL_L - 0.48, SIL_R]);
  lathe(k, body, { ...o, paint: CAN, part: PART.grip, sides: fp ? 14 : 8, capStart: false, capEnd: false });
  // Nose: dark steel, stepped in to the bore.
  lathe(k, [[x0 + SIL_L - 0.5, SIL_R + 0.01], [x0 + SIL_L - 0.16, SIL_R + 0.01], [x0 + SIL_L - 0.03, SIL_R - 0.12], [x0 + SIL_L, SIL_R - 0.26], [x0 + SIL_L, 0.2]], { ...o, paint: CAN_DARK, part: PART.grip, sides: fp ? 14 : 8, capStart: false, capEnd: false });
  lathe(k, [[x0 + SIL_L - 0.1, 0.2], [x0 + SIL_L + 0.005, 0.2]], { ...o, paint: BORE, cap: BORE, sides: 10, capStart: false });
  // Two twine bands.
  for (const x of [x0 + 2.2, x0 + SIL_L - 1.3]) lathe(k, [[x - 0.18, SIL_R + 0.05], [x + 0.18, SIL_R + 0.05]], { ...o, paint: TWINE, sides: fp ? 14 : 8, capStart: true, capEnd: true });
}

const suppressor: SilencerSpec = {
  build: buildSuppressor,
  style: "rifle",
  // As the Cottontail's: its twists roll the hand further than a wrist goes with the forearm from below the screen (v0.0.38
  // gun grips: no grip roll or working elbow under 6x the range): the wrist stays free on the can (owner call).
  freeWrist: true,
  axis: [0, BZ],
  seat: SIL_SEAT,
  thread: SIL_THREAD,
  tip: [SIL_SEAT + SIL_L, 0, BZ],
  // Overhand from the left, the palm on the can's left flank, fingers over the top (as the Cottontail's).
  grip: {
    o: [SIL_SEAT + 3.4, 0.0, BZ],
    up: [-1, 0, 0],
    fwd: [0, 0.35, 0.94],
    index: { c: [70, 80, 60] },
    middle: { c: [75, 85, 65] },
    ring: { c: [80, 88, 65] },
    pinky: { c: [85, 90, 65] },
    thumb: { c: [10, 60, 50], spread: -22 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
};

/** The M4A1: the Furrow with its suppressor; the core's M4A1 timing (CS:S weapon_m4a1: cycle 0.09, 30 rounds, reload 3.05). */
export const furrowM4: GunDef = {
  ...furrow,
  id: "m4a1",
  archetype: "Rifle with a suppressor",
  blurb: "The walnut garden rifle, with a screw-on suppressor.",
  silencer: suppressor,
  // The hand works far out at the muzzle: its forearm drops from there to the bottom edge (not back toward the camera).
  workElbow: [24, 6, -30],
  timing: { ...furrow.timing, cycle: 0.09, reload: 3.05 },
  sounds: { ...furrow.sounds, silenced: "gun_cottontail_silenced" },
};
