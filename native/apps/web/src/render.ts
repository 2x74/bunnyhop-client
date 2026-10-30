import { appLocation } from "./platform/navigation";
import { embeddedNormalPath, normalTextureSupported, mapSunDirection, withWorldNormal } from "./world-normal";
import { hiddenTriggerModels } from "./brush-visibility";
import { sourceLightColor } from "./graphics/source-light-color";
import { authoredLocalLights } from "./graphics/authored-lights";
import { withMaterialDetail, withShowcaseAlbedo } from "./material-detail";
import { prepareTextureOverrides } from "./texture-packs/textures";
import { tryTexturePath } from "./texture-packs/manifest";
import { sha256Hex } from "./content";
import { Flashlight } from "./flashlight";
import { Fullbright } from "./fullbright";
import * as THREE from "three";
import { boundGeometry, boundObject, CELL_MIN_TRIANGLES, CellCuller } from "./cull";
import {
  type Core,
  type Lightmap,
  type MaterialDesc,
  type MaterialInfo,
  type TexturePayload,
  type BrushTransform,
  MAT_ADDITIVE,
  PROP_TRANSFORM_KEY,
  MAT_ALPHATEST,
  MAT_NOCULL,
  MAT_TRANSLUCENT,
  MAT_UNLIT,
  MaterialKind,
  type MaterialExtras,
  type SkyCamera,
  TextureFormat,
} from "./core";
import { prepareMapContent, type PrepareContentOptions } from "./content";
import { markGammaBlend } from "./graphics/gamma-blend";
import { glassMaterial, setWaterVisualTime, updateWaterUniforms, waterSurfaceMaterial, waterVolumes, withWaterFog } from "./water";
import { mapSmoke, brushBounds, materialName } from "./map-effects/smoke";
import { spriteTrails } from "./sprite-trails";
import { smokeStacks } from "./smokestacks";
import { applyLightStyles } from "./lightstyles";
import { averageColor, potatoGeometry, withGrid, type PotatoSlot } from "./potato";
import { ImposterSet, type ImposterKind } from "./imposter";
import { CLIENT_DRAWN_SHADERS } from "./vmt";

export interface WorldView {
  readonly texturePacks: { id: string; version: string }[];
  root: THREE.Object3D;
  /** Depth-only sky face meshes (see `skyFaceMeshes`), under `root`. */
  skyFaces: THREE.Mesh[];
  /**
   * The 3D skybox (see `sky3dPass`), null without one. Its geometry is under `root` on SKY3D_LAYER (never drawn by
   * the main pass, skipped by raycasts); `enabled = false` turns the pass off (the miniature is then simply absent).
   */
  sky3d: { camera: SkyCamera; root: THREE.Group; enabled: boolean } | null;
  /** Moves brush entity models (doors, platforms, rotators) to their current transforms. */
  update(transforms: Map<number, BrushTransform>, visualTime?: number, effectStates?: Map<number, boolean>): void;
  /**
   * What reconstructTrails samples, or null when there is nothing to rebuild (no trails on moving brushes, or Potato):
   * `span` seconds of history, of only these brush models' transforms and these entities' states. The replay viewer
   * records that much as it plays.
   */
  trailHistory(): { span: number; models: ReadonlySet<number>; entities: ReadonlySet<number> } | null;
  /** Rebuild moving trails from a fixed history sampling grid after a replay seek/export frame. */
  reconstructTrails(time: number, sample: (time: number) => { transforms: Map<number, BrushTransform>; states?: Map<number, boolean> }): void;
  /** Potato graphics (potato.ts) on or off, live. Built the first time it's turned on. */
  setPotato(on: boolean): void;
  /** Camera-forward local illumination, also in Potato mode; no simulation state. */
  setFlashlight(on: boolean): void;
  /** Bypass baked map/prop lighting while retaining textures and fog; local rendering only. */
  setFullbright(on: boolean): void;
  /**
   * Skips the parts of the big meshes outside `camera`'s view (cull.ts). Before each render of the world, in the
   * scene's onBeforeRender; a world never culled draws everything.
   */
  cull(camera: THREE.Camera): void;
}

export interface TextureSupport {
  s3tc: boolean;
  anisotropy: number;
}

const S3TC_FORMATS: Record<number, THREE.CompressedPixelFormat> = {
  [TextureFormat.DXT1]: THREE.RGB_S3TC_DXT1_Format,
  [TextureFormat.DXT1A]: THREE.RGBA_S3TC_DXT1_Format,
  [TextureFormat.DXT3]: THREE.RGBA_S3TC_DXT3_Format,
  [TextureFormat.DXT5]: THREE.RGBA_S3TC_DXT5_Format,
};

export function textureFromPayload(p: TexturePayload, support: TextureSupport, colorSpace: string = THREE.SRGBColorSpace): THREE.Texture {
  const base = p.levels[0];
  let tex: THREE.Texture;
  if (p.format === TextureFormat.RGBA8) {
    tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
  } else {
    const mipmaps = p.levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
    tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], base.width, base.height, S3TC_FORMATS[p.format]);
    tex.generateMipmaps = false;
    tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  }
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = support.anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function lightmapTexture(lm: Lightmap): THREE.Texture {
  const tex = new THREE.DataTexture(lm.data, lm.width, lm.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.channel = 1; // second UV set ("uv1")
  tex.needsUpdate = true;
  return tex;
}

// --- Fallback for materials we don't have (stock game content) -------------------------------

function hashHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) / 360;
}

/** `maps/<map>/foo/bar_12_-34_56` (cubemap patch) and `_wvt_patch` names -> the underlying material. */
function baseMaterialName(name: string): string {
  return name
    .replace(/^maps\/[^/]+\//, "")
    .replace(/_-?\d+_-?\d+_-?\d+$/, "")
    .replace(/_wvt_patch$/, "");
}

let checker: THREE.Texture | null = null;
function checkerTexture(anisotropy: number): THREE.Texture {
  if (checker) return checker;
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c8c8c8";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#b4b4b4";
  g.fillRect(0, 0, size / 2, size / 2);
  g.fillRect(size / 2, size / 2, size / 2, size / 2);
  g.strokeStyle = "#9a9a9a";
  g.strokeRect(0.5, 0.5, size - 1, size - 1);
  checker = new THREE.CanvasTexture(c);
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.anisotropy = anisotropy;
  return checker;
}

/**
 * Neutral stand-in for content that isn't in the map's pakfile. Once users can mount their own
 * game VPKs, these resolve to real textures in core and never reach this path.
 */
function fallbackMaterial(info: MaterialInfo, lightMap: THREE.Texture, lightMapIntensity: number, support: TextureSupport): THREE.Material {
  const name = baseMaterialName(info.name);
  const color = new THREE.Color().setHSL(hashHue(name), 0.12, 0.62, THREE.SRGBColorSpace);
  if (/glass|window/.test(name)) {
    return markGammaBlend(new THREE.MeshBasicMaterial({ color: 0xbcd6e6, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
  }
  if (/^(effects|decals|overlays|sprites)\//.test(name) || name.includes("{")) {
    return markGammaBlend(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false }));
  }
  return new THREE.MeshBasicMaterial({ map: checkerTexture(support.anisotropy), color, lightMap, lightMapIntensity });
}

function sourceFlags<M extends THREE.Material>(material: M, desc?: MaterialDesc): M {
  material.userData.sourceUnlit = !!(desc && (desc.flags & MAT_UNLIT));
  // $translucent / $additive: blended in gamma space in the HDR looks (graphics/gamma-blend.ts).
  if (material.transparent && desc && desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE)) markGammaBlend(material);
  return material;
}

function texturedMaterial(desc: MaterialDesc, map: THREE.Texture, lightMap: THREE.Texture, lightMapIntensity: number): THREE.Material {
  const translucent = (desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE)) !== 0;
  const lit = (desc.flags & MAT_UNLIT) === 0;
  return sourceFlags(new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(...desc.color),
    lightMap: lit ? lightMap : null,
    lightMapIntensity,
    transparent: translucent,
    opacity: desc.alpha,
    depthWrite: !translucent,
    blending: desc.flags & MAT_ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: desc.flags & MAT_ALPHATEST ? desc.alphaRef : 0,
    side: desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide,
  }), desc);
}

