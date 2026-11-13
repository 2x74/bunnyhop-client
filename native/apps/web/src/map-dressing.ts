// The map's overlays and infodecals (crates/core/src/dressing.rs builds them on the faces they lie on, with those
// faces' lightmap coordinates), drawn as CS:S draws them: after the world, lit by its lightmaps, fogged like it, a
// little in front of it (the core lifts them 0.1 units, as the engine does, and the materials take a depth bias).
//
// Draw order: Source draws overlays (by their render order) and then decals with the opaque world, before anything
// translucent. Here the opaque ones go after the world's opaque surfaces (they don't write depth, so the world must be
// there first) and the blended ones before every other blended surface, so a window or water in front of a decal
// still covers it. Overlay fade distances (`fademindist` / `fademaxdist`) fade them by the view's distance to the
// overlay's origin, as the engine does.
//
//   const d = dressingMeshes(core.dressingMesh(), (g) => material(g))   main view and 3D skybox meshes
//   d.main.forEach((m) => root.add(m)); d.sky.forEach((m) => sky3dRoot.add(m))

import * as THREE from "three";
import { DRESSING_STRIDE, type DressingGroup } from "./core";

/** Opaque dressing draws after the world's opaque surfaces; blended dressing before the world's blended ones. */
export const DRESSING_OPAQUE_ORDER = 1;
export const DRESSING_BLENDED_ORDER = -1;

/** Depth bias of overlay and decal materials (Source's `$decal`): toward the viewer, so they win over their face. */
export function withDecalBias<M extends THREE.Material>(m: M): M {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  m.depthWrite = false;
  return m;
}

/** Fades a dressing material by the view's distance to each overlay's origin (`fadeOrigin`, `fadeRange` = min², max²). */
export function withDressingFade<M extends THREE.Material>(m: M): M {
  const prev = m.onBeforeCompile;
  const key = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 fadeOrigin;\nattribute vec2 fadeRange;\nvarying float vDressFade;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  vec3 dressFadeTo = ( modelMatrix * vec4( fadeOrigin, 1.0 ) ).xyz - cameraPosition;
  vDressFade = fadeRange.y > 0.0 ? clamp( ( fadeRange.y - dot( dressFadeTo, dressFadeTo ) ) / max( fadeRange.y - fadeRange.x, 1.0 ), 0.0, 1.0 ) : 1.0;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vDressFade;")
      .replace("#include <alphamap_fragment>", "#include <alphamap_fragment>\n  if ( vDressFade <= 0.0 ) discard;\n  diffuseColor.a *= vDressFade;");
  };
  m.customProgramCacheKey = () => `${key.call(m)}+dressfade`;
  return m;
}

/**
 * Source's DecalModulate (stains, scorch marks, dirt): the texture multiplies what's under it twice over, so mid-grey
 * leaves it as it is, and its alpha fades it towards that grey. Drawn in gamma space like the engine's LDR path; fog
 * fades it towards grey too (`depthFogTo`, depth-fog.ts).
 */
export function decalModulateMaterial(map: THREE.Texture, alpha: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    opacity: alpha,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  m.userData.depthFogTo = "vec3( 0.5 )";
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <fog_fragment>",
      "gl_FragColor = vec4( mix( vec3( 0.5 ), gl_FragColor.rgb, clamp( gl_FragColor.a, 0.0, 1.0 ) ), 1.0 );\n#include <fog_fragment>",
    );
  };
  m.customProgramCacheKey = () => "decal-modulate";
  return m;
}

export interface DressingMeshes {
  /** Main view meshes (opaque, blended), under the world's Z-up root. */
  main: THREE.Mesh[];
  /** 3D skybox meshes, under its root. */
  sky: THREE.Mesh[];
  /** Groups drawn (draw calls when all is in view). */
  draws: number;
  triangles: number;
}

const blended = (m: THREE.Material) => m.transparent || m.blending !== THREE.NormalBlending;

/**
 * Meshes for the dressing geometry. `material(group, sky3d)` is the group's material, or null to leave it out (its
 * content isn't there: a missing detail rather than a stand-in); called once per group, cache by material yourself.
 * `sky3d`: whether the 3D skybox is drawn by its own pass (else its groups join the main view, as the world's do).
 */
export function dressingMeshes(
  data: { vertices: Float32Array; indices: Uint32Array; groups: DressingGroup[] },
  material: (group: DressingGroup, inSky: boolean) => THREE.Material | null,
  sky3d: boolean,
): DressingMeshes {
  const buf = new THREE.InterleavedBuffer(data.vertices, DRESSING_STRIDE);
  const attrs: [string, THREE.InterleavedBufferAttribute][] = [
    ["position", new THREE.InterleavedBufferAttribute(buf, 3, 0)],
    ["normal", new THREE.InterleavedBufferAttribute(buf, 3, 3)],
    ["uv", new THREE.InterleavedBufferAttribute(buf, 2, 6)],
    ["uv1", new THREE.InterleavedBufferAttribute(buf, 2, 8)],
    ["fadeOrigin", new THREE.InterleavedBufferAttribute(buf, 3, 10)],
    ["fadeRange", new THREE.InterleavedBufferAttribute(buf, 2, 13)],
  ];
  const index = new THREE.BufferAttribute(data.indices, 1);
  const out: DressingMeshes = { main: [], sky: [], draws: 0, triangles: 0 };
  const meshes = new Map<string, { mesh: THREE.Mesh; mats: THREE.Material[] }>();
  for (const g of data.groups) {
    const inSky = sky3d && g.sky3d;
    const m = material(g, inSky);
    if (!m) continue;
    const key = `${inSky ? "sky" : "main"}-${blended(m) ? "blended" : "opaque"}`;
    let entry = meshes.get(key);
    if (!entry) {
      const geo = new THREE.BufferGeometry();
      for (const [name, a] of attrs) geo.setAttribute(name, a);
      geo.setIndex(index);
      const mats: THREE.Material[] = [];
      const mesh = new THREE.Mesh(geo, mats);
      mesh.name = `map-dressing-${key}`;
      mesh.frustumCulled = false;
      // Not a light source or occluder for the optional traced lighting (graphics/hybrid-gi).
      mesh.userData.giDisabled = true;
      mesh.renderOrder = blended(m) ? DRESSING_BLENDED_ORDER : DRESSING_OPAQUE_ORDER;
      entry = { mesh, mats };
      meshes.set(key, entry);
      (inSky ? out.sky : out.main).push(mesh);
    }
    let slot = entry.mats.indexOf(m);
    if (slot < 0) slot = entry.mats.push(m) - 1;
    entry.mesh.geometry.addGroup(g.firstIndex, g.indexCount, slot);
    out.draws++;
    out.triangles += g.indexCount / 3;
  }
  return out;
}
