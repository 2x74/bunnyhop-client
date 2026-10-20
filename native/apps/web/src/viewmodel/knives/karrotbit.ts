// Karrotbit (knife-karrotbit, Prize): a karambit grown from a carrot. A short crescent blade (the carrot, growth rings,
// sharp on the inside of the curve), a ridged leaf-wrapped handle that bows with it, and at the pommel the carrot's
// leaves braided into a finger ring (accent collar where it meets the handle, two leaf tips sprouting off it).
// Original design: CS's karambit only as a loose silhouette reference (curved claw + ring).
//
// Hold (first person): reverse-grip-ish like CS. The index finger goes through the ring, the handle runs across the
// fist toward the pinky and the blade curls out under it. pivots.ring is the spin pivot (index finger) for its inspect.

import { add, cross, norm, ring, scale, sub } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { tweak } from "./hold";
import { PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
/** Fine-tune of the first-person hold in the knife's own axes (offset units, rotation degrees x / y / z). */
const HOLD_O: V3 = [0, 0, 0], HOLD_A: V3 = [0, 0, 0];

/**
 * Idle arm offset (forward / left / up), arm pitch / yaw / roll and wrist pitch / yaw / roll, fitted so the blade leaves
 * the fist pointing down (knife z ~ (0.19, 0.1, -0.98) in view space) and curls forward and in (knife y ~ (0.82, 0.53,
 * 0.2)), the fist ~2.5 forward, 0.8 in and 2.6 above the carrot's grip. One set for both bases: procedural.ts's idle
 * puts the hand where v_knife_t's does (the fit on it lands within a degree / 0.1 unit of this).
 */
export const KB_IDLE = [5.06, -1.41, 0.19, -17.75, 16.25, -19, -9.75, 9.5, -2.75];
/**
 * v0.0.5's idle ("show it to you": the back of the fist and the ring to the camera, the hook curled back toward it):
 * where the inspect tricks end before they settle back to the idle. Same layout as KB_IDLE.
 */
export const KB_SHOW = [4.2, 0.5, 2.6, 0, 10, 0, -35, 55, 30];

/** Ring (finger loop) centre on the knife axis, centreline radius, braid tube radius (fits the glove's index finger). */
const RING_Z = -1.42, RING_R = 0.64, RING_T = 0.15;
/** Handle from the ring collar to the bolster (one fist wide); blade arc length and total turn. */
const H0 = -0.66, H1 = 1.02, B0 = 1.32, BLADE_L = 4.7, TURN = 140 * (Math.PI / 180);

/** Handle centreline: a slight bow away from the blade's curve (the "C" of a karambit). */
const handleAt = (z: number): V3 => [0, -0.12 * Math.sin(Math.max(0, Math.min(1, (z - H0) / (H1 - H0))) * Math.PI), z];

/** Blade centreline: leaves the bolster along +z and curls toward +y (the edge is on the inside, +y). */
function bladeAt(s: number): V3 {
  // Integrate the heading theta(s) = TURN * s^1.25 (midpoint steps: cheap, smooth).
  const n = Math.max(1, Math.round(28 * s));
  let y = 0, z = B0;
  const ds = (s * BLADE_L) / n;
  for (let i = 0; i < n; i++) {
    const th = TURN * Math.pow(((i + 0.5) / n) * s, 1.25);
    y += Math.sin(th) * ds;
    z += Math.cos(th) * ds;
  }
  return [0, y, z];
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  // --- Blade: a crescent carrot, widest a quarter of the way out, wedge section (edge on the concave side), the
  //     spine side bulging a little like a carrot's shoulder.
  k.blade({
    n: 18,
    m: 12,
    center: bladeAt,
    width: (s) => (0.5 + 0.26 * Math.sin(Math.min(1, s * 2.4) * Math.PI * 0.5)) * Math.pow(1 - s, 0.62) + 0.025,
    thick: (s) => 0.19 * Math.pow(1 - s, 0.7) + 0.03,
    shift: (s) => -0.06 * Math.sin(s * Math.PI),
    edge: 1,
    ex: 2.3,
  });
  // --- Bolster: an accent collar between handle and blade.
  {
    const zs = [H1 - 0.06, H1 + 0.12, B0 + 0.04];
    const rows = zs.map((z, i) => ring(handleAt(Math.min(z, H1)).map((v, j) => (j === 2 ? z : v)) as V3, X, Y, [0.33, 0.39, 0.3][i], [0.52, 0.62, 0.5][i], fp ? 14 : 10));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  // --- Handle: leaf wrap with ridges (finger grooves), oval section.
  {
    const n = fp ? 10 : 6;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const z = H0 + ((H1 - H0) * i) / n;
      const ridge = i % 2 ? 1.08 : 1;
      rows.push(ring(handleAt(z), X, Y, 0.3 * ridge, 0.42 * ridge, fp ? 12 : 8));
    }
    k.surface(rows, { paint: (i) => (i % 4 === 1 ? LEAF : LEAF_DARK), part: PART.grip, capStart: LEAF_DARK, capEnd: LEAF_DARK });
  }
  // --- Collar between the handle and the ring.
  {
    const rows = [RING_Z + RING_R - 0.08, H0 - 0.12, H0 + 0.05].map((z, i) => ring([0, 0, z], X, Y, [0.22, 0.32, 0.29][i], [0.3, 0.44, 0.4][i], fp ? 12 : 8));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  // --- Finger ring: the leaves braided into a loop (two strands twisting around the loop's centreline).
  {
    const n = fp ? 22 : 14;
    const strands = fp ? 2 : 1;
    for (let sIdx = 0; sIdx < strands; sIdx++) {
      const path: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // Loop in the y-z plane around (0, 0, RING_Z), starting at the collar (top of the loop, +z).
        const c: V3 = [0, Math.sin(a) * RING_R, RING_Z + Math.cos(a) * RING_R];
        if (strands === 1) {
          path.push(c);
          continue;
        }
        const out = norm(sub(c, [0, 0, RING_Z]));
        const tw = a * 4 + sIdx * Math.PI;
        path.push(add(c, add(scale(out, Math.cos(tw) * RING_T * 0.5), scale(X, Math.sin(tw) * RING_T * 0.5))));
      }
      k.loop(path, strands === 1 ? RING_T : RING_T * 0.68, fp ? 5 : 6, X, () => (sIdx ? LEAF : LEAF_DARK), { part: PART.grip });
    }
  }
  // --- Two leaves sprouting off the collar, curling back over the ring.
  for (const side of [-1, 1]) {
    const path: V3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      path.push([0.04 * side * t, side * (0.24 + 0.85 * t - 0.1 * t * t), H0 - 0.08 - 0.25 * t - 0.3 * t * t]);
    }
    k.leaf(path, (i) => 0.19 * Math.sin(((i + 0.35) / 6.7) * Math.PI) + 0.02, 0.06, X, () => (side > 0 ? LEAF : LEAF_DARK));
  }
}