/** A VMT with no base texture: Source draws its white default texture, i.e. the flat `$color`. */
function flatMaterial(desc: MaterialDesc, lightMap: THREE.Texture, lightMapIntensity: number): THREE.Material {
  const translucent = (desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE)) !== 0;
  return sourceFlags(new THREE.MeshBasicMaterial({
    color: new THREE.Color(...desc.color),
    lightMap: desc.flags & MAT_UNLIT ? null : lightMap,
    lightMapIntensity,
    transparent: translucent,
    opacity: desc.alpha,
    depthWrite: !translucent,
    blending: desc.flags & MAT_ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide,
  }), desc);
}

/**
 * Adds `$basetexture2` (WorldVertexTransition: blended by the per-vertex displacement alpha in the
 * `blend` attribute) and `$detail` (mod2x at `$detailscale`) to a textured material.
 */
function addSecondaryMaps(m: THREE.MeshBasicMaterial, map2: THREE.Texture | null, detail: THREE.Texture | null, ex: MaterialExtras | undefined): void {
  if (!map2 && !detail) return;
  const key = `${map2 ? "blend" : ""}${detail ? "+detail" : ""}`;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    let decl = "";
    let frag = "#ifdef USE_MAP\n  vec4 sampledDiffuseColor = texture2D( map, vMapUv );\n";
    if (map2) {
      shader.uniforms.map2 = { value: map2 };
      decl += "uniform sampler2D map2;\nvarying float vBlend;\n";
      frag += "  sampledDiffuseColor = mix( sampledDiffuseColor, texture2D( map2, vMapUv ), clamp( vBlend, 0.0, 1.0 ) );\n";
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float blend;\nvarying float vBlend;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\n  vBlend = blend;");
    }
    frag += "  diffuseColor *= sampledDiffuseColor;\n";
    if (detail) {
      shader.uniforms.detailMap = { value: detail };
      shader.uniforms.detailScale = { value: ex?.detailScale ?? 4 };
      shader.uniforms.detailBlend = { value: ex?.detailBlend ?? 1 };
      decl += "uniform sampler2D detailMap;\nuniform float detailScale;\nuniform float detailBlend;\n";
      // Detail textures are sampled raw (NoColorSpace) so mid-grey 0.5 * 2 is neutral, as in Source.
      frag += "  diffuseColor.rgb *= mix( vec3( 1.0 ), texture2D( detailMap, vMapUv * detailScale ).rgb * 2.0, detailBlend );\n";
    }
    frag += "#endif\n";
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${decl}`)
      .replace("#include <map_fragment>", frag);
  };
  m.userData.giDiffuseHook = m.onBeforeCompile;
}

// --- Static props ----------------------------------------------------------------------------

/** Fixed light direction (Source space) for the props' simple ambient + diffuse term. */
const PROP_LIGHT = new THREE.Vector3(0.35, 0.45, 0.82).normalize();

function hiddenToolMaterial(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll("\\", "/");
  return normalized.startsWith("tools/") && normalized !== "tools/toolsblack" && normalized !== "tools/toolswhite";
}

function propMaterial(desc: MaterialDesc | undefined, map: THREE.Texture | null, name: string): THREE.Material {
  // Invisible tool textures on models follow the world mesh; toolsblack/toolswhite remain visible.
  // An invisible group material tells three.js to skip the group.
  if (hiddenToolMaterial(name)) return new THREE.MeshBasicMaterial({ visible: false });
  if (desc?.kind === MaterialKind.Glass) return glassMaterial(desc);
  if (desc?.kind === MaterialKind.Flat) return new THREE.MeshBasicMaterial({ color: new THREE.Color(...desc.color), vertexColors: true });
  if (!desc || !map) {
    // Unavailable prop material: neutral grey (lit by vertex colours).
    return new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hashHue(name), 0.1, 0.55, THREE.SRGBColorSpace), vertexColors: true });
  }
  const translucent = (desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE)) !== 0;
  const m = new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(...desc.color),
    vertexColors: true,
    transparent: translucent,
    opacity: desc.alpha,
    depthWrite: !translucent,
    blending: desc.flags & MAT_ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: desc.flags & MAT_ALPHATEST ? desc.alphaRef : 0,
    side: desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide,
  });
  return translucent ? markGammaBlend(m) : m;
}

/**
 * All static props as one mesh. Lighting is a first pass: a constant ambient term plus a fixed
 * directional term baked into vertex colours (Source lights props per vertex from the map's lighting).
 */
function propsMesh(
  pm: ReturnType<Core["propsMesh"]>,
  mats: THREE.Material[],
  skyMats: THREE.Material[] | null,
): { mesh: THREE.Mesh; sky: THREE.Mesh | null; moving: Map<number, THREE.Mesh> } {
  const n = pm.vertices.length / 8;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    const d = Math.max(0, pm.vertices[o + 3] * PROP_LIGHT.x + pm.vertices[o + 4] * PROP_LIGHT.y + pm.vertices[o + 5] * PROP_LIGHT.z);
    const s = 0.5 + 0.5 * d;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = s;
  }
  const buf = new THREE.InterleavedBuffer(pm.vertices, 8);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
  geo.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
  geo.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 6));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("fullbrightShade", new THREE.BufferAttribute(Float32Array.from({ length: n }, (_, i) => colors[i * 3]), 1));
  geo.setIndex(new THREE.BufferAttribute(pm.indices, 1));
  // 3D skybox props (`skyMats` given): their own mesh on the same buffers, drawn by the skybox pass.
  let sky: THREE.Mesh | null = null;
  for (const g of pm.groups) {
    if (skyMats && g.sky3d) {
      if (!sky) {
        const sgeo = new THREE.BufferGeometry();
        for (const name of ["position", "normal", "uv", "color", "fullbrightShade"]) sgeo.setAttribute(name, geo.getAttribute(name));
        sgeo.setIndex(geo.getIndex());
        sky = new THREE.Mesh(sgeo, skyMats);
        sky.name = "sky3d-props";
        sky.frustumCulled = false;
      }
      sky.geometry.addGroup(g.firstIndex, g.indexCount, g.material);
    } else geo.addGroup(g.firstIndex, g.indexCount, g.material);
  }
  const mesh = new THREE.Mesh(geo, mats);
  mesh.name = "static-props";
  mesh.frustumCulled = false;
  // Moving props (doors): the same buffers, their own groups, placed by `update` (key PROP_TRANSFORM_KEY + entity).
  const moving = new Map<number, THREE.Mesh>();
  for (const g of pm.dynamicGroups) {
    let m = moving.get(g.entity);
    if (!m) {
      const dgeo = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "uv", "color", "fullbrightShade"]) dgeo.setAttribute(name, geo.getAttribute(name));
      dgeo.setIndex(geo.getIndex());
      m = new THREE.Mesh(dgeo, mats);
      m.name = `prop-${g.entity}`;
      m.frustumCulled = false;
      moving.set(g.entity, m);
    }
    m.geometry.addGroup(g.firstIndex, g.indexCount, g.material);
  }
  return { mesh, sky, moving };
}

// --- Sky -------------------------------------------------------------------------------------

/**
 * The map's 2D skybox (`skybox/<skyname>{rt,lf,bk,ft,up,dn}`) from mounted game content, as a
 * camera-centred cube. Face orientation follows the Quake/Source sky convention (st_to_vec):
 * rt = +X, lf = -X, bk = +Y, ft = -Y, up = +Z, dn = -Z, with image "up" towards +Z on the sides.
 */
function skyBox(faces: (THREE.Texture | null)[]): THREE.Mesh {
  const d = 1000;
  // (s, t) in [-1, 1] -> Source-space point on each face.
  const place: ((s: number, t: number) => [number, number, number])[] = [
    (s, t) => [d, -s * d, t * d], // rt
    (s, t) => [-d, s * d, t * d], // lf
    (s, t) => [s * d, d, t * d], // bk
    (s, t) => [-s * d, -d, t * d], // ft
    (s, t) => [-t * d, -s * d, d], // up
    (s, t) => [t * d, -s * d, -d], // dn
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const geo = new THREE.BufferGeometry();
  const materials: THREE.Material[] = [];
  faces.forEach((tex, f) => {
    const img = tex?.image as { width?: number; height?: number } | undefined;
    // Some sides ship only the upper half (w = 2h): it covers t in [0, 1]; below that the bottom row repeats.
    const half = f < 4 && !!img?.width && img.height! * 2 === img.width;
    const base = pos.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, y, z] = place[f](s, t);
      pos.push(x, z, -y); // Source (x, y, z) -> three (x, z, -y)
      uv.push((s + 1) / 2, half ? 1 - t : (1 - t) / 2); // image row 0 (v = 0) is the top (t = +1)
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    geo.addGroup(f * 6, 6, f);
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
    }
    materials.push(
      tex
        ? new THREE.MeshBasicMaterial({ map: tex, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false })
        : new THREE.MeshBasicMaterial({ color: f === 5 ? 0x3a3a3a : 0x8fb3d9, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false }),
    );
  });
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  const box = new THREE.Mesh(geo, materials);
  box.name = "skybox";
  box.frustumCulled = false;
  box.renderOrder = -1000;
  // matrixWorld was computed before this hook: refresh it so the box is centred on this frame's camera.
  box.onBeforeRender = (_r, _s, camera) => {
    box.position.copy(camera.position);
    box.updateMatrixWorld();
  };
  return box;
}

/** A gradient sky dome that follows the camera (we don't ship skybox textures). */
function skyDome(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x3f6fb5) },
      horizon: { value: new THREE.Color(0xc9dcec) },
      ground: { value: new THREE.Color(0x7d8a96) },
      sunDir: { value: new THREE.Vector3(0.45, 0.35, -0.6).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith, horizon, ground, sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = d.y > 0.0
          ? mix(horizon, zenith, pow(d.y, 0.55))
          : mix(horizon, ground, pow(min(-d.y * 3.0, 1.0), 0.7));
        float sun = max(dot(d, sunDir), 0.0);
        c += vec3(1.0, 0.92, 0.75) * (pow(sun, 600.0) * 1.5 + pow(sun, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  return dome;
}

/** Draw order of the sky face depth pass: after the sky background (-1000), before everything else (0). */
const SKY_FACE_RENDER_ORDER = -999;

/**
 * Sky faces (`tools/toolsskybox`, SURF_SKY / SURF_SKY2D) as depth-only meshes, one per brush model that has any. In
 * Source these faces show the skybox and hide everything behind them (other stages built as sealed rooms, the 3D
 * skybox's miniature). We draw the sky as a camera-centred background first (renderOrder -1000, no depth), then
 * these with colour writes off: the background stays visible through them and any world geometry, prop, player or
 * water behind them fails the depth test. The polygon offset pushes them back slightly so a coplanar world face wins
 * instead of z-fighting. One extra draw call.
 */
function skyFaceMeshes(sky: NonNullable<ReturnType<Core["skyMesh"]>>): Map<number, THREE.Mesh> {
  const out = new Map<number, THREE.Mesh>();
  if (!sky.indices.length) return out;
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  material.name = "sky-faces";
  const position = new THREE.BufferAttribute(sky.vertices, 3);
  const index = new THREE.BufferAttribute(sky.indices, 1);
  for (const g of sky.groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", position);
    geo.setIndex(index);
    geo.addGroup(g.firstIndex, g.indexCount, 0);
    // An array material like the world meshes, so camera raycasts (attract.ts) stop at sky walls too.
    const mesh = new THREE.Mesh(geo, [material]);
    mesh.name = "sky-faces";
    mesh.frustumCulled = false;
    mesh.renderOrder = SKY_FACE_RENDER_ORDER;
    out.set(g.model, mesh);
  }
  return out;
}

// --- 3D skybox ------------------------------------------------------------------------------

/** Layer of the 3D skybox geometry: not on the default layer 0, so the main pass and raycasts never see it. */
export const SKY3D_LAYER = 1;
/** Draw order of the skybox pass hook: after the sky background (-1000), before the sky faces (-999). */
const SKY3D_RENDER_ORDER = -999.5;

type SkyFogUniforms = { uSkyFogColor: { value: THREE.Vector3 }; uSkyFogRange: { value: THREE.Vector3 } };

/**
 * Adds the sky_camera's fog to a skybox material (keeps any existing onBeforeCompile). Source's fog (SDK 2013
 * `CSkyboxView::Enable3dSkyboxFog`): linear in view depth from fogstart / scale to fogend / scale (skybox units), capped
 * at fogmaxdensity, blended in gamma space like Source's LDR path (after the output colour conversion, like the
 * water fog). Additive materials fog towards black.
 */
function withSkyFog<M extends THREE.Material>(m: M, u: SkyFogUniforms): M {
  const additive = m.blending === THREE.AdditiveBlending;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vSkyFogDepth;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  vSkyFogDepth = - mvPosition.z;");
    const outputLinear = renderer.getRenderTarget() !== null || renderer.outputColorSpace !== THREE.SRGBColorSpace;
    const color = additive ? "vec3( 0.0 )" : outputLinear ? "sRGBTransferOETF(vec4(uSkyFogColor, 1.0)).rgb" : "uSkyFogColor";
    const source = outputLinear ? "sRGBTransferOETF(gl_FragColor).rgb" : "gl_FragColor.rgb";
    const mixed = `mix( ${source}, ${color}, clamp( min( uSkyFogRange.z, ( vSkyFogDepth - uSkyFogRange.x ) / max( uSkyFogRange.y - uSkyFogRange.x, 1e-3 ) ), 0.0, 1.0 ) )`;
    const fogged = outputLinear ? `sRGBTransferEOTF(vec4(${mixed}, 1.0)).rgb` : mixed;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSkyFogColor;\nuniform vec3 uSkyFogRange;\nvarying float vSkyFogDepth;")
      .replace(
        "#include <fog_fragment>",
        `gl_FragColor.rgb = ${fogged};\n#include <fog_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey.call(m)}+skyfog${additive ? "-add" : ""}`;
  return m;
}

