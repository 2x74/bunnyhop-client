// Player materials. Self-lit (the world uses unlit lightmapped materials and the scene has no lights):
//  - solid: soft key + hemisphere fill + rim, faceted; back faces darkened (inside of the hood).
//  - ghost: translucent tint with a fresnel rim glow (uGhostRim: the tint, unless the ghost cosmetic has a second
//    colour), emissive accents, near-camera fade, optional ordered dither.
//  - depth: depth-only prepass so the translucent ghost only shows its front-most surface (no self-sorting
//    artifacts) while still being depth-tested against the world.
//  - silhouette: a secret item not earned yet (the Loadout's "???" card, ui/loadout-view.ts): flat near-black with a
//    faint cool rim so the shape reads. It never reads the colour attributes or the palette, so the pixels carry no
//    hint of the real colours (no CSS filter to switch off).
// All of them share one skinned vertex shader and a per-model uniform block.
//
// Cosmetic loadout (viewmodel/finishes/shader.ts): the solid material compiles a blade finish (`#define FINISH n`) and
// glove recolouring (`#define GLOVE`) into the same program when a look asks for them, so a finished knife is still
// one material and one draw call; without a look the program is exactly the plain one.

import * as THREE from "three";
import { HAT_FX_FRAGMENT_GHOST, HAT_FX_FRAGMENT_PARS, HAT_FX_FRAGMENT_SOLID, HAT_FX_VERTEX_NORMAL, HAT_FX_VERTEX_PARS, HAT_FX_VERTEX_POSITION } from "./hat-fx";
import { finishUniforms, FRAGMENT_IS_BLADE, FRAGMENT_PARS, GLOVE_FRAGMENT_ALBEDO, GLOVE_FRAGMENT_LIGHT, lookDefines, NO_LOOK, VERTEX_MAIN, VERTEX_PARS, type FinishUniforms, type MaterialLook } from "../viewmodel/finishes/shader";

export interface PlayerUniforms extends FinishUniforms {
  [name: string]: THREE.IUniform;
  uAccent: THREE.IUniform<THREE.Color>;
  uGhost: THREE.IUniform<THREE.Color>;
  /** Ghost fresnel rim glow: uGhost unless the ghost cosmetic has a second colour (PlayerModel keeps it in step). */
  uGhostRim: THREE.IUniform<THREE.Color>;
  uOpacity: THREE.IUniform<number>;
  /** World-space feet / head points of the model, for the near-camera fade. */
  uAxisA: THREE.IUniform<THREE.Vector3>;
  uAxisB: THREE.IUniform<THREE.Vector3>;
  /** Near fade: fully hidden within x units of the body axis, fully visible beyond y (y <= x disables). */
  uNearFade: THREE.IUniform<THREE.Vector2>;
  /** Colourway palette (bunny: hoodie, trim, pants, pants trim, shoe, face, glove, detail), for accent codes >= 3. */
  uPalette: THREE.IUniform<THREE.Color[]>;
  /** Per-player rotor phase, integrated from horizontal movement speed. */
  uPropellerAngle: THREE.IUniform<number>;
  uCapybara: THREE.IUniform<THREE.Vector4>;
  /** Bind-space headwear fit, applied after its animation and before skinning. */
  uHeadwearScale: THREE.IUniform<THREE.Vector3>;
  uHeadwearOffset: THREE.IUniform<THREE.Vector3>;
}

export function playerUniforms(): PlayerUniforms {
  return {
    uFabric: { value: 0 },
    uHeadwearScale: { value: new THREE.Vector3(1, 1, 1) },
    uHeadwearOffset: { value: new THREE.Vector3() },
    uAccent: { value: new THREE.Color(0xffb43a) },
    uGhost: { value: new THREE.Color(0xffc542) },
    uGhostRim: { value: new THREE.Color(0xffc542) },
    uOpacity: { value: 0.6 },
    uAxisA: { value: new THREE.Vector3() },
    uAxisB: { value: new THREE.Vector3(0, 64, 0) },
    uNearFade: { value: new THREE.Vector2(14, 60) },
    uPalette: { value: Array.from({ length: 8 }, () => new THREE.Color(0xffffff)) },
    uPropellerAngle: { value: 0 },
    uCapybara: { value: new THREE.Vector4() },
    ...finishUniforms(),
  };
}

