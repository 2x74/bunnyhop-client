// Bunnyfly (knife-bunnyfly, Heirloom): a balisong. A slim carrot blade with an accent tang, two leaf-green handles
// split down the middle of the grip (the safe handle on the spine side, the bite handle on the edge side), accent pin
// bolts, and a pair of bunny-ear latch tabs on the bite handle's end. Original design: CS's butterfly knife only as a
// loose silhouette / mechanism reference.
//
// Rig (first person; rig.ts EXTRA_BONES, BFLY pins): Knife_Handle = the safe handle (the one the fist holds),
// v_weapon.Bfly_Blade rotates about pin A relative to it, v_weapon.Bfly_Bite about pin B relative to the blade, both by
// -angle about their local x. Angles (KnifeState.angles, degrees): [blade, bite]; 0 = open, 180 = closed. The mesh is
// authored open (the bind pose). Idle is OPEN (0, 0), held forward like CS's butterfly; the draw is the flip open (it
// comes up closed, the blade swings out and the bite handle round onto the safe one); swings keep it open; it only
// closes inside the inspect tricks.
//
// For inspects (the animation work): set vm.knifeHold.state.angles = [blade, bite] inside the inspect's apply; the
// viewmodel re-solves the two bones after it every frame. To flip while the fist keeps the BITE handle instead of the
// safe one, put bunnyflyHeldByBite(blade, bite) into state.local. Pivots: pivots.pinA / pinB (knife-local).

import { ring, type Paint } from "../../player/bunny/builder";
import { concat, invert34, type V3 } from "../../player/bunny/rig";
import { rotAbout, smooth } from "../math";
import { BFLY } from "../rig";
import { ACCENT, CARROT_DARK, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { tweak } from "./hold";
import { PART, type KnifeDef } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0];
const A = BFLY.pinY, PZ = BFLY.pinZ;
/** Handle extent along z (open), half width (y, the two meet at y = 0) and half thickness (x). */
const H_BOT = -2.7, H_TOP = PZ + 0.3, HW = A * 0.98, HT = 0.33;
/** Blade from just above the handle tops to the tip (closed it fits inside the handles). */
const B0 = PZ + 0.28, B1 = PZ + 4.85;
const D2R = Math.PI / 180;
/** 0 -> 1 with a little overshoot (the fingers squeeze the handles as they close). */
const squeezeIn = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2);

