// Source's linear fog (the world's env_fog_controller and the 3D skybox's sky_camera), as a shader patch.
//
// Source fogs by view depth: nothing up to fogstart, rising linearly to fogend, never past fogmaxdensity (SDK 2013
// `RangeFog`). The colour is blended in gamma space, like Source's LDR path and the water fog here: after the
// material's output conversion on the canvas, and converted there and back when the pass writes linear colour.
// Additive materials fog towards black. A max density of 0 skips the work.

import * as THREE from "three";

export interface DepthFogUniforms {
  /** Fog colour as authored (sRGB, 0..1). */
  uDepthFogColor: THREE.IUniform<THREE.Vector3>;
  /** x = start, y = end (view depth, in the units the material is drawn in), z = max density (0 draws no fog). */
  uDepthFogRange: THREE.IUniform<THREE.Vector3>;
}

export function depthFogUniforms(start = 0, end = 1, maxDensity = 0): DepthFogUniforms {
  return { uDepthFogColor: { value: new THREE.Vector3(1, 1, 1) }, uDepthFogRange: { value: new THREE.Vector3(start, end, maxDensity) } };
}

/** No fog: what a material's fog uniforms point at until a world links its own (model-light.ts). */
export const DEPTH_FOG_OFF: DepthFogUniforms = depthFogUniforms();

/** Shader text for a material that carries the fog itself (the player materials): declarations, then the code. */
export const DEPTH_FOG_VERTEX_PARS = "varying float vDepthFogDepth;";
/** At the end of the vertex main. Clip-space w is the view depth under a perspective camera (an orthographic overview draws no fog: w = 1). */
export const DEPTH_FOG_VERTEX_MAIN = "vDepthFogDepth = gl_Position.w;";
export const DEPTH_FOG_FRAGMENT_PARS = "uniform vec3 uDepthFogColor;\nuniform vec3 uDepthFogRange;\nvarying float vDepthFogDepth;";
/**
 * After the output colour conversion. Whether the pass writes linear colour is read off three's own conversion (a
 * constant the compiler folds), so one program text serves the canvas and the render targets.
 */
export const depthFogFragment = (color = "uDepthFogColor"): string => /* glsl */ `
  if (uDepthFogRange.z > 0.0) {
    float depthFog = clamp( min( uDepthFogRange.z, ( vDepthFogDepth - uDepthFogRange.x ) / max( uDepthFogRange.y - uDepthFogRange.x, 1e-3 ) ), 0.0, 1.0 );
    if ( linearToOutputTexel( vec4( 0.5 ) ).r < 0.6 ) gl_FragColor.rgb = sRGBTransferEOTF( vec4( mix( sRGBTransferOETF( gl_FragColor ).rgb, ${color}, depthFog ), 1.0 ) ).rgb;
    else gl_FragColor.rgb = mix( gl_FragColor.rgb, ${color}, depthFog );
  }`;

/**
 * Adds the fog to a material (keeps any existing onBeforeCompile). Built-in materials take it where three's own fog
 * would go, after anything added there before (the water fog); a ShaderMaterial right after its
 * `#include <colorspace_fragment>`. The uniforms are read from `u` by reference, so one set serves many materials.
 */
export function withDepthFog<M extends THREE.Material>(m: M, u: DepthFogUniforms): M {
  const additive = m.blending === THREE.AdditiveBlending;
  // What the surface fogs towards when it isn't the fog colour: black for additive ones, `userData.depthFogTo` (GLSL)
  // for a blend of its own (a modulating decal's neutral grey).
  const towards = (m.userData.depthFogTo as string | undefined) ?? (additive ? "vec3( 0.0 )" : undefined);
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, { uDepthFogColor: u.uDepthFogColor, uDepthFogRange: u.uDepthFogRange });
    shader.vertexShader = shader.vertexShader
      .replace("void main()", `${DEPTH_FOG_VERTEX_PARS}\nvoid main()`)
      .replace(/\}\s*$/, `  ${DEPTH_FOG_VERTEX_MAIN}\n}`);
    const fogged = depthFogFragment(towards);
    const f = shader.fragmentShader.replace("void main()", `${DEPTH_FOG_FRAGMENT_PARS}\nvoid main()`);
    shader.fragmentShader = f.includes("#include <fog_fragment>")
      ? f.replace("#include <fog_fragment>", `${fogged}\n#include <fog_fragment>`)
      : f.replace("#include <colorspace_fragment>", `#include <colorspace_fragment>\n${fogged}`);
  };
  const suffix = m.userData.depthFogTo ? "-to" : additive ? "-add" : "";
  m.customProgramCacheKey = () => `${prevKey.call(m)}+depthfog${suffix}`;
  return m;
}

/** The fog colour for a view: `fogcolor`, or with `fogblend` mixed with `fogcolor2` by how far the view faces `dir`. */
export function depthFogColor(
  fog: { blend: boolean; color: readonly number[]; color2: readonly number[]; dir: readonly number[] },
  /** View direction in the fog's space (Source world axes), unit length. */
  forward: { x: number; y: number; z: number },
  out: THREE.Vector3,
): THREE.Vector3 {
  let t = 1;
  if (fog.blend) {
    const len = Math.hypot(fog.dir[0], fog.dir[1], fog.dir[2]) || 1;
    t = 0.5 * ((forward.x * fog.dir[0] + forward.y * fog.dir[1] + forward.z * fog.dir[2]) / len) + 0.5;
  }
  return out.set(
    (fog.color[0] * t + fog.color2[0] * (1 - t)) / 255,
    (fog.color[1] * t + fog.color2[1] * (1 - t)) / 255,
    (fog.color[2] * t + fog.color2[2] * (1 - t)) / 255,
  );
}
