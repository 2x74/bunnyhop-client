// Source shaders the core resolves as "missing" (no `$basetexture` by design) that the renderer draws itself:
//
// WindowImposter (SDK 2013 materialsystem/stdshaders/windowimposter_dx90.cpp, windowimposter_vs20.fxc, _ps2x.fxc):
//   colour = texCUBE($envmap, worldPos - eyePos) * modulation ($color, $alpha), alpha-blended, no depth writes, fogged
//   unless $nofog. The cube map is looked up with the eye-to-surface direction, so the surface is a window onto an
//   infinitely distant scene (a fake sky / space backdrop). There is no parallax origin: the SDK shader declares only
//   $envmap. Skies whose faces are WindowImposter materials (bhop_angst's stormydaysprx_cubemap) draw the same cube map
//   around the camera.
//   bhop_angst's player_fade_nebula drives $alpha with a PlayerProximity proxy chain ($distmin..$distmax): drawn here as
//   the same fade from the camera to the brush entity's origin.
//
// Aftershock (aftershock_helper.cpp, aftershock_ps2x.fxc): a refraction of the frame buffer behind the surface, tinted
//   by $colortint towards the middle of the object and brightened at the silhouette by $silhouettecolor, with alpha =
//   the facing mask. Approximated without the frame-buffer copy: the same mask, tint and silhouette terms multiply what
//   is already drawn behind the surface (blend dst * 2 * src), without the refraction offset and blur.
//
// Cube maps come from vtf-cube.ts (HDR float16 / integer / RGBS decoded to sRGB RGBA8, one mip at most `maxSize`).

import * as THREE from "three";
import { decodeVtfCube, type CubeFaces } from "./vtf-cube";
import { CLIENT_DRAWN_SHADERS, loadVmt, vmtColor, vmtFlag, vmtFloat, vmtPath, vtfPath, type Vmt } from "./vmt";

/** Largest cube face uploaded (a 1024² source uses its 512² mip). */
export const IMPOSTER_MAX_FACE = 512;

export interface ImposterParams {
  envmap: string;
  color: [number, number, number];
  alpha: number;
  nofog: boolean;
  /** PlayerProximity-driven alpha: 0 at `min` units from the entity's origin, 1 at `max` and beyond. */
  fade: { min: number; max: number } | null;
}

export interface AftershockParams {
  tint: [number, number, number];
  silhouetteColor: [number, number, number];
  silhouetteThickness: number;
  groundMin: number;
  groundMax: number;
}

export function windowImposterParams(vmt: Vmt): ImposterParams | null {
  if (vmt.shader !== "windowimposter") return null;
  const envmap = vmt.params.$envmap?.trim();
  // `env_cubemap` (the nearest env_cubemap) has no texture of its own here.
  if (!envmap || envmap.toLowerCase() === "env_cubemap") return null;
  const proximity = vmt.proxies.some((p) => p.name === "playerproximity");
  const toAlpha = vmt.proxies.some((p) => (p.params.resultvar ?? "").toLowerCase() === "$alpha");
  const min = vmtFloat(vmt, "$distmin");
  const max = vmtFloat(vmt, "$distmax");
  return {
    envmap: vtfPath(envmap),
    color: vmtColor(vmt, "$color") ?? [1, 1, 1],
    alpha: Math.min(1, Math.max(0, vmtFloat(vmt, "$alpha") ?? 1)),
    nofog: vmtFlag(vmt, "$nofog"),
    fade: proximity && toAlpha && min !== undefined && max !== undefined && max > min ? { min, max } : null,
  };
}

export function aftershockParams(vmt: Vmt): AftershockParams | null {
  if (vmt.shader !== "aftershock") return null;
  // Defaults: aftershock_helper.h.
  return {
    tint: vmtColor(vmt, "$colortint") ?? [1, 1, 1],
    silhouetteColor: vmtColor(vmt, "$silhouettecolor") ?? [0.3, 0.3, 0.5],
    silhouetteThickness: vmtFloat(vmt, "$silhouettethickness") ?? 0.2,
    groundMin: vmtFloat(vmt, "$groundmin") ?? -0.3,
    groundMax: vmtFloat(vmt, "$groundmax") ?? -0.1,
  };
}

