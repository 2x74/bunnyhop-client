// The map's sprites and light glows (env_sprite / env_glow, env_lightglow; placed by crates/core/src/dressing.rs),
// drawn as CS:S draws them, with no extra glow or bloom:
//
// * env_sprite: a quad of its texture's size times `scale`, facing the view the way its material's
//   `$spriteorientation` says (vp_parallel by default, parallel_upright turns about the vertical only, oriented keeps
//   the entity's angles), tinted by rendercolor and renderamt, blended by rendermode: Color / Texture / Solid blend
//   over what's behind; Glow / Additive / Additive Fractional Frame / World Space Glow add; Normal follows the
//   material. Glow (3) keeps its size on screen (scale x distance / 200) and dims with distance (19000 / d², never
//   under 0.05) unless renderfx is No Dissipation (14), as `StandardGlowBlend` does. Animated sprites play their VTF
//   frames at `framerate`, all from the map's start like CS:S (no sprite here is ever switched).
// * env_lightglow: `sprites/light_glow03`, added, the size it would have 100 units ahead of the view (CS:S draws it
//   there), faded in from MinDist to MaxDist and out to OuterMaxDist, back-facing hidden when one-sided.
//
// CS:S draws the glow modes and light glows over everything and fades them by how much of a small proxy at their
// origin is visible (pixel visibility queries). Here the same: no depth test, faded in and out over 0.15 s by whether
// the world's opaque brushes hide the origin from the view (the core's trace, a few dozen glows a frame). Props and
// brush entities don't hide them, and a partly hidden one shows whole. On a map without trace data (drawn fullbright)
// they are depth tested instead, the whole quad at its centre's depth pulled toward the view by the proxy size.
// Additive ones fog towards black. Everything is billboarded in the vertex shader, so the CPU only does the
// visibility, the animated frames and parented sprites' transforms.
//
//   const g = mapGlows(core.dressingGlows(), names, materialInfo, fog, visibility); if (g) root.add(g.root)
//   g.update(transforms, visualTime)     every frame
//   g.observe(camera)                    before rendering the main view

import * as THREE from "three";
import { GlowKind, type BrushTransform, type DressingGlow } from "./core";
import { withDepthFog, type DepthFogUniforms } from "./depth-fog";
import { markGammaBlend } from "./graphics/gamma-blend";

/** What the renderer knows of a dressing material (render.ts: its resolved texture and VMT). Null: not loaded. */
export interface GlowMaterialInfo {
  /** First frame (sRGB). */
  map: THREE.Texture;
  /** Frame count of the VTF and a loader for frame `i` (1 = still). */
  frames: number;
  frame(i: number): THREE.Texture | null;
  /** `$spriteorientation` (lowercase), `$additive`, `$translucent`, `$alphatest` of the VMT. */
  orientation: string;
  additive: boolean;
  translucent: boolean;
  alphaTest: boolean;
}

const RENDER_NORMAL = 0;
const RENDER_GLOW = 3;
const RENDER_TRANS_ALPHA = 4;
const RENDER_WORLD_GLOW = 9;
const FX_NO_DISSIPATION = 14;

/** Blend of a sprite by rendermode (the Sprite shader's `$spriterendermode`), for Normal its material's flags. */
export function spriteBlend(mode: number, info: Pick<GlowMaterialInfo, "additive" | "translucent" | "alphaTest">): "add" | "alpha" | "test" | "opaque" {
  if (mode === RENDER_NORMAL) return info.additive ? "add" : info.translucent ? "alpha" : info.alphaTest ? "test" : "opaque";
  if (mode === 1 || mode === 2 || mode === RENDER_TRANS_ALPHA) return "alpha";
  return "add";
}

/** CS:S's glow dimming (`StandardGlowBlend`): full up close, 19000 / d² beyond about 138 units, never under 0.05. */
export function glowFalloff(dist: number): number {
  return Math.min(1, Math.max(0.05, 19000 / Math.max(dist * dist, 1e-6)));
}

