// Moving and glowing hat parts (the Supporter's hats, player/bunny/hats.ts), folded into the player materials
// (player/materials.ts) for every bunny: no extra textures or draw calls. A hat face opts in with an accent
// code (player/bunny/builder.ts Paint.code), its colour stays partColor:
//
//   -1  propeller rotor; -2 capybara body, -3 eyes, -4 mouth; -5 maxwell body, -6 eyes, -7 mouth, -8 tail (per-player
//       movement uniforms)
//   -9..-11  hair (bunny/wigs.ts), coloured by the player's hair colour (uHairColor) at the face's tone (partColor.r):
//       -10 still; -9 the Ponytail on the hood (Plush / Bun-E), -11 the Ponytail on the head (the bunny, hood down),
//       both bent about their tie by the per-player pendulum (advancePonytail, uPonytail): down on takeoff, up and back
//       in the air and with speed, out of a strafe; and stretched to the player's length (uPonytail.z, hairLength): the
//       arc out of the tie keeps its shape (a short tail's shrinks a little), the falling part scales, the lock's
//       thickness stays
//   11  the Aurora ribbon (Borealis): floats (bobs) above the ears with a light flowing round it (AURORA_C)
//   12  a gem of the Gem Orbit (and a coin of Lucky Coins: the same orbit): the ring of four turns slowly about the vertical axis through ORBIT_C, each gem spins
//       on its own axis and bobs, and every few seconds one of them pops and a white shine crosses it (hold, burst,
//       shine, rest); its facets get a dark edge where they turn away, like a drawn outline
//   13  crystal that floats (bobs) without turning (the Halo's ring), with a short light running round HALO_C
//   14  the same, for the Halo's amethyst insets
//   15  a glowing line on the hood (the Circlet's), with a light sweeping to and fro across the front of CROWN_C
//
// Crystal shading: flat facets (the geometry's), a soft inner glow in the face's colour, a light rim and a sharp glint.
// Motion and lights read uFinTime (viewmodel/finishes/shader.ts: one clock, held still in Potato mode). The spins turn
// the normals too, so the facets catch the key light as they come round. Cost: a branch per vertex and pixel.

import type { V3 } from "./bunny/rig";
import { PONYTAIL_C, PONYTAIL_HEAD_C, PONYTAIL_HEAD_LINE, PONYTAIL_LINE } from "./bunny/wigs";

/** Bind-space centre and radius of the Gem Orbit's ring (above the ear tips, clear of them as they flop). */
export const ORBIT_C: V3 = [0, 1.0, 86.9];
export const ORBIT_R = 4.7;
/** Where gem i (0..3) sits on the ring at rest: 45, 135, 225, 315 degrees (none straight in front of the face). */
export const orbitAngle = (i: number) => Math.PI / 4 + (i * Math.PI) / 2;
/** Bind-space centre and tilt (unit normal) of the Halo, above the ear tips. */
export const HALO_C: V3 = [0, 0.9, 86.7];
export const HALO_N: V3 = [0, 0.26, 0.966];
/** Bind-space centre of the Aurora ribbon (above the ear tips). */
export const AURORA_C: V3 = [0, 1.0, 87.9];
/** Bind-space centre of the Circlet's band (round the hood). */
export const CROWN_C: V3 = [0, 0.55, 73.0];
/** Toy rotor, forward of the ears; negative accent keeps it separate from crystal and glove codes. */
export const PROPELLER_C: V3 = [0, -2.9, 78.0];
/** Bind-space pivot of Maxwell the Cat on the forehead (forward of the bunny ear roots), for spinning and hopping. */
export const MAXWELL_C: V3 = [0, -1.9, 75.2];

/** HUD horizontal u/s, including high-speed airborne bhops; integrate without phase jumps or a run-speed cap. */
export function advancePropeller(angle: number, speedU: number, dt: number): number {
  const rate = 2 + Math.max(Number.isFinite(speedU) ? speedU : 0, 0) * 0.012;
  return (angle + rate * Math.max(0, Math.min(dt, 0.1))) % (Math.PI * 2);
}

