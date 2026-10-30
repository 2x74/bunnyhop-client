// Whirligig (knife-whirligig, Heirloom, free): a talon with a fidget spinner (kill's ask, 10-27: "a talon with a spinny
// thingy"). A blackened talon blade (the edge on the inside of a falcon-claw curve, a bright ground bevel, a short
// fuller), a cord-wrapped grip, a plain collar, and on the bolster a whirligig: a three-petal spinner on an axle through
// the blade's root, one plate either side of it, a round steel weight in each petal and a domed brass cap. The petals
// take the colourway's accent. Original design: a garden wind spinner on a hawkbill, not any game's knife.
//
// The spinner is its own bone in first person (rig.ts EXTRA_BONES v_weapon.Whirl_Spin at WHIRL, turning about the knife's
// x, the axle). It runs on the wall clock: every WHIRL_FLICK.period the thumb gives it a flick and it spins down; the
// draw and every slash give it a kick; the inspects (inspects/whirligig.ts) flick it hard. Every kick and flick turns
// it a whole number of thirds of a turn, so whatever ends one (an inspect cancelled, the idle's next flick) never
// shows a jump: the spinner has three-fold symmetry. Third person: the same model, still (no extra bones there).
//
// Hold: the bayonets' straight hammer grip (edge toward the knuckles), the spinner just above the index finger.

import { smoothstep } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { WHIRL } from "../rig";
import { ACCENT, fixed, type KnifeCtx } from "./ctx";
import { attackFlavour, bayonetBlade, bayonetGrip, bayonetHold, hump, idleSway, plate, reducedMotion, type BayonetBladeSpec, X, Y } from "./bayonet";
import { KMAT, PART, type KnifeDef } from "./types";
import { ring } from "../../player/bunny/builder";

/** Blackened steel, its bright ground edge, the dark spine; brass for the caps, steel for the weights. */
const BLACK = fixed(0x3a3f47, KMAT.satin), BLACK_SPINE = fixed(0x2a2e35, KMAT.satin), EDGE = fixed(0xe9eef2, KMAT.polished), FULL = fixed(0x31363d, KMAT.satin);
const BRASS = fixed(0xd9a441, KMAT.polished), STEEL = fixed(0xc9d3da, KMAT.polished), WRAP = fixed(0x2b2f36, KMAT.grip), WRAP_DARK = fixed(0x1d2026, KMAT.grip), COLLAR = fixed(0x7d8792, KMAT.satin);

/**
 * Grip from the pommel (G0) to the collar (G1); the collar to C1, under the spinner's sweep (rig.ts WHIRL: centre
 * WHIRL.r + a little above C1); above it only the blade's thin root, which the plates pass either side of.
 */
const G0 = -2.25, G1 = 1.3, C1 = 1.5;
/** Spinner: petal reach, hub radius, plate half thickness, plates' distance off the blade's centre plane. */
const R_PETAL = WHIRL.r, R_HUB = 0.32, PLATE_T = 0.055, PLATE_X = 0.2;
const ZC = WHIRL.pos[2], YC = WHIRL.pos[1];

/**
 * Talon blade from inside the spinner's hub to the tip: the centreline drops toward the edge (-y) as it goes, the
 * spine stays a smooth convex arc and the edge a concave one, the tip a needle hooked down.
 */
const TIP = 7.55;
const drop = (s: number) => -2.0 * Math.pow(s, 2.1);
const half = (s: number) => 0.56 * Math.pow(Math.max(0, 1 - s), 0.75) * (1 + 0.22 * Math.sin(Math.PI * Math.min(1, s * 1.4))) + 0.012;
export const WHIRL_BLADE: BayonetBladeSpec = {
  z0: ZC - 0.35,
  z1: TIP,
  spine: (s) => YC + 0.06 + drop(s) + half(s) * 0.92,
  edge: (s) => YC + 0.06 + drop(s) - half(s) * 1.08,
  thick: (s) => 0.118 - 0.035 * s - 0.06 * smoothstep(0.72, 1, s),
  grind: -0.3,
  fuller: { s: [0.12, 0.34], c: [0.25, 0.55], depth: 0.3 },
  clip: 0.8,
  rows: 24,
  paint: { steel: BLACK, spine: BLACK_SPINE, bevel: EDGE, fuller: FULL },
};

