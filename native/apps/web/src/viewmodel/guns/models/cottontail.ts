// Cottontail (usp): the compact pistol. A short, tall, soft-cornered slide in oat cream over a dark blueberry frame,
// a grip with ribbed bands, and a fluffy white tail where a hammer would be (it wobbles when you flick it in the
// inspect). Original design: no real-world silhouette or markings.
//
// The silencer (physics v7): a short threaded barrel peeks out of the slide's nose; the can is a soft blueberry tube
// with an oat-cream collar (eight flats, where the hand turns it) and nose cap, and one carrot-orange stripe along its
// top so every turn of it reads. It screws onto the thread (guns/anim.ts silencer clip).
//
// Construction (gun polish, v0.0.29): painted cream slide and blueberry frame (polymer sheen), a steel barrel hood in
// the ejection port and a steel extractor, a slide stop lever and pins on the frame, checkered grip ribs, a dark steel
// magazine body, a trigger that swings back with the squeeze (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { ball, box, dome, groove, guard, lathe, pins, plate, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { GunDef, SilencerSpec } from "../types";

const SLIDE = fixed(0xd8d0bf), SLIDE_DARK = fixed(0xa79f8d), FRAME = fixed(0x343c50), FRAME_DARK = fixed(0x262c3c);
const TAIL = fixed(0xf6f3ec), TAIL_SHADE = fixed(0xe2ddd2), BORE = fixed(0x14161a), DOT = fixed(0xffffff), ORANGE = fixed(0xff7a1a), STEEL = fixed(0x8b9099, "metal");
const RIB = fixed(0x262c3c, "grip"), LEVER = fixed(0x22262f, "dark"), MAG = fixed(0x2e3440, "dark"), LINE = fixed(0x1c212d), LIP = fixed(0x5a6680);
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.4, 0, -0.48];

const RAKE = (15 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.45, -0.05];
const GRIP_LEN = 3.5, GRIP_DEPTH = 1.8;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};

/** The bore axis height, where the can's rear face seats (just ahead of the slide's nose ring), the thread's length. */
const BORE_Z = 0.8, SEAT = 5.82, THREAD = 0.42;
/** The can: length and radius. */
const CAN_L = 5.0, CAN_R = 0.56;

/** The silencer, seated (gun-local; bone Sil). Grip parts are what the support hand's solver closes onto. */
function buildSilencer(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const x0 = SEAT;
  const o = { c: [0, BORE_Z] as [number, number], bone: "Sil" };
  // Collar: eight flats (the hand's purchase; the facets show each turn), rounded into the body.
  lathe(k, [[x0, CAN_R - 0.1], [x0 + 0.06, CAN_R - 0.02], [x0 + 0.3, CAN_R + 0.02], [x0 + 0.6, CAN_R + 0.02], [x0 + 0.9, CAN_R + 0.02], [x0 + 0.98, CAN_R - 0.03]], { ...o, paint: SLIDE, cap: SLIDE_DARK, part: PART.grip, sides: 8, phase: Math.PI / 8 });
  // Body: a soft tube, rows every 0.3 so the grip solver and the audits see where a finger rests.
  const body: [number, number][] = [];
  for (let x = x0 + 0.96; x <= x0 + CAN_L - 0.42; x += fp ? 0.3 : 4) body.push([x, CAN_R]);
  body.push([x0 + CAN_L - 0.4, CAN_R]);
  lathe(k, body, { ...o, paint: FRAME, part: PART.grip, sides: fp ? 16 : 8, capStart: false, capEnd: false });
  // Nose cap: cream, rounded in to the bore.
  lathe(k, [[x0 + CAN_L - 0.42, CAN_R + 0.01], [x0 + CAN_L - 0.12, CAN_R + 0.01], [x0 + CAN_L - 0.02, CAN_R - 0.08], [x0 + CAN_L, CAN_R - 0.22], [x0 + CAN_L, 0.17]], { ...o, paint: SLIDE, part: PART.grip, sides: fp ? 16 : 8, capStart: false, capEnd: false });
  lathe(k, [[x0 + CAN_L - 0.08, 0.17], [x0 + CAN_L + 0.005, 0.17]], { ...o, paint: BORE, cap: BORE, sides: 10, capStart: false });
  // The carrot stripe along the top.
  box(k, [x0 + 0.98 + (CAN_L - 1.4) / 2, 0, BORE_Z + CAN_R - 0.02], [(CAN_L - 1.5) / 2, 0.09, 0.05], { paint: ORANGE, bone: "Sil", bevel: 0.02, round: 0.03 });
}