/** Per-player reactions; speed is raw horizontal u/s, independent of gait or airborne state. */
export interface CapybaraMotion {
  alert: number;
  squash: number;
  lean: number;
  time: number;
  grounded: boolean;
  initialized: boolean;
}
export const capybaraMotion = (): CapybaraMotion => ({ alert: 0, squash: 0, lean: 0, time: 0, grounded: true, initialized: false });
export function advanceCapybara(s: CapybaraMotion, speedU: number, grounded: boolean, dt: number, snap = false, still = false): void {
  const speed = Math.max(0, Number.isFinite(speedU) ? speedU : 0);
  const h = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
  const alert = 1 - Math.exp(-speed / 900);
  if (still) {
    // Keep the visible pose frozen, but don't synthesize a landing when motion resumes.
    s.grounded = grounded;
    s.initialized = true;
    return;
  }
  if (snap || !s.initialized) {
    s.alert = alert;
    s.lean = alert * 0.09;
    s.squash = 0;
    s.time = 0;
  } else {
    const k = 1 - Math.exp(-8 * h);
    s.alert += (alert - s.alert) * k;
    s.lean += (alert * 0.09 - s.lean) * k;
    s.squash *= Math.exp(-12 * h);
    if (h > 0 && grounded !== s.grounded) s.squash = grounded ? -0.12 : 0.08;
    s.time = (s.time + h) % (Math.PI * 100);
  }
  s.grounded = grounded;
  s.initialized = true;
}

/**
 * The Ponytail's secondary motion: a damped pendulum per player, two angles about the tie (pitch: + lifts the tail up and
 * back; side: + swings the tip toward the bunny's right, -x), run on the CPU and drawn by the shader (uPonytail).
 *
 * It's driven by what the head feels, in the head's frame (x left, y back, z up): the body's acceleration (low-passed,
 * then softly saturated, so a hop's velocity step gives the same kick at any frame rate), which in the air includes
 * free fall, so the tail floats up while airborne and is jerked down on takeoff / landing; wind against the horizontal
 * velocity (streams it back, growing with u/s but levelling off, so 1000+ u/s still looks right); and the head's turn
 * (it lags a turn and swings out of a strafe). A small idle sway when nothing else moves it. Angles are clamped so it
 * never folds into the back or the head.
 */
export interface PonytailMotion {
  pitch: number;
  pitchV: number;
  side: number;
  sideV: number;
  /** Low-passed body velocity (world, Source axes) and the previous one, for the acceleration. */
  vf: [number, number, number];
  /** Low-passed yaw rate (rad/s) and the last yaw (rad). */
  yawRate: number;
  yaw: number;
  time: number;
  initialized: boolean;
}
export const ponytailMotion = (): PonytailMotion => ({ pitch: 0, pitchV: 0, side: 0, sideV: 0, vf: [0, 0, 0], yawRate: 0, yaw: 0, time: 0, initialized: false });

/** Pendulum tuning: natural frequency (Hz) and damping ratio; lever length (units); coupling to the body's acceleration. */
const PONY_HZ = 1.7, PONY_ZETA = 0.24, PONY_L = 6, PONY_K_UP = 0.3, PONY_K_SIDE = 0.14;
/** Velocity low-pass (s), acceleration saturation (u/s^2), wind at its strongest (u/s^2) and its speed scale (u/s). */
const PONY_TAU = 0.06, PONY_A = 1400, PONY_WIND = 800, PONY_WIND_V = 650;
/** Angle limits (rad) at the built length: the tail's root rises up and back from the tie, so it can't drop far before it meets the back. */
export const PONY_PITCH = [-0.3, 0.95] as const, PONY_SIDE = 0.6;

/**
 * Angle limits for a tail `len` times the built length (hairLength / 100): a long tail can drop less before its tip
 * meets the back, lift less before it fans over the head, and swing less to the side (its tip travels further); a short
 * one is perkier.
 */
