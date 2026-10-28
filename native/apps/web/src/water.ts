import * as THREE from "three";
import type { MaterialDesc, WaterParams } from "./core";

// Water and glass visuals (render.ts).
//
// * Water volumes (the BSP's water brushes, core `waterVolumes`) fog whatever is seen through them: every world,
//   prop and sky fragment is fogged by the length of the camera→fragment segment that lies inside its convex brush (including sloped surfaces), with
//   that volume's `$fogcolor` / `$fogstart` / `$fogend` (linear, like Source's water fog). That gives murky depth
//   when looking into water from above and the underwater fog when the camera is below the surface.
// * Surfaces: the top face (`$abovewater 1`) is a fresnel blend of a refraction tint (lifted `$fogcolor`) and a
//   bounded planar scene reflection and color/depth refraction in detailed presets, with layered procedural ripples; the downward "beneath" faces (`$bottommaterial`, `$abovewater 0`)
//   show the bright Snell's window looking straight up and turn opaque fog-coloured at grazing angles. Both are
//   pulled towards the camera with a polygon offset so coplanar brush faces never z-fight with them.
//   Classic and unavailable captures retain the original translucent tint / sky reflection.
// * Refract materials without a base texture are tinted translucent glass (`$refracttint`).
// * Cost (research/PERF.md): the fog runs on every world, prop and sky fragment of a map with water. Per render only
//   the volumes on screen are passed in, each with its screen rectangle, and a fragment skips the ray-box test of
//   every volume whose rectangle it is outside of (its view ray can't cross that box). Same image, a fraction of the
//   work: before, maps with 20+ volumes (arcane, advi_new, crash_egypt, bkz_goldbhop) spent most of the frame here.

/** Water volumes considered per frame (the nearest ones). */
export const WATER_MAX = 24;
// A texture keeps exact convex brush planes outside the fragment-uniform budget.
let planeData = new Float32Array(4);
const planeTexture = new THREE.DataTexture(planeData, 1, 1, THREE.RGBAFormat, THREE.FloatType);
planeTexture.needsUpdate = true;

/** Shared uniforms (the same objects are referenced by every material's program). */
export const waterUniforms = {
  uWaterCount: { value: 0 },
  uWaterMin: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector3()) },
  uWaterMax: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector3()) },
  /** rgb = fog colour (output/sRGB space, like the VMT value), a = unused. */
  uWaterColor: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector4()) },
  /** x = fog start, y = fog end. */
  uWaterRange: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector2()) },
  /** Screen rectangle per volume (see FOG_DECL). */
  uWaterRect: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector4()) },
  uWaterTime: { value: 0 },
  uWaterPlanes: { value: planeTexture },
  uWaterPlaneWidth: { value: 1 },
  uWaterPlaneSpan: { value: Array.from({ length: WATER_MAX }, () => new THREE.Vector2()) },
};

