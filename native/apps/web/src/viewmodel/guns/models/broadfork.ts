// Broadfork (m3): the pump shotgun. A long gunmetal barrel over its magazine tube, a ridged walnut pump, a walnut
// pistol-grip stock with a leaf-green wrap and a carrot-orange cap, a carrot bead at the muzzle. Original design: no
// real-world silhouette or markings.
//
// Construction (gun polish, v0.0.29): a steel receiver with a seam along its flank, pins for the trigger group and a
// carrot cross-bolt safety, the bolt face showing in the ejection port, a blued barrel and tube, walnut (grain, satin)
// pump and stock, a rubber butt pad and a steel sling loop; a steel trigger that swings back (Trig bone).

import { PART } from "../../knives/types";
import type { KnifeCtx } from "../../knives/ctx";
import { box, dome, groove, guard, lathe, pins, plate, rod, slab, trigger, type P2 } from "../shapes";
import { gunPaint as fixed } from "../material";
import type { GunDef } from "../types";

const RECV = fixed(0x5b6069, "metal"), RECV_DARK = fixed(0x3f434a, "dark"), STEEL = fixed(0x3a3f47, "dark"), STEEL_LIGHT = fixed(0x6a707a, "metal"), BORE = fixed(0x101114);
const WOOD = fixed(0x8f5d36, "wood"), WOOD_DARK = fixed(0x6b4426, "wood"), LEAF = fixed(0x58c64a), LEAF_DARK = fixed(0x2f7d34), ORANGE = fixed(0xff7a1a);
const HULL = fixed(0xc43c2c), BRASS = fixed(0xd8a640, "metal"), PAD = fixed(0x2b2a2c, "grip"), SEAM = fixed(0x2a2d33, "dark"), LIP = fixed(0x9aa1ab, "metal");
/** The trigger's pivot (top of its blade, gun-local). */
const TRIGGER: [number, number, number] = [2.35, 0, -0.3];

/** Barrel and tube axes (z), the pump's span. */
const BZ = 1.25, TZ = 0.25, P0 = 9.5, P1 = 16;
const RAKE = (24 * Math.PI) / 180;
const UP: [number, number] = [Math.sin(RAKE), Math.cos(RAKE)];
const FWD: [number, number] = [Math.cos(RAKE), -Math.sin(RAKE)];
const BACK0: P2 = [-0.5, -0.25];
const GRIP_LEN = 3.4, GRIP_DEPTH = 1.7;
const along = (p: P2, t: number, d: number): P2 => [p[0] - UP[0] * t + FWD[0] * d, p[1] - UP[1] * t + FWD[1] * d];
const gripAt = (t: number, d: number): [number, number, number] => {
  const p = along(BACK0, t, d);
  return [p[0], 0, p[1]];
};

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Receiver: a long block, the loading port underneath, the ejection port on the right.
  slab(k, [[-0.7, -0.3], [5.2, -0.3], [5.3, 1.75], [4.8, 1.95], [-0.4, 1.95], [-0.8, 1.4]], -0.74, 0.74, { paint: RECV, part: PART.blade, round: 0.15, bevel: 0.1 });
  box(k, [2.4, 0, -0.32], [1.2, 0.42, 0.03], { paint: RECV_DARK, bevel: 0.01 });
  box(k, [2.4, -0.75, 1.2], [0.85, 0.03, 0.32], { paint: RECV_DARK, bevel: 0.01 });
  if (fp) {
    // The bolt face in the ejection port; a seam along both flanks; trigger group pins; the cross-bolt safety.
    plate(k, [2.0, -0.775, 1.2], [0.36, 0.012, 0.22], { paint: STEEL_LIGHT, bone: "Pump" });
    for (const y of [-0.74, 0.74]) groove(k, -0.4, 4.95, 0.62, y, { paint: SEAM, lip: LIP });
    pins(k, [[0.9, 0.05], [3.9, 0.05]], 0.745, 0.095, { paint: STEEL_LIGHT, h: 0.05 });
    for (const y of [-0.745, 0.745]) plate(k, [0.15, y, -0.08], [0.11, 0.025, 0.11], { paint: ORANGE });
  }
  // --- Barrel, rib, bead; the magazine tube and its cap; the clamp.
  lathe(k, [[5.1, 0.45], [23.6, 0.42], [24, 0.42], [24, 0.24], [23.7, 0.24]], { c: [0, BZ], paint: (i) => (i >= 2 ? BORE : STEEL), sides: 14, part: PART.blade });
  box(k, [14.4, 0, BZ + 0.48], [9.2, 0.12, 0.06], { paint: RECV_DARK, bevel: 0.02 });
  dome(k, [23.55, 0, BZ + 0.53], [0, 0, 1], 0.12, { paint: ORANGE, h: 0.12, sides: 8 });
  lathe(k, [[5.1, 0.42], [21.9, 0.42], [22.3, 0.36], [22.45, 0.0]], { c: [0, TZ], paint: STEEL, sides: 12 });
  box(k, [21.3, 0, (BZ + TZ) / 2], [0.3, 0.46, 0.75], { paint: STEEL_LIGHT, round: 0.2 });
  // --- Pump (Pump bone): ridged walnut around the tube.
  const rows: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const x = P0 + ((P1 - P0) * i) / 12;
    const end = i === 0 || i === 12 ? 0.82 : 1;
    rows.push([x, (i % 2 ? 0.86 : 0.8) * end]);
  }
  lathe(k, rows, { c: [0, TZ + 0.1], ry: 0.95, rz: 0.82, e: 2.4, sides: fp ? 16 : 10, paint: (i) => (i % 2 ? WOOD : WOOD_DARK), bone: "Pump", part: PART.grip });
  // Action bars back to the receiver (they slide with the pump).
  if (fp) for (const y of [-0.45, 0.45]) rod(k, [5.3, y, TZ + 0.2], [P0 + 0.2, y, TZ + 0.2], 0.07, { paint: STEEL_LIGHT, bone: "Pump" });
  // --- Trigger guard, trigger, the walnut pistol grip with its orange cap, a short stock with the leaf wrap.
  guard(k, [[3.3, -0.3], [3.2, -1.25], [2.0, -1.38], [1.3, -1.15], [1.25, -0.6]], 0.13, { paint: RECV, open: true });
  trigger(k, TRIGGER, 0.65, { paint: STEEL_LIGHT });
  const b0 = BACK0;
  slab(k, [along(b0, 0, -0.05), along(b0, -0.05, 1.0), [1.15, -0.45], along(b0, 1.1, GRIP_DEPTH), along(b0, GRIP_LEN, GRIP_DEPTH - 0.1), along(b0, GRIP_LEN, 0.05), along(b0, 1.5, -0.05)], -0.62, 0.62, { paint: WOOD, part: PART.grip, round: 0.25, bevel: 0.15 });
  const c0 = along(b0, GRIP_LEN, -0.05), c1 = along(b0, GRIP_LEN, GRIP_DEPTH - 0.05), c2 = along(b0, GRIP_LEN + 0.28, GRIP_DEPTH - 0.15), c3 = along(b0, GRIP_LEN + 0.28, 0.05);
  slab(k, [c0, c1, c2, c3], -0.64, 0.64, { paint: ORANGE, round: 0.12 });
  slab(k, [[-0.75, 1.55], [-4.2, 1.35], [-4.2, -1.4], [-2.4, -1.05], [-1.2, -0.75], [-0.75, -0.2]], -0.6, 0.6, { paint: WOOD, round: 0.3, bevel: 0.15 });
  // Rubber butt pad, a steel sling loop under the stock.
  slab(k, [[-4.18, 1.38], [-4.5, 1.36], [-4.5, -1.42], [-4.18, -1.43]], -0.62, 0.62, { paint: PAD, round: 0.1, bevel: 0.08 });
  if (fp) guard(k, [[-3.35, -1.22], [-3.45, -1.62], [-3.85, -1.66], [-3.9, -1.3]], 0.05, { paint: STEEL_LIGHT, open: true });
  if (fp) for (const [x, p] of [[-2.9, LEAF], [-3.15, LEAF_DARK]] as const) slab(k, [[x + 0.1, 1.48], [x - 0.1, 1.47], [x - 0.1, -1.18], [x + 0.1, -1.2]], -0.63, 0.63, { paint: p, round: 0.06, bevel: 0.03 });
  // --- The shell the left hand loads (Aux; built seated in the tube behind the port, hidden until a reload).
  lathe(k, [[1.5, 0.33], [1.62, 0.33], [1.62, 0.3], [2.75, 0.29], [2.8, 0.2]], { c: [0, TZ], paint: (i) => (i < 1 ? BRASS : HULL), sides: 10, bone: "Aux" });
}

