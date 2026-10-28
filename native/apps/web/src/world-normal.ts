import * as THREE from "three";

/** Embedded Source VMT normals only. SSBump stores directional weights, not XYZ normals. */
export function embeddedNormalPath(name: string, read: (path: string) => Uint8Array | null, depth = 0): string | null {
  if (depth > 6) return null;
  const path = name.toLowerCase().replace(/\\/g, "/").replace(/^materials\//, "").replace(/\.vmt$/, "");
  const bytes = read(`materials/${path}.vmt`);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes).replace(/\/\/[^\r\n]*/g, "");
  if (/"?\$ssbump"?\s+"?1\b/i.test(text)) return null;
  // A nonidentity bump transform needs a separate UV transform; keep the existing material until supported.
  if (/"?\$bumptransform"?\s+/i.test(text)) return null;
  const bump = /"?\$bumpmap"?\s+"([^"\r\n]+)"/i.exec(text)?.[1];
  if (bump) return `materials/${bump.toLowerCase().replace(/\\/g, "/").replace(/^materials\//, "").replace(/\.vtf$/, "")}.vtf`;
  const include = /"?include"?\s+"([^"\r\n]+)"/i.exec(text)?.[1];
  return include ? embeddedNormalPath(include, read, depth + 1) : null;
}

/** Standard RGB normal encodings. ATI2N/UV-only packed normals need reconstruction and remain skipped. */
export function normalTextureSupported(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.length < 64 || bytes[0] !== 86 || bytes[1] !== 84 || bytes[2] !== 70 || bytes[3] !== 0) return false;
  const format = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(52, true);
  return [0, 1, 2, 3, 11, 12, 13, 14, 15, 16, 20].includes(format);
}

/** Direction towards the map's own sun, transformed from Source Z-up to the rendered world. */
export function mapSunDirection(entities: readonly Record<string, string>[]): [number, number, number] | null {
  const sun = entities.find(e => e.classname?.toLowerCase() === "light_environment");
  if (!sun) return null;
  const angles = (sun.angles ?? "0 0 0").split(/\s+/).map(Number);
  const pitch = Number(sun.pitch ?? angles[0]) * Math.PI / 180;
  const yaw = Number(angles[1]) * Math.PI / 180;
  if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) return null;
  return [-Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
}

// Conservative directional relief over the existing baked lightmap, not Source's full three-basis bump lighting.
// Neutral normals preserve the existing image; no replacement base texture, scene light or colour tint is added.
export function withWorldNormal<M extends THREE.Material>(material: M, normalMap: THREE.Texture, sun: [number, number, number]): M {
  // Attract/world teardown enumerates material texture properties and deduplicates shared assets.
  (material as M & { embeddedNormalMap: THREE.Texture }).embeddedNormalMap = normalMap;
  const before = material.onBeforeCompile;
  const beforeKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    Object.assign(shader.uniforms, {uEmbeddedNormal:{value:normalMap},uEmbeddedSun:{value:new THREE.Vector3(...sun)}});
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vEmbeddedPosition;\nvarying vec3 vEmbeddedNormal;\nvarying vec2 vEmbeddedUv;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvEmbeddedPosition=(modelMatrix*vec4(transformed,1.0)).xyz;\nvEmbeddedNormal=normalize(mat3(modelMatrix)*normal);\nvEmbeddedUv=uv;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      uniform sampler2D uEmbeddedNormal;
      uniform vec3 uEmbeddedSun;
      varying vec3 vEmbeddedPosition, vEmbeddedNormal;
      varying vec2 vEmbeddedUv;
      vec3 embeddedSurfaceNormal() {
        vec3 n=normalize(vEmbeddedNormal);
        if (!gl_FrontFacing) n=-n;
        vec3 q0=dFdx(vEmbeddedPosition), q1=dFdy(vEmbeddedPosition);
        vec2 st0=dFdx(vEmbeddedUv), st1=dFdy(vEmbeddedUv);
        vec3 q1perp=cross(q1,n), q0perp=cross(n,q0);
        vec3 t=q1perp*st0.x+q0perp*st1.x;
        vec3 b=q1perp*st0.y+q0perp*st1.y;
        float length2=max(dot(t,t),dot(b,b));
        if (length2<1e-12) return n;
        vec3 sampled=texture2D(uEmbeddedNormal,vEmbeddedUv).xyz*2.0-1.0;
        return normalize((t*sampled.x+b*sampled.y)*inversesqrt(length2)+n*sampled.z);
      }
    `).replace("#include <opaque_fragment>", `
      vec3 flatEmbeddedNormal=normalize(vEmbeddedNormal)*(gl_FrontFacing?1.0:-1.0);
      float relief=1.0+0.35*(dot(embeddedSurfaceNormal(),uEmbeddedSun)-dot(flatEmbeddedNormal,uEmbeddedSun));
      outgoingLight*=clamp(relief,0.65,1.35);
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => `${beforeKey.call(material)}+embedded-normal`;
  return material;
}