/** Draw calls of the skybox pass (one per mesh group). */
function sky3dDraws(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) n += Math.max(1, m.geometry.groups.length);
  });
  return n;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Source's 3D skybox (SDK 2013 `CViewRender` / `CSkyboxView`): the sky_camera's miniature (`sky3dRoot`, skybox set
 * from core: crates/core/src/skybox.rs) is drawn from `sky_camera.origin + eye / scale` with the main camera's angles
 * and projection, after the 2D sky and before everything else; then depth is cleared, so the main view (whose sky
 * faces are depth-only, see `skyFaceMeshes`) shows it wherever it shows sky.
 *
 * Done from the onBeforeRender of an empty mesh ordered between the sky background and the sky faces, as a nested
 * render (the pattern three's Reflector uses), so every `renderer.render(scene, camera)` of the world (game, replay
 * viewer and MP4 export, menu background, thumbnails) composes it without changes; passes with an override material
 * (the thumbnail depth probe) skip it, so there the skybox counts as sky. One no-op draw for the hook plus the
 * skybox's own draws (a handful: one per material of the skybox set).
 */
function sky3dPass(
  root: THREE.Object3D,
  sky3dRoot: THREE.Group,
  cam: SkyCamera,
  fog: SkyFogUniforms | null,
  state: { enabled: boolean },
  /** Called with the skybox camera before its pass and the main camera after (the water fog's per-camera uniforms). */
  onCamera: (camera: THREE.Camera) => void,
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  const hook = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, fog: false }));
  hook.name = "sky3d-pass";
  hook.frustumCulled = false;
  hook.renderOrder = SKY3D_RENDER_ORDER;
  const skyCam = new THREE.PerspectiveCamera();
  skyCam.layers.set(SKY3D_LAYER);
  const eye = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  const origin = new THREE.Vector3(...cam.origin);
  const dir = new THREE.Vector3(...cam.fog.dir).normalize();
  let busy = false;
  hook.onBeforeRender = (renderer, scene, camera) => {
    if (!state.enabled || busy || (scene as THREE.Scene).overrideMaterial || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    busy = true;
    // Eye in Source space (root's local frame) -> skybox camera, back to world space.
    camera.matrixWorld.decompose(eye, quat, scl);
    inv.copy(root.matrixWorld).invert();
    eye.applyMatrix4(inv).divideScalar(cam.scale).add(origin).applyMatrix4(root.matrixWorld);
    skyCam.position.copy(eye);
    skyCam.quaternion.copy(quat);
    skyCam.updateMatrixWorld();
    skyCam.projectionMatrix.copy(camera.projectionMatrix);
    skyCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    if (fog) {
      // fogblend: mix by the view direction against fogdir (GetSkyboxFogColor).
      let c = cam.fog.color;
      if (cam.fog.blend) {
        camera.getWorldDirection(fwd).transformDirection(inv);
        const t = 0.5 * fwd.dot(dir) + 0.5;
        c = [0, 1, 2].map((k) => cam.fog.color[k] * t + cam.fog.color2[k] * (1 - t)) as [number, number, number];
      }
      // The mix happens in output space: sRGB on the canvas, linear into render targets.
      const linear = renderer.getRenderTarget() !== null || renderer.outputColorSpace !== THREE.SRGBColorSpace;
      fog.uSkyFogColor.value.set(...(c.map((v) => (linear ? srgbToLinear(v / 255) : v / 255)) as [number, number, number]));
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      onCamera(skyCam);
      renderer.render(sky3dRoot, skyCam);
    } finally {
      renderer.autoClear = autoClear;
      busy = false;
      onCamera(camera);
    }
    renderer.clearDepth();
  };
  return hook;
}

