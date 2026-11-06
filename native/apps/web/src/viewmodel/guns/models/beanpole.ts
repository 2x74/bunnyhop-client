// Beanpole (stand-in for the sniper rifles: awp, scout and the auto snipers, guns/index.ts GUN_STAND_IN): the long one.
// A pea-green stock and forestock with a cheek rest, a dark receiver, a very long barrel with a slotted brake, a fat
// scope on two mounts with a carrot-orange ring at the front, and a bolt with a round knob on the right that slides
// back after every shot (the Pump bone, timed by GunTiming.pump like the M3's pump; guns/anim.ts boltClip: the firing
// hand turns it up, throws it back and home, all inside the gun's 1.455 s cycle). Same grip and hand hold as the Hedgerow.
// Original design: no real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a dark steel receiver, a steel bolt that turns up before it comes back
// (GunDef.bolt: its handle lifts), a blued barrel, a scope with glass at both ends and screws on
// its mounts, checkered grip panels, a rubber butt pad; a steel trigger that swings back (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { ball, box, groove, guard, lathe, pins, rod, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import { coat } from "../camo-zones";
import type { GunDef } from "../types";

const RECV = coat(fixed(0x3a3e45, "dark"), "upper"), RECV_DARK = fixed(0x26292e, "dark"), PEA = coat(fixed(0x6f9150), "lower"), PEA_DARK = coat(fixed(0x55733d), "lower", 0.82), STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x7a818c, "metal");
const BORE = fixed(0x101114), LENS = fixed(0x2f6f73, "glass"), ORANGE = fixed(0xff7a1a), GRIP = coat(fixed(0x55733d, "grip"), "lower", 0.85), PAD = fixed(0x26292e, "grip");
const LINE = fixed(0x17191c), LIP = fixed(0x626a76, "metal");
/** The trigger's pivot (top of its blade, gun-local). */
/**
 * The trigger's pivot (top of its blade, gun-local): tight in front of the grip's thin upper part, where the firing
 * index's pad rests on it (v0.0.37, as the Furrow's; guns/hold.ts solveTriggerIndex).
 */
const TRIGGER: [number, number, number] = [0.3, 0, -0.42];
/** The bolt's axis (gun-local y, z): its shroud's. */
const BOLT_AXIS: [number, number] = [0, 1.2];

