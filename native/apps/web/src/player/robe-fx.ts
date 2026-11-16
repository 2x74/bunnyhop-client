// The Robe (progression.ts ROBE_ITEM, player/bunny/robe.ts): a haori worn over the hoodie. Its cloth is folded into the
// player materials beside the other back items' motion (back-fx.ts): no textures, one draw call. It differs from the
// cape in three ways, which is why it has its own codes:
//
//   - It is worn round the body, so there is no one way "back": every point of its body swings from the top of its own
//     column, away from the body where the wind blows it off and pressed where the wind blows it on, and the open
//     fronts fly apart at speed.
//   - It has sleeves. A sleeve is drawn from the arm's line where it is now, not skinned to it: over the arm, then
//     hanging straight down from it whichever way the arm is turned (a forearm held forward in a gun hold, an upper
//     arm swung back in a run), each sleeve swinging on its own spring.
//   - It is printed. The pattern is drawn per pixel in the cloth's own coordinates (units round the body from the
//     middle of the back, units up it; units along a sleeve and down it), so it stays crisp at any distance it is
//     readable from and fades to its mean colour before it can shimmer.
//
// Per vertex (backfx.x the code, its fraction the shade as for every back item; backfx.w the tone role, ROBE_ROLE):
//
//   9   the body, collar band and sash: partColor = (U, V, door), backfx.z = thigh.
//         U, V   pattern coordinates (units)
//         door   0..1 toward the free front edge of an open robe: how much of the fronts' flaring it takes
//         thigh  0..1 how much it rides on a thigh (the fronts below the hips): that much of it neither hangs by its
//                own weight nor is pushed by the legs (it is skinned to one)
//   10  a sleeve: partColor = (l, u, D), backfx.z = S.
//         l, u   where it is across the arm (units): l to the side (level, square to the arm), u up from the arm's line
//         D      how far it hangs below the arm's line (0 on the half round the top of the arm)
//   11, 12  a first-person sleeve (the viewmodel's right / left forearm): as 10, drawn from that forearm's line; it has
//         no body to stay out of.
//         S      how far along the sleeve from where it starts, over ROBE_S units (so it stays in 0..1 like every
//                back item's weights): the pattern's coordinate along it
//
// backfx.y stays 0 (the other items' chain weight), and the robe never bounces (uBackTip.z = 0), so the shared code
// passes its vertices through untouched.
//
// Uniforms: the body swings on the cape's springs (uBack = [flare, pitch, side, flutter], uBackTip, uBackMid);
// uBackPivot.z is the height its cloth is free below, uBackAxis = [that cloth's length, the hip line it hangs by its
// own weight below, 0]. Its own: uRobeL / uRobeR (a sleeve's swing: the root's then the free end's, each a level
// offset per unit of drop in the model's own frame), uRobe = [pattern, the sleeves' drop, radius and start].

import { rig, type V3 } from "./bunny/rig";
import { vmRig } from "../viewmodel/rig";

/** The tone roles of the robe's faces (backfx.w; uCapeTones is shared with the Cape): robeTones' order. */
export const ROBE_ROLE = { cloth: 1, print: 2, lining: 3, band: 4 } as const;
/** (11 / 12: the first-person sleeves on the viewmodel's right / left forearm, viewmodel/robe-sleeves.ts.) */
export const ROBE_CODE = { body: 9, sleeve: 10, fpRight: 11, fpLeft: 12 } as const;

export { ROBE_PATTERNS } from "./robe-names";