/** One handle (side +1 safe, -1 bite): a rounded bar with grip ridges, pin bolts, ends rounded. */
function handle(k: KnifeCtx, side: 1 | -1, bone?: string): void {
  const fp = k.view === "fp";
  const n = fp ? 15 : 8;
  const rows: V3[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = H_BOT + (H_TOP - H_BOT) * t;
    // Rounded ends, slight waist under the fingers, ridges.
    const end = Math.min(1, Math.min(t, 1 - t) / 0.06);
    const k1 = (0.55 + 0.45 * Math.sqrt(end)) * (1 - 0.06 * Math.sin(t * Math.PI * 2) ** 2) * (fp && i % 3 === 2 && i > 1 && i < n - 1 ? 1.05 : 1);
    rows.push(ring([0, side * A * (0.98 + 0.02 * k1), z], X, Y, HT * k1, HW * k1, fp ? 12 : 8, 3.2));
  }
  const paint = (i: number): Paint => (i % 3 === 2 && i > 1 && i < n - 1 ? LEAF : LEAF_DARK);
  k.surface(rows, { paint, bone, part: PART.grip, capStart: LEAF_DARK, capEnd: LEAF_DARK });
  // Pin bolts through the handle at its pivot (and a second rivet lower down), accent.
  for (const z of [PZ, H_BOT + 0.55]) {
    const r = z === PZ ? 0.14 : 0.09;
    const rr = [ring([-HT - 0.04, side * A, z], Y, [0, 0, 1], r, r, fp ? 10 : 6), ring([HT + 0.04, side * A, z], Y, [0, 0, 1], r, r, fp ? 10 : 6)];
    k.surface(rr, { paint: () => ACCENT, bone, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  if (side < 0) {
    // Latch: two little bunny-ear tabs off the bite handle's end.
    for (const e of [-1, 1]) {
      const path: V3[] = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        path.push([e * (0.1 + 0.16 * t), -A - 0.06 * t, H_BOT + 0.05 - 0.85 * t + 0.1 * t * t]);
      }
      k.leaf(path, (i) => 0.2 * Math.sin(((i + 0.4) / 4.8) * Math.PI) + 0.03, 0.07, [0, 1, 0], () => ACCENT, { bone, part: PART.guard });
    }
  }
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const blade = fp ? "Bfly_Blade" : undefined;
  // Blade: a slim carrot, single-edged (edge toward the bite handle, -y), straight back then a gentle spear point.
  k.blade({
    n: 18,
    m: 12,
    center: (s) => [0, 0.06 * s * s, B0 + (B1 - B0) * s],
    width: (s) => 0.4 * Math.pow(Math.min(1, (1 - s) / 0.42), 0.75) + 0.015,
    thick: (s) => 0.1 * (1 - 0.6 * s) + 0.015,
    edge: -1,
    ex: 2.6,
    bone: blade,
    capStart: CARROT_DARK,
  });
  // Tang between the pins (the kicker), accent: what the pins go through.
  {
    const rows = [PZ - 0.32, PZ - 0.2, PZ + 0.2, PZ + 0.3].map((z, i) => ring([0, 0, z], X, Y, [0.08, 0.11, 0.11, 0.09][i], [0.3, 0.42, 0.42, 0.38][i], fp ? 12 : 8, 3));
    k.surface(rows, { paint: () => ACCENT, bone: blade, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  handle(k, 1);
  handle(k, -1, fp ? "Bfly_Bite" : undefined);
}

/**
 * Knife-local transform for Knife_Handle that keeps the BITE handle where the fist holds the knife (for flips that let
 * the safe handle swing): put it in KnifeState.local. Identity when open (both handles in the fist).
 */
export function bunnyflyHeldByBite(blade: number, bite: number, out = new Float32Array(12)): Float32Array {
  // Bite handle relative to the safe handle: T(pinA) Rx(-blade) T(pinB - pinA) Rx(-bite) T(-pinB).
  const a = new Float32Array(12), b = new Float32Array(12), m = new Float32Array(12);
  rotAbout(X, -blade * D2R, [0, A, PZ], a);
  rotAbout(X, -bite * D2R, [0, -A, PZ], b);
  concat(a, 0, b, 0, m, 0);
  // The bite handle stays where it is when open: Knife_Handle (safe) moves by the inverse.
  invert34(m, 0, out, 0);
  return out;
}

export const bunnyfly: KnifeDef = {
  id: "bunnyfly",
  cosmeticId: "knife-bunnyfly",
  name: "Bunnyfly",
  rarity: 4,
  blurb: "A carrot balisong with bunny-ear latches that flicks open on every swing.",
  build,
  joints: ["Bfly_Blade", "Bfly_Bite"],
  pivots: { pinA: { p: [0, A, PZ], axis: [1, 0, 0] }, pinB: { p: [0, -A, PZ], axis: [1, 0, 0] } },
  // Third person: open, held like the carrot (static; the bunny's skeleton has no handle bones).
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: {
    index: { c: [80, 94, 75] },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    // Over the closed fist like a straight knife's (knives/hold.ts STRAIGHT_THUMB), spread a little toward the index
    // so its base stays clear of the handles while they swing in the draw's flip.
    thumb: { c: [12, 40, 60], spread: 16 },
    // The fist closes on both handles (open, the idle) / the closed bundle (re-centred by state.offset).
    wrap: { fingers: ["Index", "Middle", "Ring", "Pinky", "Thumb"], seat: -0.02 },
    // The carrot's grip turned a quarter so the handles' flat sides lie against the palm and fingers.
    place: (h) => tweak(h.carrot, [0, 0, 0.3], [0, 0, 125]),
  },
  pose(action, t, s) {
    // Closedness 0..1 of the blade and the bite handle: open in idle and every swing; the draw comes up closed and
    // flicks open: the middle, ring and little fingers let go, the blade swings out in front of them, the bite handle
    // follows it round and latches onto the safe one, and the fingers close on both again (with a squeeze).
    let c = 0, cb = 0;
    if (action === "draw") {
      c = 1 - smooth((t - 0.26) / 0.2);
      cb = 1 - smooth((t - 0.32) / 0.24);
      s.loosen = smooth((t - 0.2) / 0.08) - squeezeIn((t - 0.56) / 0.16);
    }
    // (Negative: the blade swings out over the fingers' side, not round the heel of the hand.)
    s.angles[0] = -180 * c;
    s.angles[1] = 180 * Math.max(c, cb);
    // Closed, the bundle sits 2 pinY toward the spine side: keep it centred in the fist.
    s.offset[1] = -2 * A * smooth(c);
  },

};