/** Barrel axis height, scope axis height. */
const BZ = 1.0, SZ = 2.95;
const RAKE = (22 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.3];
const GRIP_LEN = 3.4, GRIP_DEPTH = 1.75;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Receiver and the bolt (Pump bone: shroud at the back, the handle on the left).
  slab(k, [[-0.8, -0.35], [5.8, -0.35], [5.9, 1.55], [-0.6, 1.55], [-0.9, 1.1]], -0.62, 0.62, { paint: RECV, part: PART.blade, round: 0.14, bevel: 0.1 });
  box(k, [3.0, -0.63, 1.3], [0.9, 0.03, 0.12], { paint: RECV_DARK, bevel: 0.01 });
  lathe(k, [[-1.1, 0.0], [-1.1, 0.2], [-0.95, 0.3], [-0.6, 0.3]], { c: [0, BZ + 0.2], paint: STEEL_LIGHT, sides: 10, bone: "Pump" });
  rod(k, [2.7, -0.55, 1.3], [2.75, -1.2, 1.05], 0.1, { paint: STEEL_LIGHT, bone: "Pump" });
  ball(k, [2.75, -1.3, 1.0], [0.24, 0.24, 0.24], { paint: STEEL_LIGHT, bone: "Pump", sides: 8 });
  // --- The long barrel and its brake.
  lathe(k, [[5.8, 0.4], [24.6, 0.3], [24.6, 0.44], [26.4, 0.44], [26.4, 0.2], [26.1, 0.2]], { c: [0, BZ], paint: (i) => (i >= 4 ? BORE : i >= 2 ? RECV_DARK : STEEL), sides: 12, part: PART.blade });
  if (fp) for (const x of [25.15, 25.75]) for (const y of [-1, 1]) box(k, [x, y * 0.42, BZ], [0.16, 0.04, 0.22], { paint: BORE, round: 0 });
  // --- Scope: bells front and back, two turrets, two mounts, an orange ring.
  lathe(k, [[-0.8, 0.5], [-0.3, 0.6], [0.6, 0.6], [1.1, 0.42], [5.4, 0.42], [6.1, 0.66], [7.5, 0.7]], { c: [0, SZ], paint: (i) => (i === 0 || i === 5 ? RECV_DARK : STEEL), cap: RECV_DARK, sides: 14 });
  lathe(k, [[7.5, 0.6], [7.52, 0.6]], { c: [0, SZ], paint: LENS, cap: LENS, sides: 14 });
  lathe(k, [[-0.84, 0.42], [-0.82, 0.42]], { c: [0, SZ], paint: LENS, cap: LENS, sides: 14 });
  if (fp) {
    pins(k, [[1.6, 2.15], [4.6, 2.15]], 0.27, 0.09, { paint: STEEL_LIGHT, h: 0.05 });
    for (const y of [-0.62, 0.62]) groove(k, -0.5, 5.6, 0.45, y, { paint: LINE, lip: LIP });
  }
  lathe(k, [[7.45, 0.74], [7.7, 0.74]], { c: [0, SZ], paint: ORANGE, sides: 14, capStart: false, capEnd: false });
  rod(k, [3.2, 0, SZ + 0.38], [3.2, 0, SZ + 0.78], 0.22, { paint: RECV_DARK });
  rod(k, [3.2, 0.38, SZ], [3.2, 0.74, SZ], 0.2, { paint: RECV_DARK });
  for (const x of [1.6, 4.6]) box(k, [x, 0, (1.55 + SZ - 0.4) / 2], [0.28, 0.26, (SZ - 0.4 - 1.55) / 2 + 0.06], { paint: RECV_DARK, round: 0.08 });
  // --- Forestock (pea green, where the left hand rests), guard, trigger, grip, the stock with a cheek rest.
  // (Its belly rises to a slim rounded tip past the support hand, v0.0.37 polish: it ran on as one flat bar.)
  slab(k, [[5.5, -0.6], [12.6, -0.5], [15.0, -0.12], [15.3, 0.4], [15.0, 0.85], [5.5, 0.85]], -0.7, 0.7, { paint: PEA, part: PART.grip, round: [0.3, 0.8, 0.6, 0.3, 0.3, 0.3], bevel: 0.16 });
  // A short guard round the trigger, open at the back where it meets the grip's swell.
  guard(k, [[1.65, -0.35], [1.58, -1.26], [0.85, -1.42], [0.3, -1.36]], 0.14, { paint: PEA_DARK, open: true });
  trigger(k, TRIGGER, 0.55, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  // The grip: thin at the top (the firing index runs along it to the trigger), full depth below the guard where the
  // other three fingers wrap it (a palm swell), as two slabs (a notched outline doesn't cap as one).
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 0.35), [0.1, -0.45], [-0.08, -0.98], along(b0, 0.8, -0.05)], -0.6, 0.6, { paint: PEA, part: PART.grip, round: 0.18, bevel: 0.14 });
  slab(k, [along(b0, 0.7, -0.05), [-0.12, -0.92], along(b0, 0.85, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.6, 0.6, { paint: PEA, part: PART.grip, round: 0.25, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 1.3, 0.3), along(b0, 1.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: GRIP, part: PART.grip, round: 0.15, bevel: 0.02 });
  // The stock: a slim wrist, then the cheek rest rises out of it as one raised comb (v0.0.37 polish: it was a box
  // stuck on a straight-sided stock), a rounded heel and toe, the belly sweeping down; a rubber pad following the butt.
  slab(k, [[-0.85, 1.35], [-2.5, 0.95], [-4.1, 1.78], [-8.7, 1.82], [-9.45, 1.45], [-9.55, -1.95], [-8.7, -2.2], [-4.6, -1.4], [-2.3, -0.72], [-0.9, -0.35]], -0.6, 0.6, { paint: PEA, round: [0.3, 0.7, 0.6, 0.5, 0.45, 0.3, 0.6, 1.0, 0.6, 0.3], bevel: 0.16 });
  if (fp) for (const y of [-0.6, 0.6]) groove(k, -8.4, -4.4, 1.32, y, { paint: PEA_DARK, lip: PEA });
  slab(k, [[-9.42, 1.4], [-9.82, 1.32], [-9.9, -1.85], [-9.5, -2.1]], -0.63, 0.63, { paint: PAD, round: 0.16, bevel: 0.08 });
  // --- Magazine (Mag bone): a short box ahead of the guard.
  box(k, [5.1, 0, -0.95], [0.45, 0.4, 0.68], { paint: RECV_DARK, bone: "Mag", round: 0.12 });
  box(k, [5.1, 0, -1.68], [0.52, 0.46, 0.08], { paint: ORANGE, bone: "Mag", round: 0.05 });
}

export const beanpole: GunDef = {
  id: "awp",
  name: "Beanpole",
  archetype: "Sniper rifle",
  blurb: "A very long, very green bolt-action rifle.",
  cls: "sniper",
  build,
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
    o: [10.9, 0.0, 0.0],
    up: [0.976, 0.195, -0.098],
    fwd: [0.218, -0.873, 0.436],
    index: { c: [60, 80, 60] },
    middle: { c: [64, 84, 64] },
    ring: { c: [68, 86, 64] },
    pinky: { c: [72, 86, 64] },
    thumb: { c: [14, 40, 40], spread: -6 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  places: {
    mag: { o: [5.1, 0, -2.3], up: [0, 0, 1], fwd: [1, 0, 0] },
    rack: { o: [2.75, 1.9, 1.0], up: [0, 0, 1], fwd: [1, 0, 0] },
    // The firing hand on the bolt knob (right side): pinched from behind and below.
    bolt: { o: [2.55, -1.75, 0.75], up: [0.2, 0, 1], fwd: [1, -0.1, 0] },
  },
  frame: { o: [16, -6.2, -6.2], a: [-1, 4, -4] },
  trigger: TRIGGER,
  bolt: { axis: BOLT_AXIS, side: -1 },
  elbows: { R: [6.85, -10.55, -15.8], L: [21.5, 1.6, -14.05] },
  muzzle: [26.5, 0, BZ],
  eject: { p: [3.0, -0.6, 1.2], dir: [-0.15, -0.9, 0.4] },
  shell: "smg",
  mag: { p: [5.1, 0, -0.3], out: [0, 0, -1] },
  timing: { cycle: 1.455, ammo: 10, reload: 3.7, draw: 1.0, pump: { at: 0.25, dur: 0.95 } },
  recoil: { kick: 8, back: 1.5, roll: 1.2, settle: 130, slide: 0, slideTime: 0 },
  sounds: { fire: "gun_beanpole_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", pump: "gun_beanpole_bolt" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
