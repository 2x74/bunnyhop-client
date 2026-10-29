// Gun materials: what a gun's surfaces are made of (painted polymer, steel, dark blued steel, a textured grip, walnut,
// glass), shaded inside the player solid material (player/materials.ts) so hands + gun stay one program and one draw
// call. The builders (guns/shapes.ts) write the material into finishUV.w as 2 + code (gloves and knives keep w in 0..1
// for their wear, so anything >= 1.5 is a gun surface); this file patches the solid material's shaders with a
// GUN_SHADE block that reads it. Nothing here touches the shared shader sources: the patch is applied to this
// material's copy only, and falls back to the plain material if the anchors ever move.
//
// Per graphics look:
//   Potato     GUN_CHEAP: the block isn't compiled at all (the plain vertex colours, plus the builders' baked bright
//              chamfers, which every look and the third-person / world models have).
//   Source /   a small soft studio fixed to the view (like the knife metals' studio fallback, softer: guns are satin,
//   Plain      not mirrors): steel shows a bright horizon band and a dim floor, polymer a broad faint sheen, walnut
//              a low satin and its grain, grips a fine checkering, glass a dark tinted mirror.
//   Enhanced / the steel parts also reflect the real scene (finishes/environment.ts cube, blurred and desaturated,
//   Cinematic  never darker than the studio), switched by the shared uFinEnvOn uniform (no recompile). The cube only
//              runs on the composer looks, and only while something drawn reads it.
// The world (floor) guns compile GUN_NO_ENV: studio only (they're in the scene the cube captures). The bunny's
// third-person gun keeps the bunny's own material (no extra program per player): colours + baked chamfers only.

import * as THREE from "three";
import { solidMaterial, type PlayerUniforms } from "../../player/materials";
import { FIN_ENV_LODS } from "../finishes/environment";
import type { MaterialLook } from "../finishes/shader";
import type { Paint } from "../../player/bunny/builder";

/** Material codes (finishUV.w = 2 + code). */
export const GUN_MAT = { poly: 0, metal: 1, dark: 2, grip: 3, wood: 4, glass: 5 } as const;
export type GunMat = keyof typeof GUN_MAT;

/**
 * A fixed colour with what it's made of (guns/shapes.ts reads `gunMat`; the Builder only sees code + colour). Not `mat`:
 * that is the knife hardware material the Builder adds to finishUV.z (player/bunny/builder.ts Paint.mat).
 */
export type GunPaint = Paint & { gunMat?: GunMat };
export const gunPaint = (color: number, mat: GunMat = "poly"): GunPaint => ({ code: 0, color, gunMat: mat });

/** finishUV.w of a material. */
export const matW = (m: GunMat | undefined): number => (m === undefined ? 0 : 2 + GUN_MAT[m]);

// finishUV is already declared by the solid material (the finish / glove pars, else player/fabric.ts): declaring it
// here too failed to compile ("'finishUV' : redefinition") and the gun drew nothing.
const VERT_PARS = /* glsl */ `
#ifndef GUN_CHEAP
varying float vGunMat;
varying vec3 vGunP;
#endif
`;

const VERT_MAIN = /* glsl */ `
#ifndef GUN_CHEAP
  vGunMat = finishUV.w;
  vGunP = position;
#endif
`;