export const karrotbit: KnifeDef = {
  id: "karrotbit",
  cosmeticId: "knife-karrotbit",
  name: "Karrotbit",
  rarity: 3,
  blurb: "A hooked carrot with a leaf-braid finger ring that spins around your index finger.",
  build,
  pivots: { ring: { p: [0, 0, RING_Z], axis: [1, 0, 0] } },
  // Third person: reverse grip, the blade curling out under the fist, the ring on the index side.
  tp: { o: [3.85, -1.12, 0.25], z: [-0.53, -0.1, 0.84], y: [1, 0, 0], s: 1.75 },
  hold: {
    index: { c: [62, 84, 52], spread: 4 },
    middle: { c: [84, 96, 58] },
    ring: { c: [88, 96, 58] },
    pinky: { c: [92, 94, 56] },
    thumb: { c: [12, 40, 60] },
    // Middle, ring and little finger wrap the handle; the index stays through the ring and curls its tip onto the
    // handle; the thumb rests on the index.
    wrap: { fingers: ["Index", "Middle", "Ring", "Pinky", "Thumb"], from: [-20, 0, 0], gripZ: [H0, H1 + 0.3], rooted: ["Index"] },
    place(h) {
      // Ring centre on the index finger's first segment, its hole along the finger.
      const ringC = add(scale(h.joint("Index01"), 0.45), scale(h.joint("Index02"), 0.55));
      const axis = h.dir("Index01");
      // The handle runs from the ring across the fist toward the pinky, through the curled fingers (the carrot's grip
      // channel), so the blade curls out under the little finger.
      const grip: V3 = [h.carrot[3], h.carrot[7], h.carrot[11]];
      const z = norm(sub(add(grip, scale(h.across, -1.4)), ringC));
      // x (the hole axis) along the finger: y = z × x.
      const m = h.frame(sub(ringC, scale(z, RING_Z)), z, cross(z, axis));
      return tweak(m, HOLD_O, HOLD_A);
    },
  },
  pose(_action, _t, s) {
    // CS-style karambit idle: index through the ring on top of the fist, the blade out of the bottom of it, hanging
    // down and hooking forward and in, away from the camera (inspects/karrotbit.ts ends each trick on the old "show
    // it to you" pose, the hook curled back toward the camera). Kept through the swings: the base slash / stab motion
    // is about the wrist, so it carries the knife with it.
    const w = s.show * s.show * (3 - 2 * s.show);
    const p = (k: number) => KB_IDLE[k] + (KB_SHOW[k] - KB_IDLE[k]) * w;
    s.arm.o[0] = p(0), s.arm.o[1] = p(1), s.arm.o[2] = p(2);
    s.arm.a[0] = p(3), s.arm.a[1] = p(4), s.arm.a[2] = p(5);
    s.wrist[0] = p(6), s.wrist[1] = p(7), s.wrist[2] = p(8);
  },
};
