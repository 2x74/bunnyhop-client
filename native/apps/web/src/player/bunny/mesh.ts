// The bunnyhop.lol bunny: an original stylised character (cream hoodie with the hood up and bunny ears, dark face with
// the amber visor, joggers with an accent stripe, chunky sneakers, gloves, and a carrot blade), built in code and
// skinned to the CS:S player skeleton (rig.ts) in its bind pose. No external assets.
//
// Everything is in Source model space in the bind pose: z up, the character faces -Y, its left is +X, 1 unit =
// 1 Source unit (feet on z = 0, hood top ~75, like a CS:S player's 72-unit body). Proportions come from the rig:
// limbs are lofted along the bones, so the CS:S animations fit.
//
// Colours are colourway palette slots (palettes.ts) so one geometry serves every colourway; the visor glows and the
// accent parts follow the style accent (multiplayer slot colour, colourway accent).

import * as THREE from "three";
import { supporterHead, plushStitches, plushMittens, robotBody } from "./supporter";
import { EAR, rig, type V3 } from "./rig";
import { add, blend, Builder, clamp, cr, frame, hat, len, lerp3, mixW, norm, ring, scale, smoothstep, sub, type Paint, type Wt } from "./builder";
import { carrot } from "../../viewmodel/knives/carrot";
import { tpCtx } from "../../viewmodel/knives/ctx";
import type { KnifeDef } from "../../viewmodel/knives/types";
import { buildTpGlove } from "../../viewmodel/gloves/tp";
import type { GloveStyleId } from "../../loadout";
import { tekHead, tekJacket, tekShoeWing } from "./tek";
import type { BunnyLook } from "./look";

/** Palette slots (accent code 3 + slot), see palettes.ts. */
export const SLOT = { hoodie: 0, trim: 1, pants: 2, pantsTrim: 3, shoe: 4, face: 5, glove: 6, detail: 7 } as const;
const S = (slot: number): Paint => ({ code: 3 + slot });
const HOODIE = S(SLOT.hoodie), TRIM = S(SLOT.trim), PANTS = S(SLOT.pants), PANTS_TRIM = S(SLOT.pantsTrim);
const SHOE = S(SLOT.shoe), FACE = S(SLOT.face), GLOVE = S(SLOT.glove), DETAIL = S(SLOT.detail);
const ACCENT: Paint = { code: 1 };
const GLOW: Paint = { code: 2 };
/** Visor band: the face slot's tint of the accent (palette slot 7 "detail" is used for laces / aglets). */
const VISOR: Paint = { code: 1 };
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];

// ---------------------------------------------------------------------------------------------
// Torso profile: superellipse rings |x/a|^e + |(y-c)/b|^e = 1 at heights z (front = -y).

const TORSO: [number, number, number, number, number][] = [
  // z, a (half width), b (half depth), c (y centre), e
  [35.4, 9.3, 6.75, 0.6, 2.5],
  [36.5, 9.7, 7.1, 0.65, 2.5],
  [37.9, 9.55, 6.95, 0.7, 2.5],
  [40.5, 9.0, 6.4, 0.9, 2.5],
  [43, 8.5, 5.95, 1.15, 2.45],
  [45.5, 8.4, 5.8, 1.4, 2.4],
  [49, 8.95, 6.0, 1.7, 2.4],
  [52.5, 9.45, 6.1, 1.9, 2.5],
  [55.5, 9.45, 6.0, 2.0, 2.6],
  [58.5, 9.0, 5.7, 2.15, 2.6],
  [61, 8.0, 5.1, 2.3, 2.5],
  [62.9, 6.6, 4.5, 2.4, 2.3],
  [64.1, 4.8, 3.7, 2.45, 2.2],
  [64.8, 3.2, 3.0, 2.45, 2.0],
];

export type BunnyBody = "classic" | "feminine";

// Model B on the same skeleton: shaped hoodie, softer shoulders and fuller hips.
const FEMININE_TORSO = TORSO.map((row, i) => {
  const width = [1.08, 1.07, 1.04, 0.95, 0.82, 0.75, 0.82, 0.92, 0.95, 0.92, 0.92, 0.96, 1, 1][i];
  const depth = [1.03, 1.03, 1.01, 0.95, 0.89, 0.89, 0.99, 1.06, 1.04, 0.99, 0.97, 0.99, 1, 1][i];
  return [row[0], row[1] * width, row[2] * depth, row[3], row[4]] as [number, number, number, number, number];
});

