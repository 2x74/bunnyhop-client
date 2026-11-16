// Hair that moves in locks, takes a highlight colour and catches a sheen (v0.0.42), for the wigs (bunny/wigs.ts,
// bunny/hair-styles.ts). Spliced into the hat shader chunks
// (hat-fx.ts) so every bunny keeps one program and one material.
//
// What a hair vertex carries (the Builder's attributes, bunny/builder.ts; nothing new on other geometry):
//   accent     -9..-11 the older codes (hat-fx.ts: -10 still hair, -9 / -11 the Ponytail's tail); -12 a sprung lock of
//              hair
//   partColor  r the tone (0.5 = the hair colour); g how much of the highlight colour it takes (0..1, HIGHLIGHT below);
//              b a sprung lock's looseness (0 stiff .. 1 loose)
//   hairRoot   only on sprung locks: xyz the lock's pivot in bind space (where it leaves the head), w = G + 0.98 t:
//              t 0 (pivot) .. 1 (tip) along the free part, G a whole number 0..8, the lock's share of the length
//              slider over 4
//
// Length: a sprung lock is stretched away from its pivot by 1 + (uHairSway.w - 1) * G / 4 (the tip moves most, the
// pivot stays), so a style says per lock what "length" means (lengthFactor below maps the slider onto a style's range).
//
// Motion: two damped springs per player (advanceHair), one loose and slow, one stiff and quick, each a small vector in
// the head's bind frame (x the bunny's left, y back, z up): what the hair's free ends feel, minus the head's own
// acceleration, plus wind against the motion. A lock bends about its pivot toward a mix of the two by its looseness, the
// tip most, keeping its length, and never into the head. Spikes ring briefly after a hop; long hair lags, streams back
// with speed, floats in the air and settles.
//
// Shading (Source and up, uCosTier): a soft sheen band where the hair turns toward the key light, broken by the strands;
// Potato and Plain shade as before. The highlight is a colour, mixed per vertex, so it costs nothing per pixel.

import type { V3 } from "./bunny/rig";

/** Accent codes. */
export const HAIR_CODE = { lock: -12 } as const;

/**
 * The length a style draws for a saved hair length (a percent, progression.ts HAIR_LENGTH: 40..300, 100 = as built):
 * `min` at the slider's bottom, 1 at 100, `max` at its top. The Ponytail keeps its own mapping (hat-fx.ts: the percent
 * over 100).
 */
export const HAIR_RANGE: Record<string, { min: number; max: number }> = {
  "hat-spiky": { min: 0.55, max: 1.9 },
  "hat-long": { min: 0.5, max: 1.75 },
};
export function lengthFactor(hat: string | null | undefined, percent: number | null | undefined): number {
  const r = HAIR_RANGE[hat ?? ""];
  const p = Number.isFinite(percent) ? Math.min(300, Math.max(40, percent as number)) : 100;
  if (!r) return p / 100;
  return p <= 100 ? r.min + ((1 - r.min) * (p - 40)) / 60 : 1 + ((r.max - 1) * (p - 100)) / 200;
}

/**
 * Where sprung hair rests on the standard bunny, whose hood is down under a wig: a lock's point hanging below the
 * collar is carried out from the neck's axis to lie on the lowered hood and the shoulders, instead of going into them
 * (Long Hair past about 130%, Spiky Hair's nape at its longest; at 100% only the very ends are touched). In the hair's
 * own space (the reference head, before hat-fit.ts's 1.28 about the top of the neck): `below` units under `z`, a point
 * is at least `r` + `out` (1 - e^(-below / fall)) from the axis at y `y` (the hood's bulge: it stands out fast under
 * the collar, then levels), plus `side` toward the shoulders, which go on sloping out; a lock keeps `thick` of its
 * thickness there. (On the bunny: from z 64.6, 5.5 from the neck's axis, 9.0 by z 60, where the hood stands 2.8 off
 * the back and is 8.4 from it; 9.7 over the shoulders.)
 */
