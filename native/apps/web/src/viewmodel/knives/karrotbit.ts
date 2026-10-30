// Karrotbit (knife-karrotbit, Prize): a karambit grown from a carrot. A short crescent blade (the carrot, growth rings,
// sharp on the inside of the curve), a ridged leaf-wrapped handle that bows with it, and at the pommel the carrot's
// leaves braided into a finger ring (accent collar where it meets the handle, two leaf tips sprouting off it).
// Original design: CS's karambit only as a loose silhouette reference (curved claw + ring).
//
// Hold (first person): reverse-grip-ish like CS. The index finger goes through the ring, the handle runs across the
// fist toward the pinky and the blade curls out under it. pivots.ring is the spin pivot (index finger) for its inspect.

import { add, cross, norm, ring, scale, sub } from "../../player/bunny/builder";
import type { V3 } from "../../player/bunny/rig";
import { ACCENT, edgeWeight, fixed, LEAF, LEAF_DARK, type KnifeCtx } from "./ctx";
import { tweak } from "./hold";
import { attackFlavour, hump, idleSway, localXf, reducedMotion, rise } from "./bayonet";
import { KMAT, PART, type KnifeDef } from "./types";

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

/** The carrot palette of the blade: skin, a thin growth line, the darker spine, the peeled (paler) edge bevel. */
const SKIN = fixed(0xff7a1a, KMAT.veg), LINE = fixed(0xe0600e, KMAT.veg), SPINE = fixed(0xe86a12, KMAT.veg), PEEL = fixed(0xffa04c, KMAT.veg), PEEL_LINE = fixed(0xf58a34, KMAT.veg);

/** The blade's half width (in its plane) and half thickness at s: slim, widest a quarter of the way out, a needle tip. */
const bladeHalf = (s: number) => (0.4 + 0.15 * Math.sin(Math.min(1, s * 2.2) * Math.PI * 0.5)) * Math.pow(1 - s, 0.72) + 0.012;
const bladeThick = (s: number) => 0.135 * Math.pow(1 - s, 0.62) + 0.018;
/** The carrot blade's half width at u (finishes/shader.ts finRad): pattern units across per unit of v (bayonet.ts). */
const finRad = (u: number) => 0.8 * Math.pow(Math.max(1 - u, 0), 0.85) + 0.04;

/**
 * The crescent: a ground section lofted along the curved centreline (like bayonet.ts's blades, but curling): the sharp
 * edge on the inside of the curve (+y), a flat bevel up to a crisp grind line in the paler "peeled" carrot, flat faces
 * with thin growth lines, a chamfered spine. Finish coordinates as on the bayonets (v -1 edge .. 1 spine, u integrated
 * along the arc so every finish keeps its aspect).
 */