export const broadfork: GunDef = {
  id: "m3",
  name: "Broadfork",
  archetype: "Pump shotgun",
  blurb: "A long pump shotgun with a ridged walnut pump and a carrot bead.",
  cls: "shotgun",
  build,
  right: {
    o: [-1.53, 0.0, -1.85],
    up: [-0.2, 0, 0.98],
    fwd: [0.751, 0.643, 0.153],
    index: { c: [16, 34, 20], spread: -4 },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    thumb: { c: [12, 10, 6], spread: -10 },
    wrap: ["Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
  },
  // The support hand under the handguard (riding the pump), palm up, fingers over its right side (placement from
  // tools/viewmodel/gun-grip-fit.ts); its forearm drops toward the elbow anchor below it, out of view.
  left: {
    o: [11.6, 0.0, -0.05],
    up: [1, 0, 0],
    fwd: [0.0, -0.707, 0.707],
    index: { c: [60, 80, 60] },
    middle: { c: [64, 84, 64] },
    ring: { c: [68, 86, 64] },
    pinky: { c: [72, 86, 64] },
    thumb: { c: [14, 40, 40], spread: -6 },
    wrap: ["Index", "Middle", "Ring", "Pinky", "Thumb"],
    seat: -0.02,
    part: "Pump",
  },
  places: {
    port: { o: [2.0, 0, -1.25], up: [1, 0, 0], fwd: [0, -1, 0.3] },
  },
  frame: { o: [16, -6.2, -5.9], a: [-1, 4, -4] },
  trigger: TRIGGER,
  elbows: { R: [8, -18, -18], L: [24, -6, -26] },
  wrist: { L: 34 },
  muzzle: [24.1, 0, BZ],
  eject: { p: [2.4, -0.8, 1.2], dir: [-0.15, -0.9, 0.4] },
  shell: "shotgun",
  timing: { cycle: 0.88, ammo: 8, shells: { start: 0.45, each: 0.5, end: 0.7 }, draw: 1.0, pump: { at: 0.3, dur: 0.48 } },
  recoil: { kick: 7, back: 1.3, roll: 1.5, settle: 140, slide: 0, slideTime: 0 },
  sounds: { fire: "gun_broadfork_fire", pump: "gun_pump", shell: "gun_shell_in" },
  tp: { o: [1.2, -0.8, 0.4], x: [0.15, 0.1, -0.98], z: [0, 1, 0], s: 1.35 },
};
