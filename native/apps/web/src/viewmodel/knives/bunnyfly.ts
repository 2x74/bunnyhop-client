// Bunnyfly (knife-bunnyfly, Heirloom): a balisong. A slim carrot blade on an accent tang, two leaf-green handles (the
// SAFE handle on the spine side, the BITE handle on the edge side), each a pair of liners the blade folds in between,
// joined by a spacer at the butt, accent pin bolts, and a bunny-ear latch hinged on the bite handle's butt that swings
// across both butts to lock them together. Original design: a real balisong's mechanism, our garden look.
//
// Rig (first person; rig.ts EXTRA_BONES, BFLY pins): Knife_Handle = the safe handle (the one the fist holds),
// v_weapon.Bfly_Blade turns about pin A relative to it, v_weapon.Bfly_Bite about pin B relative to the blade,
// v_weapon.Bfly_Latch about its hinge under the bite handle's butt: KnifeState.angles = [blade, bite, latch], degrees,
// all in [0, 180] (knives/balisong.ts says why: the handles then never pass through each other). The mesh is authored
// open and latched (the bind pose, also the third-person knife).
//
//   draw    comes up closed and latched; the little finger knocks the latch off, a flick of the wrist throws the bite
//           handle out and round (about pin B), a second throws the blade up out of the fist and brings the bite
//           handle down into the palm (about pin A), the fingers close on both handles and the latch swings home.
//           The real "basic opening": the bite handle goes once round the safe one.
//   idle    open and latched; every few seconds the thumb rubs over the pin bolt (light, never busy)
//   swings  latched open: a light, quick wrist (it's a slim blade on a long grip)
//
// For inspects: set state.angles inside the inspect's apply (KnifeHold.solve poses the bones after it). To keep the
// BITE handle in the fist instead, put bunnyflyHeldByBite(blade, bite) into state.local. Pivots: pinA / pinB / latch.

import { ring, type Paint } from "../../player/bunny/builder";
import { concat, invert34, type V3 } from "../../player/bunny/rig";
import { rotAbout, smooth } from "../math";
import { BFLY } from "../rig";
import { ease, flipClear, HANDLE_BOT, HANDLE_HW, LATCH_REACH, LATCH_Z, LINER_IN, LINER_OUT, latchFree, swing, biteTurn } from "./balisong";
import { attackFlavour, palmNormalLocal, reducedMotion } from "./bayonet";
import { ACCENT, CARROT_DARK, LEAF, LEAF_DARK, withHilt, type KnifeCtx } from "./ctx";
import { tweak } from "./hold";
import { PART, type KnifeDef, type KnifeState } from "./types";

const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];
const A = BFLY.pinY, PZ = BFLY.pinZ;
/** Blade from just above the pins to the tip: its tip stays short of the butt spacers at any angle (balisong.ts). */
const B0 = PZ + 0.28, B1 = PZ + 4.66;
const D2R = Math.PI / 180;
/** The liners' centre (|x|) and half thickness. */
const LX = (LINER_IN + LINER_OUT) / 2, LT = (LINER_OUT - LINER_IN) / 2;