export const playerVertex = /* glsl */ `
attribute vec3 partColor;
attribute float accent;
attribute float headwear;
uniform vec3 uHeadwearScale, uHeadwearOffset;
uniform vec3 uAccent;
uniform vec3 uPalette[8];
varying vec3 vFabricPos;
varying float vFabricMask;
varying vec3 vColor;
varying float vGlow;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${VERTEX_PARS}
${HAT_FX_VERTEX_PARS}
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <beginnormal_vertex>
${HAT_FX_VERTEX_NORMAL}
  if (headwear > .5) objectNormal = normalize(objectNormal / uHeadwearScale);
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
${HAT_FX_VERTEX_POSITION}
  if (headwear > .5) transformed = transformed * uHeadwearScale + uHeadwearOffset;
  #include <skinning_vertex>
  #include <project_vertex>
  vFabricPos = position;
  vFabricMask = accent > 2.5 && accent < 10.5 ? 1.0 : 0.0;
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vNormalW = normalize(mat3(modelMatrix) * objectNormal);
  // accent: 0 = partColor, 1 = style accent, 2 = accent + glow, 3 + k = palette slot k (k < 8), 12..15 hat crystal
  // (player/hat-fx.ts), >= 16 a glove style's face
  // (viewmodel/gloves/paint.ts; VERTEX_MAIN recolours it under GLOVE, else it reads as the colourway's glove slot).
  vColor = accent > 15.5 ? uPalette[6] : accent > 10.5 ? partColor : accent > 2.5 ? uPalette[int(accent - 2.5)] : accent > 0.5 ? uAccent : partColor;
  vGlow = accent > 1.5 && accent < 2.5 ? 1.0 : 0.0;
${VERTEX_MAIN}
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
}`;

const solidFragment = /* glsl */ `
uniform float uFabric;
uniform vec3 uAccent;
varying vec3 vFabricPos;
varying float vFabricMask;
varying vec3 vColor;
varying float vGlow;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${FRAGMENT_PARS}
${HAT_FX_FRAGMENT_PARS}
void main() {
  vec3 n = normalize(vNormalW);
  float back = gl_FrontFacing ? 1.0 : 0.0;
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(vec3(0.42, 0.78, 0.46));
  float ndl = dot(n, L);
  float key = smoothstep(-0.05, 0.55, ndl);
  vec3 sky = vec3(0.70, 0.76, 0.88), ground = vec3(0.30, 0.27, 0.26);
  vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5) * 0.62;
  vec3 albedo = vColor;
  if (uFabric > .5 && vFabricMask > .5) {
    vec3 cell = floor(vFabricPos * 13.0);
    float fleck = fract(sin(dot(cell, vec3(12.9898,78.233,37.719))) * 43758.5453);
    albedo *= .91 + .16 * fleck;
  }
${GLOVE_FRAGMENT_ALBEDO}
  vec3 col = albedo * (ambient + key * vec3(0.78, 0.74, 0.68));
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * 0.22 * mix(vec3(1.0), uAccent, 0.35);
${GLOVE_FRAGMENT_LIGHT}
  col = mix(col * 0.38, col, back); // inside of the hood
  col = mix(col, vColor * 1.6 + 0.15, vGlow);
${HAT_FX_FRAGMENT_SOLID}
#ifdef FINISH
  if (${FRAGMENT_IS_BLADE}) col = finishShade(n, V, L, ambient, key);
#endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ghostFragment = /* glsl */ `
uniform vec3 uGhost, uGhostRim;
uniform float uOpacity;
varying vec3 vFabricPos;
varying float vFabricMask;
varying vec3 vColor;
varying float vGlow;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${HAT_FX_FRAGMENT_PARS}
${common}
void main() {
  vec3 n = normalize(vNormalW);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.2);
  float lum = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
  float up = n.y * 0.5 + 0.5;
  vec3 col = uGhost * (0.3 + 0.7 * sqrt(lum)) * (0.7 + 0.45 * up);
  // Rim glow: the tint, or a second colour pushed a little further from the tint so it reads at the silhouette
  // (identical to the plain tint rim when uGhostRim == uGhost).
  vec3 rimC = uGhostRim + (uGhostRim - uGhost) * 0.6;
  col = max(col + rimC * fres * 1.6, 0.0) + vec3(1.0) * fres * fres * 0.35;
  col += mix(uGhost, vec3(1.0), 0.45) * vGlow * 1.1;
  float a = uOpacity * (0.38 + 0.62 * fres) + vGlow * 0.35 * uOpacity;