export function ponyLimits(len: number): { pitch: [number, number]; side: number } {
  const l = Math.min(2.5, Math.max(0.3, Number.isFinite(len) ? len : 1));
  return {
    pitch: [Math.max(-0.45, PONY_PITCH[0] / l ** 1.5), PONY_PITCH[1] - 0.4 * Math.min(1, Math.max(0, l - 1))],
    side: Math.min(0.75, PONY_SIDE / Math.sqrt(l)),
  };
}

/** `len`: the tail's length over the built one (a longer pendulum swings slower: frequency over sqrt(len)). */
export function advancePonytail(s: PonytailMotion, vel: ArrayLike<number>, yawDeg: number, dt: number, snap = false, still = false, len = 1): void {
  const h = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
  const v: [number, number, number] = [0, 1, 2].map((k) => (Number.isFinite(vel[k]) ? vel[k] : 0)) as [number, number, number];
  const yaw = (Number.isFinite(yawDeg) ? yawDeg : 0) * (Math.PI / 180);
  if (still) {
    // Frozen pose; carry the inputs so resuming doesn't read as a kick.
    s.vf = v;
    s.yaw = yaw;
    s.yawRate = 0;
    s.initialized = true;
    return;
  }
  if (snap || !s.initialized) {
    s.pitch = s.pitchV = s.side = s.sideV = 0;
    s.vf = v;
    s.yaw = yaw;
    s.yawRate = 0;
    s.time = 0;
    s.initialized = true;
    return;
  }
  if (h <= 0) return;
  // Low-passed velocity; its change is the acceleration (a step of Δv becomes Δv/τ·e^(-t/τ), whatever the frame rate).
  const k = 1 - Math.exp(-h / PONY_TAU);
  const a = [0, 1, 2].map((i) => ((v[i] - s.vf[i]) * k) / h);
  for (let i = 0; i < 3; i++) s.vf[i] += (v[i] - s.vf[i]) * k;
  const sat = (x: number) => PONY_A * Math.tanh(x / PONY_A);
  let dyaw = yaw - s.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  s.yaw = yaw;
  const rate = dyaw / h;
  const yawAcc = (rate - s.yawRate) * (1 - Math.exp(-h / 0.05)) / h;
  s.yawRate += (rate - s.yawRate) * (1 - Math.exp(-h / 0.05));
  // World (Source: x, y horizontal, z up; yaw 0 = +x forward) into the head's frame: x = left, y = back (-forward).
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toHead = (x: number, y: number): [number, number] => [-sy * x + cy * y, -(cy * x + sy * y)];
  const [axh, ayh] = toHead(a[0], a[1]);
  // Free fall reads as -800 up: in the air the tail floats; on the ground the hop's step jerks it.
  const az = (Number.isFinite(a[2]) ? a[2] : 0);
  const speed = Math.hypot(v[0], v[1]);
  const [vxh, vyh] = toHead(v[0], v[1]);
  const wind = PONY_WIND * (1 - Math.exp(-speed / PONY_WIND_V));
  // The force on the tip relative to the head: minus the head's acceleration, plus the wind (against the motion).
  const fx = -sat(axh) - (speed > 1 ? (vxh / speed) * wind * 0.35 : 0);
  const fy = -sat(ayh) - (speed > 1 ? (vyh / speed) * wind : 0);
  const fz = -sat(az);
  // Directions the tip moves for +pitch (up and back) and +side (toward -x).
  const pitchF = PONY_K_UP * (0.75 * fy + 0.67 * fz) / PONY_L;
  const sideF = PONY_K_SIDE * (-fx) / PONY_L - 0.005 * yawAcc;
  s.time = (s.time + h) % (Math.PI * 200);
  const idle = Math.exp(-speed / 120);
  const lim = ponyLimits(len);
  const w0 = (2 * Math.PI * PONY_HZ) / Math.sqrt(Math.min(2.5, Math.max(0.3, Number.isFinite(len) ? len : 1))), kk = w0 * w0, c = 2 * PONY_ZETA * w0;
  const pTarget = 0.035 * idle * Math.sin(s.time * 1.7);
  const sTarget = 0.06 * idle * Math.sin(s.time * 1.1);
  // Semi-implicit Euler in substeps (stable at 10 fps).
  const n = Math.max(1, Math.ceil(h / (1 / 120)));
  const dh = h / n;
  for (let i = 0; i < n; i++) {
    s.pitchV += (pitchF - kk * (s.pitch - pTarget) - c * s.pitchV) * dh;
    s.sideV += (sideF - kk * (s.side - sTarget) - c * s.sideV) * dh;
    s.pitch += s.pitchV * dh;
    s.side += s.sideV * dh;
    if (s.pitch < lim.pitch[0]) (s.pitch = lim.pitch[0]), (s.pitchV = Math.max(0, s.pitchV) * 0.3);
    if (s.pitch > lim.pitch[1]) (s.pitch = lim.pitch[1]), (s.pitchV = Math.min(0, s.pitchV) * 0.3);
    if (Math.abs(s.side) > lim.side) (s.side = Math.sign(s.side) * lim.side), (s.sideV *= -0.2);
  }
}