function torsoAt(z: number, profile = TORSO): { a: number; b: number; c: number; e: number } {
  const zs = profile.map((r) => r[0]);
  let i = 0;
  while (i < zs.length - 2 && z > zs[i + 1]) i++;
  const f = i + clamp((z - zs[i]) / (zs[i + 1] - zs[i]), 0, 1);
  const col = (j: number) => cr(profile.map((r) => r[j]), f);
  return { a: col(1), b: col(2), c: col(3), e: col(4) };
}

/** Point on the torso surface at height z, angle th (0 = +X/left, pi/2 = +Y/back, -pi/2 = front), pushed out by off. */
function torsoPointFor(z: number, th: number, off = 0, profile = TORSO): V3 {
  const { a, b, c, e } = torsoAt(z, profile);
  const ca = Math.cos(th), sa = Math.sin(th);
  const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e) * (a + off);
  const y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e) * (b + off);
  return [x, c + y, z];
}

/** Front (side = -1) or back (+1) surface point at (x, z), offset outward along the approximate normal. */
function torsoFacePointFor(x: number, z: number, side: number, off: number, profile = TORSO): [V3, V3] {
  const { a, b, c, e } = torsoAt(z, profile);
  const t = clamp(Math.abs(x) / a, 0, 0.995);
  const y = Math.pow(1 - Math.pow(t, e), 1 / e) * b;
  // Gradient of the superellipse for the normal.
  const gx = (Math.sign(x) * Math.pow(t, e - 1)) / a;
  const gy = Math.pow(y / b, e - 1) / b;
  const n = norm([gx, side * gy, 0]);
  const p: V3 = [x, c + side * y, z];
  return [add(p, scale(n, off)), n];
}

