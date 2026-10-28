// Materials for CS:S studio models (VertexLitGeneric approximated): base texture, tangent-space $bumpmap, half-Lambert
// key light + hemisphere ambient + rim, $phong highlights masked by the normal map alpha. The ghost variant reuses the
// runner's ghost look (player/materials.ts: tint, fresnel rim, near-camera fade, optional dither, depth prepass) with
// the base texture's luminance for detail. Self-lit like the rest of the player models (the world is lightmapped and
// the scene has no lights).

import * as THREE from "three";
import type { PlayerUniforms } from "../materials";
import type { StudioMaterialInfo } from "./data";

const vertex = /* glsl */ `
attribute vec4 aTangent;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec4 vTangentW;
varying vec3 vWorldPos;
#include <common>
#include <skinning_pars_vertex>
void main() {
  vUv = uv;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vec3 objT = aTangent.xyz;
  #ifdef USE_SKINNING
    objT = (skinMatrix * vec4(objT, 0.0)).xyz;
  #endif
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vNormalW = normalize(mat3(modelMatrix) * objectNormal);
  vTangentW = vec4(normalize(mat3(modelMatrix) * objT), aTangent.w);
}`;

const common = /* glsl */ `
uniform vec3 uAxisA, uAxisB;
uniform vec2 uNearFade;
float nearFade() {
  if (uNearFade.y <= uNearFade.x) return 1.0;
  vec3 ab = uAxisB - uAxisA;
  float h = clamp(dot(cameraPosition - uAxisA, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
  float d = length(cameraPosition - (uAxisA + ab * h));
  return smoothstep(uNearFade.x, uNearFade.y, d);
}
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[idx] + 0.5) / 16.0;
}
uniform sampler2D map;
uniform sampler2D normalMap;
uniform float uHasNormal;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec4 vTangentW;
varying vec3 vWorldPos;
vec3 surfaceNormal() {
  vec3 n = normalize(vNormalW);
  if (!gl_FrontFacing) n = -n;
  if (uHasNormal > 0.5) {
    vec3 t = normalize(vTangentW.xyz - n * dot(n, vTangentW.xyz));
    vec3 b = cross(n, t) * (vTangentW.w < 0.0 ? -1.0 : 1.0);
    vec3 nm = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
    // Source normal maps are Y-down (DirectX).
    n = normalize(t * nm.x - b * nm.y + n * max(nm.z, 0.2));
  }
  return n;
}`;

const solidFragment = /* glsl */ `
uniform float uAlphaTest;
uniform float uTranslucent;
uniform float uPhong;
uniform float uPhongExp;
uniform float uPhongBoost;
uniform float uOpacity;
uniform float uBright;
${common}
void main() {
  vec4 tex = texture2D(map, vUv);
  if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
  vec3 n = surfaceNormal();
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(vec3(0.42, 0.78, 0.46));
  // Half-Lambert key (VertexLitGeneric $halflambert) + hemisphere ambient.
  float hl = dot(n, L) * 0.5 + 0.5;
  float key = hl * hl;
  vec3 sky = vec3(0.62, 0.66, 0.74), ground = vec3(0.26, 0.24, 0.23);
  vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5) * 0.85;
  vec3 col = tex.rgb * (ambient + key * vec3(1.05, 1.0, 0.92)) * uBright;
  if (uPhong > 0.5) {
    float mask = uHasNormal > 0.5 ? texture2D(normalMap, vUv).a : 1.0;
    vec3 H = normalize(L + V);
    col += pow(max(dot(n, H), 0.0), uPhongExp) * uPhongBoost * mask * 0.35 * vec3(1.0, 0.97, 0.92);
  }
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * 0.12 * (ambient + 0.2);
  float a = uTranslucent > 0.5 ? tex.a : 1.0;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ghostFragment = /* glsl */ `
