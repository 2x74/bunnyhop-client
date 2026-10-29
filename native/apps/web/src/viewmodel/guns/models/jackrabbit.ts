// Jackrabbit (fiveseven): the heavy pistol. A long, squared-off bronze slide with a vented muzzle brake and a rear
// sight made of two tall hare's ears (pink inside), over a black frame with a deep beaver tail and a chunky grip.
// Original design: no real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a bronze steel slide with a machined step along each flank's foot, front cocking
// slots, side vents through the brake, the barrel hood in the port and an extractor; a black polymer frame with a
// steel slide stop, the takedown tab, pins, checkered grip panels; a steel trigger that swings back (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { boneOf, box, groove, guard, lathe, pins, plate, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { GunDef } from "../types";

const SLIDE = fixed(0x8a6c45, "metal"), SLIDE_TOP = fixed(0x6e5534, "metal"), SLIDE_DARK = fixed(0x4f3d26, "dark"), FRAME = fixed(0x2c2c31), FRAME_DARK = fixed(0x1f1f23, "grip");
const EAR = fixed(0x8a6c45), EAR_IN = fixed(0xf0a8a8), BORE = fixed(0x121316), ORANGE = fixed(0xff7a1a), STEEL = fixed(0x9aa0a8, "metal");
const LEVER = fixed(0x3a3b40, "dark"), MAG_BASE = fixed(0x1f1f23), MAG = fixed(0x4f3d26, "dark"), LIP = fixed(0xc9a874, "metal");
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.8, 0, -0.52];

const RAKE = (20 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.55, -0.05];
const GRIP_LEN = 3.9, GRIP_DEPTH = 1.95;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Slide: long and square, a flat darker top rib, the brake's vents at the front.
  slab(k, [[-0.65, 0.1], [7.7, 0.1], [7.75, 1.5], [-0.6, 1.5]], -0.56, 0.56, { paint: SLIDE, bone: "Slide", part: PART.blade, round: 0.12, bevel: 0.1 });
  box(k, [3.6, 0, 1.53], [3.9, 0.3, 0.05], { paint: SLIDE_TOP, bone: "Slide", bevel: 0.02 });
  if (fp) {
    for (let i = 0; i < 3; i++) box(k, [6.65 + i * 0.36, 0, 1.53], [0.1, 0.42, 0.04], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01 });
    for (let i = 0; i < 3; i++) for (const y of [-1, 1]) box(k, [-0.25 + i * 0.3, y * 0.56, 0.8], [0.07, 0.025, 0.5], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01, round: 0.03 });
    for (const y of [-1, 1]) {
      // A machined step along the foot of each flank, three short cocking slots at the front, the brake's side vents.
      groove(k, 0.25, 6.3, 0.42, y * 0.56, { paint: SLIDE_DARK, lip: LIP, h: 0.04, bone: "Slide" });
      for (let i = 0; i < 2; i++) plate(k, [5.55 + i * 0.32, y * 0.566, 0.98], [0.06, 0.012, 0.34], { paint: SLIDE_DARK, bone: "Slide" });
      for (let i = 0; i < 2; i++) plate(k, [6.85 + i * 0.42, y * 0.566, 1.02], [0.12, 0.012, 0.2], { paint: BORE, bone: "Slide" });
    }
    // The barrel's hood in the port, the extractor.
    plate(k, [2.95, -0.2, 1.585], [0.45, 0.17, 0.012], { paint: STEEL });
    plate(k, [2.0, -0.57, 1.25], [0.34, 0.012, 0.05], { paint: STEEL, bone: "Slide" });
  }
  box(k, [2.8, -0.22, 1.55], [0.7, 0.22, 0.03], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01 });
  // The ears: two tall leaves standing up at the back, tipped back a little, pink inside.
  for (const y of [-0.24, 0.24]) {
    const path: [number, number, number][] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      path.push([-0.25 - 0.35 * t * t, y * (1 + 0.5 * t), 1.5 + 1.05 * t]);
    }
    // On the Aux bone: they ride the slide and flop with each shot and twitch in the inspect (guns/pose.ts).
    k.leaf(path, (i) => 0.2 * Math.sin(((i + 0.4) / 5.5) * Math.PI) + 0.03, 0.08, [0, y > 0 ? 1 : -1, 0], () => EAR, { bone: boneOf("Aux"), part: PART.guard });
    if (fp) k.leaf(path.slice(1, 5).map((p) => [p[0] + 0.02, p[1] * 1.02, p[2]] as [number, number, number]), (i) => 0.1 * Math.sin(((i + 0.4) / 4) * Math.PI) + 0.02, 0.05, [0, y > 0 ? 1 : -1, 0], () => EAR_IN, { bone: boneOf("Aux"), part: PART.guard });
  }
  box(k, [7.3, 0, 1.6], [0.12, 0.07, 0.1], { paint: ORANGE, bone: "Slide" });
  lathe(k, [[7.6, 0.3], [7.82, 0.3], [7.82, 0.2], [7.7, 0.2]], { c: [0, 0.8], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 12, bone: "Slide" });

  // --- Frame, guard, the long trigger, the grip with a deep beaver tail.
  slab(k, [[-0.55, 0.15], [7.2, 0.15], [7.2, -0.3], [6.4, -0.6], [2.4, -0.62], [0.7, -0.52], [-0.55, -0.22]], -0.5, 0.5, { paint: FRAME, part: PART.blade, round: 0.08 });
  guard(k, [[3.75, -0.55], [3.7, -1.55], [2.6, -1.72], [1.65, -1.45], [1.55, -0.85]], 0.14, { paint: FRAME, open: true });
  trigger(k, TRIGGER, 0.76, { paint: STEEL, r: 0.08 });
  if (fp) {
    plate(k, [1.2, 0.51, 0.0], [0.55, 0.025, 0.065], { paint: LEVER });
    plate(k, [1.68, 0.53, -0.09], [0.1, 0.03, 0.11], { paint: LEVER });
    for (const y of [-0.51, 0.51]) plate(k, [3.55, y, -0.24], [0.09, 0.02, 0.12], { paint: LEVER });
    pins(k, [[2.2, -0.34], [0.0, -0.38]], 0.51, 0.085, { paint: STEEL, h: 0.05 });
  }
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.12), along(b0, -0.08, 0.95), [1.45, -0.66], along(b0, 1.1, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.05), along(b0, GRIP_LEN, 0.0), along(b0, 1.6, -0.08)], -0.6, 0.6, { paint: FRAME, part: PART.grip, round: 0.2, bevel: 0.15 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 0.6, 0.3), along(b0, 0.6, GRIP_DEPTH - 0.32), along(b0, GRIP_LEN - 0.3, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.3, 0.3)], y > 0 ? 0.58 : -0.62, y > 0 ? 0.62 : -0.58, { paint: FRAME_DARK, part: PART.grip, round: 0.15, bevel: 0.02 });
  slab(k, [[-0.5, 0.12], [-1.15, 0.05], [-1.2, -0.15], [-0.55, -0.15]], -0.42, 0.42, { paint: FRAME, round: 0.1 });
  // --- Magazine.
  slab(k, [along(b0, 0.35, 0.3), along(b0, 0.35, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.02, GRIP_DEPTH - 0.45), along(b0, GRIP_LEN - 0.02, 0.3)], -0.44, 0.44, { paint: MAG, bone: "Mag", round: 0.08 });
  slab(k, [along(b0, GRIP_LEN - 0.05, -0.05), along(b0, GRIP_LEN - 0.05, GRIP_DEPTH + 0.05), along(b0, GRIP_LEN + 0.3, GRIP_DEPTH - 0.05), along(b0, GRIP_LEN + 0.3, 0.02)], -0.62, 0.62, { paint: MAG_BASE, bone: "Mag", round: 0.12, bevel: 0.1 });
}