export function buildBunnyGeometry(knife?: KnifeDef | null, glove: GloveStyleId = "knit", look: BunnyLook = "bunny", body: BunnyBody = "classic"): THREE.BufferGeometry {
  if (look !== "bunny") body = "classic";
  const plush = look === "plush", bune = look === "bune";
  const feminine = bune || body === "feminine";
  const profile = plush ? TORSO.map(([z, a, b, c, e]) => [z, a * 1.035, b * 1.06, c, 2.0] as [number, number, number, number, number]) : feminine ? FEMININE_TORSO : TORSO;
  const torsoPoint = (z: number, th: number, off = 0) => torsoPointFor(z, th, off, profile);
  const torsoFacePoint = (x: number, z: number, side: number, off: number) => torsoFacePointFor(x, z, side, off, profile);
  const tek = look === "tek";
  const r = rig();
  const b = new Builder();
  const B = (n: string) => r.bone(n);
  const at = (n: string) => r.at(n);
  const pelvis = B("Pelvis"), spine = B("Spine"), spine1 = B("Spine1"), spine2 = B("Spine2"), spine4 = B("Spine4");
  const neck = B("Neck1"), head = B("Head1");

  /**
   * Torso weights: spine hats over height, clavicles at the shoulders, and the hoodie's lower front / sides partly
   * following the thighs (like a loose hem) so raised knees don't poke through.
   */
  const torsoW = (p: V3): Wt => {
    const sp = hat(p[2], [[39, pelvis], [44.5, spine], [48.8, spine1], [54, spine2], [60.5, spine4], [64.5, spine4], [66.5, neck]]);
    const ax = Math.abs(p[0]);
    const cl = smoothstep(4.5, 9.5, ax) * smoothstep(55, 60.5, p[2]) * 0.6;
    const ua = smoothstep(8.2, 10.4, ax) * smoothstep(57.5, 61, p[2]) * 0.25;
    // (Not across the back: there the hem following a raised thigh pulls it forward through the seat in a crouch.)
    const th = smoothstep(48, 40, p[2]) * smoothstep(0.3, 3.4, ax) * (0.25 * smoothstep(5.5, 2.5, p[1]) + 0.65 * smoothstep(1, -4.5, p[1]));
    const side = p[0] >= 0 ? "L" : "R";
    return mixW([sp, 1 - cl - ua - th], [[[B(`${side}_Clavicle`), 1]], cl], [[[B(`${side}_UpperArm`), 1]], ua], [[[B(`${side}_Thigh`), 1]], th]);
  };

  if (bune) robotBody(b);
  else {
  // --- Hoodie body ------------------------------------------------------------------------------
  {
    const zs: number[] = [];
    for (let i = 0; i + 1 < TORSO.length; i++) {
      const steps = TORSO[i + 1][0] - TORSO[i][0] > 2.5 ? 3 : 2;
      for (let s = 0; s < steps; s++) zs.push(TORSO[i][0] + ((TORSO[i + 1][0] - TORSO[i][0]) * s) / steps);
    }
    zs.push(TORSO[TORSO.length - 1][0]);
    const K = 28;
    const rows = zs.map((z) => Array.from({ length: K }, (_, k) => torsoPoint(z, (k / K) * Math.PI * 2)));
    b.surface(rows, {
      paint: (i) => (zs[i] < 37.89 ? TRIM : HOODIE),
      weight: (p) => torsoW(p),
    });
  }

  // --- Joggers: seat (under the hoodie) ---------------------------------------------------------
  {
    const spec: [number, number, number, number][] = [
      [42, 7.2, 4.9, 0.9],
      [38, 7.9, 5.3, 0.8],
      [34.5, 8.1, 5.4, 0.7],
      [32.2, 7.7, 5.1, 0.6],
      [30.6, 6.2, 4.4, 0.6],
      [29.9, 3.2, 3.0, 0.6],
    ];
    const K = 24;
    const rows = spec.map(([z, a, bb, c]) => ring([0, c, z], X, Y, a * (feminine ? 0.855 + 0.265 * smoothstep(42, 34.5, z) : 1), bb * (feminine ? 1.03 : 1), K, 2.4));
    b.surface(rows, {
      paint: () => PANTS,
      weight: (p) => {
        const th = smoothstep(37, 31, p[2]) * smoothstep(0.5, 4, Math.abs(p[0])) * 0.7;
        return mixW([[[pelvis, 1]], 1 - th], [[[B(p[0] >= 0 ? "L_Thigh" : "R_Thigh"), 1]], th]);
      },
      capEnd: PANTS,
    });
  }

  // --- Legs: joggers + cuffs, sneakers ----------------------------------------------------------
  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const thigh = B(`${side}_Thigh`), calf = B(`${side}_Calf`), foot = B(`${side}_Foot`), toe = B(`${side}_Toe0`);
    const hip = at(`${side}_Thigh`), knee = at(`${side}_Calf`), ankle = at(`${side}_Foot`);
    const d1 = norm(sub(knee, hip)), d2 = norm(sub(ankle, knee));
    const L1 = len(sub(knee, hip));
    // Stations along the leg: s (units from the hip joint, > L1 continues down the shin), radius, paint.
    const st: [number, number, number][] = [
      [-2.2, 3.4, 0],
      [-0.5, 3.9, 0],
      [3, 4.1, 0],
      [7, 4.1, 0],
      [11, 3.9, 0],
      [15, 3.7, 0],
      [L1, 3.45, 0],
      [L1 + 3, 3.4, 0],
      [L1 + 6.5, 3.35, 0],
      [L1 + 10, 3.05, 0],
      [L1 + 12.6, 2.85, 1],
      [L1 + 13.0, 3.1, 1],
      [L1 + 14.6, 3.2, 1],
      [L1 + 15.9, 3.0, 1],
      [L1 + 16.4, 2.5, 1],
    ];
    const K = 24;
    const pos = (s: number): V3 => (s <= L1 ? add(hip, scale(d1, s)) : add(knee, scale(d2, s - L1)));
    const rows = st.map(([s, rad]) => {
      const t = clamp((s - (L1 - 2.5)) / 5, 0, 1);
      const dir = norm(lerp3(d1, d2, t));
      const [, u, v] = frame(dir, X);
      const c = pos(s);
      // Slight outward bow at the thigh top so the hips read wider than the knees.
      const cc: V3 = s < 6 ? add(c, [sx * 0.3 * (1 - Math.max(0, s) / 6), 0, 0]) : c;
      const fit = plush ? 1.04 : feminine ? 0.52 + 0.62 * smoothstep(-2.2, 3, s) - 0.23 * smoothstep(3, L1 + 3, s) : 1;
      return ring(cc, u, v, rad * fit, rad * fit * (s < 7 ? 0.94 : 1.04), K, 2, Math.PI / K);
    });
    // Outer-side columns for the stripe: the ring vertex whose u (= +X-ish) component points outward.
    const outward = (k: number) => {
      const a = Math.PI / K + ((k + 0.5) / K) * Math.PI * 2;
      return Math.cos(a) * sx;
    };
    b.surface(rows, {
      paint: (i, k) => (st[i][2] ? PANTS_TRIM : outward(k) > 0.985 && i >= 2 && i < st.length - 5 ? ACCENT : PANTS),
      weight: (p, i) => {
        const s = st[i][0];
        const w = hat(s, [[-1, thigh], [L1 - 2.2, thigh], [L1 + 2.2, calf], [L1 + 14, calf], [L1 + 17.5, foot]]);
        const pw = smoothstep(2.5, -2.2, s) * 0.45;
        return mixW([w, 1 - pw], [[[pelvis, 1]], pw]);
      },
      capEnd: PANTS_TRIM,
    });

    // Sneaker: upper lofted heel -> toe in rings around the Y axis (forward = -Y).
    const fx = ankle[0] + sx * 0.15;
    const shoe: [number, number, number][] = [
      // y, half width, top z
      [5.15, 1.5, 4.0],
      [4.5, 2.2, 6.1],
      [3.0, 2.5, 6.9],
      [1.0, 2.62, 6.6],
      [-1.2, 2.72, 5.1],
      [-3.4, 2.78, 3.95],
      [-5.6, 2.6, 3.2],
      [-7.2, 2.1, 2.6],
      [-8.3, 1.2, 2.0],
    ];
    const bot = 1.05;
    const shoeW = (p: V3): Wt => blend(foot, toe, smoothstep(-2.2, -4.6, p[1]));
    const upper = shoe.map(([y, hw, top]) => ring([fx, y, (top + bot) / 2], X, Z, hw * (plush ? 1.05 : 1), (top - bot) / 2 * (plush ? 1.04 : 1), 20, 2.6));
    b.surface(upper, { closed: true, paint: (i, k) => (i === 1 && k >= 2 && k <= 6 ? ACCENT : SHOE), weight: shoeW, capStart: SHOE, capEnd: SHOE, out: (i, k) => sub(upper[i][k], [fx, shoe[i][0], (shoe[i][2] + bot) / 2]) });
    // Sole (accent), a little wider and longer than the upper.
    const sole = [[5.55, 1.7], [4.6, 2.5], [2, 2.85], [-1.5, 3.0], [-5, 2.95], [-7.4, 2.4], [-8.75, 1.35]].map(([y, hw]) => ring([fx, y, 0.62], X, Z, hw * (plush ? 1.05 : 1), 0.62, 20, 3.2));
    b.surface(sole, { paint: () => ACCENT, weight: shoeW, capStart: ACCENT, capEnd: ACCENT });
    if (tek) tekShoeWing(b, side, fx, shoeW);
    // Laces: three bars across the top of the foot.
    for (const y of [-0.6, -2.0, -3.4]) {
      const t = clamp((1.0 - y) / 4.4, 0, 1);
      const zt = 6.6 + (3.95 - 6.6) * t + 0.12;
      b.tube([[fx - 1.3, y, zt - 0.35], [fx, y - 0.1, zt], [fx + 1.3, y, zt - 0.35]], 0.32, 6, Y, () => DETAIL, (p) => shoeW(p));
    }
  }

  // --- Sleeves, cuffs, gloves -------------------------------------------------------------------
  for (const side of ["L", "R"] as const) {
    const clav = B(`${side}_Clavicle`), up = B(`${side}_UpperArm`), fore = B(`${side}_Forearm`), hand = B(`${side}_Hand`);
    const sh = at(`${side}_UpperArm`), el = at(`${side}_Forearm`), wr = at(`${side}_Hand`);
    const d1 = norm(sub(el, sh)), d2 = norm(sub(wr, el));
    const L1 = len(sub(el, sh));
    const st: [number, number, number][] = [
      // s, radius, paint (0 hoodie, 1 trim)
      [-2.6, 2.3, 0],
      [-1.6, 3.15, 0],
      [0.2, 3.3, 0],
      [3, 3.15, 0],
      [6.5, 2.95, 0],
      [9.5, 2.85, 0],
      [L1, 2.85, 0],
      [L1 + 3, 2.8, 0],
      [L1 + 6, 2.62, 0],
      [L1 + 8.6, 2.45, 0],
      [L1 + 9.0, 2.7, 1],
      [L1 + 10.8, 2.72, 1],
      [L1 + 11.3, 2.35, 1],
    ];
    const pos = (s: number): V3 => (s <= L1 ? add(sh, scale(d1, s)) : add(el, scale(d2, s - L1)));
    const K = 16;
    const rows = st.map(([s, rad]) => {
      const t = clamp((s - (L1 - 2)) / 4, 0, 1);
      const dir = norm(lerp3(d1, d2, t));
      const [, u, v] = frame(dir, Y);
      // Shoulder cap rises a little above the joint.
      const c = add(pos(s), s < 1 ? [0, 0, 0.6 * (1 - Math.abs(s + 0.6) / 2)] : [0, 0, 0]);
      // Narrow the shoulder silhouette while blending back to the unchanged wrist/glove attachment.
      if (feminine) c[0] -= Math.sign(sh[0]) * 0.48 * (1 - smoothstep(0, L1 + 6, s));
      const fit = plush ? 1.06 : feminine ? 0.82 + 0.18 * smoothstep(L1 + 3, L1 + 11.3, s) : 1;
      return ring(c, u, v, rad * 1.04 * fit, rad * fit, K);
    });
    b.surface(rows, {
      paint: (i) => (st[i][2] ? TRIM : HOODIE),
      weight: (p, i) => {
        const s = st[i][0];
        const w = hat(s, [[0.5, up], [L1 - 1.8, up], [L1 + 1.8, fore]]);
        const c = smoothstep(2.5, -2.6, s) * 0.45;
        return mixW([w, 1 - c], [[[clav, 1]], c]);
      },
      capStart: HOODIE,
      capEnd: TRIM,
    });

    // Glove: palm block wrist -> knuckles, two finger blocks (index; middle-ring-pinky) and the thumb, each lofted
    // along its finger bones so the CS:S grip curls them around the knife handle; in the equipped glove style
    // (viewmodel/gloves/tp.ts; knit = the original glove).
    if (plush) plushMittens(b, side);
    else buildTpGlove(b, side, glove);
  }

  }

  // --- Tek (tek.ts): its own head and jacket details instead of the hood, face, pocket, strings and logos ----------
  if (tek) {
    tekHead(b);
    tekJacket(b, torsoW, torsoFacePoint, HOODIE, TRIM);
  }

  // --- The bunny's own head and hoodie details (Tek has its own above) ------------------------
  if (!tek) {
    if (plush || bune) supporterHead(b, plush ? "plush" : "bune");
    else {
    // --- Neck, face, visor
    const faceC: V3 = [0, -0.55, 68.7];
    const faceR: V3 = [4.05, 4.35, 4.85];
    const headW = (p: V3): Wt => hat(p[2], [[62.8, spine4], [64.6, neck], [66.6, head]]);
    {
      const rows = [62.2, 64, 65.8].map((z) => ring([0, 2.0 - (z - 62.2) * 0.4, z], X, Y, 2.6, 2.5, 12));
      b.surface(rows, { paint: () => FACE, weight: (p) => headW(p) });
      const fr = b.ellipsoidRows(faceC, faceR, Z, X, 22, 12);
      // A gently tapered lower face; keep the upper face and hood attachment unchanged.
      if (feminine) for (const row of fr) for (const p of row) p[0] *= 1 - 0.10 * smoothstep(69, 64, p[2]);
      b.surface(fr, { paint: () => FACE, weight: (p) => headW(p) });
      // Visor: a wraparound band proud of the face at eye level, with a thin lip above and below.
      const lats = [0.04, 0.09, 0.3, 0.35];
      const offs = [0.12, 0.42, 0.42, 0.12];
      const segs = 18;
      const vrows = lats.map((lat, j) =>
        Array.from({ length: segs + 1 }, (_, k) => {
          const lon = -1.22 + (2.44 * k) / segs;
          const d: V3 = [Math.sin(lon) * Math.cos(lat), -Math.cos(lon) * Math.cos(lat), Math.sin(lat)];
          return [faceC[0] + d[0] * (faceR[0] + offs[j]), faceC[1] + d[1] * (faceR[1] + offs[j]), faceC[2] + d[2] * (faceR[2] + offs[j])] as V3;
        }),
      );
      b.surface(vrows, { closed: false, paint: () => VISOR, weight: () => [[head, 1]], out: (i, k) => sub(vrows[i][k], faceC) });
      // Glowing eyes on the visor: two soft pills, slightly proud of it.
      for (const sx of [1, -1]) {
        const lon = 0.42 * sx, lat = 0.19;
        const d: V3 = [Math.sin(lon) * Math.cos(lat), -Math.cos(lon) * Math.cos(lat), Math.sin(lat)];
        const c: V3 = [faceC[0] + d[0] * (faceR[0] + 0.42), faceC[1] + d[1] * (faceR[1] + 0.42), faceC[2] + d[2] * (faceR[2] + 0.42)];
        const [, u, v] = frame(d, Z);
        const eye = b.ellipsoidRows(c, [1, 1, 1], d, u, 12, 6);
        // Squash the unit sphere into a pill in the visor's plane: wide (v ~ horizontal), short (u ~ up), thin (d).
        const pill = eye.map((row) =>
          row.map((p) => {
            const q = sub(p, c);
            const a = dot3(q, v), bb = dot3(q, u), n = dot3(q, d);
            // Slightly almond-shaped eyes with lifted outer corners, in the same glowing visor style.
            const eyeWidth = feminine ? 0.87 : 0.78;
            const eyeHeight = feminine ? 0.46 * (1 - 0.22 * Math.abs(a)) : 0.52;
            const point = add(c, add(add(scale(v, a * eyeWidth), scale(u, bb * eyeHeight)), scale(d, n * 0.22)));
            if (feminine) point[2] += 0.20 * (point[0] - c[0]) * sx;
            return point;
          }),
        );
        b.surface(pill, { paint: () => GLOW, weight: () => [[head, 1]] });
      }
      // Bunny nose.
      const nose = b.ellipsoidRows([0, faceC[1] - faceR[1] + 0.05, faceC[2] - 1.05], [feminine ? 0.54 : 0.62, 0.45, feminine ? 0.40 : 0.45], Y, X, 10, 6);
      b.surface(nose, { paint: () => ACCENT, weight: () => [[head, 1]] });
    }

    // --- Hood (up), rim, ears -------------------------------------------------------------------
    {
      const hc: V3 = [0, 0.55, 69.35];
      const hr: V3 = [5.55, 6.05, 6.0];
      const fwd = norm([0, -1, -0.12]);
      const open = 0.98; // radians from the forward axis
      const rows = b.ellipsoidRows(hc, hr, fwd, Z, 28, 14, open, Math.PI);
      const hoodW = (p: V3): Wt => {
        const low = smoothstep(67.5, 63.6, p[2]) * smoothstep(-1, 3, p[1]);
        return mixW([[[head, 1]], 1 - low], [[[neck, 0.45], [spine4, 0.55]], low]);
      };
      b.surface(rows, { paint: () => HOODIE, weight: hoodW, capEnd: HOODIE });
      // Rim: a soft rolled edge.
      const rim = rows[0];
      const rc = scale(rim.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / rim.length);
      const tubeRows: V3[][] = [];
      const sides = 8;
      for (let k = 0; k <= rim.length; k++) {
        const p = rim[k % rim.length];
        const t = norm(sub(rim[(k + 1) % rim.length], rim[(k - 1 + rim.length) % rim.length]));
        const outv = norm(sub(p, rc));
        const [, u, v] = frame(t, outv);
        tubeRows.push(ring(p, u, v, 0.8, 0.8, sides));
      }
      // Transpose so rows run around the tube's length (surface wants rings as rows).
      b.surface(tubeRows, { paint: () => TRIM, weight: hoodW, out: (i, k) => sub(tubeRows[i][k], rim[i % rim.length]) });

      // Ears: flattened, swept back, with an accent inner panel; two bones each for floppy secondary motion.
      for (const side of ["L", "R"] as const) {
        const sx = side === "L" ? 1 : -1;
        const e1 = r.index(`bunny.Ear${side}`), e2 = r.index(`bunny.Ear${side}2`);
        const base: V3 = [EAR.base[0] * sx, EAR.base[1], EAR.base[2]];
        const dir0: V3 = [EAR.dir[0] * sx, EAR.dir[1], EAR.dir[2]];
        const dirTip = norm([0.32 * sx, 0.8, 0.5]);
        const prof: [number, number, number][] = [
          // t, half width, half thickness
          [-0.06, 1.45, 1.05],
          [0.08, 1.9, 1.0],
          [0.25, 2.35, 0.9],
          [0.45, 2.5, 0.82],
          [0.65, 2.3, 0.72],
          [0.8, 1.9, 0.62],
          [0.92, 1.25, 0.5],
          [1, 0.3, 0.3],
        ];
        const pts: V3[] = [];
        let p = add(base, scale(dir0, prof[0][0] * EAR.length));
        for (let i = 0; i < prof.length; i++) {
          if (i > 0) {
            const t = (prof[i][0] + prof[i - 1][0]) / 2;
            const d = norm(lerp3(dir0, dirTip, smoothstep(0.3, 1, t)));
            p = add(p, scale(d, (prof[i][0] - prof[i - 1][0]) * EAR.length));
          }
          pts.push(p);
        }
        const segT = EAR.seg / EAR.length;
        const K = 14;
        const erows = prof.map(([t, hw, ht], i) => {
          const d = norm(lerp3(dir0, dirTip, smoothstep(0.3, 1, t)));
          const [, u, v] = frame(d, [Math.cos(0.25) * sx, 0, -Math.sin(0.25) * 0.3]);
          // v points to the ear's front (-Y side): make sure.
          const vf = v[1] > 0 ? scale(v, -1) : v;
          return ring(pts[i], u, vf, hw, ht, K, 2.2);
        });
        b.surface(erows, {
          paint: (i, k) => {
            const a = ((k + 0.5) / K) * Math.PI * 2;
            const front = Math.sin(a) > 0.8; // v side
            return front && i >= 2 && i <= 5 ? ACCENT : HOODIE;
          },
          weight: (_, i) => {
            const t = prof[i][0];
            if (t < 0.05) return blend(head, e1, smoothstep(-0.06, 0.05, t));
            return blend(e1, e2, smoothstep(segT - 0.08, segT + 0.12, t));
          },
          capStart: HOODIE,
          capEnd: HOODIE,
        });
      }
    }

    }
    if (plush) plushStitches(b, torsoFacePoint, torsoW);

    if (!bune) {
    // --- Hoodie details: pocket, drawstrings, hop-arc logos -----------------------------------------
    {
      // Kangaroo pocket: a raised trapezoid patch on the front with a little wall around it.
      const U = 9, V = 5;
      const patch: V3[][] = [];
      const base: V3[][] = [];
      for (let j = 0; j <= V; j++) {
        const z = 39.2 + (5.6 * j) / V;
        const hw = (5.9 - 1.1 * (j / V)) * (feminine ? 0.95 : 1);
        const row: V3[] = [];
        const brow: V3[] = [];
        for (let i = 0; i <= U; i++) {
          const x = -hw + (2 * hw * i) / U;
          row.push(torsoFacePoint(x, z, -1, 0.42)[0]);
          brow.push(torsoFacePoint(x, z, -1, -0.05)[0]);
        }
        patch.push(row);
        base.push(brow);
      }
      b.surface(patch, { closed: false, paint: () => TRIM, weight: (p) => torsoW(p), out: () => [0, -1, 0] });
      const edge: V3[] = [];
      const bedge: V3[] = [];
      for (let i = 0; i <= U; i++) (edge.push(patch[0][i]), bedge.push(base[0][i]));
      for (let j = 1; j <= V; j++) (edge.push(patch[j][U]), bedge.push(base[j][U]));
      for (let i = U - 1; i >= 0; i--) (edge.push(patch[V][i]), bedge.push(base[V][i]));
      for (let j = V - 1; j >= 1; j--) (edge.push(patch[j][0]), bedge.push(base[j][0]));
      b.surface([edge, bedge], { closed: true, paint: () => TRIM, weight: (p) => torsoW(p) });

      // Drawstrings from the hood opening, ending in aglets.
      for (const sx of [1, -1]) {
        const path: V3[] = [];
        for (let z = 63.4; z >= 53.2; z -= 1.7) {
          const x = sx * (1.7 + (63.4 - z) * 0.035);
          path.push(torsoFacePoint(x, z, -1, 0.45)[0]);
        }
        b.tube(path, 0.3, 6, X, () => ACCENT, (p) => torsoW(p));
        const end = path[path.length - 1];
        b.tube([add(end, [0, 0, 0.3]), add(end, [0, -0.05, -1.5])], 0.46, 8, X, () => DETAIL, (p) => torsoW(p));
      }

      // The bunnyhop.lol hop-arc mark (three growing hops and a dot): big on the back, small on the left chest.
      const arc = (cx: number, cz: number, w: number, side: number, width: number) => {
        // Logo path in its 64x64 box: M8 47 Q14.5 33 21 47 Q29 25 37 47 Q46.5 15 56 47, dot at (56, 47).
        const quads: [number, number][][] = [
          [[8, 47], [14.5, 33], [21, 47]],
          [[21, 47], [29, 25], [37, 47]],
          [[37, 47], [46.5, 15], [56, 47]],
        ];
        const s = w / 48;
        const map = (px: number, py: number): [number, number] => [cx + side * -(px - 32) * s, cz - (py - 31) * s];
        const pts: [number, number][] = [];
        for (const [p0, p1, p2] of quads)
          for (let i = pts.length ? 1 : 0; i <= 10; i++) {
            const t = i / 10;
            const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
            const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
            pts.push(map(x, y));
          }
        // Ribbon on the surface.
        const top: V3[] = [];
        const bottom: V3[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [x, z] = pts[i];
          const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
          const [px, pz] = pts[Math.max(0, i - 1)];
          const tx = nx - px, tz = nz - pz;
          const l = Math.hypot(tx, tz) || 1;
          const ox = (-tz / l) * width * 0.5, oz = (tx / l) * width * 0.5;
          top.push(torsoFacePoint(x + ox, z + oz, side, 0.16)[0]);
          bottom.push(torsoFacePoint(x - ox, z - oz, side, 0.16)[0]);
        }
        b.surface([top, bottom], { closed: false, paint: () => ACCENT, weight: (p) => torsoW(p), out: () => [0, side, 0] });
        // Dot.
        const [dx, dz] = map(56, 47);
        const dr = 4.5 * s;
        const dot: V3[] = [];
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          dot.push(torsoFacePoint(dx + Math.cos(a) * dr, dz + Math.sin(a) * dr, side, 0.18)[0]);
        }
        const c = torsoFacePoint(dx, dz, side, 0.2)[0];
        b.surface([dot.map(() => c), dot], { paint: () => GLOW, weight: (p) => torsoW(p), out: () => [0, side, 0] });
      };
      arc(0, 52.5, 11, 1, 1.05);
      arc(4.6, 56.4, 3.6, -1, 0.5);
    }

  }

  }

  // --- The blade in the right hand: the knife registry's third-person twin (viewmodel/knives/; the carrot by default),
  // authored in R_Hand's bone frame (x along the fingers) where a CS:S knife world model sits.
  {
    const k = knife ?? carrot;
    k.build(tpCtx(b, k.tp));
  }

  return b.geometry();
}