uniform vec3 uGhost, uGhostRim;
uniform float uOpacity;
uniform float uAlphaTest;
${common}
void main() {
  vec4 tex = texture2D(map, vUv);
  if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
  vec3 n = surfaceNormal();
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.2);
  float lum = dot(tex.rgb, vec3(0.2126, 0.7152, 0.0722));
  float up = n.y * 0.5 + 0.5;
  vec3 col = uGhost * (0.25 + 0.95 * sqrt(lum)) * (0.7 + 0.45 * up);
  // Rim glow: the tint, or a second colour pushed a little further from the tint so it reads at the silhouette
  // (identical to the plain tint rim when uGhostRim == uGhost).
  vec3 rimC = uGhostRim + (uGhostRim - uGhost) * 0.6;
  col = max(col + rimC * fres * 1.6, 0.0) + vec3(1.0) * fres * fres * 0.35;
  float a = uOpacity * (0.38 + 0.62 * fres);
  a = clamp(a * nearFade(), 0.0, 1.0);
#ifdef DITHER
  if (a < bayer4(gl_FragCoord.xy) * 0.999 + 0.0005) discard;
  gl_FragColor = vec4(col, 1.0);
#else
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const depthFragment = /* glsl */ `
uniform float uOpacity;
uniform float uAlphaTest;
${common}
void main() {
  if (uAlphaTest > 0.0 && texture2D(map, vUv).a < uAlphaTest) discard;
  if (uOpacity * nearFade() < 0.02) discard;
  gl_FragColor = vec4(0.0);
}`;

/** Textures of one studio material (null until uploaded). */
export interface StudioMaps {
  map: THREE.Texture | null;
  normal: THREE.Texture | null;
}

let white: THREE.Texture | null = null;
let flat: THREE.Texture | null = null;
function placeholder(normal: boolean): THREE.Texture {
  if (normal) {
    if (!flat) {
      flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
      flat.needsUpdate = true;
    }
    return flat;
  }
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255]), 1, 1);
    white.colorSpace = THREE.SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}

function uniformsFor(u: PlayerUniforms, m: StudioMaterialInfo, maps: StudioMaps): Record<string, THREE.IUniform> {
  return {
    ...u,
    map: { value: maps.map ?? placeholder(false) },
    normalMap: { value: maps.normal ?? placeholder(true) },
    uHasNormal: { value: maps.normal ? 1 : 0 },
    uAlphaTest: { value: m.alphatest ? m.alphaRef : 0 },
    uTranslucent: { value: m.translucent ? 1 : 0 },
    uPhong: { value: m.phong ? 1 : 0 },
    uPhongExp: { value: Math.max(1, m.phongExponent) },
    uPhongBoost: { value: m.phongBoost },
    uBright: { value: m.selfillum ? 1.15 : 1 },
  };
}

/** Points a material at newly uploaded textures. */
export function setMaps(mat: THREE.ShaderMaterial, maps: StudioMaps): void {
  mat.uniforms.map.value = maps.map ?? placeholder(false);
  mat.uniforms.normalMap.value = maps.normal ?? placeholder(true);
  mat.uniforms.uHasNormal.value = maps.normal ? 1 : 0;
}

export function studioSolidMaterial(u: PlayerUniforms, m: StudioMaterialInfo, maps: StudioMaps): THREE.ShaderMaterial {
  const translucent = m.translucent || m.additive;
  return new THREE.ShaderMaterial({
    uniforms: uniformsFor(u, m, maps),
    vertexShader: vertex,
    fragmentShader: solidFragment,
    side: m.nocull ? THREE.DoubleSide : THREE.FrontSide,
    transparent: translucent,
    depthWrite: !translucent,
    blending: m.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export function studioGhostMaterial(u: PlayerUniforms, m: StudioMaterialInfo, maps: StudioMaps, dither: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniformsFor(u, m, maps),
    vertexShader: vertex,
    fragmentShader: ghostFragment,
    side: THREE.FrontSide,
    transparent: !dither,
    depthWrite: dither,
    depthFunc: THREE.LessEqualDepth,
    defines: dither ? { DITHER: 1 } : {},
  });
}

export function studioDepthMaterial(u: PlayerUniforms, m: StudioMaterialInfo, maps: StudioMaps): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniformsFor(u, m, maps),
    vertexShader: vertex,
    fragmentShader: depthFragment,
    side: THREE.FrontSide,
    transparent: true,
    colorWrite: false,
    depthWrite: true,
  });
}
