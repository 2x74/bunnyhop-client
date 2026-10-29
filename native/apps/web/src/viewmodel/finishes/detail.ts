// Cosmetic detail tiers: how much shading the gloves and the knife's hardware get, per graphics look. Folded into the
// player solid material next to the finishes (shader.ts) and the glove recipes (gloves/glsl.ts):
//
//   tier (uCosTier, one shared uniform, set from the graphics settings by main.ts setCosmeticsTier):
//     0 Potato · 1 Plain · 2 Source · 3 Enhanced / Cinematic
//   level (cosLevel(), what a program actually draws at that tier):
//                       first person (VM_DETAIL)                         third person (GLOVE only)
//     Potato / Plain    0: flat recipes (colour patterns, seam shading)  0
//     Source            1: + panel edges, stitches and knuckle creases    1 (the same; there is no level 2)
//                          in relief, fabric sheen, knife hardware
//                          shaded as metal / lacquer / grip / veg
//     Enhanced, Cinem.  2: + fine surface relief (grain, ribs, weave,      1
//                          pebble), metal hardware reflecting the scene
//                          (environment.ts cube) instead of the studio
//
// The tier is a uniform, not a define: changing the look never recompiles anything, and the branches on it are
// uniform (the same for every pixel), so the skipped work costs nothing. VM_DETAIL is one define on the first-person
// viewmodel's program only (the knife viewmodel, the gun viewmodel, the Loadout's knife showcase): third-person bunnies
// never compile the knife hardware shading or the scene reflection (many of them can be on screen).
//
// Knife hardware materials ride in finishUV.z: part id + KMAT / 16 (Builder.vert adds Paint.mat / 16 on knife parts),
// so the part id still rounds the same everywhere that reads it, and PART.blade stays |z - 1| < 0.5.
//
// Relief is derivative bump mapping: each recipe returns a height (units) and cosBump tilts the normal by its screen
// slope. Patterns fade out (gRes) before they are small enough to alias, so far-away hands stay calm.

import * as THREE from "three";
import { cosEnvReady, cosEnvTexture, FIN_ENV_LODS, touchFinishEnvironment } from "./environment";
import type { GraphicsPreset } from "../../graphics/presets";

export { KMAT, type KMat } from "../knives/types";
import { KMAT } from "../knives/types";

/** 0 Potato, 1 Plain, 2 Source, 3 Enhanced / Cinematic. */
export type CosTier = 0 | 1 | 2 | 3;

export function tierOf(g: { preset: GraphicsPreset; potato: boolean }): CosTier {
  if (g.potato) return 0;
  return g.preset === "classic" ? 1 : g.preset === "source" ? 2 : 3;
}

const search = (globalThis as { location?: { search: string } }).location?.search; // the API typechecks this without the DOM
const param = search !== undefined ? new URLSearchParams(search).get("cosTier") : null;
let tier: CosTier = param !== null && /^[0-3]$/.test(param) ? (Number(param) as CosTier) : 2;

/** Set from the graphics settings (main.ts); dev pages take ?cosTier=0..3 (default 2, Source). */
export function setCosmeticsTier(t: CosTier): void {
  if (param === null) tier = t;
}
export const cosmeticsTier = (): CosTier => tier;

/** The shared tier uniform (read at upload time, like the finishes' clock). */
export const COS_TIER: THREE.IUniform<number> = {
  get value() {
    return tier;
  },
  set value(_: number) {
    /* read-only */
  },
};

/**
 * The scene reflection for the first-person hardware (VM_DETAIL programs only). Per uniform block: `want` (set by the
 * viewmodel when its knife or gloves have reflective hardware) is what keeps the environment capture running on the
 * composer looks; nothing reflective in hand, no capture.
 */
export interface CosEnvUniform extends THREE.IUniform<THREE.Texture | null> {
  want: boolean;
}
export function cosEnvUniform(): CosEnvUniform {
  return {
    want: false,
    get value(): THREE.Texture | null {
      if (this.want && tier >= 3) touchFinishEnvironment();
      return cosEnvTexture();
    },
    set value(_: THREE.Texture | null) {
      /* read-only */
    },
  };
}
export const COS_ENV_ON: THREE.IUniform<number> = {
  get value() {
    return tier >= 3 && cosEnvReady() ? 1 : 0;
  },
  set value(_: number) {
    /* read-only */
  },
};