const FOG_DECL = /* glsl */ `
#define WATER_MAX ${WATER_MAX}
uniform int uWaterCount;
uniform vec3 uWaterMin[WATER_MAX];
uniform vec3 uWaterMax[WATER_MAX];
uniform vec4 uWaterColor[WATER_MAX];
uniform vec2 uWaterRange[WATER_MAX];
// Each volume's screen rectangle (NDC min xy, max xy; the whole screen when it reaches behind the camera).
uniform vec4 uWaterRect[WATER_MAX];
uniform sampler2D uWaterPlanes;
uniform float uWaterPlaneWidth;
uniform vec2 uWaterPlaneSpan[WATER_MAX];
varying vec3 vWaterWorld;
// Clip-space x, y, w of the fragment (divided per fragment: NDC).
varying vec3 vWaterClip;
// Length of the camera -> p segment inside each water box; fog by the total, coloured by the boxes it crossed.
vec3 applyWaterFog(vec3 col, vec3 p) {
  vec3 c = cameraPosition;
  vec3 d = p - c;
  float len = length(d);
  float total = 0.0;
  vec3 fogCol = vec3(0.0);
  vec2 range = vec2(0.0);
  vec2 ndc = vWaterClip.xy / vWaterClip.z;
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-6);
  for (int i = 0; i < WATER_MAX; i++) {
    if (i >= uWaterCount) break;
    // The view ray through this pixel can only cross a box inside the box's screen rectangle.
    vec4 r = uWaterRect[i];
    if (ndc.x < r.x || ndc.y < r.y || ndc.x > r.z || ndc.y > r.w) continue;
    vec3 t0 = (uWaterMin[i] - c) * inv;
    vec3 t1 = (uWaterMax[i] - c) * inv;
    vec3 tmin = min(t0, t1), tmax = max(t0, t1);
    float a = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    float b = min(min(min(tmax.x, tmax.y), tmax.z), 1.0);
    // The box is only a broad-phase bound. Clip against the brush's sloped sides too.
    vec2 span = uWaterPlaneSpan[i];
    for (int j = 0; j < int(span.y); j++) {
      vec4 plane = texture2D(uWaterPlanes, vec2((span.x + float(j) + 0.5) / uWaterPlaneWidth, 0.5));
      float denom = dot(plane.xyz, d);
      float numer = plane.w - dot(plane.xyz, c);
      if (abs(denom) < 1e-7) {
        if (numer < 0.0) { b = -1.0; break; }
      } else if (denom > 0.0) b = min(b, numer / denom);
      else a = max(a, numer / denom);
    }
    if (b > a) {
      float inside = (b - a) * len;
      total += inside;
      fogCol += uWaterColor[i].rgb * inside;
      range += uWaterRange[i] * inside;
    }
  }
  if (total <= 0.0) return col;
  fogCol /= total;
  range /= total;
  float f = clamp((total - range.x) / max(range.y - range.x, 1.0), 0.0, 1.0);
  return mix(col, fogCol, f);
}
`;

/**
 * Adds the water-volume fog to a built-in material (keeps any existing onBeforeCompile). `sky`: the camera-centred
 * skybox, whose fragments count as infinitely far away.
 */
export function withWaterFog<M extends THREE.Material>(m: M, opts: { sky?: boolean } = {}): M {
  m.userData.waterFog = true;
  const at = opts.sky ? "cameraPosition + normalize(vWaterWorld - cameraPosition) * 1.0e5" : "vWaterWorld";
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, waterUniforms);
    // Built-in materials apply volume fog after their output transform. Keep authored
    // Source fog in its original sRGB working space even inside linear capture/composer targets.
    const outputLinear = renderer.getRenderTarget() !== null || renderer.outputColorSpace !== THREE.SRGBColorSpace;
    const fogColor = outputLinear ? "sRGBTransferOETF(gl_FragColor).rgb" : "gl_FragColor.rgb";
    const fogResult = `applyWaterFog(${fogColor}, ${at})`;
    const outputFog = outputLinear ? `sRGBTransferEOTF(vec4(${fogResult}, 1.0)).rgb` : fogResult;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterWorld;\nvarying vec3 vWaterClip;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWaterClip = gl_Position.xyw;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FOG_DECL}`)
      .replace("#include <fog_fragment>", `gl_FragColor.rgb = ${outputFog};\n#include <fog_fragment>`);
  };
  m.customProgramCacheKey = () => `${prevKey.call(m)}+waterfog${opts.sky ? "-sky" : ""}`;
  return m;
}

const SKY_REFLECTION = new THREE.Color(0xa9c1d3);

/**
 * A water surface. `above`: the top face (seen from above); otherwise the downward-facing beneath face.
 * `doubleSided`: the map has no beneath faces, so the top face also draws its underside (beneath style).
 */
