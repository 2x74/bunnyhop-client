// Thumper (glock): the burst pistol. A compact blocky polymer pistol in sage with a graphite slide, a soft rounded nose,
// three carrot-orange dots on the slide's flank for its three-round burst, and a rabbit's-foot pad for a magazine
// base (three little toe beans). Original design: no real-world silhouette or markings.

import { fixed } from "../../knives/ctx";
import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { box, dome, guard, lathe, rod, slab, type P2 } from "../shapes";
import type { GunDef } from "../types";

const SLIDE = fixed(0x4d525c), SLIDE_DARK = fixed(0x363a42), FRAME = fixed(0x6f8a6a), FRAME_DARK = fixed(0x56705a);
const ORANGE = fixed(0xff7a1a), BORE = fixed(0x14161a), PAD = fixed(0xf0a8a0), BEAN = fixed(0xf7c4bc), STEEL = fixed(0x8b9099);

/** Grip rake: the grip's axis leans back 18 degrees from vertical (up = forward). */
const RAKE = (18 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.05];
const GRIP_LEN = 3.75, GRIP_DEPTH = 1.85;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Slide (Slide bone: it recoils): a long block with a rounded nose, cocking grooves at the rear.
  slab(k, [[-0.55, 0.1], [6.5, 0.1], [6.68, 0.75], [6.42, 1.42], [-0.5, 1.42], [-0.62, 0.8]], -0.48, 0.48, { paint: SLIDE, bone: "Slide", part: PART.blade, round: 0.16, bevel: 0.1 });
  if (fp) for (let i = 0; i < 4; i++) for (const y of [-1, 1]) box(k, [-0.15 + i * 0.22, y * 0.49, 0.82], [0.045, 0.02, 0.42], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01, round: 0.02 });
  // Ejection port (top right) and the barrel's hood showing in it.
  box(k, [2.7, -0.18, 1.43], [0.75, 0.24, 0.03], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01 });
  // Sights: a stubby rear block, the orange front post.
  box(k, [-0.25, 0, 1.52], [0.14, 0.36, 0.1], { paint: SLIDE_DARK, bone: "Slide" });
  box(k, [6.05, 0, 1.52], [0.12, 0.08, 0.11], { paint: ORANGE, bone: "Slide" });
  // Burst dots: three orange beans on the left flank (the side the camera sees).
  for (let i = 0; i < 3; i++) dome(k, [4.35 + i * 0.36, 0.48, 0.95], [0, 1, 0], 0.11, { paint: ORANGE, bone: "Slide", h: 0.05, sides: 8 });
  // Muzzle: the barrel's mouth in the slide's nose.
  lathe(k, [[6.55, 0.27], [6.72, 0.27], [6.72, 0.17], [6.6, 0.17]], { c: [0, 0.78], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 12, bone: "Slide" });

  // --- Frame (polymer): dust cover under the slide, the trigger guard, the raked grip.
  slab(k, [[-0.45, 0.15], [6.2, 0.15], [6.25, -0.2], [5.55, -0.52], [2.2, -0.58], [0.6, -0.5], [-0.45, -0.2]], -0.44, 0.44, { paint: FRAME, part: PART.blade, round: 0.1 });
  guard(k, [[3.55, -0.5], [3.42, -1.48], [2.4, -1.62], [1.6, -1.35], [1.5, -0.8]], 0.13, { paint: FRAME, open: true });
  rod(k, [2.62, 0, -0.5], [2.74, 0, -0.9], 0.075, { paint: ORANGE });
  rod(k, [2.74, 0, -0.9], [2.66, 0, -1.2], 0.075, { paint: ORANGE });
  // Grip: a raked slab, front strap with three soft finger bumps (sage, darker panel inset on the sides).
  const b0 = BACK0;
  const grip: P2[] = [
    along(b0, 0, -0.12),
    along(b0, -0.1, 0.9),
    [1.42, -0.62],
    along(b0, 1.05, GRIP_DEPTH),
    along(b0, 1.9, GRIP_DEPTH + 0.06),
    along(b0, 2.75, GRIP_DEPTH + 0.04),
    along(b0, GRIP_LEN, GRIP_DEPTH - 0.08),
    along(b0, GRIP_LEN, 0.05),
    along(b0, 1.6, -0.04),
  ];
  slab(k, grip, -0.55, 0.55, { paint: FRAME, part: PART.grip, round: 0.22, bevel: 0.14 });
  if (fp) for (const y of [-1, 1]) slab(k, [along(b0, 0.7, 0.35), along(b0, 0.7, GRIP_DEPTH - 0.35), along(b0, GRIP_LEN - 0.35, GRIP_DEPTH - 0.45), along(b0, GRIP_LEN - 0.35, 0.35)], y > 0 ? 0.53 : -0.57, y > 0 ? 0.57 : -0.53, { paint: FRAME_DARK, part: PART.grip, round: 0.2, bevel: 0.02 });
  // Beaver tail over the web of the hand.
  slab(k, [[-0.45, 0.12], [-0.95, 0.02], [-0.98, -0.12], [-0.5, -0.12]], -0.38, 0.38, { paint: FRAME, round: 0.1 });

  // --- Magazine (Mag bone): the body inside the grip, the rabbit's-foot base pad with three toe beans.
  const m0 = along(b0, 0.35, 0.3), m1 = along(b0, GRIP_LEN - 0.02, 0.3);
  slab(k, [m0, along(b0, 0.35, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.02, GRIP_DEPTH - 0.45), m1], -0.4, 0.4, { paint: SLIDE_DARK, bone: "Mag", round: 0.08 });
  slab(k, [along(b0, GRIP_LEN - 0.05, -0.08), along(b0, GRIP_LEN - 0.05, GRIP_DEPTH + 0.02), along(b0, GRIP_LEN + 0.32, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN + 0.32, 0.02)], -0.6, 0.6, { paint: PAD, bone: "Mag", round: 0.16, bevel: 0.12 });
  for (let i = 0; i < 3; i++) {
    const p = along(b0, GRIP_LEN + 0.33, 0.45 + i * 0.5);
    dome(k, [p[0], (i - 1) * 0.12, p[1]], [-UP[0], 0, -UP[1]], 0.2, { paint: BEAN, bone: "Mag", h: 0.1, sides: 8 });
  }
}