// ---------------------------------------------------------------------------------------------

/**
 * `bsp` (the loaded map file) identifies the map's hosted stock-content manifest (content/index.ts). `content`: the
 * loading screen's download progress, skip and "play without textures" (PrepareContentOptions).
 */
export async function buildWorld(
  core: Core,
  renderer: THREE.WebGLRenderer,
  opts: { bsp?: Uint8Array; content?: Omit<PrepareContentOptions, "bsp" | "mapSha256"> } = {},
): Promise<WorldView> {
  const t0 = performance.now();
  // Resolve stock materials from hosted content before building: pakfile → hosted → fallback.
  const content = await prepareMapContent(core, { ...opts.content, bsp: opts.bsp }).catch((e) => {
    console.warn("game content:", e);
    return { sky: null, extra: [] as string[], propMaterials: [] as string[] };
  });
  const texturePaths = core.texturePaths();
  // Keep original alpha masks for cutouts/translucent materials; generic opaque packs cannot replace them safely.
  const alphaTextures = new Set(core.materials().filter((material) => material.flags & (MAT_ALPHATEST | MAT_TRANSLUCENT)).map((material) => material.texture));
  const overrides = await prepareTextureOverrides(renderer, texturePaths.filter((_, index) => !alphaTextures.has(index)), opts.bsp ? await sha256Hex(opts.bsp) : "");
  const { vertices, indices, stride, groups, materials } = core.mesh();
  const support: TextureSupport = {
    // `?nos3tc` forces the RGBA decode path (for testing the fallback).
    s3tc:
      !appLocation().searchParams.has("nos3tc") &&
      renderer.extensions.has("WEBGL_compressed_texture_s3tc") &&
      renderer.extensions.has("WEBGL_compressed_texture_s3tc_srgb"),
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  };

  const lm = core.lightmap();
  // The core's atlas is style 0 only; add the named / patterned lights' pages (lightstyles.ts). `?nolightstyles` skips
  // that (before / after comparisons).
  const styles = opts.bsp && !appLocation().searchParams.has("nolightstyles") ? applyLightStyles(lm, opts.bsp) : null;
  if (styles?.skipped && styles.styledFaces) console.warn(`light styles not applied: ${styles.skipped}`);
  const lightMap = lightmapTexture(lm);
  // MeshBasicMaterial scales lightmaps by 1/PI; undo that and the atlas encoding scale.
  const lightMapIntensity = Math.PI / lm.scale;

  const imposters = new ImposterSet((path) => core.contentRead(path));
  /** Materials (parallel to `materials`) and the sky. */
  const buildMaterials = () => {
    const descs = core.materials();
    const extras = core.materialExtras();
    // Decode each texture once, with alpha-capable DXT1 if any material using it needs alpha.
    const needAlpha = new Set<number>();
    for (const d of descs) if (d.texture >= 0 && d.flags & (MAT_ALPHATEST | MAT_TRANSLUCENT)) needAlpha.add(d.texture);
    const textures = new Map<string, THREE.Texture | null>();
    const texture = (i: number, colorSpace: string = THREE.SRGBColorSpace): THREE.Texture | null => {
      const key = `${i}:${colorSpace}`;
      if (!textures.has(key)) {
        const replacement = texturePaths[i] ? overrides.get(tryTexturePath(texturePaths[i]!) ?? "") : null;
        if (replacement && !needAlpha.has(i) && colorSpace === THREE.SRGBColorSpace) { textures.set(key, replacement); return replacement; }
        const p = core.texture(i, support.s3tc, needAlpha.has(i));
        if (!p) console.warn("texture decode failed:", core.lastError());
        textures.set(key, p ? textureFromPayload(p, support, colorSpace) : null);
      }
      return textures.get(key)!;
    };
    const sun = mapSunDirection(core.entities());
    const normals = new Map<string, THREE.Texture | null>();
    const embeddedNormal = (name: string): THREE.Texture | null => {
      const path = embeddedNormalPath(name, p => core.contentRead(p));
      if (!path) return null;
      if (!normals.has(path)) {
        if (!normalTextureSupported(core.contentRead(path))) {
          normals.set(path, null);
          return null;
        }
        const payload = core.texturePath(path, support.s3tc, false);
        normals.set(path, payload ? textureFromPayload(payload, support, THREE.NoColorSpace) : null);
      }
      return normals.get(path)!;
    };
    const water = core.materialWater();
    // WindowImposter / Aftershock (imposter.ts): materials the core leaves missing by design. Only those materials (and a
    // sky whose faces are WindowImposters) touch this; `?noimposter` keeps the old fallback (before / after comparisons).
    const imposterOn = !appLocation().searchParams.has("noimposter");
    const imposterKinds = new Map<number, ImposterKind | null>();
    const imposterAt = (i: number): ImposterKind | null => {
      const desc = descs[i];
      if (!imposterOn || desc?.kind !== MaterialKind.Missing || !CLIENT_DRAWN_SHADERS.has(desc.shader)) return null;
      if (!imposterKinds.has(i)) imposterKinds.set(i, imposters.material(materials[i].name, desc.shader));
      return imposterKinds.get(i)!;
    };
    // Maps carry separate downward-facing "beneath" faces ($bottommaterial); without them the top face draws both sides.
    const hasBeneath = descs.some((d, i) => d.kind === MaterialKind.Water && water[i]?.aboveWater === false);
    const hasWater = core.waterVolumes().length > 0;
    const fogged = <M extends THREE.Material>(m: M): M => (hasWater ? withWaterFog(m) : m);
    /** World material `i`; `fog` wraps built-in materials (the water fog, or the 3D skybox's fog). */
    const worldMaterial = (i: number, fog: <M extends THREE.Material>(m: M) => M): THREE.Material => {
      const info = materials[i];
      const desc = descs[i];
      if (desc?.kind === MaterialKind.Water) return waterSurfaceMaterial(desc, water[i], { doubleSided: !hasBeneath && water[i]?.aboveWater !== false });
      if (desc?.kind === MaterialKind.Glass) return glassMaterial(desc);
      if (desc?.kind === MaterialKind.Flat) return fog(flatMaterial(desc, lightMap, lightMapIntensity));
      const imp = imposterAt(i);
      if (imp) return imp.kind === "window" && !imp.params.nofog ? fog(imp.material) : imp.material;
      const map = desc && desc.texture >= 0 ? texture(desc.texture) : null;
      if (!map) return fog(sourceFlags(fallbackMaterial(info, lightMap, lightMapIntensity, support), desc));
      const m = texturedMaterial(desc, map, lightMap, lightMapIntensity);
      const ex = extras[i];
      const map2 = ex && ex.texture2 >= 0 ? texture(ex.texture2) : null;
      const detail = ex && ex.detail >= 0 ? texture(ex.detail, THREE.NoColorSpace) : null;
      addSecondaryMaps(m as THREE.MeshBasicMaterial, map2, detail, ex);
      // Potato swaps in its own flat materials. Water/glass/unlit/blended surfaces keep their dedicated paths.
      if (sun && desc.shader === "lightmappedgeneric" && !(desc.flags & MAT_UNLIT) && !map2 && !appLocation().searchParams.has("nonormals")) {
        const normal = embeddedNormal(info.name);
        if (normal) withWorldNormal(m, normal, sun);
      }
      if (!(desc.flags & MAT_UNLIT)) withMaterialDetail(m as THREE.MeshBasicMaterial, overrides.materials.get(tryTexturePath(texturePaths[desc.texture] ?? "") ?? ""), 0.9, texturePaths[desc.texture] ?? "");
      withShowcaseAlbedo(m as THREE.MeshBasicMaterial, texturePaths[desc.texture] ?? "");
      return fog(m);
    };
    const mats = materials.map((_, i) => worldMaterial(i, fogged));
    // Sky faces follow the mesh materials (see prepareMapContent); need at least the four sides.
    const skyCount = content.sky ? 6 : 0;
    const extraCount = content.extra.length;
    const skyDescs = skyCount === 6 ? descs.slice(materials.length, materials.length + 6) : [];
    const skyFaces = skyDescs.map((d) => (d.texture >= 0 ? texture(d.texture) : null));
    // A sky whose faces are WindowImposter materials is their cube map, seen around the camera.
    const skyCube = imposterOn && skyDescs.length ? imposters.sky(content.extra, skyDescs.map((d) => d.shader)) : null;
    const sky = skyCube ? skyCube.mesh : skyFaces.length && skyFaces.slice(0, 4).every(Boolean) ? skyBox(skyFaces) : skyDome();
    if (hasWater && sky.name === "skybox") for (const m of sky.material as THREE.Material[]) withWaterFog(m, { sky: true });
    // Static prop materials follow the sky faces.
    const propMaterialAt = (k: number, fog: <M extends THREE.Material>(m: M) => M): THREE.Material => {
      const desc = descs[materials.length + extraCount + k];
      const map = desc && desc.texture >= 0 ? texture(desc.texture) : null;
      const m = sourceFlags(propMaterial(desc, map, content.propMaterials[k]), desc);
      if (m instanceof THREE.MeshBasicMaterial && desc && !(desc.flags & MAT_UNLIT)) withMaterialDetail(m, overrides.materials.get(tryTexturePath(texturePaths[desc.texture] ?? "") ?? ""), 0.9, texturePaths[desc.texture] ?? "");
      if (m instanceof THREE.MeshBasicMaterial && desc) withShowcaseAlbedo(m, texturePaths[desc.texture] ?? "");
      return m instanceof THREE.ShaderMaterial ? m : fog(m);
    };
    const propMats = content.propMaterials.map((_, k) => propMaterialAt(k, fogged));
    const missing = descs.slice(0, materials.length).filter((d, i) => d.kind === MaterialKind.Missing && !imposterAt(i)).length;
    return { mats, sky, skyCube, propMats, textures, missing, worldMaterial, propMaterialAt, descs, texture, water, hasBeneath, skyCount, extraCount, skyFaces, imposterAt };
  };

  const built = buildMaterials();

  // Water volumes (fog through water, underwater fog) with the fog of the water material on top of each.
  const waterDescs = core.materials();
  const waterParams = core.materialWater();
  const surfaces: Parameters<typeof waterVolumes>[1] = [];
  for (const g of groups) {
    const desc = waterDescs[g.material];
    if (desc?.kind !== MaterialKind.Water || waterParams[g.material]?.aboveWater === false) continue;
    for (let t = g.firstIndex; t < g.firstIndex + g.indexCount; t += 3) {
      const [a, b, c] = [indices[t] * stride, indices[t + 1] * stride, indices[t + 2] * stride];
      if (vertices[a + 5] < 0.9) continue; // upward-facing only
      surfaces.push({
        x: (vertices[a] + vertices[b] + vertices[c]) / 3,
        y: (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3,
        z: (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3,
        desc,
        params: waterParams[g.material],
      });
    }
  }
  const volumes = waterVolumes(core.waterVolumes(), surfaces, core.waterPlanes());
  const skyHook = built.sky.onBeforeRender;
  built.sky.onBeforeRender = (r, sc, camera, geo, mat, group) => {
    skyHook.call(built.sky, r, sc, camera, geo, mat, group);
    if (imposters.stats.cubes) imposters.update(root);
    updateWaterUniforms(volumes, camera);
  };

  const interleaved = new THREE.InterleavedBuffer(vertices, stride);
  const position = new THREE.InterleavedBufferAttribute(interleaved, 3, 0);
  const normal = new THREE.InterleavedBufferAttribute(interleaved, 3, 3);
  const uv = new THREE.InterleavedBufferAttribute(interleaved, 2, 6);
  const uv1 = new THREE.InterleavedBufferAttribute(interleaved, 2, 8);
  const blendData = core.meshBlend();
  const blend = blendData && blendData.length * stride === vertices.length ? new THREE.BufferAttribute(blendData, 1) : null;
  const index = new THREE.BufferAttribute(indices, 1);

  // Source is Z-up; rotate the whole world so three.js sees Y-up: (x, y, z) -> (x, z, -y).
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld();
  imposters.update(root);

  // 3D skybox: its world faces and brush models in their own meshes under `sky3dRoot` (drawn by `sky3dPass` only).
  // `?sky3d=0` turns the 3D skybox off, `?sky3dfog=0` its fog (for comparisons).
  const params = appLocation().searchParams;
  const sky3d = params.get("sky3d") === "0" ? null : core.skyCamera();
  const sky3dRoot = new THREE.Group();
  sky3dRoot.name = "sky3d";
  const fog: SkyFogUniforms | null =
    sky3d?.fog.enable && sky3d.fog.end > sky3d.fog.start && params.get("sky3dfog") !== "0"
      ? {
          uSkyFogColor: { value: new THREE.Vector3(1, 1, 1) },
          uSkyFogRange: { value: new THREE.Vector3(sky3d.fog.start / sky3d.scale, sky3d.fog.end / sky3d.scale, sky3d.fog.maxDensity) },
        }
      : null;
  // Fogged skybox variants of the materials it uses (water and glass shaders unfogged); else the main materials.
  const skyVariants = (base: THREE.Material[], used: Iterable<number>, make: (i: number) => THREE.Material): THREE.Material[] => {
    if (!fog) {
      const out = base.slice();
      for (const i of used) {
        out[i] = base[i].clone();
        // clone() omits shader hooks; keep secondary maps/fog while isolating the miniature from the flashlight.
        out[i].onBeforeCompile = base[i].onBeforeCompile;
        out[i].customProgramCacheKey = base[i].customProgramCacheKey;
      }
      return out;
    }
    const out = base.slice();
    for (const i of used) out[i] = base[i] instanceof THREE.ShaderMaterial ? base[i] : make(i);
    return out;
  };
  const skyMats = skyVariants(
    built.mats,
    new Set(groups.filter((g) => sky3d && g.sky3d).map((g) => g.material)),
    (i) => built.worldMaterial(i, (m) => withSkyFog(m, fog!)),
  );

  const hiddenModels = hiddenTriggerModels(core.entities());
  const models = new Map<number, THREE.Mesh>();
  const skyWorld = new Map<number, THREE.Mesh>();
  /** The main view's brush model meshes (potato mode swaps their geometry and materials). */
  const worldMeshes: THREE.Mesh[] = [];
  for (const g of groups) {
    if (hiddenModels.has(g.model)) continue;
    const inSky = !!sky3d && !!g.sky3d;
    // Brush models are all in or all out; the world (model 0) has a mesh on each side.
    const table = inSky && g.model === 0 ? skyWorld : models;
    let mesh = table.get(g.model);
    if (!mesh) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", position);
      geo.setAttribute("normal", normal);
      geo.setAttribute("uv", uv);
      geo.setAttribute("uv1", uv1);
      if (blend) geo.setAttribute("blend", blend);
      geo.setIndex(index);
      mesh = new THREE.Mesh(geo, inSky ? skyMats : built.mats);
      // Render-only classification for optional static BVH GI; brush entities must never freeze into it.
      mesh.userData.giDynamic = g.model !== 0;
      mesh.userData.sourceBrushModel = g.model;
      mesh.frustumCulled = false;
      if (inSky) mesh.name = `sky3d-model-${g.model}`;
      table.set(g.model, mesh);
      (inSky ? sky3dRoot : root).add(mesh);
      if (!inSky) worldMeshes.push(mesh);
    }
    mesh.geometry.addGroup(g.firstIndex, g.indexCount, g.material);
  }

  // View-frustum culling (cull.ts): the big meshes per cell of space, the small ones (bhop blocks, doors) by their own
  // bounds. `?nocull` draws everything (before / after comparisons).
  const culler = new CellCuller();
  const cullOn = !params.has("nocull");
  const cullMesh = (mesh: THREE.Mesh) => {
    if (!cullOn) return;
    if (mesh.geometry.groups.reduce((n, g) => n + g.count, 0) / 3 >= CELL_MIN_TRIANGLES) culler.add(mesh);
    else boundObject(mesh);
  };
  for (const mesh of worldMeshes) cullMesh(mesh);

  // Sky faces: brush entity ones ride on their model's mesh (moved by `update`).
  const skyMeshes = skyFaceMeshes(core.skyMesh() ?? { vertices: new Float32Array(0), indices: new Uint32Array(0), groups: [] });
  for (const [model, m] of skyMeshes) {
    if (hiddenModels.has(model)) {
      skyMeshes.delete(model);
      m.geometry.dispose();
      continue;
    }
    const parent = models.get(model);
    if (parent) parent.add(m);
    else {
      models.set(model, m);
      root.add(m);
    }
  }

  // Static props (one mesh, Source space, under the Z-up root).
  let propTris = 0;
  let props: { pm: ReturnType<Core["propsMesh"]>; meshes: THREE.Mesh[] } | null = null;
  if (built.propMats.length) {
    const pm = core.propsMesh();
    if (pm.indices.length) {
      const skyPropMats = sky3d
        ? skyVariants(
            built.propMats,
            new Set(pm.groups.filter((g) => g.sky3d).map((g) => g.material)),
            (k) => built.propMaterialAt(k, (m) => withSkyFog(m, fog!)),
          )
        : null;
      const { mesh, sky, moving } = propsMesh(pm, built.propMats, skyPropMats);
      root.add(mesh);
      if (sky) sky3dRoot.add(sky);
      for (const [entity, m] of moving) {
        models.set(PROP_TRANSFORM_KEY + entity, m);
        root.add(m);
      }
      propTris = pm.indices.length / 3;
      props = { pm, meshes: [mesh, ...moving.values()] };
      for (const m of props.meshes) cullMesh(m);
    }
  }

  // env_spritetrail ribbons on moving brush entities (bhop_2easy's teleport markers), following `update`'s transforms.
  const effectTexture = (name: string) => {
    const index = content.extra.findIndex(n => materialName(n) === materialName(name));
    const desc = index < 0 ? undefined : built.descs[materials.length + index];
    return desc && desc.texture >= 0 ? built.texture(desc.texture) : null;
  };
  const trails = spriteTrails(core.entities(), effectTexture);
  if (trails) root.add(trails.root);
  // env_smokestack puffs (bhop_absolutebhop_v4's sky level: the clouds are the only visible part of its platforms).
  // Kept in potato mode for that reason.
  const smoke = smokeStacks(core.entities(), effectTexture);
  if (smoke) root.add(smoke.root);
  // func_smokevolume clouds (bhop_arcane's mist); map-effects/smoke.ts draws only those here (stacks blanked out so
  // entity indices still match the core's effect states). Hidden in potato mode.
  const smokeVolumes = mapSmoke(core.entities().map((e) => (/^env_smokestack$/i.test(e.classname ?? "") ? {} : e)), brushBounds(opts.bsp), effectTexture);
  if (smokeVolumes) root.add(smokeVolumes.root);

  const flashlight = new Flashlight();
  const fullbright = new Fullbright();
  const container = new THREE.Group();
  container.add(built.sky, root);
  // Maps with HDR lighting get CS:S's HDR look (graphics/source-hdr.ts); this also marks the world root.
  container.userData.lightmapHdr = lm.hdr;
  const localLights = authoredLocalLights(core.entities());
  container.userData.authoredLocalLights = localLights.lights;
  // Light directions are authored in Source Z-up space. Light-environment angles point along the incoming rays.
  const sun = core.entities().find(e => /^(env_sun|light_environment)$/i.test(e.classname ?? ""));
  if (sun) {
    const angles = (sun.angles ?? "0 0 0").trim().split(/\s+/).map(Number);
    const pitch = (sun.pitch === undefined ? (angles[0] ?? 0) : -Number(sun.pitch)) * Math.PI / 180;
    const yaw = (angles[1] ?? 0) * Math.PI / 180;
    const incoming = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch));
    const direction = incoming.negate().applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).normalize();
    const raw = (sun.rendercolor ?? sun._light ?? "255 244 220").trim().split(/\s+/).map(Number);
    const environment=core.entities().find(e=>e.classname?.toLowerCase()==="light_environment");
    const irradiance=sourceLightColor(environment?._lightHDR,environment?._light??sun._light??sun.rendercolor,"255 244 220");
    const ambient=sourceLightColor(environment?._ambientHDR,environment?._ambient,"172 196 204");
    container.userData.authoredSun = { direction, irradianceColor:new THREE.Color().setRGB((irradiance[0]??255)/255,(irradiance[1]??244)/255,(irradiance[2]??220)/255,THREE.SRGBColorSpace), ambientColor:new THREE.Color().setRGB((ambient[0]??172)/255,(ambient[1]??196)/255,(ambient[2]??204)/255,THREE.SRGBColorSpace), color: new THREE.Color().setRGB((raw[0] ?? 255)/255, (raw[1] ?? 244)/255, (raw[2] ?? 220)/255, THREE.SRGBColorSpace) };
  }

  // (A skybox with nothing in it, e.g. only an env_sun, needs no pass.)
  const sky3dState = sky3d && sky3dRoot.children.length ? { camera: sky3d, root: sky3dRoot, enabled: true } : null;
  if (sky3dState) {
    root.add(sky3dRoot);
    sky3dRoot.traverse((o) => o.layers.set(SKY3D_LAYER));
    container.add(sky3dPass(root, sky3dRoot, sky3dState.camera, fog, sky3dState, (c) => updateWaterUniforms(volumes, c)));
  }

  // Potato mode (potato.ts): its geometry and materials are built the first time it's turned on, then swapped in and
  // out live (the normal ones stay as they are).
  let potato: { set(on: boolean): void } | null = null;
  let potatoOn = false;
  const buildPotato = (): { set(on: boolean): void } => {
    const t = performance.now();
    const { descs, water } = built;
    const nVerts = vertices.length / stride;
    /** Linear RGB + alpha of a material: its texture's average colour times `$color`. */
    const flat = (desc: MaterialDesc): [number, number, number, number] => {
      const tex = desc.texture >= 0 ? built.texture(desc.texture) : null;
      const avg = (tex && averageColor(tex)) ?? [0.5, 0.5, 0.5, 1];
      return [avg[0] * desc.color[0], avg[1] * desc.color[1], avg[2] * desc.color[2], avg[3]];
    };
    const worldColor = (i: number): [number, number, number, number] => {
      const desc = descs[i];
      const imp = built.imposterAt(i);
      if (imp?.kind === "window") return [...imp.average, 1];
      if (!desc || desc.kind === MaterialKind.Missing) {
        // The fallback's tint over its grey checker (about half bright).
        const c = new THREE.Color().setHSL(hashHue(baseMaterialName(materials[i].name)), 0.12, 0.62, THREE.SRGBColorSpace).multiplyScalar(0.52);
        return [c.r, c.g, c.b, 1];
      }
      if (desc.kind === MaterialKind.Flat) return [...desc.color, 1];
      return flat(desc);
    };
    const colors = materials.map((_, i) => worldColor(i));
    // Per-vertex colours of the merged draws (vertices belong to one face, so to one material).
    const vc = new Float32Array(nVerts * 3);
    for (const g of groups) {
      const c = colors[g.material];
      for (let k = g.firstIndex; k < g.firstIndex + g.indexCount; k++) {
        const v = indices[k] * 3;
        vc[v] = c[0];
        vc[v + 1] = c[1];
        vc[v + 2] = c[2];
      }
    }
    const worldColors = new THREE.BufferAttribute(vc, 3);
    const translucentFlat = (c: [number, number, number, number], desc: MaterialDesc, lit: boolean) =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(c[0], c[1], c[2]),
        lightMap: lit ? lightMap : null,
        lightMapIntensity,
        transparent: true,
        opacity: desc.alpha * c[3],
        depthWrite: false,
        blending: desc.flags & MAT_ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide,
      });
    const tint = (color: THREE.ColorRepresentation, opacity: number, side: THREE.Side) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    const merged = (lit: boolean, side: THREE.Side) => (): THREE.Material =>
      withGrid(new THREE.MeshBasicMaterial({ vertexColors: true, lightMap: lit ? lightMap : null, lightMapIntensity, side }));
    const worldSlot = (i: number): PotatoSlot => {
      const desc = descs[i];
      const name = baseMaterialName(materials[i].name);
      const imp = built.imposterAt(i);
      // Imposters: their cube map's average colour, unlit (a translucent one as a tint); Aftershock is not drawn.
      if (imp?.kind === "aftershock") return null;
      if (imp?.kind === "window") {
        const c = colors[i];
        return imp.params.alpha < 1 || imp.params.fade
          ? { key: `i${i}`, material: () => tint(new THREE.Color(c[0], c[1], c[2]), imp.params.alpha * 0.5, THREE.FrontSide) }
          : { key: "unlit", material: merged(false, THREE.FrontSide) };
      }
      if (!desc || desc.kind === MaterialKind.Missing) {
        if (/^(effects|decals|overlays|sprites)\//.test(name) || name.includes("{")) return null;
        if (/glass|window/.test(name)) return { key: `g${i}`, material: () => tint(0xbcd6e6, 0.3, THREE.DoubleSide) };
        return { key: "lit", material: merged(true, THREE.FrontSide) };
      }
      if (desc.kind === MaterialKind.Water) {
        const c = new THREE.Color(0x3d6f8c).lerp(new THREE.Color(...desc.color), 0.45);
        const side = !built.hasBeneath && water[i]?.aboveWater !== false ? THREE.DoubleSide : THREE.FrontSide;
        return { key: `w${i}`, material: () => tint(c, 0.6, side) };
      }
      if (desc.kind === MaterialKind.Glass) return { key: `g${i}`, material: () => tint(new THREE.Color(...desc.color), 0.3, THREE.FrontSide) };
      const lit = (desc.flags & MAT_UNLIT) === 0;
      const side = desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide;
      if (desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE)) {
        if (/^(decals|overlays)\//.test(name)) return null;
        return { key: `t${i}`, material: () => translucentFlat(colors[i], desc, lit) };
      }
      const map = desc.kind === MaterialKind.Textured && desc.texture >= 0 ? built.texture(desc.texture) : null;
      // Grates and fences keep their texture: flat, their holes would turn solid.
      if (desc.flags & MAT_ALPHATEST && map) return { key: `a${i}`, material: () => texturedMaterial(desc, map, lightMap, lightMapIntensity) };
      return { key: `${lit ? "lit" : "unlit"}${side === THREE.DoubleSide ? "2" : ""}`, material: merged(lit, side) };
    };
    const cache = new Map<string, THREE.Material>();
    const swaps: { mesh: THREE.Mesh; normal: [THREE.BufferGeometry, THREE.Material | THREE.Material[]]; potato: [THREE.BufferGeometry, THREE.Material[]] }[] = [];
    let before = 0;
    let after = 0;
    for (const mesh of worldMeshes) {
      const p = potatoGeometry(mesh.geometry, worldColors, worldSlot, cache);
      if (mesh.frustumCulled) boundGeometry(p.geometry);
      swaps.push({ mesh, normal: [mesh.geometry, mesh.material], potato: [p.geometry, p.materials] });
      before += mesh.geometry.groups.length;
      after += p.geometry.groups.length;
    }
    // Static props: flat (shading times the material's colour), opaque ones in one draw.
    if (props) {
      const { pm, meshes } = props;
      const base = materials.length + built.extraCount;
      const propColors = content.propMaterials.map((_, k) => (descs[base + k] ? flat(descs[base + k]) : ([0.45, 0.45, 0.45, 1] as [number, number, number, number])));
      const shade = (meshes[0].geometry.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
      const pc = new Float32Array(shade.length);
      for (const g of [...pm.groups, ...pm.dynamicGroups]) {
        const c = propColors[g.material];
        for (let k = g.firstIndex; k < g.firstIndex + g.indexCount; k++) {
          const v = pm.indices[k] * 3;
          pc[v] = shade[v] * c[0];
          pc[v + 1] = shade[v + 1] * c[1];
          pc[v + 2] = shade[v + 2] * c[2];
        }
      }
      const propAttr = new THREE.BufferAttribute(pc, 3);
      const propSlot = (k: number): PotatoSlot => {
        const desc = descs[base + k];
        const name = content.propMaterials[k];
        if (hiddenToolMaterial(name)) return null;
        if (desc?.kind === MaterialKind.Glass) return { key: `pg${k}`, material: () => tint(new THREE.Color(...desc.color), 0.3, THREE.FrontSide) };
        const side = desc && desc.flags & MAT_NOCULL ? THREE.DoubleSide : THREE.FrontSide;
        const map = desc && desc.kind === MaterialKind.Textured && desc.texture >= 0 ? built.texture(desc.texture) : null;
        if (desc && desc.flags & MAT_ALPHATEST && map)
          return {
            key: `pa${k}`,
            material: () => {
              // Textured (foliage): the potato vertex colours carry the average colour too, so divide it back out.
              const m = propMaterial(desc, map, name) as THREE.MeshBasicMaterial;
              const c = propColors[k];
              m.color.multiply(new THREE.Color(1 / Math.max(c[0], 0.02), 1 / Math.max(c[1], 0.02), 1 / Math.max(c[2], 0.02)));
              return m;
            },
          };
        if (desc && desc.flags & (MAT_TRANSLUCENT | MAT_ADDITIVE))
          return {
            key: `pt${k}`,
            material: () =>
              new THREE.MeshBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: desc.alpha * propColors[k][3],
                depthWrite: false,
                blending: desc.flags & MAT_ADDITIVE ? THREE.AdditiveBlending : THREE.NormalBlending,
                side,
              }),
          };
        return { key: `prop${side === THREE.DoubleSide ? "2" : ""}`, material: () => new THREE.MeshBasicMaterial({ vertexColors: true, side }) };
      };
      const propCache = new Map<string, THREE.Material>();
      for (const mesh of meshes) {
        const p = potatoGeometry(mesh.geometry, propAttr, propSlot, propCache);
        if (mesh.frustumCulled) boundGeometry(p.geometry);
        swaps.push({ mesh, normal: [mesh.geometry, mesh.material], potato: [p.geometry, p.materials] });
        before += mesh.geometry.groups.length;
        after += p.geometry.groups.length;
      }
    }
    // Sky: one flat colour, the average of the skybox's sides (or a plain blue).
    const sideAvg = built.skyFaces
      .slice(0, 4)
      .map((tex) => (tex ? averageColor(tex) : null))
      .filter((c): c is [number, number, number, number] => !!c);
    const skyColor = built.skyCube ? new THREE.Color(...built.skyCube.average) : sideAvg.length ? new THREE.Color(...([0, 1, 2].map((k) => sideAvg.reduce((n, c) => n + c[k], 0) / sideAvg.length) as [number, number, number])) : new THREE.Color(0x9dbbd8);
    const skyFlat = new THREE.MeshBasicMaterial({ color: skyColor, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false });
    const skyNormal = built.sky.material;
    const skyPotato = Array.isArray(skyNormal) ? skyNormal.map(() => skyFlat) : skyFlat;
    console.info(`potato: ${before} → ${after} draws, built in ${(performance.now() - t).toFixed(0)} ms`);
    return {
      set(on) {
        for (const s of swaps) [s.mesh.geometry, s.mesh.material] = on ? s.potato : s.normal;
        built.sky.material = on ? skyPotato : skyNormal;
        if (sky3dState) sky3dState.enabled = !on;
        if (trails) trails.root.visible = !on;
        if (smokeVolumes) smokeVolumes.root.visible = !on;
      },
    };
  };

  console.info(
    `world: ${materials.length} materials (${built.missing} missing), ${core.textureCount()} textures` +
      ` (${support.s3tc ? "S3TC" : "RGBA"}), sky ${built.sky.name === "skybox" ? `${content.sky}${built.skyCube ? " (cube map)" : ""}` : "gradient"},` +
      (imposters.stats.cubes
        ? ` imposters: ${[...built.mats].filter((m) => m.name === "window-imposter" || m.name === "aftershock").length} materials, ${imposters.stats.cubes} cube maps` +
          ` (${(imposters.stats.sourceBytes / 1e6).toFixed(1)} MB VTF -> ${(imposters.stats.gpuBytes / 1e6).toFixed(1)} MB GPU, ${imposters.stats.ms.toFixed(0)} ms),`
        : "") +
      ` props ${propTris} tris / ${built.propMats.length} materials,` +
      ` sky faces ${[...skyMeshes.values()].reduce((n, m) => n + m.geometry.groups[0].count / 3, 0)} tris,` +
      (trails ? ` ${trails.count} sprite trails,` : "") +
      (smoke ? ` ${smoke.count} smoke stacks,` : "") +
      (smokeVolumes ? ` ${smokeVolumes.count} smoke volumes,` : "") +
      (sky3dState && sky3d ? ` 3D skybox (scale ${sky3d.scale}${fog ? ", fog" : ""}) ≤${sky3dDraws(sky3dRoot)} draws,` : "") +
      ` lightmap ${lm.width}x${lm.height}${styles?.faces ? ` (+light styles on ${styles.faces} faces)` : ""}, built in ${(performance.now() - t0).toFixed(0)} ms`,
  );

  flashlight.apply(container);
  fullbright.apply(container);
  return {
    root: container,
    texturePacks: overrides.packs,
    skyFaces: [...skyMeshes.values()],
    sky3d: sky3dState,
    update(transforms, visualTime = 0, effectStates) {
      setWaterVisualTime(visualTime);
      localLights.update(transforms, effectStates, visualTime);
      const D = Math.PI / 180;
      for (const [model, t] of transforms) {
        const mesh = models.get(model);
        if (!mesh) continue;
        mesh.position.set(t[0], t[1], t[2]);
        // Source AngleMatrix = Rz(yaw) * Ry(pitch) * Rx(roll) in the Z-up space of `root`.
        mesh.rotation.set(t[5] * D, t[3] * D, t[4] * D, "ZYX");
        // Drawn or not as the core says (`brush_states`: visible and not removed): toggled func_wall_toggle, disabled
        // func_brush, broken or killed entities, point_template copies not (yet / again) in the world. In the main view
        // and the 3D skybox (miku_v2's equalizer). bhop_monster_jam's `bw` wall disappears when its button breaks it
        // and comes back with its template 14 s later.
        if (t.length > 6) { mesh.visible = t[6] !== 0; mesh.userData.giDisabled = t[6] === 0; }
      }
      trails?.update(transforms, visualTime, effectStates);
      if (trails && potatoOn) trails.root.visible = false;
      smoke?.update(transforms, visualTime, effectStates);
      smokeVolumes?.update(visualTime, transforms, effectStates);
    },
    trailHistory() {
      return trails && !potatoOn ? { span: trails.maxLifetime, models: trails.models, entities: trails.entities } : null;
    },
    reconstructTrails(time, sample) {
      if (!trails || potatoOn) return;
      trails.reset();
      const step = trails.maxLifetime / 63;
      const start = Math.max(0, time - trails.maxLifetime);
      for (let t = start; t < time; t += step) {
        const at = sample(t);
        trails.update(at.transforms, t, at.states);
      }
      const at = sample(time);
      trails.update(at.transforms, time, at.states);
    },
    setFlashlight(on) { flashlight.set(on); },
    setFullbright(on) { fullbright.set(on); },
    cull(camera) { culler.cull(camera); },
    setPotato(on) {
      if (on === potatoOn) return;
      potatoOn = on;
      // Potato geometry is built from all of a mesh's triangles, not the last cull's.
      if (!potato) culler.uncull();
      (potato ??= buildPotato()).set(on);
      flashlight.apply(container);
      fullbright.apply(container);
    },
  };
}
