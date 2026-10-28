import * as THREE from "three";

export interface MaterialChannels {
  normal?: THREE.Texture;
  roughness?: THREE.Texture;
  normalStrength?: number;
  normalConvention?: "opengl" | "directx";
  roughnessFactor?: number;
}
export interface SurfaceResponse { kind: "generic" | "concrete" | "grass" | "bark" | "foliage"; roughness: number; relief: number; thinSheet: boolean }
/** Conservative dielectric defaults; names identify broad material classes, never unique artwork. */
export function surfaceResponse(path: string, cutout = false, fallbackRoughness = 0.9): SurfaceResponse {
  if (cutout && /(?:leaves|leaf|foliage)[_/]/i.test(path)) return { kind: "foliage", roughness: .72, relief: 0, thinSheet: true };
  if (/(?:^|[/_])grass(?:[/_]|\.)/i.test(path)) return { kind: "grass", roughness: .96, relief: /grass_nubs/i.test(path) ? .35 : 0, thinSheet: false };
  if (/(?:^|[/_])bark(?:[/_]|\.)/i.test(path)) return { kind: "bark", roughness: .92, relief: /bark_06/i.test(path) ? 1.8 : 0, thinSheet: false };
  if (/concrete/i.test(path)) return { kind: "concrete", roughness: .84, relief: /concrete_nubs/i.test(path) ? 1.35 : 0, thinSheet: false };
  return { kind: "generic", roughness: fallbackRoughness, relief: 0, thinSheet: false };
}
/** CPU reference for filtered-normal variance broadening (same fourth-power alpha convention as GGX). */
export function filteredSurfaceRoughness(roughness: number, normalLength: number, derivativeVariance = 0): number {
  const variance = Math.max(0, 1 - Math.min(1, normalLength)) / Math.max(.25, normalLength);
  return Math.min(1, Math.pow(Math.pow(Math.max(.18, Math.min(1, roughness)), 4) + Math.min(.35, variance + Math.max(0, derivativeVariance)), .25));
}
const shared = {
  uMaterialEnabled: { value: 0 },
  uMaterialShowcase: { value: 0 },
  uMaterialSunDirection: { value: new THREE.Vector3(0, 1, 0) },
  uMaterialSunColor: { value: new THREE.Color(1, 1, 1) },
};
/** Hybrid baked-light response uses authored sun only; maps without one retain their baked look. */
export function setMaterialDetail(enabled: boolean, sun?: { direction: THREE.Vector3; color: THREE.Color }): void {
  const valid = !!sun && Number.isFinite(sun.direction.lengthSq()) && sun.direction.lengthSq() > 1e-8;
  shared.uMaterialEnabled.value = enabled && valid ? 1 : 0;
  if (valid && sun) {
    shared.uMaterialSunDirection.value.copy(sun.direction).normalize();
    shared.uMaterialSunColor.value.copy(sun.color);
  }
}

/** Explicit map-profile relief; preserves authored albedo and never enables outside opt-in rendering. */
export function setMaterialShowcase(enabled: boolean): void { shared.uMaterialShowcase.value = enabled ? 1 : 0; }
/** Read-only capture contract; optional GI must match current material/UV response without beauty feedback. */
export function materialDetailState(): { enabled: boolean; showcase: boolean } { return { enabled: shared.uMaterialEnabled.value > .5, showcase: shared.uMaterialShowcase.value > .5 }; }