const silencer: SilencerSpec = {
  build: buildSilencer,
  axis: [0, BORE_Z],
  seat: SEAT,
  thread: THREAD,
  tip: [SEAT + CAN_L, 0, BORE_Z],
  // Overhand from the left: the palm on the can's left flank, the fingers over the top, the index side toward the gun
  // (the turning hand of the CS:S attach, original pose).
  grip: {
    o: [SEAT + 2.9, 0.0, BORE_Z],
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

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Slide: short and tall, a big round nose.
  slab(k, [[-0.5, 0.1], [5.55, 0.1], [5.75, 0.6], [5.45, 1.52], [-0.4, 1.52], [-0.55, 0.9]], -0.5, 0.5, { paint: SLIDE, bone: "Slide", part: PART.blade, round: 0.28, bevel: 0.12 });
  // Cocking grooves: square-cut little slabs (tiny enough that rounding them only costs triangles).
  if (fp) for (let i = 0; i < 4; i++) for (const y of [-1, 1]) box(k, [-0.1 + i * 0.2, y * 0.5, 0.85], [0.04, 0.02, 0.45], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01, round: 0 });
  box(k, [2.3, -0.2, 1.53], [0.6, 0.22, 0.03], { paint: SLIDE_DARK, bone: "Slide", bevel: 0.01 });
  if (fp) {
    // The barrel's hood in the port, the extractor on the right flank.
    plate(k, [2.42, -0.18, 1.565], [0.4, 0.16, 0.012], { paint: STEEL });
    plate(k, [1.75, -0.505, 1.2], [0.32, 0.012, 0.05], { paint: STEEL, bone: "Slide" });
  }
  // Sights: rear with two dots, a white front dot.
  box(k, [-0.15, 0, 1.62], [0.13, 0.38, 0.1], { paint: FRAME_DARK, bone: "Slide" });
  if (fp) for (const y of [-0.22, 0.22]) dome(k, [-0.29, y, 1.64], [-1, 0, 0], 0.05, { paint: DOT, bone: "Slide", h: 0.02, sides: 6 });
  box(k, [5.15, 0, 1.62], [0.1, 0.07, 0.1], { paint: FRAME_DARK, bone: "Slide" });
  dome(k, [5.04, 0, 1.66], [-1, 0, 0], 0.05, { paint: DOT, bone: "Slide", h: 0.02, sides: 6 });
  lathe(k, [[5.6, 0.26], [5.8, 0.26], [5.8, 0.16], [5.68, 0.16]], { c: [0, 0.8], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 12, bone: "Slide" });
  // The threaded barrel: rides the frame (the slide runs back over it), reaches back inside the slide so a recoiling
  // slide never shows a gap, and pokes out of the nose with a few thread rings.
  const thread: [number, number][] = [[4.3, 0.15], [5.84, 0.15]];
  if (fp) for (let x = 5.88; x < SEAT + THREAD - 0.04; x += 0.08) thread.push([x, 0.18], [x + 0.04, 0.15]);
  thread.push([SEAT + THREAD, 0.15], [SEAT + THREAD + 0.02, 0.11]);
  lathe(k, thread, { c: [0, BORE_Z], paint: STEEL, cap: BORE, sides: 10 });
  // The tail (rides the slide; Aux so the inspect can wobble it): a fluffy ball of a few lumps.
  ball(k, [-0.95, 0, 1.0], [0.42, 0.42, 0.42], { paint: TAIL, bone: "Aux", sides: 10 });
  if (fp) for (const [x, y, z] of [[-1.12, 0.22, 1.22], [-1.15, -0.22, 1.18], [-1.05, 0.0, 0.72]] as const) ball(k, [x, y, z], [0.22, 0.22, 0.22], { paint: TAIL_SHADE, bone: "Aux", sides: 7 });

  // --- Frame: smooth dust cover, rounded guard, the ribbed grip.
  slab(k, [[-0.45, 0.15], [5.25, 0.15], [5.35, -0.15], [4.8, -0.48], [2.0, -0.55], [0.6, -0.48], [-0.45, -0.2]], -0.46, 0.46, { paint: FRAME, part: PART.blade, round: 0.12 });
  guard(k, [[3.25, -0.48], [3.2, -1.42], [2.2, -1.58], [1.45, -1.3], [1.38, -0.78]], 0.13, { paint: FRAME, open: true });
  trigger(k, TRIGGER, 0.68, { paint: ORANGE });
  if (fp) {
    // Left flank: the slide stop lever and its thumb tab; the takedown tab; pins through the frame.
    plate(k, [1.0, 0.47, 0.02], [0.5, 0.025, 0.06], { paint: LEVER });
    plate(k, [1.42, 0.49, -0.07], [0.09, 0.03, 0.1], { paint: LEVER });
    for (const y of [-0.47, 0.47]) plate(k, [3.05, y, -0.2], [0.08, 0.02, 0.11], { paint: LEVER });
    pins(k, [[1.95, -0.3], [-0.05, -0.34]], 0.47, 0.08, { paint: STEEL, h: 0.05 });
    for (const y of [-0.46, 0.46]) groove(k, 3.45, 5.1, -0.14, y, { paint: LINE, lip: LIP });
  }
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.15), along(b0, -0.05, 0.9), [1.28, -0.6], along(b0, 1.0, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.05), along(b0, GRIP_LEN, 0.02), along(b0, 1.5, -0.05)], -0.56, 0.56, { paint: FRAME, part: PART.grip, round: 0.25, bevel: 0.14 });
  if (fp) for (let i = 0; i < 5; i++) for (const y of [-1, 1]) {
    const t = 0.95 + i * 0.5;
    slab(k, [along(b0, t, 0.25), along(b0, t, GRIP_DEPTH - 0.25), along(b0, t + 0.18, GRIP_DEPTH - 0.27), along(b0, t + 0.18, 0.25)], y > 0 ? 0.54 : -0.58, y > 0 ? 0.58 : -0.54, { paint: RIB, round: 0, bevel: 0.015 });
  }
  slab(k, [[-0.4, 0.12], [-0.8, 0.06], [-0.82, -0.08], [-0.42, -0.1]], -0.36, 0.36, { paint: FRAME, round: 0.08 });
  // --- Magazine: the body inside the grip, a rounded base with a carrot-orange heel.
  slab(k, [along(b0, 0.35, 0.3), along(b0, 0.35, GRIP_DEPTH - 0.4), along(b0, GRIP_LEN - 0.02, GRIP_DEPTH - 0.45), along(b0, GRIP_LEN - 0.02, 0.3)], -0.4, 0.4, { paint: MAG, bone: "Mag", round: 0.08 });
  slab(k, [along(b0, GRIP_LEN - 0.05, -0.05), along(b0, GRIP_LEN - 0.05, GRIP_DEPTH), along(b0, GRIP_LEN + 0.25, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN + 0.25, 0.02)], -0.58, 0.58, { paint: FRAME_DARK, bone: "Mag", round: 0.14, bevel: 0.1 });
  const h = along(b0, GRIP_LEN + 0.12, 0.05);
  box(k, [h[0], 0, h[1]], [0.14, 0.5, 0.12], { paint: ORANGE, bone: "Mag" });
}