/**
 * Seconds per turn of the Gem Orbit's ring; its gems' bob; the pop + shine cycle (one gem per cycle, in turn); seconds per
 * lap of the Halo's light; the Halo's bob; the Circlet's sweep.
 */
const RING_T = 16.0, GEM_BOB = 0.22, GLINT_T = 3.0, LAP = 7.0, BOB = 0.38, BOB_T = 3.2, SCAN_T = 3.6;

const v3 = (p: V3) => `vec3(${p.map((x) => x.toFixed(3)).join(", ")})`;

/** Vertex declarations. */
export const HAT_FX_VERTEX_PARS = /* glsl */ `
varying float vFx;
varying vec3 vFxP;
uniform float uFinTime;
uniform float uPropellerAngle;
// alertness, takeoff/landing stretch, wind lean, local clock (frozen with cosmetics).
uniform vec4 uCapybara;
// The Ponytail's pendulum (advancePonytail): pitch (+ up and back), side (+ the tip toward -x).
uniform vec4 uPonytail;
const vec3 FX_ORBIT_C = ${v3(ORBIT_C)};
const vec3 FX_HALO_C = ${v3(HALO_C)};
const vec3 FX_CROWN_C = ${v3(CROWN_C)};
const vec3 FX_AURORA_C = ${v3(AURORA_C)};
const vec3 FX_PROPELLER_C = ${v3(PROPELLER_C)};
const vec3 FX_MAXWELL_C = ${v3(MAXWELL_C)};
const vec3 FX_PONYTAIL_C = ${v3(PONYTAIL_C)};
const vec3 FX_PONYTAIL_HEAD_C = ${v3(PONYTAIL_HEAD_C)};
const vec3 FX_PONY_HOOD[6] = vec3[6](${PONYTAIL_LINE.map(v3).join(", ")});
const vec3 FX_PONY_HEAD[6] = vec3[6](${PONYTAIL_HEAD_LINE.map(v3).join(", ")});
// vFx: 1 orbit, 2 halo, 3 halo inset, 4 circlet line (codes 12-15), 5 aurora ribbon (code 11), 0 none.
float fxCode() { return accent > 11.5 && accent < 15.5 ? floor(accent - 11.0 + 0.5) : accent > 10.5 && accent < 11.5 ? 5.0 : 0.0; }
vec2 fxRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
float fxBob() { return ${BOB.toFixed(3)} * sin(uFinTime * ${((Math.PI * 2) / BOB_T).toFixed(4)}); }
bool fxCapy() { return accent < -1.5 && accent > -4.5; }
float fxCapyEyeScale() { return 0.12 + 0.88 * uCapybara.x; }
float fxCapyMouthScale() { return 0.12 + 0.88 * smoothstep(0.45, 0.95, uCapybara.x); }
float fxCapyStretch() { return 1.0 + uCapybara.y + 0.012 * sin(uCapybara.w * 2.0); }
bool fxMaxwell() { return accent < -4.5 && accent > -8.5; }
float fxMaxwellEyeScale() { return 0.52 + 0.62 * uCapybara.x; }
float fxMaxwellMouthScale() { return 0.18 + 0.82 * smoothstep(0.45, 0.95, uCapybara.x); }
float fxMaxwellSway() { return (0.045 + 0.14 * uCapybara.x) * sin(uPropellerAngle * 2.0 + uCapybara.w * 5.0); }
float fxMaxwellHop() {
  float b = abs(sin(uPropellerAngle + uCapybara.w * 3.2));
  return (0.12 + 1.05 * uCapybara.x) * b + max(uCapybara.y, 0.0) * 5.5;
}
float fxMaxwellStretch() {
  float b = cos(uPropellerAngle * 2.0 + uCapybara.w * 6.4);
  return 1.0 + uCapybara.y * 1.35 - 0.11 * uCapybara.x * b;
}
// Ponytail: how much a point swings (0 at the tie, 1 at the tip: the root stays stiff, the tip bends most), and the
// swing about the tie: side to side about the vertical, then up and back (+y) by the pendulum (uPonytail).
bool fxHair() { return accent < -8.5 && accent > -11.5; }
// Hair tone t: 0.5 = the colour; below darkens toward 0.45x at 0, above lifts toward a soft sheen (dark hair gets a
// visible one too: lifted toward a grey, not just multiplied).
vec3 fxHairTone(vec3 c, float t) {
  if (t < 0.5) return c * mix(0.45, 1.0, t * 2.0);
  return mix(c, max(c, vec3(0.16)) * 1.6 + vec3(0.05), (t - 0.5) * 2.0 * 0.5);
}
bool fxPony() { return (accent < -8.5 && accent > -9.5) || (accent < -10.5 && accent > -11.5); }
vec3 fxPonyC() { return accent < -10.5 ? FX_PONYTAIL_HEAD_C : FX_PONYTAIL_C; }
// The tail's length over the built one (uPonytail.z; 0 before it's set = as built).
float fxPonyLen() { return uPonytail.z > 0.01 ? uPonytail.z : 1.0; }
vec3 fxPonyPt(int i) { return accent < -10.5 ? FX_PONY_HEAD[i] : FX_PONY_HOOD[i]; }
vec3 fxPonyAt(float s) { int i = int(min(floor(s), 4.0)); return mix(fxPonyPt(i), fxPonyPt(i + 1), s - float(i)); }
// Where centreline point s (0..5 along its six points) goes at length L: the arc out of the tie (to point 2) keeps its
// shape (shrunk a little for a short tail), the falling part after it scales (see below).
vec3 fxPonyMapped(float s, float L) {
  float a = min(1.0, 0.55 + 0.45 * L);
  vec3 p0 = fxPonyPt(0), p2 = fxPonyPt(2);
  if (s <= 2.0) return p0 + (fxPonyAt(s) - p0) * a;
  vec3 d = fxPonyAt(s) - p2;
  // Down: by L when shorter, a little more when longer (the slider's top reaches between the shoulder blades); back: a
  // long tail steps out over the lowered hood's pouch on the upper back, then hangs straight again below it.
  float z = d.z * (L < 1.0 ? L : 1.0 + (L - 1.0) * 1.3);
  float y = d.y * (1.0 + max(0.0, L - 1.0) * 0.1) + 1.9 * smoothstep(6.0, 11.0, -z);
  return p0 + (p2 - p0) * a + vec3(d.x * L, y, z);
}
// Stretches a tail point to the player's length: finds its place along the centreline (the nearest point on it) and
// moves it with that point, so the lock keeps its thickness.
vec3 fxPonyStretch(vec3 p) {
  float L = fxPonyLen();
  if (abs(L - 1.0) < 0.005) return p;
  float best = 1e9, s = 0.0;
  for (int i = 0; i < 5; i++) {
    vec3 a = fxPonyPt(i), ab = fxPonyPt(i + 1) - a;
    float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
    float d = length(p - a - ab * t);
    if (d < best) { best = d; s = float(i) + t; }
  }
  return p + fxPonyMapped(s, L) - fxPonyAt(s);
}
// Distances along the swing are taken on the stretched tail, scaled with it so the tip still bends most.
float fxPonyW(vec3 p) { return pow(clamp(length(p - fxPonyC()) / (9.0 * mix(1.0, fxPonyLen(), 0.85)), 0.0, 1.0), 1.35); }
vec3 fxPonySwing(vec3 d, float w) {
  d.xy = fxRot(d.xy, w * uPonytail.y);
  d.yz = fxRot(d.yz, w * uPonytail.x);
  return d;
}
// Gem Orbit: which gem a bind-space point belongs to (by its angle round the ring), that gem's rest centre, its own
// spin (alternate gems turn the other way, at slightly different speeds), the ring's turn, and the pop of the gem whose
// turn it is (0..1, the first 0.12 s of its cycle).
float fxGem(vec3 p) { vec3 d = p - FX_ORBIT_C; return floor(mod(atan(d.y, d.x) / 1.5708 + 4.0, 4.0)); }
vec3 fxGemC(float i) { float a = 0.7854 + i * 1.5708; return FX_ORBIT_C + vec3(cos(a), sin(a), 0.0) * ${ORBIT_R.toFixed(3)}; }
float fxSelf(float i) { return (mod(i, 2.0) < 0.5 ? 1.0 : -1.0) * uFinTime * (1.1 + 0.2 * i) + i * 1.3; }
float fxRing() { return uFinTime * ${((Math.PI * 2) / RING_T).toFixed(4)}; }
float fxPop(float i) {
  float ph = fract(uFinTime / ${GLINT_T.toFixed(2)});
  return abs(mod(floor(uFinTime / ${GLINT_T.toFixed(2)}), 4.0) - i) < 0.5 ? sin(3.14159 * clamp(ph / 0.04, 0.0, 1.0)) * step(ph, 0.04) : 0.0;
}`;