const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};

export const thumper: GunDef = {
  id: "glock",
  name: "Thumper",
  archetype: "Burst pistol",
  blurb: "A compact pistol that thumps out three at a time.",
  cls: "pistol",
  build,
  right: {
    o: [-0.66, 0.0, -1.9],
        up: [-0.28, 0, 0.96],
    fwd: [0.96, 0.0, 0.28],
    index: { c: [18, 38, 22], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [8, 6, 4], spread: -18 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  left: {
    o: [-0.51, 0.0, -3.02],
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
    mag: { o: gripAt(GRIP_LEN + 0.55, 0.95), up: [UP[0], 0, UP[1]], fwd: [FWD[0], 0, FWD[1]] },
    rack: { o: [0.25, 0.95, 0.75], up: [-1, 0, 0], fwd: [0, 0, 1] },
  },
  frame: { o: [18, -5.2, -3.6], a: [0, 6, -5] },
  muzzle: [6.8, 0, 0.78],
  eject: { p: [2.7, -0.3, 1.45], dir: [-0.1, -0.85, 0.5] },
  shell: "pistol",
  mag: { p: [...gripAt(GRIP_LEN, 0.9)] as [number, number, number], out: [-UP[0], 0, -UP[1]] },
  timing: { cycle: 0.15, ammo: 20, reload: 2.2, draw: 1.0, burst: { n: 3, gap: 0.05 } },
  recoil: { kick: 4.5, back: 0.55, roll: 1.2, settle: 260, slide: 1.25, slideTime: 0.085 },
  sounds: { fire: "gun_thumper_fire", magOut: "gun_mag_out", magIn: "gun_mag_in", slide: "gun_slide" },
  tp: { o: [1.6, -0.9, 0.2], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.7 },
};
