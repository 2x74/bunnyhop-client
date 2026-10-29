// Hedgerow (xm1014): the auto shotgun. A tall dark receiver with a hedge-green handguard cut with leaf-shaped vents, a
// bolt handle on the left you can see (and tug), a looped skeleton stock and a green front sight. Original design: no
// real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a dark steel receiver with a slotted top rail, the bolt face in the port and pins
// for the trigger group, a blued barrel, the polymer handguard (sheen), checkered grip panels, a dark steel skeleton
// stock with a rubber pad; a steel trigger that swings back (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { ball, box, groove, guard, lathe, pins, plate, rod, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { GunDef } from "../types";

const RECV = fixed(0x34383f, "dark"), RECV_DARK = fixed(0x24272c, "dark"), GREEN = fixed(0x557d47), GREEN_DARK = fixed(0x3c5c33), VENT = fixed(0x1d2a1a);
const STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x707782, "metal"), BORE = fixed(0x101114), LEAF = fixed(0x7fd36a), HULL = fixed(0xc43c2c), BRASS = fixed(0xd8a640, "metal");
const GRIP = fixed(0x3c5c33, "grip"), PAD = fixed(0x26282b, "grip"), SLOT = fixed(0x17191c), LIP = fixed(0x5d636d, "metal");
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.55, 0, -0.35];

const BZ = 1.35, TZ = 0.3;
const RAKE = (22 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.3];
const GRIP_LEN = 3.4, GRIP_DEPTH = 1.75;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Receiver: tall, a top rail, the loading port under it, the ejection port on the right.
  slab(k, [[-0.8, -0.35], [6.2, -0.35], [6.3, 2.05], [-0.6, 2.05], [-0.9, 1.5]], -0.76, 0.76, { paint: RECV, part: PART.blade, round: 0.14, bevel: 0.1 });
  box(k, [2.6, 0, 2.12], [2.8, 0.3, 0.08], { paint: RECV_DARK, round: 0.04 });
  box(k, [2.6, 0, -0.37], [1.25, 0.42, 0.03], { paint: RECV_DARK, bevel: 0.01 });
  box(k, [2.6, -0.77, 1.3], [0.9, 0.03, 0.35], { paint: RECV_DARK, bevel: 0.01 });
  if (fp) {
    // Slots across the top rail, the bolt face in the port (it rides the bolt), pins for the trigger group.
    for (let i = 0; i < 7; i++) plate(k, [0.3 + i * 0.75, 0, 2.205], [0.14, 0.31, 0.014], { paint: SLOT });
    for (const y of [-0.76, 0.76]) groove(k, -0.5, 6.0, 0.55, y, { paint: SLOT, lip: LIP });
    plate(k, [2.45, -0.795, 1.3], [0.4, 0.012, 0.24], { paint: STEEL_LIGHT, bone: "Slide" });
    pins(k, [[1.2, -0.08], [4.0, -0.08]], 0.76, 0.095, { paint: STEEL_LIGHT, h: 0.05 });
  }
  // Bolt handle (Slide bone) on the left: a short stalk with a ball.
  rod(k, [3.2, 0.7, 1.3], [3.2, 1.25, 1.3], 0.11, { paint: STEEL_LIGHT, bone: "Slide" });
  ball(k, [3.2, 1.35, 1.3], [0.2, 0.2, 0.2], { paint: STEEL_LIGHT, bone: "Slide", sides: 8 });
  box(k, [3.2, 0.77, 1.3], [0.6, 0.03, 0.12], { paint: RECV_DARK, bevel: 0.01 });
  // --- Barrel, tube, the green front sight.
  lathe(k, [[6.2, 0.42], [21.6, 0.4], [22, 0.4], [22, 0.23], [21.7, 0.23]], { c: [0, BZ], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 14, part: PART.blade });
  lathe(k, [[6.2, 0.4], [19.3, 0.4], [19.6, 0.32], [19.7, 0]], { c: [0, TZ], paint: STEEL, sides: 12 });
  box(k, [21.2, 0, BZ + 0.55], [0.18, 0.06, 0.2], { paint: LEAF, round: 0.05 });
  // --- Handguard: a green sleeve around barrel and tube, leaf vents along its sides.
  slab(k, [[6.3, -0.55], [15.5, -0.45], [15.7, 1.0], [15.4, 1.95], [6.3, 1.95]], -0.82, 0.82, { paint: (i) => (i === 0 || i === 3 ? GREEN_DARK : GREEN), part: PART.grip, round: 0.3, bevel: 0.16 });
  if (fp) for (const y of [-1, 1]) for (let i = 0; i < 5; i++) {
    const x = 7.6 + i * 1.6;
    k.leaf([[x - 0.45, y * 0.83, 0.75], [x, y * 0.84, 0.95], [x + 0.45, y * 0.83, 1.15]], (j) => [0.06, 0.2, 0.06][j] ?? 0.06, 0.03, [0, y, 0], () => VENT);
  }
  // --- Guard, trigger, the polymer grip, the looped skeleton stock.
  guard(k, [[3.5, -0.35], [3.4, -1.3], [2.2, -1.45], [1.4, -1.2], [1.35, -0.65]], 0.14, { paint: RECV, open: true });
  trigger(k, TRIGGER, 0.67, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 1.0), [1.25, -0.5], along(b0, 1.1, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.6, 0.6, { paint: RECV, part: PART.grip, round: 0.25, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 0.6, 0.3), along(b0, 0.6, GRIP_DEPTH - 0.3), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: GRIP, part: PART.grip, round: 0.15, bevel: 0.02 });
  guard(k, [[-0.85, 1.55], [-6.5, 1.25], [-6.6, -1.6], [-2.2, -1.0], [-0.9, -0.5]], 0.22, { paint: RECV });
  box(k, [-6.6, 0, -0.15], [0.35, 0.55, 1.75], { paint: PAD, round: 0.25 });
  // --- The shell the left hand loads (Aux, hidden until a reload): red hull, brass base.
  lathe(k, [[1.6, 0.33], [1.72, 0.33], [1.72, 0.3], [2.85, 0.29], [2.9, 0.2]], { c: [0, TZ], paint: (i) => (i < 1 ? BRASS : HULL), sides: 10, bone: "Aux" });
}