const cached = new Map<string, THREE.BufferGeometry>();

/**
 * The shared bunny geometry per knife + glove style (built once per pair on first use, ~20-30k vertices, a few ms;
 * the carrot and the knit glove by default).
 */
export function bunnyGeometry(knife?: KnifeDef | null, glove: GloveStyleId = "knit", look: BunnyLook = "bunny", body: BunnyBody = "classic"): THREE.BufferGeometry {
  if (look !== "bunny") body = "classic";
  const id = bunnyGeometryKey(knife, glove, look, body);
  let g = cached.get(id);
  if (!g) cached.set(id, (g = buildBunnyGeometry(knife, glove, look, body)));
  return g;
}

/** bunnyGeometry's cache key. */
export const bunnyGeometryKey = (knife: KnifeDef | null | undefined, glove: GloveStyleId, look: BunnyLook, body: BunnyBody): string =>
  `${knife?.id ?? "carrot"}|${glove}|${look}|${look !== "bunny" ? "classic" : body}`;

/** Already built (or seeded) for this key. */
export const hasBunnyGeometry = (key: string): boolean => cached.has(key);

/** A geometry built elsewhere (prebuild.ts: the same build, in a worker) for this key, unless one is already there. */
export function seedBunnyGeometry(key: string, g: THREE.BufferGeometry): void {
  if (!cached.has(key)) cached.set(key, g);
}
