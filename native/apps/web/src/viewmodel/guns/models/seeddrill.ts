// Seed Drill (p90): the bullpup SMG. A rounded pebble of a body in sand and olive with a thumbhole grip and a front
// hand stop, and its magazine on top is a long green pea pod, split along its side so the peas show (it's what the
// left hand lifts off in a reload, and drums on in the inspect). A little sprout of a sight at the front. Original
// design: no real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a seam along the body where its two shells meet and three screws holding them,
// checkered thumbhole grip and hand stop, a glossy pod, a steel muzzle with a short flash ring; the trigger swings back
// with the squeeze (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { ball, boneOf, box, groove, guard, lathe, slab, stud, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { GunDef } from "../types";

const SAND = fixed(0xcdbf99), SAND_DARK = fixed(0xb0a27c), OLIVE = fixed(0x66744a), OLIVE_DARK = fixed(0x4c5737);
const POD = fixed(0x8fd16a), POD_DARK = fixed(0x5fa543), PEA = fixed(0xa6e07c), SPROUT = fixed(0x58c64a), BORE = fixed(0x121316), STEEL = fixed(0x707782, "metal"), ORANGE = fixed(0xff7a1a);
const GRIP = fixed(0x66744a, "grip"), SEAM = fixed(0x8a7d5b), SCREW = fixed(0x5b5f66, "metal"), LIP = fixed(0xeae0c0);
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [1.75, 0, -0.5];

const RAKE = (12 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.2, -0.45];
const GRIP_LEN = 3.0, GRIP_DEPTH = 1.6;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};
/** The pod's span along x and its axis height. */
const POD0 = -5.8, POD1 = 6.4, PODZ = 1.75;

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Upper body (sand): a long rounded pebble from the butt to the nose, the pod's bed on top.
  slab(k, [[-8.2, -0.5], [7.4, -0.5], [8.6, 0.1], [8.4, 1.1], [7.2, 1.3], [-8.0, 1.3], [-8.6, 0.5]], -0.95, 0.95, { paint: SAND, part: PART.blade, round: 0.6, bevel: 0.25 });
  // --- Stock (olive), under the rear.
  slab(k, [[-8.4, -0.4], [-2.4, -0.4], [-1.6, -1.6], [-3.2, -3.1], [-8.0, -3.4], [-8.6, -2.2]], -0.9, 0.9, { paint: OLIVE, round: 0.55, bevel: 0.22 });
  // --- Grip (olive), the thumbhole loop round the hand, the trigger.
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.1), along(b0, 0, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.05), along(b0, GRIP_LEN + 0.2, 0.7), along(b0, GRIP_LEN, -0.05)], -0.6, 0.6, { paint: GRIP, part: PART.grip, round: 0.3, bevel: 0.15 });
  guard(k, [[-1.6, -1.6], [-1.3, -3.6], along(b0, GRIP_LEN + 0.3, 0.4)], 0.22, { paint: OLIVE_DARK, open: true });
  guard(k, [[2.4, -0.55], [2.5, -2.0], along(b0, GRIP_LEN * 0.55, GRIP_DEPTH + 0.1)], 0.16, { paint: OLIVE_DARK, open: true, part: PART.grip });
  trigger(k, TRIGGER, 0.75, { paint: ORANGE, r: 0.08 });
  // --- Front: the hand stop under the nose, the muzzle.
  slab(k, [[3.0, -0.4], [7.2, -0.4], [7.6, -1.2], [6.8, -1.55], [4.0, -1.45], [3.2, -2.3], [2.7, -1.0]], -0.82, 0.82, { paint: GRIP, part: PART.grip, round: 0.35, bevel: 0.18 });
  lathe(k, [[8.4, 0.38], [9.2, 0.36], [9.2, 0.22], [8.95, 0.22]], { c: [0, 0.35], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 12 });
  if (fp) {
    // A short flash ring on the muzzle; the shells' seam along both flanks and three screws holding them.
    lathe(k, [[8.75, 0.4], [8.95, 0.4]], { c: [0, 0.35], paint: STEEL, sides: 12, capStart: false, capEnd: false });
    for (const y of [-0.95, 0.95]) groove(k, -7.6, 6.8, 0.38, y, { paint: SEAM, lip: LIP });
    for (const [x, z] of [[-6.9, 0.05], [-1.2, 0.85], [5.9, 0.05]] as const) for (const y of [-1, 1]) stud(k, [x, y * 0.93, z], [0, y, 0], 0.15, 0.06, { paint: SCREW });
  }
  // Charging knob on the left (Slide bone).
  box(k, [4.6, 0.98, 0.55], [0.35, 0.08, 0.16], { paint: OLIVE_DARK, bone: "Slide", round: 0.06 });
  ball(k, [4.6, 1.12, 0.55], [0.17, 0.12, 0.17], { paint: OLIVE_DARK, bone: "Slide", sides: 8 });
  if (fp) for (let i = 0; i < 4; i++) box(k, [-6.5 + i * 0.5, 0, 1.31], [0.12, 0.6, 0.02], { paint: SAND_DARK, bevel: 0.01 });
  // --- The pea pod (Mag bone): pointed both ends, a dark seam, peas in the split on the left.
  const rows: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    rows.push([POD0 + (POD1 - POD0) * t, 0.62 * Math.pow(Math.sin(Math.PI * t), 0.55) + 0.001]);
  }
  lathe(k, rows, { c: [0, PODZ], rz: 0.82, sides: fp ? 14 : 8, paint: (_i, kk) => (kk === 0 || kk === 7 ? POD_DARK : POD), bone: "Mag", part: PART.blade });
  if (fp) for (let i = 0; i < 8; i++) {
    const x = POD0 + 1.6 + i * 1.12;
    ball(k, [x, 0.5, PODZ + 0.05], [0.34, 0.24, 0.34], { paint: PEA, bone: "Mag", sides: 8 });
  }
  // The pod's stalk at the back, curling up (Aux: wobbles when drummed on).
  k.tube([[POD0 - 0.1, 0, PODZ], [POD0 - 0.5, 0, PODZ + 0.25], [POD0 - 0.6, 0, PODZ + 0.65]], 0.1, fp ? 6 : 5, [0, 1, 0], () => POD_DARK, { bone: boneOf("Aux") });
  // Sprout sight at the front, on the body.
  k.tube([[5.9, 0, 1.3], [5.95, 0, 1.75]], 0.06, 6, [1, 0, 0], () => SPROUT);
  for (const s of [-1, 1]) k.leaf([[5.95, 0, 1.72], [5.95 + s * 0.25, 0, 1.92], [5.95 + s * 0.5, 0, 1.98]], (i) => [0.04, 0.14, 0.04][i] ?? 0.04, 0.03, [0, 1, 0], () => SPROUT);
}