export const hedgerow: GunDef = {
  id: "xm1014",
  name: "Hedgerow",
  archetype: "Auto shotgun",
  blurb: "A self-loading shotgun with a leafy green handguard.",
  cls: "shotgun",
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
  // The support hand under the handguard, palm up, fingers over its right side (placement from
  // tools/viewmodel/gun-grip-fit.ts); its forearm drops toward the elbow anchor below it, out of view.
  left: {
    o: [9.9, 0.0, 0.0],
    up: [1, 0, 0],
    fwd: [0.0, -0.848, 0.53],
    index: { c: [60, 80, 60] },
    middle: { c: [64, 84, 64] },
    ring: { c: [68, 86, 64] },
    pinky: { c: [72, 86, 64] },
    thumb: { c: [14, 40, 40], spread: -6 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.12,
  },
  places: {
    port: { o: [2.1, 0, -1.3], up: [1, 0, 0], fwd: [0, -1, 0.3] },
    rack: { o: [3.2, 2.2, 1.3], up: [0, 0, 1], fwd: [1, 0, 0] },
  },
  frame: { o: [16, -6.2, -6.0], a: [-1, 4, -4] },
  trigger: TRIGGER,
  elbows: { R: [8, -18, -18], L: [24, -6, -26] },
  wrist: { L: 34 },
  muzzle: [22.1, 0, BZ],
  eject: { p: [2.6, -0.85, 1.3], dir: [-0.15, -0.9, 0.4] },
  shell: "shotgun",
  timing: { cycle: 0.25, ammo: 7, shells: { start: 0.45, each: 0.45, end: 0.6 }, draw: 1.0 },
  recoil: { kick: 6, back: 1.1, roll: 1.3, settle: 170, slide: 1.4, slideTime: 0.1 },
  sounds: { fire: "gun_hedgerow_fire", slide: "gun_bolt", shell: "gun_shell_in" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