/** Vertex, after <beginnormal_vertex> (before skinning): turns the normal with the spin. */
export const HAT_FX_VERTEX_NORMAL = /* glsl */ `
  if (accent < -0.5 && accent > -1.5) objectNormal.xy = fxRot(objectNormal.xy, uPropellerAngle);
  if (fxCapy()) {
    if (accent < -2.5 && accent > -3.5) objectNormal.z /= fxCapyEyeScale();
    if (accent < -3.5) objectNormal.z /= fxCapyMouthScale();
    objectNormal.z = (objectNormal.z - uCapybara.z * objectNormal.y) / fxCapyStretch();
    objectNormal = normalize(objectNormal);
  }
  if (fxMaxwell()) {
    if (accent < -5.5 && accent > -6.5) objectNormal.z /= fxMaxwellEyeScale();
    if (accent < -6.5 && accent > -7.5) objectNormal.z /= fxMaxwellMouthScale();
    objectNormal.z = (objectNormal.z - uCapybara.z * objectNormal.y - fxMaxwellSway() * objectNormal.x) / fxMaxwellStretch();
    objectNormal.xy = fxRot(objectNormal.xy, uPropellerAngle);
    objectNormal = normalize(objectNormal);
  }
  if (fxPony()) objectNormal = normalize(fxPonySwing(objectNormal, fxPonyW(fxPonyStretch(position))));
  if (fxCode() == 1.0) objectNormal.xy = fxRot(objectNormal.xy, fxSelf(fxGem(position)) + fxRing());`;