export const seeddrill: GunDef = {
  id: "p90",
  name: "Seed Drill",
  archetype: "Bullpup SMG",
  blurb: "A pebble-smooth bullpup fed from a pea pod.",
  cls: "smg",
  build,
  right: {
    o: [0.2, 0.0, -1.4],
    up: [-0.1, 0, 0.99],
    fwd: [0.172, 0.979, 0.017],
    index: { c: [14, 30, 18], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [14, 14, 8], spread: -6 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  left: {
    o: [5.2, 0.0, -1.6],
    up: [1, 0, 0.1],
    fwd: [0.018, -1.045, 0.172],
    index: { c: [70, 90, 66] },
    middle: { c: [76, 95, 72] },
    ring: { c: [84, 100, 76] },
    pinky: { c: [88, 100, 76] },
    thumb: { c: [14, 40, 40], spread: -6 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  places: {
    mag: { o: [0.6, 0, PODZ + 0.2], up: [-1, 0, 0], fwd: [0, -1, 0] },
    rack: { o: [4.6, 2.0, 0.6], up: [0, 0, 1], fwd: [1, 0, 0] },
  },
  frame: { o: [21, -6.4, -6.2], a: [-1, 4, -4] },
  trigger: TRIGGER,
  elbows: { R: [8, -18, -18], L: [22, 8, -30] },
  // The thumbhole grip turns the firing wrist (a straighter one sends the sleeve across the top of the screen); the
  // support wrist 34 keeps its sleeve as low as before.
  wrist: { R: 40, L: 34 },
  muzzle: [9.3, 0, 0.35],
  eject: { p: [-2.5, 0, -0.6], dir: [0, -0.2, -1] },
  shell: "smg",
  mag: { p: [0.3, 0, PODZ], out: [0, 0, 1] },
  timing: { cycle: 0.07, ammo: 50, reload: 3.3, draw: 1.0 },
  recoil: { kick: 1.6, back: 0.35, roll: 0.6, settle: 420, slide: 0, slideTime: 0 },
  sounds: { fire: "gun_seeddrill_fire", magOut: "gun_pod_out", magIn: "gun_pod_in", slide: "gun_bolt" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