function crescent(k: KnifeCtx): void {
  const fp = k.view === "fp";
  const n = fp ? 28 : 12;
  // Half profile (+x side) from the edge apex to the spine: c (-1 edge .. 1 spine), thickness factor, crease.
  const GRIND = -0.25;
  const half = fp
    ? [
        { c: GRIND, t: 1, crease: true },
        { c: 0.62, t: 1, crease: true },
        { c: 0.86, t: 0.88 },
        { c: 1, t: 0.5, crease: true },
      ]
    : [
        { c: GRIND, t: 1 },
        { c: 0.8, t: 1 },
        { c: 1, t: 0.55 },
      ];
  const cols: { c: number; side: number; t: number }[] = [{ c: -1, side: 0, t: 0 }];
  for (const q of half) for (let d = 0; d < (q.crease ? 2 : 1); d++) cols.push({ c: q.c, side: 1, t: q.t });
  for (let j = half.length - 1; j >= 0; j--) for (let d = 0; d < (half[j].crease ? 2 : 1); d++) cols.push({ c: half[j].c, side: -1, t: half[j].t });
  const facePaint = (i: number, kk: number) => {
    const a = cols[kk], b = cols[(kk + 1) % cols.length];
    // Thin growth rings right round the blade (the carrot's), a row wide, none on the last stretch to the tip.
    const line = fp && i > 1 && i < n - 5 && i % 5 === 2;
    if (a.side === 0 || b.side === 0 || Math.max(a.c, b.c) <= GRIND + 1e-6) return line ? PEEL_LINE : PEEL;
    if (Math.min(a.c, b.c) >= 0.62 - 1e-6) return line ? LINE : SPINE;
    return line ? LINE : SKIN;
  };
  // Along-the-arc finish coordinate (aspect-preserving, as bayonet.ts finishAlong).
  const N = 200;
  const tab = new Float32Array(N + 1);
  let u = 0;
  for (let i = 0; i < N; i++) {
    const s0 = i / N, s1 = (i + 1) / N;
    const p0 = bladeAt(s0), p1 = bladeAt(s1);
    u = Math.min(0.995, u + (finRad(u) / (8.9 * Math.max(0.03, bladeHalf((s0 + s1) / 2)))) * Math.hypot(p1[1] - p0[1], p1[2] - p0[2]));
    tab[i + 1] = u;
  }
  const along = (s: number) => {
    const f = s * N, i = Math.min(N - 1, Math.floor(f));
    return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
  };
  const rows: V3[][] = [];
  const fins: [number, number, number][][] = [];
  const h = 1e-3;
  for (let i = 0; i <= n; i++) {
    const sv = i / n;
    const c0 = bladeAt(sv);
    const t = norm(sub(bladeAt(Math.min(1, sv + h)), bladeAt(Math.max(0, sv - h))));
    const wd = norm(cross(t, X));
    const hw = bladeHalf(sv), th = bladeThick(sv);
    // The spine side bulges a little (the carrot's shoulder): the section's centre sits toward the spine.
    const sh = -0.05 * Math.sin(sv * Math.PI);
    const uu = along(sv);
    const row: V3[] = [];
    const fr: [number, number, number][] = [];
    for (const cc of cols) {
      row.push(add(add(c0, scale(wd, -cc.c * hw + sh)), scale(X, cc.side * th * cc.t)));
      fr.push([uu, cc.c, edgeWeight(uu, Math.max(0, -cc.c * 1.1))]);
    }
    rows.push(row);
    fins.push(fr);
  }
  const outRef = (i: number, kk: number): V3 => {
    const cc = cols[kk];
    const sv = i / n;
    const t = norm(sub(bladeAt(Math.min(1, sv + h)), bladeAt(Math.max(0, sv - h))));
    const wd = norm(cross(t, X));
    return cc.side === 0 ? wd : cc.c >= 0.99 ? add(scale(wd, -1), scale(X, cc.side * 0.6)) : [cc.side, 0, 0];
  };
  k.surface(rows, { paint: facePaint, part: PART.blade, fin: (i, kk) => fins[i][kk], capStart: SKIN, capEnd: null, out: outRef });
  // Jimping: a row of small notches on the spine by the bolster, where the thumb rides.
  if (fp)
    for (let j = 0; j < 5; j++) {
      const sv = 0.035 + j * 0.028;
      const c0 = bladeAt(sv);
      const t = norm(sub(bladeAt(sv + h), bladeAt(sv - h)));
      const wd = norm(cross(t, X));
      const top = add(c0, scale(wd, -bladeHalf(sv) - 0.05 * Math.sin(sv * Math.PI) + 0.01));
      const w = bladeThick(sv) * 0.55;
      k.tube([add(top, scale(X, -w)), top, add(top, scale(X, w))], 0.045, 6, wd, () => SPINE, { part: PART.blade });
    }
}

function build(k: KnifeCtx): void {
  const fp = k.view === "fp";
  crescent(k);
  // --- Bolster: a lacquered collar between handle and blade that swells into a small finger guard on the edge side.
  {
    const zs = [H1 - 0.06, H1 + 0.04, H1 + 0.16, B0 - 0.04, B0 + 0.04];
    const rx = [0.31, 0.36, 0.37, 0.3, 0.2];
    const ry = [0.45, 0.55, 0.66, 0.6, 0.46];
    const cy = [0, 0.04, 0.12, 0.1, 0.04];
    const rows = zs.map((z, i) => ring([0, handleAt(Math.min(z, H1))[1] + cy[i], z], X, Y, rx[i], ry[i], fp ? 16 : 10, 2.6));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  // --- Handle: a leaf cord wrap (diamonds in two greens, the cord rows proud, like bayonet.ts's wrapped grips), three
  //     shallow finger grooves on the edge side (the fingers' side).
  {
    const n = fp ? 14 : 6;
    const m = fp ? 12 : 8;
    const rows: V3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = H0 + (H1 - H0) * t;
      const c = handleAt(z);
      const groove = fp ? 0.07 * Math.max(0, Math.sin(3 * Math.PI * Math.min(1, Math.max(0, (t - 0.08) / 0.84)))) : 0;
      const row: V3[] = [];
      const cord = fp && i % 2 === 1 && i < n ? 1.05 : 1;
      for (let kk = 0; kk < m; kk++) {
        const a = ((kk + (fp && i % 2 ? 0.5 : 0)) / m) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / 2.3) * 0.3 * cord;
        const yy = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / 2.3) * 0.42 * cord * (sa > 0 ? 1 - groove * sa : 1);
        row.push([c[0] + x, c[1] + yy, c[2]]);
      }
      rows.push(row);
    }
    k.surface(rows, { paint: (i, kk) => (fp ? ((i + kk) % 2 ? LEAF : LEAF_DARK) : i % 2 ? LEAF : LEAF_DARK), part: PART.grip, capStart: LEAF_DARK, capEnd: LEAF_DARK });
  }
  // --- Collar between the handle and the ring.
  {
    const rows = [RING_Z + RING_R - 0.08, H0 - 0.12, H0 + 0.05].map((z, i) => ring([0, 0, z], X, Y, [0.22, 0.32, 0.29][i], [0.3, 0.44, 0.4][i], fp ? 12 : 8));
    k.surface(rows, { paint: () => ACCENT, part: PART.guard, capStart: ACCENT, capEnd: ACCENT });
  }
  // --- Finger ring: a smooth lacquered core, the carrot's leaves braided round it (two strands, first person).
  {
    const n = fp ? 30 : 14;
    const loopAt = (a: number): V3 => [0, Math.sin(a) * RING_R, RING_Z + Math.cos(a) * RING_R];
    const core: V3[] = [];
    for (let i = 0; i < n; i++) core.push(loopAt((i / n) * Math.PI * 2));
    k.loop(core, fp ? RING_T * 0.62 : RING_T, fp ? 8 : 6, X, () => ACCENT, { part: PART.grip });
    if (fp)
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const path: V3[] = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const c = loopAt(a);
          const out = norm(sub(c, [0, 0, RING_Z]));
          const tw = a * 5 + sIdx * Math.PI;
          path.push(add(c, add(scale(out, Math.cos(tw) * RING_T * 0.62), scale(X, Math.sin(tw) * RING_T * 0.62))));
        }
        k.loop(path, RING_T * 0.42, 5, X, () => (sIdx ? LEAF : LEAF_DARK), { part: PART.grip });
      }
  }
  // --- Two leaves sprouting off the collar, curling back over the ring.
  for (const side of [-1, 1]) {
    const path: V3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      path.push([0.05 * side * t, side * (0.24 + 0.85 * t - 0.12 * t * t), H0 - 0.08 - 0.25 * t - 0.32 * t * t]);
    }
    k.leaf(path, (i) => 0.17 * Math.sin(((i + 0.35) / 6.7) * Math.PI) + 0.02, 0.05, X, () => (side > 0 ? LEAF : LEAF_DARK));
  }
}