/** C_LightGlowOverlay: in from MinDist to MaxDist, then out to OuterMaxDist when that is set beyond MaxDist. */
export function lightGlowFade(dist: number, min: number, max: number, outer: number): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (outer > max && dist > max) return 1 - clamp((dist - max) / (outer - max));
  return clamp((dist - min) / Math.max(max - min, 1e-3));
}

const VERTEX = /* glsl */ `
uniform float uKind;
uniform float uOrient;
attribute vec2 corner;
attribute vec2 size;
attribute vec4 color;
attribute vec4 params;
attribute vec4 fade;
attribute vec3 axisU;
attribute vec3 axisV;
attribute float vis;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec3 c = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vec3 toCam = cameraPosition - c;
  float dist = max( length( toCam ), 1e-3 );
  vec2 hs = size;
  vec4 col = color * vis;
  if ( uKind < 0.5 ) {
    // params: x = keeps its size on screen, y = dims with distance, z = depth pull.
    if ( params.x > 0.5 ) hs *= dist / 200.0;
    if ( params.y > 0.5 ) col.rgb *= clamp( 19000.0 / ( dist * dist ), 0.05, 1.0 );
  } else {
    hs *= dist / 100.0;
    float f = ( fade.z > fade.y && dist > fade.y ) ? 1.0 - clamp( ( dist - fade.y ) / ( fade.z - fade.y ), 0.0, 1.0 ) : clamp( ( dist - fade.x ) / max( fade.y - fade.x, 1e-3 ), 0.0, 1.0 );
    if ( fade.w > 0.5 && dot( toCam, mat3( modelMatrix ) * axisU ) < 0.0 ) f = 0.0;
    col.rgb *= f;
  }
  // A glow faded out (hidden, out of its distance range) draws nothing: no quad, no fill.
  if ( max( col.r, max( col.g, col.b ) ) * col.a <= 0.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 );
    vColor = vec4( 0.0 );
    return;
  }
  vec3 right;
  vec3 up;
  if ( uOrient > 1.5 ) {
    right = normalize( mat3( modelMatrix ) * axisU );
    up = normalize( mat3( modelMatrix ) * axisV );
  } else if ( uOrient > 0.5 ) {
    up = vec3( 0.0, 1.0, 0.0 );
    right = normalize( cross( up, toCam ) );
  } else {
    right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
    up = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  }
  vec4 mv = viewMatrix * vec4( c + right * corner.x * hs.x + up * corner.y * hs.y, 1.0 );
  if ( params.z > 0.0 ) {
    // The whole quad at its centre's depth, pulled toward the view (never more than halfway).
    float zc = ( viewMatrix * vec4( c, 1.0 ) ).z;
    mv.xyz *= min( zc + params.z, 0.5 * zc ) / mv.z;
  }
  gl_Position = projectionMatrix * mv;
  vUv = vec2( corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5 );
  vColor = col;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float uAlphaTest;
uniform float uExposure;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 c = texture2D( map, vUv ) * vColor;
  if ( c.a <= uAlphaTest ) discard;
  gl_FragColor = vec4( c.rgb * uExposure, c.a );
  #include <colorspace_fragment>
}`;

interface Batch {
  key: string;
  kind: number;
  /** Drawn over everything, faded by visibility (see the top). */
  overlay: boolean;
  info: GlowMaterialInfo;
  blend: ReturnType<typeof spriteBlend>;
  framerate: number;
  parent: number;
  items: DressingGlow[];
  /** Each item's index in the core's glow list. */
  index: number[];
}

export interface MapGlows {
  /** Under the world's Z-up root. */
  root: THREE.Group;
  sprites: number;
  lightGlows: number;
  draws: number;
  /** Animated frames and parented sprites. */
  update(transforms: Map<number, BrushTransform>, time: number): void;
  /** Visibility of the glows drawn over everything, from `camera` (the main view). */
  observe(camera: THREE.Camera): void;
}

/** `Core.dressingGlowVisibility`: 1 / 0 per glow `first .. first + count` seen from Source-space `eye`, or null. */
export type GlowVisibility = (eye: THREE.Vector3, first: number, count: number) => Float32Array | null;

/** Visibility fades over this long (CS:S's pixel visibility fades in and out too). */
const VIS_FADE = 0.15;
/** Glows traced per frame (of those in view; the rest keep their state). */
const VIS_PER_FRAME = 24;