/** Preserve the diffuse/lightmap shader and masks; add dielectric GGX + normal relief before output/fog. */
export function withMaterialDetail<M extends THREE.MeshBasicMaterial>(material: M, channels: MaterialChannels = {}, roughness = 0.9, sourceTexturePath = ""): M {
  if (material.userData.materialDetail || material.transparent || !material.map || !material.depthTest) return material;
  material.userData.materialDetail = true;
  // Artistic micro-height approximation only for identified generic surfaces, never signs/foliage/sky.
  const surface = surfaceResponse(sourceTexturePath, material.alphaTest > 0, roughness);
  const relief = surface.relief > 0;
  const image = material.map.image as { width?: number; height?: number };
  const reliefStrength = surface.relief;
  material.userData.surfaceResponse = { ...surface, normal: channels.normal ? "authored-pack" : relief ? "inferred-albedo" : "geometry", roughness: channels.roughness ? "authored-pack" : surface.roughness };
  material.userData.materialChannels = { normalStrength: channels.normalStrength ?? .65, normalConvention: channels.normalConvention ?? "opengl", roughnessFactor: channels.roughnessFactor ?? 1, roughnessDefault: surface.roughness };
  material.userData.materialReliefSource = relief ? "authored-albedo-height-approximation" : null;
  // Enumerable texture properties participate in the existing world disposal traversal.
  Object.assign(material, { surfaceNormalMap: channels.normal ?? null, surfaceRoughnessMap: channels.roughness ?? null });
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, shared, {
      uMaterialRelief: { value: relief ? reliefStrength : 0 },
      uMaterialThinSheet: { value: surface.thinSheet ? 1 : 0 },
      uMaterialTexel: { value: new THREE.Vector2(1 / Math.max(1, image?.width ?? 256), 1 / Math.max(1, image?.height ?? 256)) },
      uMaterialNormalMap: { value: channels.normal ?? null }, uMaterialRoughnessMap: { value: channels.roughness ?? null },
      uMaterialHasNormal: { value: channels.normal ? 1 : 0 }, uMaterialHasRoughness: { value: channels.roughness ? 1 : 0 },
      uMaterialNormalStrength: { value: channels.normalStrength ?? 0.65 },
      uMaterialNormalY: { value: channels.normalConvention === "directx" ? -1 : 1 },
      uMaterialRoughnessFactor: { value: channels.roughnessFactor ?? 1 }, uMaterialRoughness: { value: surface.roughness },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMaterialWorld;\nvarying vec3 vMaterialNormal;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 materialPosition = vec4(transformed, 1.0);
        vec3 materialObjectNormal = normal;
        #ifdef USE_BATCHING
          materialPosition = batchingMatrix * materialPosition;
          mat3 materialBatch = mat3(batchingMatrix);
          materialObjectNormal = transpose(inverse(materialBatch)) * materialObjectNormal;
        #endif
        #ifdef USE_INSTANCING
          materialPosition = instanceMatrix * materialPosition;
          mat3 materialInstance = mat3(instanceMatrix);
          materialObjectNormal = transpose(inverse(materialInstance)) * materialObjectNormal;
        #endif
        vMaterialWorld = (modelMatrix * materialPosition).xyz;
        #if defined(USE_ENVMAP) || defined(USE_SKINNING)
          vMaterialNormal = inverseTransformDirection(normalize(transformedNormal), viewMatrix);
        #else
          #ifdef FLIP_SIDED
            materialObjectNormal = -materialObjectNormal;
          #endif
          vMaterialNormal = inverseTransformDirection(normalize(normalMatrix * materialObjectNormal), viewMatrix);
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vMaterialWorld, vMaterialNormal;
        uniform float uMaterialEnabled, uMaterialShowcase, uMaterialRelief, uMaterialHasNormal, uMaterialHasRoughness, uMaterialThinSheet;
        uniform vec2 uMaterialTexel;
        uniform float uMaterialNormalY, uMaterialNormalStrength, uMaterialRoughnessFactor, uMaterialRoughness;
        uniform vec3 uMaterialSunDirection, uMaterialSunColor;
        uniform sampler2D uMaterialNormalMap, uMaterialRoughnessMap;
        // Cotangent frame from world derivatives follows mirrored UVs and transformed geometry.
        // Degenerate UVs return the unperturbed surface normal.
        vec3 materialNormalFromSample(vec3 n, vec2 uv, vec3 sampled) {
          vec3 dx = dFdx(vMaterialWorld), dy = dFdy(vMaterialWorld);
          vec2 du = dFdx(uv), dv = dFdy(uv);
          vec3 dyPerp = cross(dy, n), dxPerp = cross(n, dx);
          vec3 tangent = dyPerp * du.x + dxPerp * dv.x;
          vec3 bitangent = dyPerp * du.y + dxPerp * dv.y;
          float scale = max(dot(tangent, tangent), dot(bitangent, bitangent));
          if (scale < 1e-12) return n;

          sampled = dot(sampled, sampled) > 1e-8 ? normalize(sampled) : vec3(0.0, 0.0, 1.0);
          return normalize(mat3(tangent * inversesqrt(scale), bitangent * inversesqrt(scale), n) * sampled);
        }
        // GGX distribution, correlated Smith visibility and Schlick Fresnel for a dielectric surface.
        float materialSpecular(vec3 n, vec3 l, vec3 v, float roughness) {
          float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 0.001);
          vec3 halfVector = l + v;
          if (nl <= 0.0 || dot(halfVector, halfVector) < 1e-8) return 0.0;
          vec3 h = normalize(halfVector);
          float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
          float alpha = roughness * roughness, a2 = alpha * alpha;
          float denominator = nh * nh * (a2 - 1.0) + 1.0;
          float distribution = a2 / max(3.14159265 * denominator * denominator, 1e-6);
          float visibility = 0.5 / max(nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2), 1e-5);
          float fresnel = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
          return min(distribution * visibility * fresnel * nl, 0.12);
        }`)
      .replace("#include <opaque_fragment>", `
        vec3 materialLightingNormal = normalize(vMaterialNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 materialSunDiffuse = vec3(max(dot(materialLightingNormal, uMaterialSunDirection), 0.0));
        vec3 materialSunSpecular = vec3(0.0);
        vec3 materialBakedSpecular = vec3(0.0);
        if (uMaterialEnabled > 0.5) {
          vec3 baseNormal = normalize(vMaterialNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          vec3 responseNormal = baseNormal;
          float normalVariance = 0.0;
          #ifdef USE_MAP
            if (uMaterialHasNormal > 0.5) {
              vec3 normalSample = texture2D(uMaterialNormalMap, vMapUv).xyz * 2.0 - 1.0;
              // Mip filtering averages different unit normals; their shorter length measures lost detail.
              float filteredLength = clamp(length(normalSample), .25, 1.0);
              normalVariance = (1.0 - filteredLength) / filteredLength * uMaterialNormalStrength * uMaterialNormalStrength;
              normalSample.xy *= uMaterialNormalStrength;
              normalSample.y *= uMaterialNormalY;
              responseNormal = materialNormalFromSample(baseNormal, vMapUv, normalSample);
            } else if (uMaterialShowcase > 0.5 && uMaterialRelief > 0.0) {
              vec3 lumaWeights = vec3(0.2126, 0.7152, 0.0722);
              float hx = dot(texture2D(map, vMapUv + vec2(uMaterialTexel.x, 0.)).rgb - texture2D(map, vMapUv - vec2(uMaterialTexel.x, 0.)).rgb, lumaWeights);
              float hy = dot(texture2D(map, vMapUv + vec2(0., uMaterialTexel.y)).rgb - texture2D(map, vMapUv - vec2(0., uMaterialTexel.y)).rgb, lumaWeights);
              // Fade detail beyond its texel footprint; minified height is not coherent geometry.
              float footprint = max(length(dFdx(vMapUv) / uMaterialTexel), length(dFdy(vMapUv) / uMaterialTexel));
              float reliefFade = 1.0 - smoothstep(1.0, 4.0, footprint);
              responseNormal = materialNormalFromSample(baseNormal, vMapUv, vec3(-hx * uMaterialRelief * reliefFade, -hy * uMaterialRelief * reliefFade, 1.0));
            }
          #endif
          materialLightingNormal = responseNormal;
          vec3 viewDirection = normalize(cameraPosition - vMaterialWorld);
          float surfaceRoughness = uMaterialRoughness;
          #ifdef USE_MAP
            if (uMaterialHasRoughness > 0.5) surfaceRoughness = texture2D(uMaterialRoughnessMap, vMapUv).r;
          #endif
          surfaceRoughness = clamp(surfaceRoughness * uMaterialRoughnessFactor, 0.18, 1.0);
          #ifdef USE_MAP
            if (uMaterialShowcase > 0.5 && uMaterialRelief > 0.0 && uMaterialHasRoughness < 0.5) {
              float reliefLuma = dot(texture2D(map, vMapUv).rgb, vec3(0.2126, 0.7152, 0.0722));
              surfaceRoughness = clamp(uMaterialRoughness + (0.5 - reliefLuma) * 0.06, 0.78, 1.0);
            }
          #endif
          // Specular anti-aliasing broadens highlights where normals vary below a pixel footprint.
          vec3 normalDx = dFdx(responseNormal), normalDy = dFdy(responseNormal);
          float geometricVariance = .25 * (dot(normalDx, normalDx) + dot(normalDy, normalDy));
          surfaceRoughness = min(1.0, pow(pow(surfaceRoughness, 4.0) + min(.35, normalVariance + geometricVariance), .25));
          // Perturb the directional part only, keeping the flat-normal baked result unchanged.
          float normalDelta = max(dot(responseNormal, uMaterialSunDirection), 0.0) - max(dot(baseNormal, uMaterialSunDirection), 0.0);
          outgoingLight *= clamp(1.0 + normalDelta * 0.55, 0.72, 1.28);
          // Baked illumination gates highlights so unlit indoor surfaces do not receive a new sun.
          float bakedEnergy = clamp(dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722)), 0.0, 0.8);
          float specular = materialSpecular(responseNormal, uMaterialSunDirection, viewDirection, surfaceRoughness);
          // Shadow receiver consumes these angular BRDF factors with actual irradiance and visibility.
          materialSunSpecular = vec3(specular);
          float facingSun = dot(responseNormal, uMaterialSunDirection);
          float directDiffuse = max(facingSun, 0.0);
          if (uMaterialThinSheet > .5) {
            // Leaves are thin dielectric sheets: restrained back-side diffusion, no alpha/mask changes.
            float backlight = max(-facingSun, 0.0) * .24;
            directDiffuse = max((facingSun + .12) / 1.12, 0.0) + backlight;
            materialSunSpecular *= .65;
          }
          materialSunDiffuse = vec3(directDiffuse * .96);
          materialBakedSpecular = uMaterialSunColor * specular * bakedEnergy * 0.75;
          outgoingLight += materialBakedSpecular;
        }
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${key.call(material)}+material-detail-v3`;
  material.needsUpdate = true;
  return material;
}

/** Explicit showcase color art direction, retaining texture masks/detail and the foliage's pink identity. */
export function withShowcaseAlbedo<M extends THREE.MeshBasicMaterial>(material: M, sourceTexturePath: string): M {
  const kind = /default_tree_02\/leaves_0[45]_1024_pu\.vtf$/i.test(sourceTexturePath) ? 1 : /grass_nubs\.vtf$/i.test(sourceTexturePath) ? 2 : 0;
  if (!kind || material.userData.showcaseAlbedo) return material;
  material.userData.showcaseAlbedo = kind;
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uAmbienceAlbedoShowcase = shared.uMaterialShowcase;
    shader.uniforms.uAmbienceAlbedoKind = {value:kind};
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAmbienceAlbedoShowcase,uAmbienceAlbedoKind;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if(uAmbienceAlbedoShowcase>.5){
          if(uAmbienceAlbedoKind<1.5){
            float foliageLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
            diffuseColor.rgb=mix(diffuseColor.rgb,vec3(foliageLuma),.38)*vec3(1.,.98,.88);
          }else{diffuseColor.rgb*=vec3(.72,.92,1.14);}
        }`);
  };
  material.customProgramCacheKey=()=>`${key.call(material)}+ambience-albedo-v1`;
  material.needsUpdate=true;
  return material;
}