const reflective = new WeakMap<THREE.BufferGeometry, boolean>();
/**
 * Whether a geometry has metal worth the scene reflection: polished / satin knife parts or glove metal (snaps, trim).
 * Lacquer and plates keep the studio (their coat is faint), so the default carrot + knit never starts the capture.
 */
export function wantsReflection(g: THREE.BufferGeometry): boolean {
  let r = reflective.get(g);
  if (r !== undefined) return r;
  r = false;
  const F = g.getAttribute("finishUV");
  const A = g.getAttribute("accent");
  for (let i = 0; F && i < F.count && !r; i += 3) {
    const z = F.getZ(i), part = Math.floor(z + 0.02), m = Math.round((z - part) * 16);
    if (part !== 4 && (m === KMAT.polished || m === KMAT.satin)) r = true;
    // Glove faces: the metal material code (gloves/paint.ts MAT.metal = 9).
    const a = A.getX(i);
    if (a > 15.5 && Math.floor((a - 16) / 8 + 0.01) === 9) r = true;
  }
  reflective.set(g, r);
  return r;
}

// ---------------------------------------------------------------------------------------------
// GLSL (FRAGMENT_PARS, after the noise; GLOVE or VM_DETAIL)

export const DETAIL_PARS = /* glsl */ `
#if defined(GLOVE) || defined(VM_DETAIL) || defined(FINISH)
// (uCosTier is declared for every solid program: shader.ts FRAGMENT_PARS; the hats read it too, player/hat-detail.ts.)
// What this program draws at the current look (see finishes/detail.ts).
float cosLevel() {
#ifdef VM_DETAIL
  return uCosTier > 2.5 ? 2.0 : uCosTier > 1.5 ? 1.0 : 0.0;
#else
  return uCosTier > 1.5 ? 1.0 : 0.0;
#endif
}
// Normal tilted by the screen-space slope of a height field h (world units). Call in uniform control flow.
vec3 cosBump(vec3 n, float h) {
  vec3 dpx = dFdx(vWorldPos), dpy = dFdy(vWorldPos);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - g);
}
// A small studio seen in polished surfaces, fixed to the view (Rv: view-space reflection), so hardware reads the same
// on any map: a bright sky with a soft strip light, a hot horizon line, a dark band under it, a dim warm floor.
vec3 cosStudio(vec3 Rv, float rough) {
  float y = Rv.y;
  float w = 0.02 + rough * 0.5;
  vec3 sky = mix(vec3(1.25, 1.27, 1.32), vec3(0.34, 0.36, 0.42), smoothstep(0.0, 0.5 + rough, y));
  sky += vec3(0.85) * smoothstep(0.48 - w, 0.54, y) * (1.0 - smoothstep(0.62, 0.70 + w, y)) * (1.0 - rough);
  vec3 fl = mix(vec3(0.06, 0.06, 0.07), vec3(0.36, 0.33, 0.30), smoothstep(-0.05 - w, -0.45 - w, y));
  return mix(fl, sky, smoothstep(-w, w, y));
}
#ifdef VM_DETAIL
uniform samplerCube uCosEnv;
uniform float uCosEnvOn;
#endif
// Reflection of polished hardware: the studio, or (level 2, the composer looks, first person) the real scene over the
// studio's bands, desaturated a little toward its own light so the hardware's colour stays its own.
vec3 cosReflect(vec3 R, float rough, float lv) {
  vec3 st = cosStudio((viewMatrix * vec4(R, 0.0)).xyz, rough);
#ifdef VM_DETAIL
  if (lv > 1.5 && uCosEnvOn > 0.5) {
    // As the metal finishes treat the scene (shader.ts finSceneMetal): blurred well past texture detail (no foliage or
    // concrete reads as a pattern, a lumpy surface doesn't turn it into ripples), desaturated toward its own light, its
    // brightest parts given back some range, and never darker than the studio's clean bands.
    vec3 e = textureLod(uCosEnv, R, (rough + 0.34) * ${FIN_ENV_LODS.toFixed(1)}).rgb;
    float l = dot(e, vec3(0.2126, 0.7152, 0.0722));
    e = mix(vec3(l), e, 0.3) * (1.0 + 2.0 * smoothstep(0.5, 0.95, l));
    return max(e, st * 0.9);
  }
#endif
  return st;
}
#endif`;

