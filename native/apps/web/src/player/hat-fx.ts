// Moving and glowing hat parts (the Supporter's hats, player/bunny/hats.ts), folded into the player materials
// (player/materials.ts) for every bunny: no extra textures or draw calls. A hat face opts in with an accent
// code (player/bunny/builder.ts Paint.code), its colour stays partColor:
//
//   -1  propeller rotor; -2 capybara body, -3 eyes, -4 mouth (per-player movement uniforms)
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
const vec3 FX_ORBIT_C = ${v3(ORBIT_C)};
const vec3 FX_HALO_C = ${v3(HALO_C)};
const vec3 FX_CROWN_C = ${v3(CROWN_C)};
const vec3 FX_AURORA_C = ${v3(AURORA_C)};
const vec3 FX_PROPELLER_C = ${v3(PROPELLER_C)};
// vFx: 1 orbit, 2 halo, 3 halo inset, 4 circlet line (codes 12-15), 5 aurora ribbon (code 11), 0 none.
float fxCode() { return accent > 11.5 && accent < 15.5 ? floor(accent - 11.0 + 0.5) : accent > 10.5 && accent < 11.5 ? 5.0 : 0.0; }
vec2 fxRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
float fxBob() { return ${BOB.toFixed(3)} * sin(uFinTime * ${((Math.PI * 2) / BOB_T).toFixed(4)}); }
bool fxCapy() { return accent < -1.5 && accent > -4.5; }
float fxCapyEyeScale() { return 0.12 + 0.88 * uCapybara.x; }
float fxCapyMouthScale() { return 0.12 + 0.88 * smoothstep(0.45, 0.95, uCapybara.x); }
float fxCapyStretch() { return 1.0 + uCapybara.y + 0.012 * sin(uCapybara.w * 2.0); }
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