/** Vertex, after <begin_vertex> (before skinning): spin / bob in bind space, and the pattern point. */
export const HAT_FX_VERTEX_POSITION = /* glsl */ `
  vFx = fxCode();
  vFxP = vec3(0.0);
  if (accent < -0.5 && accent > -1.5) transformed.xy = FX_PROPELLER_C.xy + fxRot(transformed.xy - FX_PROPELLER_C.xy, uPropellerAngle);
  if (fxCapy()) {
    if (accent < -2.5 && accent > -3.5) transformed.z = 78.25 + (transformed.z - 78.25) * fxCapyEyeScale();
    if (accent < -3.5) transformed.z = 76.86 + (transformed.z - 76.86) * fxCapyMouthScale();
    // Squash about the paws, keeping contact with the hood; lean the upper body into the wind.
    transformed.y += (transformed.z - 74.9) * uCapybara.z;
    transformed.z = 74.9 + (transformed.z - 74.9) * fxCapyStretch();
  }
  if (fxMaxwell()) {
    if (accent < -5.5 && accent > -6.5) transformed.z = 77.78 + (transformed.z - 77.78) * fxMaxwellEyeScale();
    if (accent < -6.5 && accent > -7.5) transformed.z = 76.76 + (transformed.z - 76.76) * fxMaxwellMouthScale();
    if (accent < -7.5) {
      float w = clamp((transformed.y - 0.1) / 1.5, 0.0, 1.0);
      transformed.x += w * (0.1 + 0.34 * uCapybara.x) * sin(uPropellerAngle * 2.0 + uCapybara.w * 6.0);
      transformed.z += w * (0.05 + 0.16 * uCapybara.x) * cos(uPropellerAngle * 2.0 + uCapybara.w * 6.0);
    }
    float h = transformed.z - FX_MAXWELL_C.z;
    float s = fxMaxwellStretch();
    transformed.x = FX_MAXWELL_C.x + (transformed.x - FX_MAXWELL_C.x) / sqrt(max(s, 0.65)) + h * fxMaxwellSway();
    transformed.y = FX_MAXWELL_C.y + (transformed.y - FX_MAXWELL_C.y) / sqrt(max(s, 0.65)) + h * uCapybara.z * 0.5;
    transformed.z = FX_MAXWELL_C.z + h * s + fxMaxwellHop();
    transformed.xy = FX_MAXWELL_C.xy + fxRot(transformed.xy - FX_MAXWELL_C.xy, uPropellerAngle);
  }
  if (fxPony()) {
    vec3 q = fxPonyStretch(transformed);
    transformed = fxPonyC() + fxPonySwing(q - fxPonyC(), fxPonyW(q));
  }
  if (vFx == 1.0) {
    float gi = fxGem(transformed);
    vec3 c = fxGemC(gi);
    vec3 d = transformed - c;
    vFxP = vec3(gi, d.z, 0.0);
    d.xy = fxRot(d.xy, fxSelf(gi));
    d *= 1.0 + 0.22 * fxPop(gi);
    vec3 q = c + d + vec3(0.0, 0.0, ${GEM_BOB.toFixed(3)} * sin(uFinTime * 2.4 + gi * 1.7)) - FX_ORBIT_C;
    q.xy = fxRot(q.xy, fxRing());
    transformed = FX_ORBIT_C + q;
  } else if (vFx == 2.0 || vFx == 3.0) {
    vFxP = transformed - FX_HALO_C;
    transformed.z += fxBob() * 0.8;
  } else if (vFx == 4.0) {
    vFxP = transformed - FX_CROWN_C;
  } else if (vFx == 5.0) {
    vFxP = transformed - FX_AURORA_C;
    transformed.z += fxBob() * 0.8;
  }`;