/** The petal outline's reach at angle `a` (three rounded petals round the hub, petal 0 pointing up the blade, +z). */
const reach = (a: number) => R_HUB + (R_PETAL - R_HUB) * Math.pow(0.5 + 0.5 * Math.cos(3 * a), 1.35);

/** One spinner plate at x (outward side `side`): a flat trefoil with a rounded rim, centred on the axle. */
function spinnerPlate(k: KnifeCtx, side: number): void {
  const fp = k.view === "fp";
  const n = fp ? 36 : 18;
  const x0 = side * PLATE_X;
  // Rows across the plate's thickness, inner face to outer face; the middle rows are the rounded rim (first person).
  const prof = fp
    ? [
        { dx: -PLATE_T, s: 0.94 },
        { dx: -PLATE_T * 0.55, s: 1 },
        { dx: PLATE_T * 0.55, s: 1 },
        { dx: PLATE_T, s: 0.94 },
      ]
    : [
        { dx: -PLATE_T, s: 1 },
        { dx: PLATE_T, s: 1 },
      ];
  const rows = prof.map(({ dx, s }) => {
    const out: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = reach(a) * s;
      // (y, z) round the axle; z up the blade.
      out.push([x0 + side * dx, YC + Math.sin(a) * r, ZC + Math.cos(a) * r]);
    }
    return out;
  });
  if (side < 0) rows.reverse();
  k.surface(rows, { paint: () => ACCENT, part: PART.guard, bone: "Whirl_Spin", capStart: ACCENT, capEnd: ACCENT, closed: true });
  // A round steel weight in each petal, standing proud of the plate (first person: too small to read on the bunny);
  // a domed brass cap on the axle.
  if (fp)
    for (let p = 0; p < 3; p++) {
      const a = (p / 3) * Math.PI * 2;
      const c: V3 = [x0 + side * PLATE_T, YC + Math.sin(a) * 0.68, ZC + Math.cos(a) * 0.68];
      k.tube([c, [c[0] + side * 0.05, c[1], c[2]], [c[0] + side * 0.085, c[1], c[2]]], (i) => [0.2, 0.19, 0.12][i], 10, Y, () => STEEL, { bone: "Whirl_Spin", part: PART.guard });
    }
  const hub: V3 = [x0 + side * PLATE_T, YC, ZC];
  const cap: V3[] = fp ? [hub, [hub[0] + side * 0.06, YC, ZC], [hub[0] + side * 0.13, YC, ZC], [hub[0] + side * 0.17, YC, ZC]] : [hub, [hub[0] + side * 0.12, YC, ZC]];
  k.tube(cap, (i) => (fp ? [0.27, 0.26, 0.19, 0.07] : [0.27, 0.16])[i], fp ? 12 : 6, Y, () => BRASS, { bone: "Whirl_Spin", part: PART.guard });
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  bayonetBlade(k, WHIRL_BLADE);
  // --- The axle through the blade's root (between the plates), fixed to the knife.
  k.tube([[-PLATE_X, YC, ZC], [0, YC, ZC], [PLATE_X, YC, ZC]], 0.13, fp ? 10 : 6, Y, () => STEEL, { part: PART.guard });
  spinnerPlate(k, 1);
  spinnerPlate(k, -1);
  // --- Collar: a plain satin ring from the grip up to under the spinner (its petals clear it), the blade's root
  //     standing out of it.
  plate(k, [G1 - 0.04, G1 + 0.05, C1 - 0.05, C1], [0.34, 0.38, 0.36, 0.3], [0.46, 0.52, 0.5, 0.42], YC, COLLAR, PART.guard, 2.4);
  {
    // The blade's root from the collar into the hub (unsharpened, the same blackened steel).
    const rows = [C1 - 0.06, ZC - 0.2].map((z, i) => ring([0, YC + 0.04, z], X, Y, [0.1, 0.11][i], [0.4, 0.48][i], fp ? 10 : 6, 3));
    k.surface(rows, { paint: () => BLACK, part: PART.guard, capStart: BLACK, capEnd: BLACK });
  }
  // --- Grip: a dark cord wrap, then a rounded steel pommel cap.
  bayonetGrip(k, { z0: G0, z1: G1, rx: 0.33, ry: 0.44, cy: -0.04, ribs: 7, a: WRAP, b: WRAP_DARK, wrap: true });
  plate(k, [G0 - 0.22, G0 - 0.12, G0 + 0.02], [0.24, 0.34, 0.33], [0.32, 0.45, 0.44], -0.04, STEEL, PART.guard, 2.2);
}