/** One handle (side +1 safe, -1 bite): two liners, rounded about the pin at the top, a spacer at the butt. */
function handle(k: KnifeCtx, side: 1 | -1, bone?: string): void {
  const fp = k.view === "fp";
  const c = side * A;
  // Profile along z: [z, half width]. The pin end is a half circle about the pin (so the handle can turn about it
  // without its end sweeping past the centre line); the butt end has rounded corners; a slight waist under the
  // fingers and finger ridges (every third row a lighter green).
  const prof: [number, number][] = [];
  const nb = fp ? 4 : 2;
  for (let i = 0; i <= nb; i++) {
    const a = (i / nb) * (Math.PI / 2);
    prof.push([HANDLE_BOT + 0.16 * (1 - Math.sin(a)), HANDLE_HW * (0.55 + 0.45 * Math.sin(a))]);
  }
  const nm = fp ? 14 : 6;
  for (let i = 1; i < nm; i++) {
    const t = i / nm;
    const z = HANDLE_BOT + 0.16 + (PZ - HANDLE_BOT - 0.16) * t;
    prof.push([z, HANDLE_HW * (1 - 0.05 * Math.sin(t * Math.PI) ** 2)]);
  }
  const nt = fp ? 6 : 3;
  for (let i = 0; i <= nt; i++) {
    const a = (i / nt) * (Math.PI / 2);
    prof.push([PZ + HANDLE_HW * Math.sin(a), Math.max(0.03, HANDLE_HW * Math.cos(a))]);
  }
  const ridge = (i: number) => fp && i > nb + 1 && i < nb + nm - 1 && (i - nb) % 3 === 0;
  for (const xs of [-1, 1]) {
    // (Ridges bulge outward only: the inner face stays at LINER_IN, clear of the blade between the liners.)
    const rows = prof.map(([z, hw], i) => {
      const g = ridge(i) ? 1.12 : 1;
      return ring([xs * (LX + (g - 1) * LT), c, z], X, Y, LT * g, hw, fp ? 12 : 8, 3.4);
    });
    const paint = (i: number): Paint => (ridge(i) ? LEAF : LEAF_DARK);
    k.hilt("handle", () => k.surface(rows, { paint, bone, part: PART.grip, capStart: LEAF_DARK, capEnd: LEAF_DARK, name: "liner" }));
    // Pin bolt on the liner's outer face (accent), and a rivet at the butt (the spacer's screw).
    for (const [z, r] of [[PZ, 0.13], [HANDLE_BOT + 0.2, 0.075]] as const) {
      const x0 = xs * (LINER_OUT - 0.02), x1 = xs * (LINER_OUT + 0.045);
      k.hilt("fitting", () => k.surface([ring([x0, c, z], Y, Z, r, r, fp ? 10 : 6), ring([x1, c, z], Y, Z, r * 0.9, r * 0.9, fp ? 10 : 6)], { paint: () => ACCENT, bone, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "bolt" }));
    }
  }
  // The butt spacer between the liners (the blade's tip folds in just above it).
  {
    const zs = [HANDLE_BOT + 0.04, HANDLE_BOT + 0.1, HANDLE_BOT + 0.28, HANDLE_BOT + 0.33];
    const rows = zs.map((z, i) => ring([0, c, z], X, Y, LINER_IN + 0.01, HANDLE_HW * [0.62, 0.8, 0.8, 0.7][i], fp ? 10 : 6, 3));
    k.hilt("handle", () => k.surface(rows, { paint: () => LEAF_DARK, bone, part: PART.grip, capStart: LEAF_DARK, capEnd: LEAF_DARK, name: "spacer" }));
  }
  if (side < 0) {
    // The latch lug: a tab down from the bite handle's butt to the latch hinge (accent).
    const zs = [HANDLE_BOT + 0.12, HANDLE_BOT - 0.02, LATCH_Z - 0.02, LATCH_Z - 0.09];
    const rows = zs.map((z, i) => ring([0, c, z], X, Y, [0.12, 0.11, 0.1, 0.06][i], [0.14, 0.13, 0.12, 0.07][i], fp ? 10 : 6, 2.6));
    k.hilt("pommel", () => k.surface(rows, { paint: () => ACCENT, bone, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "latch" }));
  }
}