/** Fragment declarations: crystal shading for fx faces. */
export const HAT_FX_FRAGMENT_PARS = /* glsl */ `
varying float vFx;
varying vec3 vFxP;
#ifndef FINISH
uniform float uFinTime;
#endif
// A light running round a ring (local point p, ring in the xy plane): bright head, fading tail.
float fxComet(vec3 p, float lap) {
  float a = atan(p.y, p.x);
  float head = fract(uFinTime / lap) * 6.28318 - 3.14159;
  float d = mod(head - a, 6.28318);
  return exp(-d * 5.0) + 0.7 * exp(-(6.28318 - d) * 40.0);
}
// A light sweeping to and fro across the front of a band round the hood (p: from its centre, -y the front).
float fxScan(vec3 p) {
  float a = atan(p.x, -p.y);
  float s = 1.15 * sin(uFinTime * ${((Math.PI * 2) / SCAN_T).toFixed(4)});
  return exp(-(a - s) * (a - s) * 18.0);
}
// Gem Orbit: the shine that crosses gem gi top to bottom just after its pop (local height h), 0 the rest of the time.
float fxGlint(float gi, float h) {
  float ph = fract(uFinTime / ${GLINT_T.toFixed(2)});
  if (abs(mod(floor(uFinTime / ${GLINT_T.toFixed(2)}), 4.0) - gi) > 0.5 || ph > 0.2) return 0.0;
  float s = mix(1.4, -1.4, clamp((ph - 0.03) / 0.15, 0.0, 1.0));
  return exp(-(h - s) * (h - s) * 7.0);
}
vec3 fxCrystal(vec3 base, vec3 n, vec3 V, vec3 L, vec3 ambient, float key, float glow) {
  float ndv = max(dot(n, V), 0.0);
  vec3 lit = base * (ambient * 0.55 + key * vec3(0.55, 0.53, 0.5));
  // Inner glow: brighter where the facet faces away from the eye (light through the far side), breathing slowly.
  float breathe = 0.85 + 0.15 * sin(uFinTime * 1.9);
  vec3 inner = base * (0.38 + 0.32 * (1.0 - ndv)) * glow * breathe;
  float rim = pow(1.0 - ndv, 2.5);
  vec3 R = reflect(-V, n);
  float glint = pow(max(dot(R, L), 0.0), 28.0);
  return lit + inner + rim * mix(base, vec3(1.0), 0.55) * 0.8 + glint * vec3(1.0, 1.0, 1.0) * 0.9;
}`;