export const jackrabbit: GunDef = {
  id: "fiveseven",
  name: "Jackrabbit",
  archetype: "Heavy pistol",
  blurb: "A long, heavy pistol with its ears up.",
  cls: "pistol",
  build,
  right: {
    o: [-0.89, 0.0, -3.02],
    up: [-0.28, 0, 0.96],
    fwd: [0.831, 0.5, 0.242],
    index: { c: [16, 36, 22], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [8, 6, 4], spread: -18 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  left: {
    o: [-1.59, 0.0, -1.78],
    up: [0.45, 0, 0.89],
    fwd: [0.876, -0.173, -0.443],
    index: { c: [62, 70, 50] },
    middle: { c: [70, 80, 60] },
    ring: { c: [76, 84, 62] },
    pinky: { c: [80, 84, 60] },
    thumb: { c: [10, 4, 4], spread: -26 },
    wrap: ["Index", "Middle", "Ring", "Pinky"],
    proxy: [[gripAt(0.9, GRIP_DEPTH + 0.55), gripAt(GRIP_LEN - 0.2, GRIP_DEPTH + 0.5), 0.75]],
  },
  places: {
    mag: { o: gripAt(GRIP_LEN + 0.55, 1.0), up: [UP[0], 0, UP[1]], fwd: [FWD[0], 0, FWD[1]] },
    rack: { o: [0.25, 0.95, 0.75], up: [-1, 0, 0], fwd: [0, 0, 1] },
  },
  // 0.6 lower than v0.0.28 (-3.8) since the v0.0.29 default framing (viewmodel/defaults.ts) lifts the hands: the support
  // cuff stays under the grip instead of standing up in front of the gloves.
  frame: { o: [18.5, -5.2, -4.4], a: [0, 6, -5] },
  trigger: TRIGGER,
  muzzle: [7.9, 0, 0.8],
  eject: { p: [2.8, -0.3, 1.58], dir: [-0.1, -0.85, 0.5] },
  shell: "pistol",
  mag: { p: [...gripAt(GRIP_LEN, 0.95)] as [number, number, number], out: [-UP[0], 0, -UP[1]] },
  timing: { cycle: 0.15, ammo: 20, reload: 3.1, draw: 1.0 },
  recoil: { kick: 6.5, back: 0.75, roll: 1.4, settle: 200, slide: 1.4, slideTime: 0.1 },
  sounds: { fire: "gun_jackrabbit_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", slide: "gun_slide" },
  tp: { o: [1.6, -0.9, 0.2], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.6 },
};