/** After the glove declarations (reads vGl / vGP / vGN). */
export const KNIFE_PARS = /* glsl */ `
#ifdef VM_DETAIL
// KNIFE HARDWARE (first person): guards, pommels, grips and bare blades by material (finishUV.z fraction, KMAT).
// Returns the shaded colour over the toon base (col), and the relief height for the bump.
float kMat() { float p = floor(vGl.z + 0.02); return floor((vGl.z - p) * 16.0 + 0.5); }
float kHeight(float km, float lv) {
  if (lv < 0.5 || km < 0.5) return 0.0;
  vec3 N0 = normalize(vGN);
  vec3 a = abs(N0);
  vec2 q = a.x > a.y && a.x > a.z ? vGP.yz : a.y > a.z ? vGP.xz : vGP.xy;
  float px = length(fwidth(vGP));
  float fine = lv > 1.5 ? 1.0 : 0.0;
  if (km > 3.5 && km < 4.5) {
    // Grip: a fine cord weave.
    float f = 26.0;
    return 0.006 * sin(q.x * f) * sin(q.y * f) * (1.0 - smoothstep(0.2, 0.5, px * f / 6.28)) * (0.4 + 0.6 * fine);
  }
  if (km > 4.5) {
    // Vegetable skin: faint growth lines across the part, slightly irregular.
    float f = 30.0;
    return fine * 0.004 * gnoise(vec2(dot(vGP, vec3(0.2, 0.3, 1.0)) * f, q.x * 2.0)) * (1.0 - smoothstep(0.2, 0.5, px * f / 6.28));
  }
  // Metal and lacquer: smooth.
  return 0.0;
}
vec3 knifeShade(vec3 col, vec3 alb, float km, float lv, vec3 n, vec3 V, vec3 L, vec3 ambient, float key) {
  if (lv < 0.5 || km < 0.5) return col;
  vec3 R = reflect(-V, n);
  float nv = max(dot(n, V), 0.0);
  float fc = pow(1.0 - nv, 5.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  if (km < 1.5) {
    // Polished metal: the reflection tinted by the colour, whiter toward grazing, a crisp glint.
    vec3 F = alb + (1.0 - alb) * fc;
    vec3 c = cosReflect(R, 0.06, lv) * F * 0.92 + alb * (ambient * 0.12 + key * 0.12);
    // A bare blade's honed edge: a thin bright line right along the cutting edge (finishUV.w is the edge weight, or the
    // tip's: only where the edge term is the larger one).
    if (abs(vGl.z - 1.0) < 0.5) {
      float tip = smoothstep(0.85, 1.0, vGl.x);
      c += mix(vec3(1.0), alb, 0.25) * smoothstep(0.9, 0.985, vGl.w) * step(tip + 0.02, vGl.w) * (0.35 + 0.4 * key);
    }
    return c + mix(vec3(1.0), alb, 0.3) * (pow(nh, 220.0) * 2.2 + pow(nh, 30.0) * 0.25) * (0.3 + 0.7 * key);
  }
  if (km < 2.5) {
    // Satin metal: half diffuse, a blurred reflection, a broad soft highlight.
    vec3 F = alb + (1.0 - alb) * fc;
    vec3 c = alb * (ambient + key * vec3(0.78, 0.74, 0.68)) * 0.55 + cosReflect(R, 0.45, lv) * F * 0.55;
    return c + vec3(pow(nh, 24.0) * 0.35 * (0.3 + 0.7 * key));
  }
  if (km < 3.5) {
    // Lacquer / hard candy: the toon colour under a clear coat (reflection weighted by fresnel) and a sharp highlight.
    float coat = 0.05 + 0.95 * fc;
    return col * 0.97 + cosReflect(R, 0.03, lv) * coat * 0.55 + vec3(pow(nh, 160.0) * 1.3 + pow(nh, 22.0) * 0.08) * (0.25 + 0.75 * key);
  }
  if (km < 4.5) {
    // Grip: matte, a little darker in the weave, a soft sheen at grazing angles.
    return col * 0.96 + alb * pow(1.0 - nv, 2.5) * 0.25;
  }
  // Vegetable skin: waxy, a soft broad highlight and light that wraps a little past the terminator.
  float wrap = smoothstep(-0.35, 0.4, dot(n, L)) - key;
  return col + alb * max(wrap, 0.0) * 0.18 + vec3(pow(nh, 36.0) * 0.16 * (0.3 + 0.7 * key));
}
#endif`;