export const HAIR_REST = { z: 64.51, y: 1.825, r: 4.3, out: 2.9, fall: 1.25, side: 0.6, thick: 0.22 };
/** Whether a loadout's hair rests that way (uHairFlex.w): sprung locks on the standard bunny. */
export const hairRests = (hat: string | null | undefined, bunny: boolean): boolean => bunny && !!hat && SPRUNG_HATS.includes(hat);

/** Hats whose locks are sprung (model.ts runs advanceHair for them). */
export const SPRUNG_HATS: readonly string[] = ["hat-spiky", "hat-long"];

export interface HairMotion {
  /** The loose and the stiff spring: displacement (about radians at a lock's tip) and velocity, head frame. */
  loose: [number, number, number];
  looseV: [number, number, number];
  stiff: [number, number, number];
  stiffV: [number, number, number];
  /** Low-passed body velocity (world, Source axes). */
  vf: [number, number, number];
  yawRate: number;
  yaw: number;
  time: number;
  initialized: boolean;
}
export const hairMotion = (): HairMotion => ({ loose: [0, 0, 0], looseV: [0, 0, 0], stiff: [0, 0, 0], stiffV: [0, 0, 0], vf: [0, 0, 0], yawRate: 0, yaw: 0, time: 0, initialized: false });

/** Springs: natural frequency (Hz), damping ratio, coupling to the force per axis (left, back, up), and the most they bend. */
export const HAIR_SPRING = {
  loose: { hz: 1.8, zeta: 0.26, k: [0.06, 0.1, 0.085] as V3, max: 0.95 },
  stiff: { hz: 4.2, zeta: 0.22, k: [0.1, 0.11, 0.1] as V3, max: 0.5 },
} as const;
/** Velocity low-pass (s), acceleration saturation (u/s^2), wind at its strongest (u/s^2) and its speed scale (u/s). */
const TAU = 0.06, A_SAT = 1400, WIND = 760, WIND_V = 650;

/**
 * Steps both springs. vel: the body's velocity (world, Source axes, u/s); yawDeg: the view yaw; snap: restart at rest
 * (a teleport, a new hat); still: hold the pose (Potato, cosmetics held still) while carrying the inputs, so resuming
 * isn't a kick. Deterministic from its inputs; the same result at any frame rate to within the substep.
 */