const D = Math.PI / 180;
/** Source AngleMatrix (pitch, yaw, roll), as render.ts places brush models. */
const rotation = (a: readonly number[], out = new THREE.Matrix4()) => out.makeRotationFromEuler(new THREE.Euler(a[2] * D, a[0] * D, a[1] * D, "ZYX"));

/** Linear rendercolor x renderamt / 255 (the blend multiplies rgb by alpha for added sprites). */
function tint(g: DressingGlow): [number, number, number, number] {
  const c = new THREE.Color().setRGB(g.color[0] / 255, g.color[1] / 255, g.color[2] / 255, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b, Math.min(1, Math.max(0, g.alpha / 255))];
}

function batchMesh(b: Batch, fog: DepthFogUniforms | null, traced: boolean): { mesh: THREE.Mesh; material: THREE.ShaderMaterial; vis: THREE.BufferAttribute } {
  const n = b.items.length;
  const pos = new Float32Array(n * 12);
  const corner = new Float32Array(n * 8);
  const size = new Float32Array(n * 8);
  const color = new Float32Array(n * 16);
  const params = new Float32Array(n * 16);
  const fade = new Float32Array(n * 16);
  const axisU = new Float32Array(n * 12);
  const axisV = new Float32Array(n * 12);
  const vis = new Float32Array(n * 4).fill(b.overlay && traced ? 0 : 1);
  const index = new Uint32Array(n * 6);
  const img = b.info.map.image as { width?: number; height?: number } | undefined;
  const [tw, th] = [img?.width ?? 64, img?.height ?? 64];
  const m = new THREE.Matrix4();
  b.items.forEach((g, i) => {
    let half: [number, number];
    let col: [number, number, number, number];
    let par: [number, number, number, number] = [0, 0, 0, 0];
    let fd: [number, number, number, number] = [0, 0, 0, 0];
    let u: number[] = [0, 0, 0];
    let v: number[] = [0, 0, 0];
    if (b.kind === GlowKind.LightGlow) {
      half = [g.size, g.size2];
      const c = new THREE.Color().setRGB(g.color[0] / 255, g.color[1] / 255, g.color[2] / 255, THREE.SRGBColorSpace);
      col = [c.r, c.g, c.b, 1];
      fd = [g.dist[0], g.dist[1], g.dist[2], g.spawnflags & 1 ? 1 : 0];
      par = [0, 0, traced ? 0 : g.dist[3], 0];
      u = g.dir;
    } else {
      const scale = g.size > 0 ? g.size : 1;
      half = [(tw * scale) / 2, (th * scale) / 2];
      col = tint(g);
      // Normal draws fully opaque whatever renderamt says.
      if (g.renderMode === RENDER_NORMAL) col[3] = 1;
      const glow = g.renderMode === RENDER_GLOW || g.renderMode === RENDER_WORLD_GLOW;
      par = [g.renderMode === RENDER_GLOW ? 1 : 0, g.renderMode === RENDER_GLOW && g.renderFx !== FX_NO_DISSIPATION ? 1 : 0, glow && !traced ? Math.max(g.dist[0], 0.5) : 0, 0];
      // oriented: the quad in the entity's own axes (Source: left = +y, up = +z of its rotation).
      rotation(g.dir, m);
      const e = m.elements;
      u = [-e[4], -e[5], -e[6]];
      v = [e[8], e[9], e[10]];
    }
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) {
      const o = i * 4 + k;
      pos.set(g.origin, o * 3);
      corner.set(corners[k], o * 2);
      size.set(half, o * 2);
      color.set(col, o * 4);
      params.set(par, o * 4);
      fade.set(fd, o * 4);
      axisU.set(u, o * 3);
      axisV.set(v, o * 3);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(color, 4));
  geo.setAttribute("params", new THREE.BufferAttribute(params, 4));
  geo.setAttribute("fade", new THREE.BufferAttribute(fade, 4));
  geo.setAttribute("axisU", new THREE.BufferAttribute(axisU, 3));
  geo.setAttribute("axisV", new THREE.BufferAttribute(axisV, 3));
  const visAttr = new THREE.BufferAttribute(vis, 1);
  geo.setAttribute("vis", visAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const orient = b.info.orientation === "oriented" ? 2 : b.info.orientation === "parallel_upright" ? 1 : 0;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: b.info.map },
      uKind: { value: b.kind === GlowKind.LightGlow ? 1 : 0 },
      uOrient: { value: b.kind === GlowKind.LightGlow ? 0 : orient },
      uAlphaTest: { value: b.blend === "test" ? 0.5 : 0 },
      uExposure: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: b.blend === "add" || b.blend === "alpha",
    depthWrite: b.blend === "opaque" || b.blend === "test",
    depthTest: !(b.overlay && traced),
    blending: b.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  material.name = `map-glow-${b.key}`;
  if (material.transparent) markGammaBlend(material);
  const mesh = new THREE.Mesh(geo, fog ? withDepthFog(material, fog) : material);
  mesh.name = "map-glows";
  mesh.frustumCulled = false;
  mesh.userData.giDisabled = true;
  return { mesh, material, vis: visAttr };
}

/**
 * Sprites and light glows of `glows` whose material is loaded (`info(name)` non-null; a missing one is left out, not
 * stood in for). `fog`: the world's (depth-fog.ts). Null when there is nothing to draw.
 */
export function mapGlows(
  glows: readonly DressingGlow[],
  names: readonly string[],
  info: (name: string) => GlowMaterialInfo | null,
  fog: DepthFogUniforms | null,
  visibility: GlowVisibility | null,
): MapGlows | null {
  const infos = new Map<number, GlowMaterialInfo | null>();
  const infoOf = (i: number) => {
    if (!infos.has(i)) infos.set(i, info(names[i] ?? ""));
    return infos.get(i)!;
  };
  const batches = new Map<string, Batch>();
  for (const [gi, g] of glows.entries()) {
    if (g.kind !== GlowKind.Sprite && g.kind !== GlowKind.LightGlow) continue;
    const mi = infoOf(g.material);
    if (!mi) continue;
    if (g.kind === GlowKind.LightGlow && (g.size <= 0 || g.size2 <= 0)) continue;
    const blend = g.kind === GlowKind.LightGlow ? "add" : spriteBlend(g.renderMode, mi);
    // Only animated sprites differ by frame rate.
    const framerate = g.kind === GlowKind.Sprite && mi.frames > 1 ? g.size2 : 0;
    const overlay = g.kind === GlowKind.LightGlow || g.renderMode === RENDER_GLOW || g.renderMode === RENDER_WORLD_GLOW;
    const key = `${g.kind}:${g.material}:${blend}:${framerate}:${g.parentModel}:${overlay}`;
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { key, kind: g.kind, overlay, info: mi, blend, framerate, parent: g.parentModel, items: [], index: [] }));
    b.items.push(g);
    b.index.push(gi);
  }
  if (!batches.size) return null;
  const traced = !!visibility?.(new THREE.Vector3(), 0, 1);
  // Per traced glow (core index): where its four `vis` values are, and its faded and target visibility.
  const watched = new Map<number, { attr: THREE.BufferAttribute; at: number; now: number; target: number; glow: DressingGlow }>();
  const root = new THREE.Group();
  root.name = "map-glows";
  const parents = new Map<number, { group: THREE.Group; spawnInverse: THREE.Matrix4; at: number[] }>();
  const animated: { material: THREE.ShaderMaterial; frames: (THREE.Texture | null | undefined)[]; info: GlowMaterialInfo; rate: number; shown: number }[] = [];
  let sprites = 0;
  let lightGlows = 0;
  for (const b of batches.values()) {
    const { mesh, material, vis } = batchMesh(b, fog, traced);
    // Blended glows after the world's blended surfaces, the ones drawn over everything last; opaque and cut-out ones
    // are ordinary geometry.
    mesh.renderOrder = b.overlay && traced ? 2 : material.transparent ? 1 : 0;
    if (b.overlay && traced) b.index.forEach((gi, k) => watched.set(gi, { attr: vis, at: k * 4, now: 0, target: 0, glow: b.items[k] }));
    let parent: THREE.Object3D = root;
    if (b.parent >= 0) {
      let p = parents.get(b.parent);
      if (!p) {
        const g = b.items[0];
        const spawn = rotation(g.parentAngles).setPosition(g.parentOrigin[0], g.parentOrigin[1], g.parentOrigin[2]);
        p = { group: new THREE.Group(), spawnInverse: spawn.invert(), at: [] };
        p.group.matrixAutoUpdate = false;
        parents.set(b.parent, p);
        root.add(p.group);
      }
      parent = p.group;
    }
    parent.add(mesh);
    if (b.framerate > 0) animated.push({ material, frames: [b.info.map], info: b.info, rate: b.framerate, shown: 0 });
    if (b.kind === GlowKind.LightGlow) lightGlows += b.items.length;
    else sprites += b.items.length;
  }
  const m = new THREE.Matrix4();
  // Traced a couple of dozen a frame, round robin over the ones that could show: in the view, not faded out by distance.
  const order = [...watched.keys()].sort((a, b) => a - b);
  let cursor = 0;
  let last = -1;
  const eye = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();
  const m4 = new THREE.Matrix4();
  const shows = (g: DressingGlow, world: THREE.Matrix4) => {
    const d = Math.hypot(g.origin[0] - eye.x, g.origin[1] - eye.y, g.origin[2] - eye.z);
    if (g.kind === GlowKind.LightGlow && lightGlowFade(d, g.dist[0], g.dist[1], g.dist[2]) <= 0) return false;
    // Generous bounds: glows keep their size on screen, so the sphere grows with distance.
    sphere.center.set(g.origin[0], g.origin[1], g.origin[2]).applyMatrix4(world);
    sphere.radius = Math.max(64, d * 0.5);
    return frustum.intersectsSphere(sphere);
  };
  return {
    root,
    sprites,
    lightGlows,
    draws: batches.size,
    observe(camera) {
      if (!order.length || !root.parent) return;
      const now = performance.now() / 1000;
      const first = last < 0;
      const dt = first ? 1 : Math.min(1, Math.max(0, now - last));
      last = now;
      eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse.copy(root.parent.matrixWorld).invert());
      frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      // The first look traces all of them (and shows them as they are); then a few in view a frame.
      let budget = first ? order.length : VIS_PER_FRAME;
      for (let seen = 0; seen < order.length && budget > 0; seen++) {
        if (cursor >= order.length) cursor = 0;
        const gi = order[cursor++];
        const w = watched.get(gi)!;
        if (!first && !shows(w.glow, root.parent.matrixWorld)) continue;
        w.target = visibility!(eye, gi, 1)?.[0] ?? 0;
        budget--;
      }
      const step = dt / VIS_FADE;
      for (const w of watched.values()) {
        const next = first ? w.target : w.now + Math.max(-step, Math.min(step, w.target - w.now));
        if (next === w.now) continue;
        w.now = next;
        const a = w.attr.array as Float32Array;
        a[w.at] = a[w.at + 1] = a[w.at + 2] = a[w.at + 3] = next;
        w.attr.needsUpdate = true;
      }
    },
    update(transforms, time) {
      for (const a of animated) {
        const f = Math.floor(Math.max(0, time) * a.rate) % a.info.frames;
        if (f === a.shown) continue;
        if (a.frames[f] === undefined) a.frames[f] = a.info.frame(f);
        const tex = a.frames[f];
        if (tex) a.material.uniforms.map.value = tex;
        a.shown = f;
      }
      for (const [model, p] of parents) {
        const t = transforms.get(model);
        if (!t) continue;
        p.group.visible = t.length <= 6 || t[6] !== 0;
        if (p.at.length && t.slice(0, 6).every((x, k) => x === p.at[k])) continue;
        p.at = t.slice(0, 6);
        rotation([t[3], t[4], t[5]], m).setPosition(t[0], t[1], t[2]);
        p.group.matrix.multiplyMatrices(m, p.spawnInverse);
        p.group.matrixWorldNeedsUpdate = true;
      }
    },
  };
}