${HAT_FX_FRAGMENT_GHOST}
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

const silhouetteFragment = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 n = normalize(vNormalW);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  // (Linear values: the output is sRGB-encoded, so these read as near-black with a thin cool edge.)
  float rim = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 3.5);
  // A whisper of top light so overlapping shapes (hair over the visor, wings) separate.
  float top = smoothstep(0.3, 1.0, n.y) * 0.004;
  vec3 col = vec3(0.0035, 0.004, 0.005) + vec3(top) + rim * vec3(0.11, 0.125, 0.15);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const depthFragment = /* glsl */ `
uniform float uOpacity;
${common}
void main() {
  if (uOpacity * nearFade() < 0.02) discard;
  gl_FragColor = vec4(0.0);
}`;

/**
 * Solid (opaque) player material. `look` compiles the equipped finish / glove style in (viewmodel/finishes/shader.ts:
 * set the uniforms with applyLoadoutUniforms); NO_LOOK is the plain material.
 */
export function solidMaterial(u: PlayerUniforms, look: MaterialLook = NO_LOOK): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: playerVertex, fragmentShader: solidFragment, side: THREE.DoubleSide, defines: lookDefines(look) });
  // Meshes without a finishUV attribute (CS:S models, the runner) read zeros (no finish, no glove zones) rather than
  // whatever generic attribute value another program left behind.
  (m.defaultAttributeValues as Record<string, number[]>).finishUV = [0, 0, 0, 0];
  (m.defaultAttributeValues as Record<string, number[]>).headwear = [0];
  return m;
}

/** Translucent ghost (blended, drawn after its depth prepass) or `dither` (opaque, screen-door). */
export function ghostMaterial(u: PlayerUniforms, dither: boolean): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: playerVertex,
    fragmentShader: ghostFragment,
    side: THREE.DoubleSide,
    transparent: !dither,
    depthWrite: dither,
    depthFunc: THREE.LessEqualDepth,
    defines: dither ? { DITHER: 1 } : {},
  });
  (m.defaultAttributeValues as Record<string, number[]>).headwear = [0];
  return m;
}

/** Opaque silhouette (a secret item not earned yet): no colours, only the shape and a faint rim. */
export function silhouetteMaterial(u: PlayerUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: playerVertex, fragmentShader: silhouetteFragment, side: THREE.DoubleSide });
  (m.defaultAttributeValues as Record<string, number[]>).finishUV = [0, 0, 0, 0];
  (m.defaultAttributeValues as Record<string, number[]>).headwear = [0];
  return m;
}

export function depthMaterial(u: PlayerUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: playerVertex,
    fragmentShader: depthFragment,
    side: THREE.DoubleSide,
    // Rendered in the transparent pass (after the opaque world) right before the colour pass.
    transparent: true,
    colorWrite: false,
    depthWrite: true,
  });
  (m.defaultAttributeValues as Record<string, number[]>).headwear = [0];
  return m;
}
