import * as THREE from "three";
import { SHADOW_FILTER_GLSL } from "./shadow-filter";
import { CLOUD_SHADOW_GLSL } from "./clouds";
import type { ResolvedSun } from "./lighting-state";
import { ShadowCasters, ShadowTransmission } from "./shadow-casters";
export type ShadowQuality = "low" | "medium" | "high";
export interface ShadowOptions { quality?: ShadowQuality; distance?: number; strength?: number; bias?: number; directStrength?: number; skyFill?: number; bakedScale?: number; cloudUniforms?: Record<string,THREE.IUniform> }
export interface ShadowSampling { texture: THREE.Texture | null; matrix: THREE.Matrix4; direction: THREE.Vector3; texelSize: THREE.Vector2; strength: number; bias: number; active: boolean; packed: true; transmission?: { colors: THREE.Texture[]; depths: THREE.Texture[]; layers: number } }
export function castsSunShadow(material: THREE.Material): boolean { return !material.alphaHash && !(material as THREE.ShaderMaterial).defines?.DITHER; }
let programId = 0;
const SIZES = { low: 512, medium: 1024, high: 2048 };
/** World-space depth shadows supplement Source's baked illumination; no screen-space occluder approximation. */
export class SunShadows {
  private readonly programId = ++programId;
  private target: THREE.WebGLRenderTarget | null = null;
  private depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, blending: THREE.NoBlending });
  private opaque = new ShadowCasters();
  private transmission = new ShadowTransmission();
  private failed = false;
  private disposed = false;
  private lightCamera = new THREE.OrthographicCamera();
  private patched = new Map<THREE.MeshBasicMaterial, { previous: THREE.Material["onBeforeCompile"]; key: () => string; hook: THREE.Material["onBeforeCompile"] }>();
  private uniforms = { uSunLightingActive: { value: 0 }, uSunSkyFill: { value: 0 }, uSunAmbientColor: { value: new THREE.Color() }, uSunDirectStrength: { value: 0 }, uSunBakedScale: { value: 1 }, uSunDirectDirection: { value: new THREE.Vector3() }, uSunDirectColor: { value: new THREE.Color() }, uSunTransmission0: { value: this.transmission.targets[0].texture }, uSunTransmission1: { value: this.transmission.targets[1].texture },  uSunShadowMap: { value: null as THREE.Texture | null }, uSunShadowMatrix: { value: new THREE.Matrix4() }, uSunShadowTexel: { value: new THREE.Vector2() }, uSunShadowStrength: { value: 0 }, uSunShadowRadius: { value: 2 }, uSunShadowBias: { value: .0003 } };
  private cloudUniforms: Record<string,THREE.IUniform> = { uCloudActive:{value:0},uCloudCoverage:{value:0},uCloudDensity:{value:0},uCloudBase:{value:8192},uCloudThickness:{value:1800},uCloudScale:{value:2400},uCloudSeed:{value:1},uCloudWindOffset:{value:new THREE.Vector2()} };
  private sampling: ShadowSampling = { texture: null, matrix: this.uniforms.uSunShadowMatrix.value, direction: new THREE.Vector3(), texelSize: this.uniforms.uSunShadowTexel.value, strength: 0, bias: .0003, active: false, packed: true };
  readonly supported: boolean;
  constructor(private renderer: THREE.WebGLRenderer) { this.supported = renderer.capabilities.maxTextureSize >= 512; }
  private stats = { draws: 0, triangles: 0, size: 0, distance: 0, allocations: 0 };
  getStats() { return { ...this.stats, directStrength:this.sampling.active?this.uniforms.uSunDirectStrength.value:0,skyFill:this.uniforms.uSunLightingActive.value?this.uniforms.uSunSkyFill.value:0,filter:"continuous-tent",filterTaps:this.uniforms.uSunShadowRadius.value===1?4:16,filterWorldRadius:this.stats.size?this.stats.distance*2/this.stats.size*this.uniforms.uSunShadowRadius.value:0 }; }
  getSampling(): ShadowSampling { return this.sampling; }
  private patch(scene: THREE.Scene): void {
    scene.traverse(object => {
      if (object.userData.sunShadowOnly || !(object instanceof THREE.Mesh) || object.renderOrder < -900 || object.geometry.getAttribute("center") || !object.layers.test(new THREE.Layers())) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshBasicMaterial) || material.transparent || !castsSunShadow(material) || !material.colorWrite || !material.depthWrite || material.userData.sourceUnlit || this.patched.has(material)) continue;
        const previous = material.onBeforeCompile, key = material.customProgramCacheKey;
        const hook: THREE.Material["onBeforeCompile"] = (shader, renderer) => {
          previous.call(material, shader, renderer); Object.assign(shader.uniforms, this.uniforms,this.cloudUniforms);
          shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform mat4 uSunShadowMatrix;varying vec4 vSunShadow;varying vec3 vSunWorld;").replace("#include <project_vertex>", `#include <project_vertex>
            vec4 sunShadowWorld=vec4(transformed,1.);
            #ifdef USE_BATCHING
            sunShadowWorld=batchingMatrix*sunShadowWorld;
            #endif
            #ifdef USE_INSTANCING
            sunShadowWorld=instanceMatrix*sunShadowWorld;
            #endif
            vSunWorld=(modelMatrix*sunShadowWorld).xyz;vSunShadow=uSunShadowMatrix*vec4(vSunWorld,1.);`);
          shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
            #include <packing>
            ${CLOUD_SHADOW_GLSL}
            ${SHADOW_FILTER_GLSL}
            uniform sampler2D uSunTransmission0,uSunTransmission1;uniform sampler2D uSunShadowMap;uniform vec2 uSunShadowTexel;uniform float uSunLightingActive,uSunShadowStrength,uSunShadowBias,uSunShadowRadius,uSunDirectStrength,uSunBakedScale,uSunSkyFill;uniform vec3 uSunDirectDirection,uSunDirectColor,uSunAmbientColor;varying vec4 vSunShadow;varying vec3 vSunWorld;
            vec3 sunShadowVisibility(vec3 p){vec3 visible=vec3(0.0);float bias=uSunShadowBias;vec2 gradient=stableShadowDepthGradient(p);float weight=0.;
              for(int y=-1;y<=2;y++){for(int x=-1;x<=2;x++){vec3 tap=stableShadowTap(p.xy,uSunShadowTexel,ivec2(x,y),uSunShadowRadius);if(tap.z<=0.)continue;vec2 uv=clamp(tap.xy,uSunShadowTexel*.5,vec2(1.)-uSunShadowTexel*.5);float receiver=p.z+dot(gradient,uv-p.xy)-bias;float z=unpackRGBAToDepth(texture2D(uSunShadowMap,uv));vec3 transmit=vec3(1.0);
                vec4 layer0=texture2D(uSunTransmission0,uv),layer1=texture2D(uSunTransmission1,uv);
                if(receiver>layer0.a)transmit*=layer0.rgb;
                if(receiver>layer1.a)transmit*=layer1.rgb;
                visible+=step(receiver,z)*transmit*tap.z;weight+=tap.z;}}return visible/max(weight,.00001);}

          `).replace("#include <opaque_fragment>", `
            if(uSunLightingActive>.5&&uSunDirectStrength<=0.){outgoingLight*=uSunBakedScale;outgoingLight+=diffuseColor.rgb*uSunAmbientColor*uSunSkyFill*cloudAmbientFactor();}
            if(uSunShadowStrength>0.||uSunDirectStrength>0.){vec3 p=vSunShadow.xyz/vSunShadow.w;float border=min(min(p.x,1.-p.x),min(p.y,1.-p.y));
              if(border>0.&&p.z>0.&&p.z<1.){float fade=smoothstep(0.,.06,border);vec3 lit=sunShadowVisibility(p)*cloudSunTransmission(vSunWorld,uSunDirectDirection);${material.userData.materialDetail?"if(uSunDirectStrength>0.)outgoingLight=max(vec3(0.),outgoingLight-materialBakedSpecular*fade);":""}float bakedLuma=dot(outgoingLight,vec3(.2126,.7152,.0722));
                outgoingLight*=mix(1.,uSunBakedScale,fade)*(1.-(1.-lit)*uSunShadowStrength*fade*smoothstep(.005,.08,bakedLuma));
                outgoingLight+=diffuseColor.rgb*uSunAmbientColor*uSunSkyFill*cloudAmbientFactor()*fade;
                ${material.userData.materialDetail?"outgoingLight+=(diffuseColor.rgb*materialSunDiffuse+materialSunSpecular)*uSunDirectColor*lit*uSunDirectStrength*fade;":"vec3 n=normalize(cross(dFdx(vSunWorld),dFdy(vSunWorld)));outgoingLight+=diffuseColor.rgb*uSunDirectColor*max(0.,dot(n,uSunDirectDirection))*lit*uSunDirectStrength*fade;"}}}
            #include <opaque_fragment>`);
        };
        this.patched.set(material, { previous, key, hook }); material.onBeforeCompile = hook; material.customProgramCacheKey = () => `${key.call(material)}+sun-shadow-v1-${this.programId}`; material.needsUpdate = true;
      }
    });
  }
  update(scene: THREE.Scene, camera: THREE.Camera, options: ShadowOptions = {}, sunOverride?: ResolvedSun | null, ambientOverride?: THREE.Color): void {
    this.uniforms.uSunLightingActive.value = 0; this.uniforms.uSunSkyFill.value = 0; this.uniforms.uSunShadowStrength.value = 0; this.uniforms.uSunDirectStrength.value = 0; this.sampling.active = false;
    if (this.disposed) return;
    let sun: { direction: THREE.Vector3; color?: THREE.Color; irradianceColor?: THREE.Color; ambientColor?: THREE.Color } | undefined; scene.traverse(object => { sun ??= object.userData.authoredSun; });
    if(sunOverride!==undefined)sun=sunOverride??undefined;
    if(options.cloudUniforms){for(const [key,uniform]of Object.entries(this.cloudUniforms))if(options.cloudUniforms[key])uniform.value=options.cloudUniforms[key].value;}else this.cloudUniforms.uCloudActive.value=0;
    if (!sun) {
      if(ambientOverride&&(options.skyFill??0)>0){this.uniforms.uSunBakedScale.value=THREE.MathUtils.clamp(options.bakedScale??1,.4,1);this.uniforms.uSunAmbientColor.value.copy(ambientOverride);this.uniforms.uSunSkyFill.value=THREE.MathUtils.clamp(options.skyFill??0,0,.3);this.uniforms.uSunLightingActive.value=1;this.patch(scene);}
      return;
    }
    if(!this.supported||!sun.direction.lengthSq())return;
    this.uniforms.uSunLightingActive.value=1;
    this.uniforms.uSunDirectStrength.value=THREE.MathUtils.clamp(options.directStrength??0,0,2);this.uniforms.uSunBakedScale.value=THREE.MathUtils.clamp(options.bakedScale??1,.4,1);this.uniforms.uSunDirectDirection.value.copy(sun.direction).normalize();this.uniforms.uSunDirectColor.value.copy(sun.irradianceColor??sun.color??new THREE.Color(1,1,1));this.uniforms.uSunAmbientColor.value.copy(ambientOverride??sun.ambientColor??new THREE.Color(.4,.5,.6));this.uniforms.uSunSkyFill.value=THREE.MathUtils.clamp(options.skyFill??0,0,.3);
    this.patch(scene);
    this.uniforms.uSunShadowRadius.value=options.quality==="low"?1:2;
    const size = Math.min(SIZES[options.quality ?? "medium"] ?? 1024, this.renderer.capabilities.maxTextureSize);
    const range = THREE.MathUtils.clamp(options.distance ?? 1024, 256, 4096);
    this.stats.distance = range;
    const strength = THREE.MathUtils.clamp(options.strength ?? .18, 0, .4);
    if (!this.target || this.target.width !== size) { this.target?.dispose(); this.stats.allocations++; this.stats.size = size; this.target = new THREE.WebGLRenderTarget(size, size, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true }); }
    const direction = sun.direction.clone().normalize(), center = camera.getWorldPosition(new THREE.Vector3());
    const light = this.lightCamera; light.up.set(0, 1, 0); if (Math.abs(direction.y) > .98) light.up.set(0, 0, 1);
    light.position.copy(center).addScaledVector(direction, range * 2); light.lookAt(center); light.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(light.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(light.matrixWorld, 1), texel = range * 2 / size;
    for (const axis of [right, up, direction]) { const value = center.dot(axis); center.addScaledVector(axis, Math.round(value / texel) * texel - value); }
    light.left = light.bottom = -range; light.right = light.top = range; light.near = 1; light.far = range * 4;
    light.position.copy(center).addScaledVector(direction, range * 2); light.lookAt(center); light.updateProjectionMatrix(); light.updateMatrixWorld();
    this.uniforms.uSunShadowMatrix.value.set(.5,0,0,.5, 0,.5,0,.5, 0,0,.5,.5, 0,0,0,1).multiply(light.projectionMatrix).multiply(light.matrixWorldInverse);
    this.uniforms.uSunShadowTexel.value.set(1/size, 1/size); this.uniforms.uSunShadowBias.value = THREE.MathUtils.clamp(options.bias ?? .0003, .00001, .003);
    const renderer = this.renderer, target = renderer.getRenderTarget(), viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha(), autoClear = renderer.autoClear, xr = renderer.xr.enabled, background = scene.background;
    const proxies: THREE.Object3D[] = [];
    const infoAutoReset = renderer.info.autoReset, calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
    renderer.info.autoReset = false;
    try {
      scene.traverse(object => { if (object.userData.sunShadowOnly && object.userData.sunShadowEnabled && !object.visible) { proxies.push(object); object.visible = true; } });
      scene.background = null; renderer.xr.enabled = false; renderer.autoClear = true; renderer.setRenderTarget(this.target); renderer.setScissorTest(false); renderer.setClearColor(0xffffff, 1);
      this.opaque.run(scene, () => renderer.render(scene, light));
      this.transmission.render(renderer, scene, light, Math.min(512, size));
      this.stats.draws = renderer.info.render.calls - calls; this.stats.triangles = renderer.info.render.triangles - triangles;
      this.uniforms.uSunShadowMap.value = this.target.texture; this.uniforms.uSunShadowStrength.value = strength;this.uniforms.uSunDirectStrength.value=THREE.MathUtils.clamp(options.directStrength??0,0,2);
      Object.assign(this.sampling, { transmission: { colors: this.transmission.targets.map(t => t.texture), depths: this.transmission.targets.map(t => t.depthTexture!), layers: 2 }, texture: this.target.texture, direction, strength, bias: this.uniforms.uSunShadowBias.value, active: true });
    } catch (error) { this.uniforms.uSunLightingActive.value=0;this.uniforms.uSunSkyFill.value=0;this.uniforms.uSunDirectStrength.value = 0; this.uniforms.uSunShadowMap.value = null; if (!this.failed) console.warn("Sun shadows unavailable; using baked lighting", error); this.failed = true; } finally { renderer.info.autoReset = infoAutoReset; for (const proxy of proxies) proxy.visible = false; scene.background = background; renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.setClearColor(clear, alpha); renderer.autoClear = autoClear; renderer.xr.enabled = xr; }
  }
  dispose(): void {
    this.disposed = true;
    this.uniforms.uSunShadowStrength.value = 0; this.uniforms.uSunShadowMap.value = null; this.sampling.active = false; this.sampling.texture = null;
    for (const [material, patch] of this.patched) if (material.onBeforeCompile === patch.hook) { material.onBeforeCompile = patch.previous; material.customProgramCacheKey = patch.key; material.dispose(); material.needsUpdate = true; }
    this.patched.clear(); this.target?.dispose(); this.target = null; this.opaque.dispose(); this.transmission.dispose(); this.depth.dispose();
  }
}