/** The latch (its own bone): authored locked open, its arm along +y under both butts, two bunny-ear tabs at its end. */
function latch(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const bone = "Bfly_Latch";
  const y0 = -A, n = fp ? 7 : 4;
  // Hinge barrel (along x, through the lug).
  k.surface([ring([-0.15, y0, LATCH_Z], Y, Z, 0.07, 0.07, fp ? 10 : 6), ring([0.15, y0, LATCH_Z], Y, Z, 0.07, 0.07, fp ? 10 : 6)], { paint: () => ACCENT, bone, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "latch" });
  // Arm: a flat bar, thinner toward its tip.
  const rows: V3[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    rows.push(ring([0, y0 + 0.02 + LATCH_REACH * t, LATCH_Z - 0.01 * t], X, Z, 0.1 - 0.02 * t, 0.05 - 0.01 * t, fp ? 10 : 6, 3));
  }
  k.surface(rows, { paint: () => ACCENT, bone, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "latch" });
  // Bunny ears off the tip, out and down (they hang clear of both butts at every latch angle).
  const tip = y0 + LATCH_REACH;
  for (const e of [-1, 1]) {
    const path: V3[] = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      path.push([e * (0.04 + 0.1 * t), tip - 0.04 + 0.18 * t, LATCH_Z - 0.04 - 0.36 * t + 0.06 * t * t]);
    }
    k.leaf(path, (i) => 0.08 * Math.sin(((i + 0.4) / 4.8) * Math.PI) + 0.018, 0.045, [1, 0, 0], () => ACCENT, { bone, part: PART.guard, name: "latch" });
  }
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const blade = "Bfly_Blade";
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
  // Tang (accent) round both pins, between the liners: a rounded plate with the kicker on the edge side.
  {
    const rows = [PZ - 0.36, PZ - 0.26, PZ + 0.22, PZ + 0.3].map((z, i) => ring([0, -0.02 * (i < 2 ? 1 : 0), z], X, Y, [0.07, 0.1, 0.1, 0.09][i], [0.34, 0.44, 0.44, 0.38][i], fp ? 12 : 8, 3));
    k.surface(rows, { paint: () => ACCENT, bone: blade, part: PART.guard, capStart: ACCENT, capEnd: ACCENT, name: "tang" });
  }
  handle(k, 1);
  handle(k, -1, "Bfly_Bite");
  k.hilt("pommel", () => latch(k));
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

/** Wrist turn about the knife's pin axis (deg, + turns the blade from the knuckles' side toward the wrist's), as view-space wrist pitch / roll on the bunnyfly's hold. */
function flick(s: KnifeState, deg: number): void {
  s.wrist[2] += -0.89 * deg;
  s.wrist[0] += 0.54 * deg;
}

/** Thumb play in the idle: every IDLE_PERIOD s the thumb strokes up over the pin bolt and back (~1.2 s). */
const IDLE_PERIOD = 7.4, IDLE_PHASE = 2.6;

/** The draw's joint angles at t (s): [blade, bite, latch]. Variant "a": held by the safe handle. */
export function bunnyflyDraw(t: number, out: number[] = [0, 0, 0]): number[] {
  // 1) the latch knocked off (0.09-0.15), 2) the bite handle thrown round pin B (0.15-0.28), 3) blade + bite handle
  // thrown round pin A (0.29-0.42): the blade comes up out of the fist and the bite handle slaps into the palm,
  // 4) the latch swings home across the butts (0.44-0.52) and clicks.
  out[0] = swing(t, 0.29, 0.42, 180, 0);
  out[1] = swing(t, 0.15, 0.28, 180, 0);
  out[2] = drawLatch(t);
  return out;
}
const turnA = (t: number) => biteTurn(swing(t, 0.29, 0.42, 180, 0), swing(t, 0.15, 0.28, 180, 0));
function drawLatch(t: number): number {
  if (t < 0.09) return 180;
  const free = latchFree(t, turnA);
  if (t < 0.15) return ease(t, 0.09, 0.15, 180, free);
  if (t < 0.44) return free;
  return t < 0.52 ? ease(t, 0.44, 0.52, free, 0) : swing(t, 0.44, 0.52, 90, 0, 6);
}
const LOCAL = new Float32Array(12);