export function advanceHair(s: HairMotion, vel: ArrayLike<number>, yawDeg: number, dt: number, snap = false, still = false): void {
  const h = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
  const v: [number, number, number] = [0, 1, 2].map((k) => (Number.isFinite(vel[k]) ? vel[k] : 0)) as [number, number, number];
  const yaw = (Number.isFinite(yawDeg) ? yawDeg : 0) * (Math.PI / 180);
  if (still || snap || !s.initialized) {
    if (!still) {
      s.loose = [0, 0, 0];
      s.looseV = [0, 0, 0];
      s.stiff = [0, 0, 0];
      s.stiffV = [0, 0, 0];
      s.time = 0;
    }
    s.vf = v;
    s.yaw = yaw;
    s.yawRate = 0;
    s.initialized = true;
    return;
  }
  if (h <= 0) return;
  // Low-passed velocity; its change is the acceleration (a hop's step of dv becomes dv / tau * e^(-t / tau) at any frame rate).
  const k = 1 - Math.exp(-h / TAU);
  const a = [0, 1, 2].map((i) => ((v[i] - s.vf[i]) * k) / h);
  for (let i = 0; i < 3; i++) s.vf[i] += (v[i] - s.vf[i]) * k;
  const sat = (x: number) => A_SAT * Math.tanh(x / A_SAT);
  let dyaw = yaw - s.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  s.yaw = yaw;
  const kr = 1 - Math.exp(-h / 0.05);
  const rate = dyaw / h;
  const yawAcc = ((rate - s.yawRate) * kr) / h;
  s.yawRate += (rate - s.yawRate) * kr;
  // World (yaw 0 = +x forward) into the head's frame: x = left, y = back.
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toHead = (x: number, y: number): [number, number] => [-sy * x + cy * y, -(cy * x + sy * y)];
  const [axh, ayh] = toHead(a[0], a[1]);
  const speed = Math.hypot(v[0], v[1]);
  const [vxh, vyh] = toHead(v[0], v[1]);
  const wind = WIND * (1 - Math.exp(-speed / WIND_V));
  // What a free end feels relative to the head: minus the head's acceleration (in the air that is free fall, so hair
  // floats), wind against the motion, and a turn of the head throwing it the other way.
  const f: V3 = [
    -sat(axh) - (speed > 1 ? (vxh / speed) * wind * 0.4 : 0) + Math.max(-900, Math.min(900, yawAcc * 9)),
    -sat(ayh) - (speed > 1 ? (vyh / speed) * wind : 0),
    -sat(a[2]),
  ];
  s.time = (s.time + h) % (Math.PI * 200);
  const idle = Math.exp(-speed / 120);
  const rest: V3 = [0.03 * idle * Math.sin(s.time * 1.15), 0.016 * idle * Math.sin(s.time * 0.8 + 1), 0];
  const n = Math.max(1, Math.ceil(h / (1 / 120)));
  const dh = h / n;
  for (const [q, qv, sp, tgt] of [[s.loose, s.looseV, HAIR_SPRING.loose, rest], [s.stiff, s.stiffV, HAIR_SPRING.stiff, [0, 0, 0] as V3]] as const) {
    const w0 = 2 * Math.PI * sp.hz, kk = w0 * w0, c = 2 * sp.zeta * w0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 3; j++) {
        qv[j] += (sp.k[j] * f[j] - kk * (q[j] - tgt[j]) - c * qv[j]) * dh;
        q[j] += qv[j] * dh;
      }
      // A soft stop: past the limit the bend is pulled back onto it and loses most of its outward speed.
      const m = Math.hypot(q[0], q[1], q[2]);
      if (m > sp.max) {
        const r = sp.max / m;
        for (let j = 0; j < 3; j++) (q[j] *= r), (qv[j] *= 0.4);
      }
    }
  }
}

const f3 = (p: V3) => `vec3(${p.map((x) => x.toFixed(3)).join(", ")})`;
/** About the middle of the head and hood (bind space): locks never bend toward it. */
const HEAD_MID: V3 = [0, 0.1, 69.2];

/** Vertex declarations (before hat-fx's own, which use fxSprung in fxHair). */
export const HAIR_FX_VERTEX_PARS = /* glsl */ `
attribute vec4 hairRoot;
// The highlight colour (linear), a = 1 when one is picked.
uniform vec4 uHairHi;
// The loose spring (xyz, head bind frame) and the length factor of sprung locks (w; 0 before it's set = as built).
uniform vec4 uHairSway;
// The stiff spring (xyz); w: 1 when the locks rest over the lowered hood and the shoulders (HAIR_REST).
uniform vec4 uHairFlex;
// 1 on hair faces (for the sheen), else 0.
varying float vHair;
bool fxSprung() { return accent < -11.5 && accent > -12.5; }
// A sprung lock's point moved: stretched from its pivot for the length, then bent about it by the springs (nrm: its normal).
vec3 fxLockMove(vec3 p, vec3 nrm, out vec3 turn) {
  float g = floor(hairRoot.w + 0.001), t = clamp((hairRoot.w - g) / 0.98, 0.0, 1.0);
  vec3 d = p - hairRoot.xyz;
  float L = uHairSway.w > 0.01 ? uHairSway.w : 1.0;
  d *= 1.0 + (L - 1.0) * g * 0.25 * smoothstep(0.0, 0.45, t);
  float len = length(d);
  turn = vec3(0.0);
  if (len < 1e-4) return hairRoot.xyz;
  float loose = partColor.b;
  // Longer hair swings a little further and its tip is later.
  vec3 sway = mix(uHairFlex.xyz, uHairSway.xyz, loose) * (0.55 + 0.45 * loose) * pow(t, 1.35);
  // Never into the head: the part of the bend that points at it is dropped.
  vec3 outw = normalize(hairRoot.xyz - ${f3(HEAD_MID)});
  sway -= outw * min(0.0, dot(sway, outw)) * 0.85;
  vec3 dir = d / len;
  vec3 b = dir + sway;
  turn = cross(dir, sway);
  vec3 q = hairRoot.xyz + normalize(b) * len;
  // Resting over the lowered hood and the shoulders (HAIR_REST): out from the neck's axis, the lock's two faces kept apart.
  float below = ${HAIR_REST.z.toFixed(3)} - q.z;
  if (uHairFlex.w > 0.5 && below > 0.0) {
    vec2 r = q.xy - vec2(0.0, ${HAIR_REST.y.toFixed(3)});
    float have = max(length(r), 1e-3);
    vec2 rn = r / have;
    float need = ${HAIR_REST.r.toFixed(3)} + ${HAIR_REST.out.toFixed(3)} * (1.0 - exp(-below / ${HAIR_REST.fall.toFixed(3)})) + ${HAIR_REST.side.toFixed(3)} * abs(rn.x) * smoothstep(1.2, 3.5, below) + ${HAIR_REST.thick.toFixed(3)} * dot(nrm.xy, rn);
    if (have < need) q.xy += rn * (need - have);
  }
  return q;
}`;