export function waterSurfaceMaterial(desc: MaterialDesc, params: WaterParams | undefined, opts: { doubleSided?: boolean } = {}): THREE.Material {
  const fog = new THREE.Color(...desc.color);
  // $fogcolor is usually dark; lift it so the surface reads as water rather than a hole.
  const tint = new THREE.Color(0x3d6f8c).lerp(fog, 0.45).offsetHSL(0, 0, 0.06);
  const above = params?.aboveWater ?? true;
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    uniforms: {
      ...waterUniforms,
      uTint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
      uFog: { value: new THREE.Vector3(fog.r, fog.g, fog.b) },
      uSky: { value: new THREE.Vector3(SKY_REFLECTION.r, SKY_REFLECTION.g, SKY_REFLECTION.b) },
      uAbove: { value: above ? 1 : 0 },
      uSceneColor: { value: null }, uSceneDepth: { value: null },
      uReflection: { value: null }, uReflectionMatrix: { value: new THREE.Matrix4() },
      uCaptureReady: { value: 0 }, uReflectionReady: { value: 0 },
      uReflectionB: { value: null }, uReflectionMatrixB: { value: new THREE.Matrix4() },
      uReflectionHeight: { value: new THREE.Vector2(1e20, 1e20) }, uReflectionReadyB: { value: 0 },
      uCameraNearFar: { value: new THREE.Vector2(1, 10000) },
      uFogDistance: { value: Math.max(1, params?.fogEnd ?? 400) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWaterWorld;
      varying vec3 vWaterClip;
      varying vec3 vNormalW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWaterWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        vWaterClip = gl_Position.xyw;
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_DECL}
      uniform float uWaterTime;
      uniform vec3 uTint, uFog, uSky;
      uniform int uAbove;
      varying vec3 vNormalW;
      uniform sampler2D uSceneColor, uSceneDepth, uReflection, uReflectionB;
      uniform mat4 uReflectionMatrix, uReflectionMatrixB;
      uniform vec2 uReflectionHeight;
      uniform float uReflectionReadyB;
      uniform float uCaptureReady, uReflectionReady, uFogDistance;
      uniform vec2 uCameraNearFar;
      float viewDepth(float z) {
        return uCameraNearFar.x * uCameraNearFar.y / (uCameraNearFar.y - z * (uCameraNearFar.y - uCameraNearFar.x));
      }
      // Layered travelling ripples: a few travelling waves perturbing the surface normal.
      vec3 ripple(vec3 n, vec2 p, float t) {
        vec2 g = vec2(0.0);
        g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.045 + t * 1.3) * 0.5;
        g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 0.071 + t * 1.7) * 0.35;
        g += vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 0.113 + t * 2.3) * 0.2;
        if (uCaptureReady > 0.5) {
          // Integrate the short waves over the world-space pixel footprint instead of aliasing distant glints.
          float footprint = max(length(dFdx(p)), length(dFdy(p)));
          g += vec2(0.91, -0.41) * cos(dot(p, vec2(0.91, -0.41)) * 0.21 - t * 1.1) * 0.11 * exp(-0.5 * pow(footprint * 0.21, 2.0));
          g += vec2(-0.72, -0.69) * cos(dot(p, vec2(-0.72, -0.69)) * 0.36 + t * 2.8) * 0.06 * exp(-0.5 * pow(footprint * 0.36, 2.0));
        }
        return normalize(n + vec3(g.x, 0.0, g.y) * 0.08);
      }
      void main() {
        vec3 v = normalize(cameraPosition - vWaterWorld);
        vec3 n = normalize(vNormalW);
        bool fromAbove = uAbove == 1 && gl_FrontFacing;
        if (!gl_FrontFacing) n = -n;
        n = ripple(n, vWaterWorld.xz, uWaterTime);
        float cosv = clamp(abs(dot(n, v)), 0.0, 1.0);
        vec3 col;
        float alpha;
        if (fromAbove) {
          float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
          vec3 transmitted = uTint;
          vec3 reflected = uSky;
          if (uCaptureReady > 0.5) {
            vec2 uv = vWaterClip.xy / vWaterClip.z * 0.5 + 0.5;
            vec2 bent = clamp(uv + n.xz * 0.012, vec2(0.001), vec2(0.999));
            // Reject refraction offsets that cross geometry in front of the surface.
            float surfaceDepth = viewDepth(gl_FragCoord.z);
            float sceneDepth = viewDepth(texture2D(uSceneDepth, bent).r);
            if (sceneDepth < surfaceDepth) bent = uv;
            sceneDepth = viewDepth(texture2D(uSceneDepth, bent).r);
            float thickness = max(0.0, sceneDepth - surfaceDepth);
            vec3 scene = sRGBTransferOETF(texture2D(uSceneColor, bent)).rgb;
            transmitted = mix(scene, uTint, 0.12 + 0.7 * (1.0 - exp(-thickness / uFogDistance)));
          }
          if (uReflectionReady > 0.5 && abs(vWaterWorld.y - uReflectionHeight.x) < 0.2) {
            vec4 projected = uReflectionMatrix * vec4(vWaterWorld, 1.0);
            vec2 uv = projected.xy / projected.w * 0.5 + 0.5;
            uv += n.xz * 0.009;
            if (projected.w > 0.0 && all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))))
              reflected = sRGBTransferOETF(texture2D(uReflection, uv)).rgb;
          }
          if (uReflectionReadyB > 0.5 && abs(vWaterWorld.y - uReflectionHeight.y) < 0.2) {
            vec4 projected = uReflectionMatrixB * vec4(vWaterWorld, 1.0);
            vec2 uv = projected.xy / projected.w * 0.5 + 0.5 + n.xz * 0.009;
            if (projected.w > 0.0 && all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) reflected = sRGBTransferOETF(texture2D(uReflectionB, uv)).rgb;
          }
          if (uCaptureReady > 0.5) {
            // Fresnel weights radiance, not display-space values; HDR reflection contains the actual sky/sun.
            vec3 transmittedLinear = sRGBTransferEOTF(vec4(transmitted, 1.0)).rgb;
            vec3 reflectedLinear = sRGBTransferEOTF(vec4(reflected, 1.0)).rgb;
            col = sRGBTransferOETF(vec4(mix(transmittedLinear, reflectedLinear, clamp(fres * .95, 0.0, 1.0)), 1.0)).rgb;
          } else {
            col = mix(transmitted, reflected, clamp(fres * .85, 0.0, 1.0));
            // Original Classic/fallback sparkle is retained exactly; detailed water uses captured illumination.
            col += vec3(0.05) * smoothstep(0.985, 1.0, dot(n, normalize(v + vec3(0.3, 0.8, 0.2))));
          }
          alpha = uCaptureReady > 0.5 ? 1.0 : mix(0.38, 0.9, fres);
        } else {
          // Seen from below: Snell's window straight up (see-through, bright), total internal reflection
          // (opaque, fog-coloured) towards grazing angles.
          float window = smoothstep(0.55, 0.85, cosv);
          col = mix(uFog * 1.6 + uTint * 0.3, uSky * 0.9 + uTint * 0.2, window);
          alpha = mix(0.92, 0.35, window);
        }
        col = applyWaterFog(col, vWaterWorld);
        gl_FragColor = sRGBTransferEOTF(vec4(col, alpha));
        #include <colorspace_fragment>
      }`,
  });
  material.userData.waterSurface = true;
  return material;
}

/** Refract glass with no base texture: `$refracttint`, translucent, a little brighter at grazing angles. */
export function glassMaterial(desc: MaterialDesc): THREE.Material {
  const tint = new THREE.Color(...desc.color);
  // Plain (untinted) refract glass would be invisible: give it a faint cool tint.
  if (tint.r > 0.97 && tint.g > 0.97 && tint.b > 0.97) tint.set(0xd8e8f0);
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { ...waterUniforms, uTint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) } },
    vertexShader: /* glsl */ `
      varying vec3 vWaterWorld;
      varying vec3 vWaterClip;
      varying vec3 vNormalW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWaterWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        vWaterClip = gl_Position.xyw;
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_DECL}
      uniform vec3 uTint;
      varying vec3 vNormalW;
      void main() {
        vec3 v = normalize(cameraPosition - vWaterWorld);
        float cosv = clamp(abs(dot(normalize(vNormalW), v)), 0.0, 1.0);
        float fres = pow(1.0 - cosv, 3.0);
        vec3 col = mix(uTint, vec3(1.0), fres * 0.35);
        float alpha = mix(0.28, 0.6, fres);
        gl_FragColor = sRGBTransferEOTF(vec4(applyWaterFog(col, vWaterWorld), alpha));
        #include <colorspace_fragment>
      }`,
  });
}

interface Volume {
  min: THREE.Vector3;
  max: THREE.Vector3;
  color: THREE.Vector4;
  range: THREE.Vector2;
  planes: THREE.Vector4[];
}

/**
 * Water volumes in three.js space (the world root maps Source (x, y, z) to (x, z, -y)), each with the fog of the
 * water material on its top surface. `surfaces`: upward-facing water triangles (Source space centroid + material).
 */
export function waterVolumes(
  boxes: number[][],
  surfaces: { x: number; y: number; z: number; desc: MaterialDesc; params?: WaterParams }[],
  planes: number[][][] = [],
): Volume[] {
  const fallback = surfaces[0];
  return boxes.map(([x0, y0, z0, x1, y1, z1], index) => {
    const top = surfaces.find((s) => Math.abs(s.z - z1) < 2 && s.x >= x0 - 1 && s.x <= x1 + 1 && s.y >= y0 - 1 && s.y <= y1 + 1) ?? fallback;
    const c = top?.desc.color ?? [0.2, 0.3, 0.35];
    let start = top?.params?.fogStart ?? 0;
    let end = top?.params?.fogEnd ?? 0;
    if (!(end > start)) [start, end] = [0, 400];
    return {
      min: new THREE.Vector3(x0, z0, -y1),
      max: new THREE.Vector3(x1, z1, -y0),
      color: new THREE.Vector4(c[0], c[1], c[2], 1),
      range: new THREE.Vector2(start, end),
      planes: (planes[index] ?? []).map(([x, y, z, d]) => new THREE.Vector4(x, z, -y, d)),
    };
  });
}

const viewProj = new THREE.Matrix4();
const corner = new THREE.Vector4();
const camPos = new THREE.Vector3();
/** Clip-space x, y, w of the 8 corners of the box being projected. */
const cx = new Float64Array(8);
const cy = new Float64Array(8);
const cw = new Float64Array(8);
/** Per-volume scratch, reused every render: screen rectangle, squared distance to the camera; the volumes on screen. */
let rects = new Float32Array(0);
let dists = new Float32Array(0);
const onScreen: number[] = [];
/** Rectangles are widened by this much (NDC) so interpolation error at an edge never drops a fogged pixel. */
const RECT_MARGIN = 0.002;
/** "Whole screen". Finite: some drivers mishandle infinite uniforms. */
const FAR = 1e9;
/**
 * A box this close to the camera (in near-plane distances) gets the whole screen: a view ray can cross it in front of
 * the near plane, where the clipped rectangle below doesn't look. (Within the view cone, points in front of the near
 * plane are under ~2.3 near-plane distances away even at a 130° FOV.)
 */
const NEAR_BOXES = 4;

/**
 * Screen rectangle of `v` (squared distance `d2` from the camera) into `rects[4k..]`: the projection of the part of the
 * box beyond the near plane, which every fogged pixel's view ray crosses it in. False when that's off screen or empty:
 * no view ray crosses the box, so it fogs nothing.
 */
function screenRect(v: Volume, k: number, d2: number, near: number): boolean {
  let x0 = FAR, y0 = FAR, x1 = -FAR, y1 = -FAR;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  if (near <= 0 || d2 <= (NEAR_BOXES * near) ** 2) {
    x0 = y0 = -FAR;
    x1 = y1 = FAR;
  } else {
    for (let c = 0; c < 8; c++) {
      corner.set(c & 1 ? v.max.x : v.min.x, c & 2 ? v.max.y : v.min.y, c & 4 ? v.max.z : v.min.z, 1).applyMatrix4(viewProj);
      cx[c] = corner.x;
      cy[c] = corner.y;
      cw[c] = corner.w; // view depth
      if (corner.w >= near) add(corner.x / corner.w, corner.y / corner.w);
    }
    // Where the box's edges cross the near plane (clip-space interpolation is linear along an edge).
    for (let a = 0; a < 8; a++) {
      for (let bit = 1; bit < 8; bit <<= 1) {
        if (a & bit) continue;
        const b = a | bit;
        if (cw[a] >= near === cw[b] >= near) continue;
        const t = (near - cw[a]) / (cw[b] - cw[a]);
        add((cx[a] + (cx[b] - cx[a]) * t) / near, (cy[a] + (cy[b] - cy[a]) * t) / near);
      }
    }
    if (x0 > x1) return false; // wholly nearer than the near plane (behind the camera)
  }
  rects[k * 4] = x0 - RECT_MARGIN;
  rects[k * 4 + 1] = y0 - RECT_MARGIN;
  rects[k * 4 + 2] = x1 + RECT_MARGIN;
  rects[k * 4 + 3] = y1 + RECT_MARGIN;
  return x1 >= -1 - RECT_MARGIN && x0 <= 1 + RECT_MARGIN && y1 >= -1 - RECT_MARGIN && y0 <= 1 + RECT_MARGIN;
}

/**
 * Per render, with the camera being drawn (the sky's onBeforeRender; the 3D skybox pass with its own camera): the
 * volumes on screen (the nearest WATER_MAX of them) and their screen rectangles into the shared uniforms.
 */
export function setWaterVisualTime(seconds: number): void {
  if (Number.isFinite(seconds)) waterUniforms.uWaterTime.value = seconds;
}

export function updateWaterUniforms(volumes: Volume[], camera: THREE.Camera, visualTime?: number): void {
  if (visualTime !== undefined) setWaterVisualTime(visualTime);
  if (rects.length < volumes.length * 4) {
    rects = new Float32Array(volumes.length * 4);
    dists = new Float32Array(volumes.length);
  }
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  camera.getWorldPosition(camPos);
  // Rectangles need view rays from the camera position (the fog's segments): perspective only; else all volumes,
  // whole screen.
  const near = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).near : 0;
  onScreen.length = 0;
  for (let k = 0; k < volumes.length; k++) {
    const v = volumes[k];
    const dx = Math.max(v.min.x - camPos.x, 0, camPos.x - v.max.x);
    const dy = Math.max(v.min.y - camPos.y, 0, camPos.y - v.max.y);
    const dz = Math.max(v.min.z - camPos.z, 0, camPos.z - v.max.z);
    dists[k] = dx * dx + dy * dy + dz * dz;
    if (screenRect(v, k, dists[k], near)) onScreen.push(k);
  }
  if (onScreen.length > WATER_MAX) {
    onScreen.sort((a, b) => dists[a] - dists[b]);
    onScreen.length = WATER_MAX;
  }
  const planeCount = onScreen.reduce((n, k) => n + volumes[k].planes.length, 0);
  const width = Math.max(1, planeCount);
  if (planeData.length < width * 4) {
    planeData = new Float32Array(width * 4);
    planeTexture.dispose();
    planeTexture.image = { data: planeData, width, height: 1 };
  }
  waterUniforms.uWaterPlaneWidth.value = planeData.length / 4;
  let planeAt = 0;
  for (let i = 0; i < onScreen.length; i++) {
    const planes = volumes[onScreen[i]].planes;
    waterUniforms.uWaterPlaneSpan.value[i].set(planeAt, planes.length);
    for (const p of planes) { p.toArray(planeData, planeAt * 4); planeAt++; }
  }
  planeTexture.needsUpdate = true;
  waterUniforms.uWaterCount.value = onScreen.length;
  for (let i = 0; i < onScreen.length; i++) {
    const k = onScreen[i];
    const v = volumes[k];
    waterUniforms.uWaterMin.value[i].copy(v.min);
    waterUniforms.uWaterMax.value[i].copy(v.max);
    waterUniforms.uWaterColor.value[i].copy(v.color);
    waterUniforms.uWaterRange.value[i].copy(v.range);
    waterUniforms.uWaterRect.value[i].set(rects[k * 4], rects[k * 4 + 1], rects[k * 4 + 2], rects[k * 4 + 3]);
  }
}

/** Whether a three.js-space point is inside any water volume (e.g. to tint the HUD when underwater). */
export function pointInWater(volumes: Volume[], p: THREE.Vector3): boolean {
  return volumes.some((v) => p.x > v.min.x && p.x < v.max.x && p.y > v.min.y && p.y < v.max.y && p.z > v.min.z && p.z < v.max.z && v.planes.every((n) => n.x * p.x + n.y * p.y + n.z * p.z <= n.w));
}

/** Preserve convex-volume fog when a procedural/custom shader replaces the camera-centered sky. */
export function withShaderSkyWaterFog(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  if(material.userData.waterFog)return material;
  material.userData.waterFog=true;
  Object.assign(material.uniforms,waterUniforms);
  material.vertexShader='varying vec3 vWaterWorld; varying vec3 vWaterClip;\n'+material.vertexShader
    .replace(/void\s+main\s*\(\s*\)\s*\{/,match=>match+'vWaterWorld=(modelMatrix*vec4(position,1.)).xyz;')
    .replace(/\}\s*$/, 'vWaterClip=gl_Position.xyw;}');
  material.fragmentShader=FOG_DECL+'\n'+material.fragmentShader.replace('#include <colorspace_fragment>', `
    gl_FragColor.rgb=sRGBTransferEOTF(vec4(applyWaterFog(sRGBTransferOETF(gl_FragColor).rgb,cameraPosition+normalize(vWaterWorld-cameraPosition)*1.e5),1.)).rgb;
    #include <colorspace_fragment>`);
  return material;
}