export const bunnyfly: KnifeDef = withHilt({
  id: "bunnyfly",
  cosmeticId: "knife-bunnyfly",
  name: "Bunnyfly",
  rarity: 4,
  blurb: "A carrot balisong with a bunny-ear latch. The handles really swing.",
  build,
  // Both handles' liners (the lighter finger ridges the second tone) and butt spacers, the pin bolts and rivets and the
  // tang round the pins (guard), the latch with its lug and bunny ears (pommel).
  hilt: { liner: { role: "grip", alt: [LEAF] }, spacer: "grip", bolt: "guard", tang: "guard", latch: "pommel" },
  joints: ["Bfly_Blade", "Bfly_Bite", "Bfly_Latch"],
  pivots: { pinA: { p: [0, A, PZ], axis: [1, 0, 0] }, pinB: { p: [0, -A, PZ], axis: [1, 0, 0] }, latch: { p: [0, -A, LATCH_Z], axis: [1, 0, 0] } },
  // Third person: held like the carrot; its blade, bite handle and latch on the bunny's knife-part bones (bunny/rig.ts
  // KNIFE_PART_BONES), posed from the same joint angles (knives/tp-parts.ts).
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: {
    index: { c: [80, 94, 75] },
    middle: { c: [84, 98, 75] },
    ring: { c: [88, 98, 75] },
    pinky: { c: [92, 96, 75] },
    // Over the closed fist like a straight knife's (knives/hold.ts STRAIGHT_THUMB), spread a little toward the index
    // so its base stays clear of the handles while they swing in the draw.
    thumb: { c: [12, 40, 60], spread: 16 },
    // The fist closes on both handles (open, the idle) / the closed bundle (re-centred by state.offset).
    wrap: { fingers: ["Index", "Middle", "Ring", "Pinky", "Thumb"], seat: -0.02 },
    // The carrot's grip turned a quarter so the handles' flat sides lie against the palm and fingers.
    place: (h) => tweak(h.carrot, [0, 0, 0.3], [0, 0, 125]),
  },
  pose(action, t, s) {
    const rm = reducedMotion();
    if (action === "draw") {
      bunnyflyDraw(t, s.angles);
      // Closed, the bundle sits 2 pinY toward the spine side: keep it centred in the fist. It slides over while the
      // fingers are open.
      s.offset[1] = -2 * A * smooth(Math.max(0, Math.min(1, s.angles[0] / 180)));
      // The middle, ring and little finger (and most of the index) let go for the throws and close on both handles
      // when the bite handle lands, with a squeeze.
      s.loosen = smooth((t - 0.11) / 0.06) * (1 - smooth((t - 0.43) / 0.12));
      // Held in the thumb and index while they let go, the knife turns flat to the palm and rides a little off it, so
      // the handle swinging round the heel of the hand clears it (balisong.ts flipClear); back as the fist closes.
      if (s.loosen > 0) s.local = flipClear(s.loosen, palmNormalLocal(bunnyfly), LOCAL);
      // The thumb lifts off the safe handle while the parts swing past its base (the knife rides in the index's crook
      // and the thumb's tip), and comes back down as the fist closes.
      const th = smooth((t - 0.09) / 0.06) * (1 - smooth((t - 0.42) / 0.12));
      s.thumb[0] += 55 * th;
      s.thumb[1] += -15 * th;
      s.thumb[2] += -15 * th;
      // The wrist: two throws the same way round (the swinging parts turn the same way both times), a small pump
      // between them, a recoil as the handle lands in the palm, and it settles.
      const k = rm ? 0.4 : 1;
      const th1 = Math.sin(Math.PI * clamp01((t - 0.09) / 0.17)) ** 2;
      const th2 = Math.sin(Math.PI * clamp01((t - 0.24) / 0.17)) ** 2;
      const pump = Math.sin(Math.PI * clamp01((t - 0.22) / 0.08)) ** 2;
      const land = t > 0.42 && t < 0.7 ? Math.exp(-(t - 0.42) / 0.06) * Math.sin(Math.PI * Math.min(1, (t - 0.42) / 0.09)) : 0;
      flick(s, k * (16 * th1 + 18 * th2 - 6 * pump - 7 * land));
      return;
    }
    if (action === "idle") {
      // Thumb play: the thumb lifts a little and strokes up over the pin bolt and back. Light; the knife stays put.
      const u = ((((s.time + IDLE_PHASE) % IDLE_PERIOD) + IDLE_PERIOD) % IDLE_PERIOD) / 1.25;
      if (u < 1 && !rm) {
        const lift = Math.sin(Math.PI * u) ** 2;
        const stroke = Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u);
        s.thumb[0] += -7 * lift + 3 * stroke;
        s.thumb[1] += -9 * lift;
        s.thumb[2] += -6 * lift + 4 * stroke;
      }
      return;
    }
    // Swings: latched open, a light quick wrist.
    attackFlavour(action, t, s, { roll: 12, snap: 7, twist: 10 });
  },
});

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