const L = new Float32Array(12);
const RING_C: V3 = [0, 0, RING_Z], RING_AXIS: V3 = [1, 0, 0];
/** The draw's turn slides the knife this far along the ring's hole (off the back of the hand) at its middle. */
const SLIDE = 0.4;

export const karrotbit: KnifeDef = {
  id: "karrotbit",
  cosmeticId: "knife-karrotbit",
  name: "Karrotbit",
  rarity: 3,
  blurb: "A hooked carrot with a peeled edge and a leaf-braid finger ring that spins round your index finger.",
  build,
  pivots: { ring: { p: RING_C, axis: RING_AXIS } },
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
  pose(action, t, s) {
    // CS-style karambit idle: index through the ring on top of the fist, the blade out of the bottom of it, hanging
    // down and hooking forward and in, away from the camera (inspects/karrotbit.ts ends each trick on the old "show
    // it to you" pose, the hook curled back toward the camera). Kept through the swings: the base slash / stab motion
    // is about the wrist, so it carries the knife with it.
    const w = s.show * s.show * (3 - 2 * s.show);
    const p = (k: number) => KB_IDLE[k] + (KB_SHOW[k] - KB_IDLE[k]) * w;
    s.arm.o[0] = p(0), s.arm.o[1] = p(1), s.arm.o[2] = p(2);
    s.arm.a[0] = p(3), s.arm.a[1] = p(4), s.arm.a[2] = p(5);
    s.wrist[0] = p(6), s.wrist[1] = p(7), s.wrist[2] = p(8);
    if (action === "idle") return idleSway(s, 0.8 * (1 - w));
    if (action === "draw") {
      // The karambit draw: the hand comes up with the fingers open and the knife turns once round the index finger
      // through the ring (about the ring's hole, an even turn so it reads), then the fist closes on the handle.
      const rm = reducedMotion();
      if (!rm) {
        const e = Math.min(1, Math.max(0, (t - 0.14) / 0.3));
        const turn = e * e * (3 - 2 * e);
        if (e > 0 && e < 1) s.local = localXf(L, RING_AXIS, 360 * turn, RING_C, [SLIDE * Math.sin(Math.PI * e), 0, 0]);
        s.loosen = rise(t, 0.04, 0.12) * (1 - rise(t, 0.42, 0.54));
      }
      // The fist lifts a little into frame for it and the wrist rolls the ring toward you.
      const k = rm ? 0.4 : 1;
      s.arm.o[2] += k * 1.2 * hump(t, 0.04, 0.62);
      s.wrist[2] += k * 14 * hump(t, 0.06, 0.6);
      return;
    }
    // Swings: the hook leads (a bigger wrist roll into the cut than a straight blade), a little twist on the stab.
    attackFlavour(action, t, s, { roll: 16, snap: 9, twist: 10 });
  },
};