/** Fragment (solid material), after the base colour `col`: n (front-facing), V, L, ambient, key in scope. */
export const HAT_FX_FRAGMENT_SOLID = /* glsl */ `
  if (vFx == 1.0) {
    // A Gem Orbit gem: flat 2-3 tone facets (the geometry's colours, little inner glow), a dark edge where a facet turns
    // away from the eye, and the shine.
    col = fxCrystal(vColor, n, V, L, ambient, key, 0.45);
    col = mix(col, vColor * 0.3, smoothstep(0.62, 0.9, 1.0 - max(dot(n, V), 0.0)) * 0.55);
    col += vec3(1.0) * fxGlint(vFxP.x, vFxP.y / 1.6) * 1.3;
  } else if (vFx > 0.5) {
    col = fxCrystal(vColor, n, V, L, ambient, key, 1.0);
    if (vFx == 2.0 || vFx == 3.0) col += mix(vColor, vec3(1.0), 0.6) * fxComet(vFxP, ${LAP.toFixed(2)}) * 1.3;
    if (vFx == 4.0) col = vColor * 1.25 + 0.06 + mix(vColor, vec3(1.0), 0.65) * fxScan(vFxP) * 1.4;
    if (vFx == 5.0) {
      // Self-lit, a brighter swell flowing round the ribbon.
      float a = atan(vFxP.y, vFxP.x);
      col = vColor * (1.05 + 0.45 * sin(a * 3.0 - uFinTime * 1.3)) + vColor * vColor * 0.2;
    }
  }`;

/** Fragment (ghost material): fx faces glow a little like the visor does. */
export const HAT_FX_FRAGMENT_GHOST = /* glsl */ `
  if (vFx > 0.5) {
    float lit = vFx == 5.0 ? 0.8 : vFx == 1.0 ? fxGlint(vFxP.x, vFxP.y / 1.6) : vFx == 2.0 || vFx == 3.0 ? fxComet(vFxP, ${LAP.toFixed(2)}) : vFx == 4.0 ? 0.6 + fxScan(vFxP) : 0.0;
    col += mix(uGhost, vec3(1.0), 0.45) * (0.35 + lit);
    a = max(a, uOpacity * 0.55);
  }`;