const FRAG_PARS = /* glsl */ `
#ifndef GUN_CHEAP
#ifdef GUN_FLASH
// The muzzle's light (viewmodel only): colour * strength, its world position.
uniform vec4 uGunFlash;
uniform vec3 uGunFlashPos;
#endif
varying float vGunMat;
varying vec3 vGunP;
#ifndef GUN_NO_ENV
#define GUN_ENV 1
#ifdef FINISH
#if FINISH >= 22
#ifndef FINISH_LOD
#define GUN_ENV_DECLARED 1
#endif
#endif
#endif
#ifndef GUN_ENV_DECLARED
uniform samplerCube uFinEnv;
uniform float uFinEnvOn;
#endif
#endif
// The gun studio: view-locked, soft (satin metal): a bright sky fading up into grey, a soft strip light, a bright band
// at the horizon and a dim warm floor. R is the reflected ray in view space.
vec3 gunStudio(vec3 R) {
  float y = R.y;
  vec3 sky = mix(vec3(1.05, 1.07, 1.1), vec3(0.34, 0.36, 0.4), smoothstep(0.06, 0.62, y));
  sky += vec3(0.55) * smoothstep(0.34, 0.44, y) * (1.0 - smoothstep(0.52, 0.66, y));
  vec3 grd = mix(vec3(0.06, 0.058, 0.055), vec3(0.22, 0.2, 0.18), smoothstep(-0.08, -0.55, y));
  return mix(grd, sky, smoothstep(-0.06, 0.06, y));
}
float gunLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Diamond checkering on a grip's flanks (gun-local x / z), faded out where it would alias.
float gunCheck(vec3 p) {
  vec2 q = vec2(p.x + p.z, p.x - p.z) * 5.5;
  vec2 g = abs(fract(q) - 0.5);
  float d = min(g.x, g.y);
  float aa = clamp(1.6 - length(fwidth(q)) * 1.4, 0.0, 1.0);
  return mix(0.5, 1.0 - smoothstep(0.08, 0.16, d), aa);
}
vec3 gunShade(float code, vec3 base, vec3 lit, vec3 n, vec3 V, vec3 L, float key) {
  vec3 R = reflect(-V, n);
  vec3 Rv = (viewMatrix * vec4(R, 0.0)).xyz;
  float nv = max(dot(n, V), 0.0);
  float fr = pow(1.0 - nv, 4.0);
  float rl = max(dot(R, L), 0.0);
  if (code < 0.5) {
    // Painted polymer: a broad faint sheen from the key and a soft rim of the studio.
    return lit * 0.97 + (pow(rl, 10.0) * 0.06 * key + fr * 0.035) * mix(vec3(1.0), base, 0.5);
  }
  if (code < 2.5) {
    // Steel (1) and dark blued steel (2): less diffuse, the studio (and on the composer looks the scene) tinted by the
    // metal's colour, whiter toward grazing angles, a soft highlight from the key.
    bool dark = code > 1.5;
    // A gentle bend along the part, so a long flat face still shows the horizon as a line sliding over it.
    vec3 Rb = normalize(Rv + vec3(0.0, 0.08 * sin(vGunP.x * 0.7), 0.0));
    vec3 env = gunStudio(Rb);
#ifdef GUN_ENV
    if (uFinEnvOn > 0.5) {
      vec3 e = textureLod(uFinEnv, R, 0.62 * ${FIN_ENV_LODS.toFixed(1)}).rgb;
      e = mix(vec3(gunLum(e)), e, 0.4);
      // Dark steel: the scene's light capped, so a bright sky can't lift the whole part to grey.
      if (dark) e *= min(1.0, 0.75 / max(gunLum(e), 1e-3));
      env = max(mix(env, e, 0.7), env * 0.75);
    }
#endif
    // The reflection tints the highlights, not the whole base: the part keeps its own colour (lit), and only the
    // reflection's bright bands (the studio's horizon and strip, the sky) are added on top, tinted by the metal.
    float band = smoothstep(dark ? 0.6 : 0.4, 1.1, gunLum(env));
    vec3 hue = base / max(max(base.r, max(base.g, base.b)), 1e-3);
    vec3 F0 = mix(vec3(1.0), hue, 0.6) * (dark ? 0.075 : 0.3);
    vec3 F = mix(F0, vec3(1.0), fr * (dark ? 0.15 : 0.35));
    // Steel: darker body (metals have little diffuse), a soft reflection of the room under the bands; dark steel keeps
    // nearly all of its body colour.
    vec3 col = dark ? lit * 0.95 + env * band * F : lit * 0.72 + env * F * (0.15 + 0.85 * band);
    col += mix(vec3(1.0), base, 0.3) * (pow(rl, dark ? 70.0 : 40.0) * (dark ? 0.45 : 0.7) + pow(rl, 8.0) * 0.05) * key;
    return col;
  }
  if (code < 3.5) {
    // Grip: matte, checkered (the lands catch a little light, the grooves stay dark).
    float c = gunCheck(vGunP);
    return lit * (0.62 + 0.46 * c);
  }
  if (code < 4.5) {
    // Walnut: grain along the part (gun-local x), a low satin.
    float g = sin(vGunP.x * 2.3 + sin(vGunP.z * 3.1 + vGunP.x * 0.6) * 2.2 + vGunP.y * 0.8);
    float grain = 0.86 + 0.13 * g + 0.07 * sin(vGunP.x * 11.0 + g * 3.0);
    return lit * grain + (pow(rl, 22.0) * 0.16 * key + fr * 0.07) * vec3(1.0, 0.9, 0.78);
  }
  // Glass (a scope's lens): a dark tinted mirror of the studio, a hot glint.
  vec3 env = gunStudio(Rv);
  return base * 0.25 + env * (0.06 + 0.9 * fr) + vec3(pow(rl, 90.0) * 1.2) * key;
}
#endif
`;

