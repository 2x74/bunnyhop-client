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
import type { GunDef } from "../types";

const RECV = fixed(0x3a3e45, "dark"), RECV_DARK = fixed(0x26292e, "dark"), PEA = fixed(0x6f9150), PEA_DARK = fixed(0x55733d), STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x7a818c, "metal");
const BORE = fixed(0x101114), LENS = fixed(0x2f6f73, "glass"), ORANGE = fixed(0xff7a1a), GRIP = fixed(0x55733d, "grip"), PAD = fixed(0x26292e, "grip");
const LINE = fixed(0x17191c), LIP = fixed(0x626a76, "metal");
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.55, 0, -0.35];
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
  slab(k, [[5.5, -0.6], [15.0, -0.45], [15.3, 0.25], [15.0, 0.85], [5.5, 0.85]], -0.7, 0.7, { paint: PEA, part: PART.grip, round: 0.3, bevel: 0.16 });
  guard(k, [[3.5, -0.35], [3.4, -1.3], [2.2, -1.45], [1.4, -1.2], [1.35, -0.65]], 0.14, { paint: PEA_DARK, open: true });
  trigger(k, TRIGGER, 0.67, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 1.0), [1.25, -0.5], along(b0, 1.1, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.6, 0.6, { paint: PEA, part: PART.grip, round: 0.25, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 0.6, 0.3), along(b0, 0.6, GRIP_DEPTH - 0.3), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: GRIP, part: PART.grip, round: 0.15, bevel: 0.02 });
  slab(k, [[-0.85, 1.35], [-9.4, 1.35], [-9.6, -2.0], [-8.4, -2.1], [-3.0, -1.0], [-0.9, -0.35]], -0.6, 0.6, { paint: PEA, round: 0.32, bevel: 0.15 });
  box(k, [-5.4, 0, 1.55], [2.2, 0.48, 0.25], { paint: PEA_DARK, round: 0.2 });
  box(k, [-9.65, 0, -0.32], [0.22, 0.62, 1.6], { paint: PAD, round: 0.18 });
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
    o: [10.9, 0.0, 0.0],
    up: [1, 0, 0],
    fwd: [0.0, -0.848, 0.53],
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
  elbows: { R: [8, -18, -18], L: [24, -6, -26] },
  wrist: { L: 34 },
  muzzle: [26.5, 0, BZ],
  eject: { p: [3.0, -0.6, 1.2], dir: [-0.15, -0.9, 0.4] },
  shell: "smg",
  mag: { p: [5.1, 0, -0.3], out: [0, 0, -1] },
  timing: { cycle: 1.455, ammo: 10, reload: 3.7, draw: 1.0, pump: { at: 0.25, dur: 0.95 } },
  recoil: { kick: 8, back: 1.5, roll: 1.2, settle: 130, slide: 0, slideTime: 0 },
  sounds: { fire: "gun_beanpole_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", pump: "gun_beanpole_bolt" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