export const cottontail: GunDef = {
  id: "usp",
  name: "Cottontail",
  archetype: "Compact pistol",
  blurb: "A short, soft-cornered pistol with a fluffy tail.",
  cls: "pistol",
  build,
  right: {
    o: [-0.36, 0.0, -2.38],
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
    o: [-0.14, 0.0, -2.67],
    up: [0.45, 0, 0.89],
    fwd: [0.89, 0.0, -0.45],
    index: { c: [62, 70, 50] },
    middle: { c: [70, 80, 60] },
    ring: { c: [76, 84, 62] },
    pinky: { c: [80, 84, 60] },
    thumb: { c: [10, 4, 4], spread: -26 },
    wrap: ["Index", "Middle", "Ring", "Pinky"],
    proxy: [[gripAt(0.9, GRIP_DEPTH + 0.55), gripAt(GRIP_LEN - 0.2, GRIP_DEPTH + 0.5), 0.75]],
  },
  places: {
    mag: { o: gripAt(GRIP_LEN + 0.5, 0.95), up: [UP[0], 0, UP[1]], fwd: [FWD[0], 0, FWD[1]] },
    rack: { o: [0.25, 0.95, 0.75], up: [-1, 0, 0], fwd: [0, 0, 1] },
    tail: { o: [-1.0, 1.3, 1.0], up: [0, 0, 1], fwd: [1, 0, 0] },
  },
  // 0.6 lower than v0.0.28 (-3.65) since the v0.0.29 default framing (viewmodel/defaults.ts) lifts the hands: the
  // support cuff stays under the grip instead of standing up in front of the gloves.
  frame: { o: [18, -5.2, -4.25], a: [0, 6, -5] },
  silencer,
  trigger: TRIGGER,
  muzzle: [5.85, 0, 0.8],
  eject: { p: [2.3, -0.3, 1.55], dir: [-0.1, -0.85, 0.5] },
  shell: "pistol",
  mag: { p: [...gripAt(GRIP_LEN, 0.9)] as [number, number, number], out: [-UP[0], 0, -UP[1]] },
  timing: { cycle: 0.15, ammo: 12, reload: 2.7, draw: 1.0 },
  recoil: { kick: 5, back: 0.6, roll: 1.0, settle: 240, slide: 1.1, slideTime: 0.09 },
  sounds: { fire: "gun_cottontail_fire", silenced: "gun_cottontail_silenced", magOut: "gun_mag_out", magIn: "gun_mag_in", slide: "gun_slide" },
  tp: { o: [1.6, -0.9, 0.2], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.7 },
};