/** Vertex, with hat-fx's normal block (before skinning): a bent lock's normal turns with it. */
export const HAIR_FX_VERTEX_NORMAL = /* glsl */ `
  if (fxSprung()) {
    vec3 hTurn;
    fxLockMove(position, objectNormal, hTurn);
    objectNormal = normalize(objectNormal + cross(hTurn, objectNormal));
  }`;

/** Vertex, with hat-fx's position block (before the head fit and skinning). */
export const HAIR_FX_VERTEX_POSITION = /* glsl */ `
  if (fxSprung()) {
    vec3 hTurn;
    transformed = fxLockMove(transformed, objectNormal, hTurn);
  }`;

/** Vertex, where the hair colour is set (materials.ts): the highlight's share, and the fragment's flag. */
export const HAIR_FX_VERTEX_COLOUR = /* glsl */ `
  vHair = 0.0;
  if (fxHair()) {
    vColor = fxHairTone(mix(uHairColor, uHairHi.rgb, uHairHi.a * clamp(partColor.g, 0.0, 1.0)), partColor.r);
    vHair = 1.0;
  }`;

/** Fragment declarations (vHair itself is declared with the hat materials, hat-detail.ts, which skip hair). */
export const HAIR_FX_FRAGMENT_PARS = /* glsl */ ``;

/**
 * Fragment (solid material), after the hat materials: `col`, n, V, L, key in scope, vFabricPos the bind position. A
 * sheen band where the hair turns toward the light from above, its height broken strand by strand round the head.
 */
export const HAIR_FX_FRAGMENT_SOLID = /* glsl */ `
  if (vHair > 0.5 && uCosTier > 1.5) {
    vec3 hH = normalize(L + V);
    float hnh = dot(n, hH);
    // Strands: a cheap hash of the angle round the head (bind space), so the band wavers like combed hair.
    float ha = atan(vFabricPos.x, vFabricPos.y - 0.5) * 9.0 + vFabricPos.z * 0.35;
    float hs = fract(sin(floor(ha * 2.0) * 12.9898) * 43758.5453);
    float hw = 0.5 + 0.5 * sin(ha * 6.2832);
    float band = exp(-pow((hnh - 0.78 - 0.07 * (hs - 0.5)) / 0.085, 2.0));
    float lum = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
    vec3 sheen = mix(vColor, vec3(1.0), 0.35) * (0.16 + 0.5 * lum) + vec3(0.035);
    col += sheen * band * (0.55 + 0.45 * hw) * (0.35 + 0.65 * key);
    // Fine strand shading across the lock, a few percent.
    col *= 0.965 + 0.07 * hs;
  }`;