/** A cube map texture from decoded faces (sRGB RGBA8, mipmapped). Sample it with Source-space directions. */
export function cubeTexture(c: CubeFaces): THREE.CubeTexture {
  const images = c.faces.map((data) => {
    const t = new THREE.DataTexture(data, c.size, c.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    return t;
  });
  const tex = new THREE.CubeTexture(images as unknown as HTMLImageElement[]);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** GPU bytes of a cube texture made by `cubeTexture` (6 RGBA8 faces + a full mip chain). */
export function cubeBytes(size: number): number {
  return Math.round(size * size * 4 * 6 * (4 / 3));
}

/**
 * Three world space -> Source space (the world root's inverse rotation), shared by every imposter material and
 * refreshed each frame (`ImposterSet.update`).
 */
export type ToSourceUniform = { value: THREE.Matrix3 };

const IMPOSTER_VERT = /* glsl */ `
  #include <common>
  varying vec3 vImpWorld;
  #ifdef IMP_FADE
  varying float vImpOrigin;
  uniform vec2 uImpFade;
  #endif
  void main() {
    vec3 transformed = position;
    #include <project_vertex>
    vImpWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    #ifdef IMP_FADE
    // PlayerProximity: distance from the viewer to the brush entity's origin (the model's origin).
    vImpOrigin = clamp((distance((modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, cameraPosition) - uImpFade.x) / (uImpFade.y - uImpFade.x), 0.0, 1.0);
    #endif
  }`;

const IMPOSTER_FRAG = /* glsl */ `
  #include <common>
  uniform samplerCube uImpEnv;
  uniform mat3 uImpToSource;
  uniform vec4 uImpColor;
  varying vec3 vImpWorld;
  #ifdef IMP_FADE
  varying float vImpOrigin;
  #endif
  void main() {
    vec3 dir = uImpToSource * (vImpWorld - cameraPosition);
    gl_FragColor = vec4(textureCube(uImpEnv, dir).rgb * uImpColor.rgb, uImpColor.a);
    #ifdef IMP_FADE
    gl_FragColor.a *= vImpOrigin;
    #endif
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/** A WindowImposter surface (world brushes). Opaque unless $alpha < 1 or alpha is proxy-driven. */
export function windowImposterMaterial(p: ImposterParams, env: THREE.CubeTexture, toSource: ToSourceUniform): THREE.ShaderMaterial {
  const translucent = p.alpha < 1 || !!p.fade;
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uImpEnv: { value: env },
      uImpToSource: toSource,
      uImpColor: { value: new THREE.Vector4(...p.color, p.alpha) },
      ...(p.fade ? { uImpFade: { value: new THREE.Vector2(p.fade.min, p.fade.max) } } : {}),
    },
    defines: p.fade ? { IMP_FADE: "" } : {},
    vertexShader: IMPOSTER_VERT,
    fragmentShader: IMPOSTER_FRAG,
    transparent: translucent,
    depthWrite: !translucent,
    fog: false,
  });
  m.name = "window-imposter";
  m.userData.ownedTextures = [env];
  return m;
}

/** A sky drawn from a cube map (sky faces that are WindowImposter materials): a camera-centred box, like `skyBox`. */
export function cubemapSky(env: THREE.CubeTexture, toSource: ToSourceUniform): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { uImpEnv: { value: env }, uImpToSource: toSource, uImpColor: { value: new THREE.Vector4(1, 1, 1, 1) } },
    vertexShader: IMPOSTER_VERT,
    fragmentShader: IMPOSTER_FRAG,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: false,
  });
  material.name = "cubemap-sky";
  material.userData.ownedTextures = [env];
  const box = new THREE.Mesh(new THREE.BoxGeometry(2000, 2000, 2000), [material]);
  box.geometry.clearGroups();
  box.geometry.addGroup(0, Infinity, 0);
  box.name = "skybox";
  box.frustumCulled = false;
  box.renderOrder = -1000;
  box.onBeforeRender = (_r, _s, camera) => {
    box.position.copy(camera.position);
    box.updateMatrixWorld();
  };
  return box;
}

/** Aftershock approximation (see the top of this file). Transparent pass, no depth writes. */
export function aftershockMaterial(p: AftershockParams, toSource: ToSourceUniform): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uImpToSource: toSource,
      uTint: { value: new THREE.Vector3(...p.tint) },
      uSil: { value: new THREE.Vector4(...p.silhouetteColor, p.silhouetteThickness) },
      uGround: { value: new THREE.Vector2(p.groundMin, p.groundMax) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      varying vec3 vAsWorld;
      varying vec3 vAsNormal;
      void main() {
        vec3 transformed = position;
        #include <project_vertex>
        vAsWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vAsNormal = normalize(mat3(modelMatrix) * normal);
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform mat3 uImpToSource;
      uniform vec3 uTint;
      uniform vec4 uSil;
      uniform vec2 uGround;
      varying vec3 vAsWorld;
      varying vec3 vAsNormal;
      void main() {
        vec3 n = normalize(vAsNormal);
        vec3 v = normalize(vAsWorld - cameraPosition);
        float mask = clamp(dot(-v, n) * (2.0 - uSil.w), 0.0, 1.0);
        // HLSL smoothstep(groundMin, groundMax, normal.z), which also runs "backwards" (min > max).
        float t = clamp(((uImpToSource * n).z - uGround.x) / (uGround.y - uGround.x), 0.0, 1.0);
        mask *= t * t * (3.0 - 2.0 * t);
        mask *= mask;
        float sil = clamp(mask * (1.0 - mask) * 4.0, 0.0, 1.0);
        sil = sil * sil * sil;
        // Source: rgb = refraction * mix(tint, 1, 1 - mask) * (1 + sil * silColor), alpha = mask, blended over the scene.
        vec3 factor = vec3(1.0 - mask) + mask * mix(vec3(1.0), uTint, mask) * (1.0 + sil * uSil.rgb);
        gl_FragColor = vec4(factor, 1.0);
        #include <colorspace_fragment>
        gl_FragColor.rgb = min(gl_FragColor.rgb * 0.5, vec3(1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    fog: false,
  });
  m.name = "aftershock";
  return m;
}

/** What `ImposterSet` built for one material. */
export type ImposterKind =
  | { kind: "window"; material: THREE.ShaderMaterial; average: [number, number, number]; params: ImposterParams }
  | { kind: "aftershock"; material: THREE.ShaderMaterial };

/**
 * The imposter materials of one world: VMTs read through `read` (the core's VFS), cube maps decoded once per path.
 * Only materials whose shader is WindowImposter or Aftershock ever reach here, so other maps pay nothing.
 */
export class ImposterSet {
  readonly toSource: ToSourceUniform = { value: new THREE.Matrix3() };
  private cubes = new Map<string, { texture: THREE.CubeTexture; faces: CubeFaces } | null>();
  /** Decoded cube maps and their GPU bytes (for the load log and tests). */
  readonly stats = { cubes: 0, gpuBytes: 0, sourceBytes: 0, ms: 0 };

  constructor(
    private read: (path: string) => Uint8Array | null,
    private maxFace = IMPOSTER_MAX_FACE,
  ) {}

  /** Keeps `uImpToSource` = inverse(world root rotation). Call before rendering (cheap). */
  update(root: THREE.Object3D): void {
    this.toSource.value.setFromMatrix4(root.matrixWorld).invert();
  }

  private vmt(name: string): Vmt | null {
    return loadVmt(vmtPath(name), this.read);
  }

  cube(path: string): { texture: THREE.CubeTexture; faces: CubeFaces } | null {
    if (this.cubes.has(path)) return this.cubes.get(path)!;
    const t = performance.now();
    const bytes = this.read(path);
    let entry: { texture: THREE.CubeTexture; faces: CubeFaces } | null = null;
    if (bytes) {
      const faces = decodeVtfCube(bytes, { maxSize: this.maxFace, hdr: /\.hdr\.vtf$/.test(path) });
      if (faces) {
        entry = { texture: cubeTexture(faces), faces };
        this.stats.cubes++;
        this.stats.gpuBytes += cubeBytes(faces.size);
        this.stats.sourceBytes += bytes.length;
      } else console.warn(`imposter: ${path}: not a supported cube map`);
    } else console.warn(`imposter: ${path} not found`);
    this.stats.ms += performance.now() - t;
    this.cubes.set(path, entry);
    return entry;
  }

  /** The material for world material `name` with resolved shader `shader`, or null (keep the old fallback). */
  material(name: string, shader: string): ImposterKind | null {
    if (!CLIENT_DRAWN_SHADERS.has(shader)) return null;
    const vmt = this.vmt(name);
    if (!vmt) return null;
    const as = aftershockParams(vmt);
    if (as) return { kind: "aftershock", material: aftershockMaterial(as, this.toSource) };
    const p = windowImposterParams(vmt);
    const cube = p && this.cube(p.envmap);
    if (!p || !cube) return null;
    const avg = cube.faces.average;
    return {
      kind: "window",
      material: windowImposterMaterial(p, cube.texture, this.toSource),
      average: [avg[0] * p.color[0], avg[1] * p.color[1], avg[2] * p.color[2]],
      params: p,
    };
  }

  /**
   * The sky as a cube map when the sky face materials (`skybox/<name>{rt,lf,bk,ft,up,dn}`) are WindowImposters: the
   * envmap of the first side face. Null otherwise.
   */
  sky(faceNames: string[], shaders: string[]): { mesh: THREE.Mesh; average: [number, number, number] } | null {
    if (faceNames.length < 4 || !shaders.slice(0, 4).every((s) => s === "windowimposter")) return null;
    const vmt = this.vmt(faceNames[0]);
    const p = vmt && windowImposterParams(vmt);
    const cube = p && this.cube(p.envmap);
    if (!cube) return null;
    return { mesh: cubemapSky(cube.texture, this.toSource), average: cube.faces.average };
  }

  dispose(): void {
    for (const c of this.cubes.values()) c?.texture.dispose();
    this.cubes.clear();
  }
}