const FRAG_MAIN = /* glsl */ `
#ifndef GUN_CHEAP
  if (vGunMat > 1.5) {
    vec3 gs = gunShade(floor(vGunMat - 2.0 + 0.5), vColor, col, n, V, L, key);
    if (back > 0.5) col = gs;
  }
#ifdef GUN_FLASH
  // A shot lights the gun and the gloves near the muzzle for a few frames (warm, falling off with distance).
  if (uGunFlash.a > 0.001) {
    vec3 fd = uGunFlashPos - vWorldPos;
    float fl = length(fd);
    float wrap = 0.35 + 0.65 * max(dot(n, fd / max(fl, 1e-3)), 0.0);
    col += uGunFlash.rgb * uGunFlash.a * wrap * vColor * 2.2 / (1.0 + fl * fl / 90.0) * back;
  }
#endif
#endif
`;

/** Inserts `add` after (or before) the first `anchor` in `src`; null when the anchor isn't there. */
function insert(src: string, anchor: string, add: string, before = false): string | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const at = before ? i : i + anchor.length;
  return src.slice(0, at) + add + src.slice(at);
}

export interface GunMaterialOptions {
  /** Potato: no gun shading at all (plain colours). */
  cheap?: boolean;
  /** Studio only, never the scene cube (world guns, which the cube itself sees). */
  noEnv?: boolean;
  /** The muzzle light on hands + gun (the first-person viewmodel): adds uGunFlash / uGunFlashPos to `u`. */
  flash?: boolean;
}

let warned = false;

/**
 * The player solid material with gun shading (one program per look + tier, like the finishes). Same uniforms, same
 * attributes; hands (and anything else with finishUV.w < 1.5) shade exactly as in solidMaterial.
 */
export function gunMaterial(u: PlayerUniforms, look: MaterialLook, o: GunMaterialOptions = {}): THREE.ShaderMaterial {
  const m = solidMaterial(u, look);
  if (o.cheap) {
    m.defines = { ...m.defines, GUN_CHEAP: 1 };
    return m;
  }
  let vs: string | null = m.vertexShader;
  vs = insert(vs, "#include <common>", VERT_PARS, true);
  vs = vs && insert(vs, "vNormalW = normalize(mat3(modelMatrix) * objectNormal);", VERT_MAIN);
  let fs: string | null = m.fragmentShader;
  fs = insert(fs, "void main() {", FRAG_PARS, true);
  fs = fs && insert(fs, "  gl_FragColor = vec4(col, 1.0);", FRAG_MAIN, true);
  if (!vs || !fs) {
    if (!warned) console.warn("gun material: shader anchors not found, plain colours");
    warned = true;
    return m;
  }
  m.vertexShader = vs;
  m.fragmentShader = fs;
  m.defines = { ...m.defines, GUN_SHADE: 1, ...(o.noEnv ? { GUN_NO_ENV: 1 } : {}), ...(o.flash ? { GUN_FLASH: 1 } : {}) };
  if (o.flash) {
    const uu = u as unknown as Record<string, THREE.IUniform>;
    uu.uGunFlash ??= { value: new THREE.Vector4(1, 0.72, 0.4, 0) };
    uu.uGunFlashPos ??= { value: new THREE.Vector3() };
  }
  return m;
}