/**
 * The idle's thumb flicks: every `period` s the spinner gets `turns` thirds of a turn, slowing down exponentially (time
 * constant `tau` s). A whole number of thirds per flick, so each one starts where the last one stopped (it looks the
 * same as rest).
 */
export const WHIRL_FLICK = { period: 6.5, thirds: 15, tau: 0.85 } as const;

/** The idle spinner angle (deg) at wall-clock time `now` (s): continuous across every action. */
export function whirlIdle(now: number): number {
  const { period, thirds, tau } = WHIRL_FLICK;
  const u = now - Math.floor(now / period) * period;
  // Each flick ends where the next starts (a whole number of thirds: the same look), so the count can be dropped.
  return thirds * 120 * ((1 - Math.exp(-u / tau)) / (1 - Math.exp(-period / tau)));
}

/** A kick of `thirds` thirds of a turn over [t0, t0 + dur]: fast out of the kick, easing to a stop. */
export function whirlKick(t: number, t0: number, dur: number, thirds: number): number {
  const x = Math.min(1, Math.max(0, (t - t0) / dur));
  return thirds * 120 * (1 - (1 - x) ** 3);
}

const nowS = (): number => (((globalThis as { performance?: { now(): number } }).performance?.now() ?? 0) / 1000) % 3600;

export const whirligig: KnifeDef = {
  id: "whirligig",
  cosmeticId: "knife-whirligig",
  name: "Whirligig",
  rarity: 4,
  blurb: "A talon with a three-petal spinner on its bolster. The thumb never leaves it alone.",
  build,
  joints: ["Whirl_Spin"],
  // crook: where it rides on the index finger in its finger spins (the collar, under the spinner on the edge side);
  // whirl: the spinner's axle.
  pivots: { crook: { p: [0, -0.62, G1 + 0.12], axis: [1, 0, 0] }, whirl: { p: [0, YC, ZC], axis: [1, 0, 0] } },
  tp: { o: [3.16, -1.24, 1.34], z: [0.53, 0.1, -0.84], y: [1, 0, 0], s: 1.6 },
  hold: bayonetHold([0, 0, 0.18]),
  pose(action, t, s) {
    const rm = reducedMotion();
    // The spinner: the idle's thumb flicks (not with reduced motion), plus a kick on the draw and on every swing.
    let spin = rm ? 0 : whirlIdle(nowS());
    if (action === "draw") spin += whirlKick(t, 0.12, 0.9, rm ? 3 : 6);
    else if (action === "slash1" || action === "slash2") spin += whirlKick(t, 0.1, 0.55, action === "slash1" ? 3 : -3);
    else if (action === "stab") spin += whirlKick(t, 0.3, 0.6, 3);
    s.angles[0] = spin;
    if (action === "idle") return idleSway(s, 1);
    if (action === "draw") {
      // Comes up with the blade turned to show its side, the wrist cocked back a little, then into the hold.
      const k = rm ? 0.4 : 1;
      s.wrist[2] += k * -18 * hump(t, 0.05, 0.7);
      s.wrist[0] += k * -8 * hump(t, 0, 0.45);
      return;
    }
    attackFlavour(action, t, s, { roll: 14, snap: 8, twist: 12 });
  },
};