const fin = (x: number) => (Number.isFinite(x) ? x : 0);
const clampN = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linHex = (hex: number): V3 => [lin(((hex >> 16) & 255) / 255), lin(((hex >> 8) & 255) / 255), lin((hex & 255) / 255)];
const lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** A picked colour is kept between near-black and near-white (linear), so folds still shade on both (as the Cape's). */
const TONE_MIN = 0.012, TONE_MAX = 0.88;
/** The least contrast (WCAG's ratio) between the print and the cloth, and between the collar band and the cloth. */
const PRINT_CONTRAST = 1.7, BAND_CONTRAST = 1.45;

/** `c` moved lighter or darker (the way it already leans from `from`, if there is room) until it stands `min` from it. */
function apart(c: V3, from: V3, min: number): V3 {
  const yc = lum(c), yf = lum(from);
  if (ratio(yc, yf) >= min) return c;
  const lighter = (yf + 0.05) * min - 0.05, darker = (yf + 0.05) / min - 0.05;
  const up = yc >= yf ? lighter <= TONE_MAX : darker < TONE_MIN;
  if (up) {
    const t = clampN((lighter - yc) / Math.max(1e-4, 1 - yc), 0, 1);
    return [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t];
  }
  const k = clampN(darker / Math.max(1e-4, yc), 0, 1);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * The robe's four tones (linear RGB, in ROBE_ROLE order: cloth, print, lining, collar band) from the colourway (its
 * joggers' colour and its accent, linear) and the colours its owner picked (sRGB 0xRRGGBB; absent = the default).
 *   - The cloth is the picked colour, else the colourway's joggers colour: the outfit's own second garment colour, a
 *     dark neutral on most, so the robe reads as part of the outfit over the hoodie.
 *   - The print is the picked pattern colour, else the accent; it is moved lighter or darker until it stands
 *     PRINT_CONTRAST from the cloth, so a pattern reads on any pair (white on white prints a grey).
 *   - The collar band (and the sleeve edges and the sash) is the print's colour, plain. The lining is the cloth's
 *     colour a third of the way to the print's, in shade.
 */
export function robeTones(pants: V3, accent: V3, cloth?: number | null, print?: number | null): [V3, V3, V3, V3] {
  const keep = (c: V3): V3 => [clampN(c[0], TONE_MIN, TONE_MAX), clampN(c[1], TONE_MIN, TONE_MAX), clampN(c[2], TONE_MIN, TONE_MAX)];
  const base = cloth != null ? keep(linHex(cloth)) : pants;
  const ink = apart(print != null ? keep(linHex(print)) : accent, base, PRINT_CONTRAST);
  const band = apart(ink, base, BAND_CONTRAST);
  const inner = mix3(base, ink, 0.34);
  return [base, ink, [inner[0] * 0.62, inner[1] * 0.62, inner[2] * 0.62], band];
}

// ---------------------------------------------------------------------------------------------
// The sleeves' motion (CPU): one small pendulum per sleeve, in the model's own frame (x, y level; z up).

export interface SleeveMotion {
  /** Per sleeve (left, right): the root's level offset per unit of drop, its rate, and the free end's. */
  q: Float64Array;
  /** Where each sleeve hung from last frame (model space), and its low-passed velocity there (the acceleration's source). */
  at: Float64Array;
  v: Float64Array;
  yaw: number;
  initialized: boolean;
}
export const sleeveMotion = (): SleeveMotion => ({ q: new Float64Array(16), at: new Float64Array(6), v: new Float64Array(6), yaw: 0, initialized: false });

/**
 * A sleeve's swing: its natural frequency (Hz) and damping, the free end's, how far the air streams it (an offset per
 * unit of drop at full wind) and that wind's speed scale (u/s), how far a unit of the arm's acceleration (u/s2) throws
 * it, how far falling floats it out, and the most it may lean.
 */
export const SLEEVE = { hz: 1.9, zeta: 0.34, tipHz: 1.55, tipZeta: 0.3, wind: 0.62, windV: 620, acc: 0.00042, accMax: 1500, limit: 0.85 } as const;

/**
 * Steps both sleeves by dt (s). `anchors`: where each hangs from now (the middle of the left forearm's sleeve, then the
 * right's; model space: the feet face +x, z up). `vel`: the body's velocity (Source u/s, world) and `yawDeg` the feet's
 * yaw, which turn it into that frame. `snap`: start from where the wind rests them; `still`: Potato (hold the pose).
 */
export function advanceSleeves(s: SleeveMotion, anchors: ArrayLike<number>, vel: ArrayLike<number>, yawDeg: number, dt: number, snap = false, still = false): void {
  const h = Math.max(0, Math.min(fin(dt), 0.1));
  const yaw = fin(yawDeg) * (Math.PI / 180), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // The body's velocity in the model's frame.
  const bx = cy * fin(vel[0]) + sy * fin(vel[1]), by = -sy * fin(vel[0]) + cy * fin(vel[1]);
  const rest = (vx: number, vy: number): [number, number] => {
    const sp = Math.hypot(vx, vy);
    if (sp < 1) return [0, 0];
    const k = (-SLEEVE.wind * (1 - Math.exp(-sp / SLEEVE.windV))) / sp;
    return [vx * k, vy * k];
  };
  if (still || snap || !s.initialized) {
    if (!still) {
      const [rx, ry] = rest(bx, by);
      for (let i = 0; i < 2; i++) {
        const o = i * 8;
        s.q.fill(0, o, o + 8);
        s.q[o] = s.q[o + 4] = rx;
        s.q[o + 1] = s.q[o + 5] = ry;
      }
    }
    for (let i = 0; i < 6; i++) (s.at[i] = fin(anchors[i])), (s.v[i] = 0);
    s.yaw = yaw;
    s.initialized = true;
    return;
  }
  if (h <= 0) return;
  // A turn of the feet carries the sleeves round: the air they move through, as a velocity at each anchor.
  let dyaw = yaw - s.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  s.yaw = yaw;
  const wz = clampN(dyaw / h, -12, 12);
  const k = 1 - Math.exp(-h / 0.05);
  const n = Math.max(1, Math.ceil(h / (1 / 120))), dh = h / n;
  const w0 = 2 * Math.PI * SLEEVE.hz, kk = w0 * w0, c = 2 * SLEEVE.zeta * w0;
  const w1 = 2 * Math.PI * SLEEVE.tipHz, kt = w1 * w1, ct = 2 * SLEEVE.tipZeta * w1;
  for (let i = 0; i < 2; i++) {
    const o = i * 8, a = i * 3;
    const ax = fin(anchors[a]), ay = fin(anchors[a + 1]), az = fin(anchors[a + 2]);
    // The anchor's own velocity in the model (the arm's swing), low-passed; its change is the arm's acceleration.
    const vx = (ax - s.at[a]) / h, vy = (ay - s.at[a + 1]) / h, vz = (az - s.at[a + 2]) / h;
    const acx = ((vx - s.v[a]) * k) / h, acy = ((vy - s.v[a + 1]) * k) / h;
    s.v[a] += (vx - s.v[a]) * k;
    s.v[a + 1] += (vy - s.v[a + 1]) * k;
    s.v[a + 2] += (vz - s.v[a + 2]) * k;
    (s.at[a] = ax), (s.at[a + 1] = ay), (s.at[a + 2] = az);
    const sat = (x: number) => SLEEVE.accMax * Math.tanh(x / SLEEVE.accMax);
    const [rx, ry] = rest(bx + s.v[a] - wz * ay, by + s.v[a + 1] + wz * ax);
    const fx = -SLEEVE.acc * sat(acx), fy = -SLEEVE.acc * sat(acy);
    for (let j = 0; j < n; j++) {
      s.q[o + 2] += (kk * (rx + fx - s.q[o]) - c * s.q[o + 2]) * dh;
      s.q[o + 3] += (kk * (ry + fy - s.q[o + 1]) - c * s.q[o + 3]) * dh;
      s.q[o] += s.q[o + 2] * dh;
      s.q[o + 1] += s.q[o + 3] * dh;
      const m = Math.hypot(s.q[o], s.q[o + 1]);
      if (m > SLEEVE.limit) (s.q[o] *= SLEEVE.limit / m), (s.q[o + 1] *= SLEEVE.limit / m), (s.q[o + 2] *= 0.5), (s.q[o + 3] *= 0.5);
      s.q[o + 6] += (kt * (s.q[o] - s.q[o + 4]) - ct * s.q[o + 6]) * dh;
      s.q[o + 7] += (kt * (s.q[o + 1] - s.q[o + 5]) - ct * s.q[o + 7]) * dh;
      s.q[o + 4] += s.q[o + 6] * dh;
      s.q[o + 5] += s.q[o + 7] * dh;
      const mt = Math.hypot(s.q[o + 4], s.q[o + 5]);
      if (mt > SLEEVE.limit * 1.15) (s.q[o + 4] *= (SLEEVE.limit * 1.15) / mt), (s.q[o + 5] *= (SLEEVE.limit * 1.15) / mt);
    }
  }
}

/** A sleeve's uniform (uRobeL: 0, uRobeR: 1): [the root's offset x, y, the free end's x, y]. */
export const sleeveUniform = (s: SleeveMotion, i: 0 | 1): [number, number, number, number] => [s.q[i * 8], s.q[i * 8 + 1], s.q[i * 8 + 4], s.q[i * 8 + 5]];

// ---------------------------------------------------------------------------------------------
// GLSL

const R = rig();
const f3 = (x: number) => x.toFixed(4);
const bone = (n: string) => R.bone(n).toFixed(1);
/** The arm's line in the bind pose (left; mirror x): the sleeve's frame is built from where the bones turn it to. */
const ARM = (() => {
  const a = R.at("L_UpperArm"), b = R.at("L_Hand");
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  return d.map((x) => x / l) as V3;
})();
/** The sleeve's frame in the bind pose (left): level and square to the arm (`side`), and square to both (`up`). */
export function sleeveFrame(sx: number): { arm: V3; side: V3; up: V3 } {
  const arm: V3 = [ARM[0] * sx, ARM[1], ARM[2]];
  const l = Math.hypot(arm[0], arm[1]);
  const side: V3 = [arm[1] / l, -arm[0] / l, 0];
  const up: V3 = [side[1] * arm[2] - side[2] * arm[1], side[2] * arm[0] - side[0] * arm[2], side[0] * arm[1] - side[1] * arm[0]];
  return { arm, side, up };
}

/**
 * What the robe's body is kept outside of, in the bind pose: the torso as an ellipse round [0, cy] (half width a, half
 * depth b, the hoodie's widest from the chest down) for the sleeves, which hang beside it. The legs are back-fx.ts's.
 */
export const ROBE_BODY = { a: 11.3, b: 8.8, cy: 0.85, z: [30, 34, 55, 61] } as const;

/**
 * A sleeve narrows over the shoulder, in toward the neck: its radius is `min` of the full one at `from` (units along
 * the arm from the shoulder joint) and full from `to` on.
 */
export const SLEEVE_CAP = { min: 0.66, from: -4.8, to: 0.4 } as const;
export const SLEEVE_TAPER = 0.1, SLEEVE_TAPER_AT = 14;

/** A sleeve's radius `along` units from the shoulder joint, for a full radius `r` (as the shader's rbRad). */
export function sleeveRadius(along: number, r: number): number {
  const st = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // Fitted: it narrows with the arm toward the forearm (SLEEVE_TAPER of its radius by SLEEVE_TAPER_AT units along).
  return r * (SLEEVE_CAP.min + (1 - SLEEVE_CAP.min) * st(SLEEVE_CAP.from, SLEEVE_CAP.to, along)) * (1 - SLEEVE_TAPER * st(SLEEVE_CAP.to, SLEEVE_TAPER_AT, along));
}

/** How far above a bottom edge the hem's stitching runs (the turned-up fold, drawn as a fine darker line). */
export const ROBE_HEM = 0.6;

/** The sleeve's along-coordinate is stored over this many units (backfx.z stays in 0..1). */
export const ROBE_S = 32;

/** The first-person forearms' lines in the viewmodel's bind pose (viewmodel/rig.ts): right, left. */
const VM = vmRig();
export const FP_ARMS = (["Right", "Left"] as const).map((side) => {
  const a = VM.at(`v_weapon.${side}_Arm`), b = VM.at(`v_weapon.${side}_Hand`);
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  return { bone: VM.bone(`v_weapon.${side}_Arm`), from: a, dir: d.map((x) => x / l) as V3, length: l };
});

/**
 * The first-person cut (viewmodel units; s along a forearm from the elbow, the wrist at its length, about 8.6):
 *   from, to   where the sleeve starts and where its opening is (short of the hoodie's cuff, which shows)
 *   snug, r    its radius where it starts (on the hoodie's sleeve, 2.2 at most there) and at the opening
 *   flare      the stretch before the opening over which it widens
 *   drop       how far it hangs below the forearm's line at the opening; `dropFrom`: where the drop starts
 *   band       the width of the edge band
 */
export const FP_ROBE = { from: -6.5, to: -2.3, snug: 2.42, r: 2.62, flare: 5.6, drop: 7.4, dropFrom: 6.8, band: 0.3, corner: 0.6, gap: 0.26 } as const;
/** How much finer the print is drawn on the first-person sleeves. */
export const FP_PRINT = 2.1;
/** A first-person sleeve's radius s along a forearm of `length` (as the shader's rbRad for codes 11 / 12). */
export function fpSleeveRadius(s: number, length: number): number {
  const s1 = length + FP_ROBE.to, t = Math.min(1, Math.max(0, (s - (s1 - FP_ROBE.flare)) / (FP_ROBE.flare - 0.6)));
  return FP_ROBE.snug + (FP_ROBE.r - FP_ROBE.snug) * t * t * (3 - 2 * t);
}

/** Vertex declarations (after back-fx.ts's). */
export const ROBE_FX_VERTEX_PARS = /* glsl */ `
// uRobe: [pattern, the sleeves' drop, their radius, where they start along the arm].
uniform vec4 uRobeL, uRobeR, uRobe;
varying vec3 vRobe;
// How far a point is above the bottom edge of its cloth (the body's hem, the bottom of a sleeve's drop).
varying float vRobeHem;
// A sleeve vertex's radius over the arm, and how much of its drop goes round under the arm (the rest hangs).
float rbRad, rbRound;
bool rbBody() { return backfx.x > 8.5 && backfx.x < 9.5; }
bool rbSleeve() { return backfx.x > 9.5 && backfx.x < 12.5; }
// (A first-person sleeve: on the viewmodel's forearm.)
bool rbFp() { return backfx.x > 10.5; }
// Which side a sleeve vertex is on: +1 the bunny's left (and the viewmodel's left arm), -1 the right.
float rbSide() { return backfx.x > 11.5 ? 1.0 : backfx.x > 10.5 ? -1.0 : position.x < 0.0 ? -1.0 : 1.0; }
// The sleeve's arm line in the bind pose.
vec3 rbArm(float sx) {
  if (backfx.x > 11.5) return vec3(${FP_ARMS[1].dir.map(f3).join(", ")});
  if (backfx.x > 10.5) return vec3(${FP_ARMS[0].dir.map(f3).join(", ")});
  return vec3(sx * ${f3(ARM[0])}, ${f3(ARM[1])}, ${f3(ARM[2])});
}
// The body's cloth at a bind-space point: free below uBackPivot.z, each point swinging from the top of its own column.
// o: its way out from the body (level). It goes where the wind takes it on the side the wind blows off, and stays
// (pressed) where the wind blows on; the open fronts fly apart and back with the flare (uBack.x); a ripple runs down it
// at speed, more at its free edges, and a landing sends a soft wave down it (uBackMid.w, the seconds since).
vec3 rbCloth(vec3 p, float door, float thigh, out vec2 ang) {
  ang = vec2(0.0);
  float below = uBackPivot.z - p.z;
  if (below <= 0.0) return p;
  float s = clamp(below / uBackAxis.x, 0.0, 1.0), w = pow(s, 1.25);
  vec2 o = normalize(vec2(p.x / ${f3(ROBE_BODY.a * ROBE_BODY.a)}, (p.y - ${f3(ROBE_BODY.cy)}) / ${f3(ROBE_BODY.b * ROBE_BODY.b)}));
  vec2 a = bkAng(w);
  // (+ pitch carries a hanging point back, + side toward -x.)
  vec2 wd = vec2(-a.y, a.x);
  float lee = dot(o, wd) / (length(wd) + 0.05);
  float f = mix(0.16, 1.0, smoothstep(-0.5, 0.5, lee)) * (1.0 - 0.8 * thigh);
  ang = a * f;
  vec3 q = vec3(p.xy, uBackPivot.z) + bkSwing(vec3(0.0, 0.0, -below), ang.x, ang.y);
  float low = smoothstep(0.25, 1.0, s), fl = uBack.w;
  float back = smoothstep(-0.2, 0.6, o.y);
  // The back fills and ripples; the free edges flutter.
  q.xy += o * fl * low * back * (1.0 - 0.6 * thigh) * (0.9 + 0.42 * sin(p.z * 0.55 + p.x * 0.22 + uFinTime * 9.0) + 0.3 * sin(p.z * 0.23 - p.x * 0.31 + uFinTime * 5.3));
  q.xy += o * fl * w * door * 0.55 * sin(p.z * 0.6 + uFinTime * 11.0 + sign(p.x) * 1.7);
  // The open fronts: out to the side and back, more toward the hem.
  q.xy += w * door * uBack.x * vec2(sign(p.x) * 4.6, 3.4);
  float tw = uBackMid.w, d = (s - 0.05 - tw * 1.7) / 0.2;
  q.xy += o * 1.5 * exp(-d * d) * max(0.0, 1.0 - tw / 0.6) * (1.0 - thigh);
  return q;
}
#ifdef USE_SKINNING
// A sleeve's swing at its drop D of the whole drop: the root's going over to the free end's.
vec2 rbSleeveSwing(float sx, float w) {
  vec4 q = sx > 0.0 ? uRobeL : uRobeR;
  return q.xy * w + (q.zw - q.xy) * w * w * w;
}
#endif`;

/** Vertex, after back-fx.ts's normal block: the body's cloth turns its normal as it swings. */
export const ROBE_FX_VERTEX_NORMAL = /* glsl */ `
  if (rbBody()) {
    vec2 rbA;
    rbCloth(position, partColor.z, backfx.z, rbA);
    objectNormal = bkSwing(objectNormal, rbA.x, rbA.y);
  }`;

/** Vertex, after back-fx.ts's position block (before skinning). */
export const ROBE_FX_VERTEX_POSITION = /* glsl */ `
  vRobe = vec3(0.0);
  vRobeHem = 99.0;
  rbRad = 1.0; rbRound = 0.0;
  if (rbBody()) {
    vRobeHem = position.z - (uBackPivot.z - uBackAxis.x);
    vec2 rbA;
    transformed = rbCloth(transformed, partColor.z, backfx.z, rbA);
    bkBind = transformed;
    vRobe = vec3(partColor.xy, backfx.w);
  } else if (rbSleeve()) {
    float rbS = backfx.z * ${f3(ROBE_S)} + uRobe.w;
    rbRad = uRobe.z * (${f3(SLEEVE_CAP.min)} + ${f3(1 - SLEEVE_CAP.min)} * smoothstep(${f3(SLEEVE_CAP.from)}, ${f3(SLEEVE_CAP.to)}, rbS)) * (1.0 - ${f3(SLEEVE_TAPER)} * smoothstep(${f3(SLEEVE_CAP.to)}, ${f3(SLEEVE_TAPER_AT)}, rbS));
    if (rbFp()) {
      // (A first-person sleeve: snug where it starts, widening to its opening.)
      float s1 = (backfx.x > 11.5 ? ${f3(FP_ARMS[1].length)} : ${f3(FP_ARMS[0].length)}) + ${f3(FP_ROBE.to)};
      rbRad = mix(${f3(FP_ROBE.snug)}, ${f3(FP_ROBE.r)}, smoothstep(s1 - ${f3(FP_ROBE.flare)}, s1 - 0.6, backfx.z * ${f3(ROBE_S)} + ${f3(FP_ROBE.from)}));
    }
    rbRound = min(partColor.z, rbRad);
    vRobeHem = uRobe.y - partColor.z;
#ifdef USE_SKINNING
    // The point of the arm's line it is drawn from: skinned, then built out again from where the arm is. (Unskinned,
    // an item's tile, it is drawn as built.)
    float sx = rbSide();
    vec3 a0 = rbArm(sx), h0 = normalize(vec3(a0.y, -a0.x, 0.0)), u0 = cross(h0, a0);
    transformed = position - h0 * partColor.x - u0 * (partColor.y - rbRound) + vec3(0.0, 0.0, partColor.z - rbRound);
    bkBind = transformed;
#endif
    // (Its print: units along it, and units round it from the top of the arm and on down the drop.)
    vRobe = vec3(backfx.z * ${f3(ROBE_S)}, partColor.z > 0.0 ? sign(partColor.x) * (1.5708 * rbRad + partColor.z) : rbRad * atan(partColor.x, partColor.y), backfx.w);
    // (In first person the arm is drawn smaller than the bunny's and seen along its length: the print is drawn finer,
    // so a few repeats show on what is in view.)
    if (rbFp()) vRobe.xy *= ${f3(FP_PRINT)};
  }`;

const legGlsl = (side: "L" | "R") => {
  const joint = (b: string, p: V3 = R.at(b)) => `(getBoneMatrix(${bone(b)}) * vec4(${p.map((x) => x.toFixed(3)).join(", ")}, 1.0)).xyz`;
  const foot = R.at(`${side}_Foot`), toe = R.at(`${side}_Toe0`);
  const heel: V3 = [foot[0], foot[1] + 3.3, 2.6], tip: V3 = [toe[0], toe[1] - 4.2, 1.6];
  return `bkLeg(${joint(`${side}_Thigh`)}, ${joint(`${side}_Calf`)}, ${joint(`${side}_Foot`)}, ${joint(`${side}_Foot`, heel)}, ${joint(`${side}_Toe0`, tip)}, rbT, rbO, rbXs, transformed.z, rbNeed);`;
};

/**
 * Vertex, after <skinning_vertex> and back-fx.ts's block. The body: below the hip line (uBackAxis.y) what does not ride
 * on a thigh hangs straight down from that line, and is kept outside the legs along its own way out from the body. A
 * sleeve: over the arm where the arm is now, then hanging straight down from it, swung by its spring, kept outside
 * the torso and off a raised thigh.
 */
export const ROBE_FX_VERTEX_SKINNED = /* glsl */ `
#ifdef USE_SKINNING
  if (backfx.x > 8.5 && backfx.x < 12.5) {
    mat4 rbM = boneMatX * skinWeight.x + boneMatY * skinWeight.y + boneMatZ * skinWeight.z + boneMatW * skinWeight.w;
    if (rbBody()) {
      float free = 1.0 - backfx.z;
      float below = uBackAxis.y - bkBind.z;
      if (below > 0.0 && free > 0.0) transformed = mix(transformed, (rbM * vec4(bkBind.xy, uBackAxis.y, 1.0)).xyz - vec3(0.0, 0.0, below), free);
      if (free > 0.01 && bkBind.z < uBackAxis.y + 6.0) {
        vec2 ob = vec2(position.x / ${f3(ROBE_BODY.a * ROBE_BODY.a)}, (position.y - ${f3(ROBE_BODY.cy)}) / ${f3(ROBE_BODY.b * ROBE_BODY.b)});
        vec2 rbO = (rbM * vec4(ob, 0.0, 0.0)).xy;
        rbO = dot(rbO, rbO) > 1e-8 ? normalize(rbO) : vec2(0.0, 1.0);
        vec2 rbT = vec2(rbO.y, -rbO.x);
        float rbBase = dot(transformed.xy, rbO), rbXs = dot(transformed.xy, rbT), rbNeed = rbBase;
        ${legGlsl("L")}
        ${legGlsl("R")}
        transformed.xy += rbO * free * (rbNeed - rbBase + (rbNeed > rbBase + 1e-4 ? 0.4 : 0.0));
      }
    } else {
      float sx = rbSide();
      vec3 a = normalize(mat3(rbM) * rbArm(sx));
      vec3 h = normalize(vec3(a.y, -a.x, 0.0)), up = cross(h, a);
      float D = partColor.z, w = clamp(D / uRobe.y, 0.0, 1.0);
      vec2 sw = rbSleeveSwing(sx, w);
      float below = D - rbRound;
      vec3 hang = below * vec3(sw, -sqrt(max(0.1, 1.0 - dot(sw, sw))));
      transformed += h * partColor.x + up * (partColor.y - rbRound) + hang;
      objectNormal = below > 0.0 ? normalize(h * sign(partColor.x) * (1.0 - 0.75 * smoothstep(0.82, 1.0, w)) + vec3(sw * 0.6, -smoothstep(0.7, 1.0, w))) : normalize(h * partColor.x + up * (partColor.y - rbRound) + vec3(0.0, 0.0, 1e-4));
      if (below > 0.0 && !rbFp()) {
        // Beside the torso, not through it: out of the hoodie's ellipse in the chest's own frame.
        mat4 tm = getBoneMatrix(${bone("Spine1")});
        vec3 q = (transformed - tm[3].xyz) * mat3(tm);
        vec2 e = vec2(q.x / ${f3(ROBE_BODY.a)}, (q.y - ${f3(ROBE_BODY.cy)}) / ${f3(ROBE_BODY.b)});
        float r = length(e), in01 = smoothstep(${f3(ROBE_BODY.z[0])}, ${f3(ROBE_BODY.z[1])}, q.z) * smoothstep(${f3(ROBE_BODY.z[3])}, ${f3(ROBE_BODY.z[2])}, q.z);
        if (r < 1.0 && r > 1e-4) {
          q.xy = mix(q.xy, vec2(e.x / r * ${f3(ROBE_BODY.a)}, e.y / r * ${f3(ROBE_BODY.b)} + ${f3(ROBE_BODY.cy)}), in01 * w);
          transformed = mat3(tm) * q + tm[3].xyz;
        }
        // Off a raised thigh: out to the body's own side.
        vec2 rbO = (getBoneMatrix(${bone("Pelvis")}) * vec4(sx, 0.0, 0.0, 0.0)).xy;
        rbO = dot(rbO, rbO) > 1e-8 ? normalize(rbO) : vec2(sx, 0.0);
        vec2 rbT = vec2(rbO.y, -rbO.x);
        float rbBase = dot(transformed.xy, rbO), rbXs = dot(transformed.xy, rbT), rbNeed = rbBase;
        ${legGlsl("L")}
        ${legGlsl("R")}
        transformed.xy += rbO * (rbNeed - rbBase);
      }
    }
  }
#endif`;

/**
 * Pattern sizes (units): a check's side, a wave's radius, the star lattice's side, an arrow column's width and a
 * feather's height. A few repeats across the back (about 20 units), so each reads from the chase camera.
 */
export const ROBE_PATTERN = { check: 4.2, wave: 5.2, star: 8.6, arrowW: 3.9, arrowH: 3.4 } as const;

/** Fragment declarations (solid). */
export const ROBE_FX_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uCapeTones[4];
uniform vec4 uRobe;
uniform vec3 uBackAxis;
varying vec3 vRobe;
varying float vRobeHem;
float rbSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// How much of a pixel at p (units; aw: units per pixel each way) the print covers, and the share it covers overall.
float rbPrint(vec2 p, vec2 aw, float kind, out float mean) {
  float am = max(aw.x, aw.y);
  if (kind < 1.5) {
    // Checks (ichimatsu): squares, every other one printed.
    mean = 0.5;
    vec2 d = p / ${f3(ROBE_PATTERN.check)}, ad = aw / ${f3(ROBE_PATTERN.check)};
    vec2 sg = clamp((0.25 - abs(fract(d * 0.5) - 0.5)) / (ad * 0.5), -1.0, 1.0);
    return 0.5 + 0.5 * sg.x * sg.y;
  }
  if (kind < 2.5) {
    // Waves (seigaiha): rows of overlapping scallops, each row half a radius above the one in front of it and set
    // half a scallop across; three printed arcs in each.
    mean = 0.42;
    vec2 q = p / ${f3(ROBE_PATTERN.wave)};
    float aq = am / ${f3(ROBE_PATTERN.wave)}, j0 = ceil((q.y - 1.0) * 2.0), d = 2.0;
    for (int k = 0; k < 4; k++) {
      float j = j0 + float(k);
      float cx = (floor((q.x - mod(j, 2.0)) * 0.5 + 0.5) * 2.0) + mod(j, 2.0);
      float dd = length(q - vec2(cx, j * 0.5));
      if (dd < 1.0) { d = dd; break; }
    }
    float arcs = 0.0;
    for (int k = 0; k < 3; k++) {
      float r0 = 1.0 - 0.3 * float(k);
      arcs = max(arcs, clamp((0.09 - abs(d - (r0 - 0.09))) / aq + 0.5, 0.0, 1.0));
    }
    return arcs;
  }
  if (kind < 3.5) {
    // Star (asanoha): a lattice of triangles, each cut from its middle to its corners.
    mean = 0.3;
    vec2 q = p.yx / ${f3(ROBE_PATTERN.star)};
    float aq = am / ${f3(ROBE_PATTERN.star)};
    vec2 l = vec2(q.x - q.y * 0.57735, q.y * 1.154701), i = floor(l), f = fract(l);
    vec2 la = i + (f.x + f.y < 1.0 ? vec2(0.0) : vec2(1.0)), lb = i + vec2(1.0, 0.0), lc = i + vec2(0.0, 1.0);
    vec2 A = vec2(la.x + la.y * 0.5, la.y * 0.866025), B = vec2(lb.x + lb.y * 0.5, lb.y * 0.866025), C = vec2(lc.x + lc.y * 0.5, lc.y * 0.866025);
    vec2 G = (A + B + C) / 3.0;
    float d = min(min(rbSeg(q, A, B), rbSeg(q, B, C)), rbSeg(q, C, A));
    d = min(d, min(min(rbSeg(q, G, A), rbSeg(q, G, B)), rbSeg(q, G, C)));
    return clamp((0.042 - d) / aq + 0.5, 0.0, 1.0) * min(1.0, 0.084 / aq + 0.4);
  }
  // Arrows (yagasuri): columns of feathers, every other feather printed, each column half a feather out of step with
  // the next; a fine shaft down each column in the other tone.
  mean = 0.5;
  float x = p.x / ${f3(ROBE_PATTERN.arrowW)}, col = floor(x), xl = fract(x) - 0.5;
  float t = (p.y + abs(xl) * ${f3(ROBE_PATTERN.arrowW * 1.15)}) / ${f3(ROBE_PATTERN.arrowH)} + mod(col, 2.0) * 0.5;
  float at = (aw.y + aw.x * 1.15) / ${f3(ROBE_PATTERN.arrowH)};
  float band = 0.5 + 0.5 * clamp((0.25 - abs(fract(t * 0.5) - 0.5)) / (at * 0.5), -1.0, 1.0);
  float ax = aw.x / ${f3(ROBE_PATTERN.arrowW)};
  float shaft = clamp((0.035 - abs(xl)) / ax + 0.5, 0.0, 1.0) * min(1.0, 0.07 / ax + 0.3);
  float edge = clamp((0.03 - (0.5 - abs(xl))) / ax + 0.5, 0.0, 1.0) * min(1.0, 0.06 / ax + 0.3);
  return mix(mix(band, 1.0 - band, shaft), 0.0, edge * 0.0);
}`;

/**
 * Fragment (solid), after back-fx.ts's: the robe's cloth, shaded as cloth (a soft sheen in its own colour, no
 * highlight); its outside printed where the face is cloth (role 1), its inside the lining, in the garment's shade.
 */
export const ROBE_FX_FRAGMENT_SOLID = /* glsl */ `
  if (vRobe.z > 0.5) {
    vec3 rb = vColor;
    float shade = max(0.0, vBackFx - floor(vBackFx + 0.03));
    if (!gl_FrontFacing) rb = uCapeTones[2];
    else if (vRobe.z < 1.5 && uRobe.x > 0.5) {
      vec2 aw = max(abs(dFdx(vRobe.xy)), abs(dFdy(vRobe.xy)));
      float mean, m = rbPrint(vRobe.xy, aw, uRobe.x, mean);
      // Too small to draw: its mean colour (no shimmer on a far bunny).
      m = mix(m, mean, smoothstep(0.35, 0.9, max(aw.x, aw.y)));
      rb = mix(rb, uCapeTones[1], m);
    }
    // Its seams, up close: down the middle of the back and down each side (a fine darker line).
    if (gl_FrontFacing && vBackFx < 9.5) {
      float sd = min(abs(vRobe.x), abs(abs(vRobe.x) - uBackAxis.z));
      float sw = max(fwidth(vRobe.x), 1e-4);
      rb *= 1.0 - 0.2 * clamp((0.07 - sd) / sw + 0.5, 0.0, 1.0) * min(1.0, 0.14 / sw);
    }
    // The hem, turned up and stitched: a narrow fold along the body's bottom edge and along the bottom of a sleeve.
    if (gl_FrontFacing && vRobe.z < 1.5) {
      float hw = max(fwidth(vRobeHem), 1e-4);
      rb *= 1.0 - 0.24 * clamp((0.07 - abs(vRobeHem - ${f3(ROBE_HEM)})) / hw + 0.5, 0.0, 1.0) * min(1.0, 0.14 / hw);
    }
    float rnv = max(dot(n, V), 0.0), graze = pow(1.0 - rnv, 2.5);
    // Cloth: its own colour in the light, and at grazing angles a sheen of that colour plus a little the weave scatters
    // whatever its colour (a black robe keeps its form).
    col = rb * (ambient + key * vec3(0.78, 0.74, 0.68)) + (rb * 0.3 + vec3(0.026, 0.028, 0.032)) * graze * (0.45 + 0.55 * key);
    col *= (1.0 - 0.75 * shade) * (gl_FrontFacing ? 1.0 : 0.8);
  }`;

/** Fragment (ghost): the print as a faint change of tone. */
export const ROBE_FX_FRAGMENT_PARS_GHOST = /* glsl */ `
varying vec3 vRobe;`;
