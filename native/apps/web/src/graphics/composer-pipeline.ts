import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { presetConfig, type GraphicsOptions } from "./presets";
import { resolveVisualProfile } from "./profiles";
import { projectSun } from "./sun";
import { particleRandom } from "../map-effects/smoke";
import { OpaqueDepthScene } from "./depth-scene";
import { setMaterialDetail, setMaterialShowcase } from "../material-detail";
import { VolumetricScatteringPass } from "./volumetric-scattering";
import { TemporalAccumulationPass, createSpatialAAPass } from "./cinematic-sampling";
import { LocalLights, LOCAL_LIGHT_DECLARATIONS } from "./local-lights";
import { DynamicGI } from "./dynamic-gi";
import { SkyBackground } from "./sky-background";
import { SkyPackRuntime } from "../sky-packs/runtime";
import { alignedSkyYaw, authoredSun, effectiveLightingSource, resolveLighting, type LightingState } from "./lighting-state";
import { CloudRenderer } from "./clouds";
import { SunShadows } from "./shadows";
import { publishHybridStatus } from "./hybrid-status";
import type { HybridGI } from "./hybrid-gi/index";
import { WaterCapture } from "../water-capture";
import { hdrWorld } from "./source-hdr";
import { SourceHdrPass } from "./source-hdr-pass";


/**
 * The Enhanced / Cinematic composer and everything it drives. Loaded on demand by pipeline.ts (GraphicsPipeline),
 * which draws the Source and Plain looks itself, so players on those never download this. Owns transient GPU
 * resources; no simulation state or wall-clock effects.
 */
export class ComposerPipeline {
  private options: GraphicsOptions = { preset: "classic", potato: false };
  private composer: EffectComposer | null = null;
  private scenePass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private contact: SSAOPass | null = null;
  private bokeh: BokehPass | null = null;
  private output: OutputPass | null = null;
  private shafts: ShaderPass | null = null;
  private opaqueDepth = new OpaqueDepthScene();
  private scattering: VolumetricScatteringPass | null = null;
  private accumulation: TemporalAccumulationPass | null = null;
  private aa: ShaderPass | null = null;
  private sampleCount = 0;
  private sampleIndex = 0;
  private accumulating = false;
  beginCinematicFrame(count: number): void { this.sampleCount = count; this.sampleIndex = 0; this.accumulating = false; }
  beginCinematicSample(index: number): void { this.sampleIndex = index; }
  endCinematicFrame(): void { if (this.accumulating) this.accumulation!.endFrame(); this.resetCinematicSampling(); }
  resetCinematicSampling(): void { this.accumulation?.reset(); this.sampleCount = 0; this.accumulating = false; }
  getEffectiveEffects() { return { clouds:!!this.clouds?.getSampling().active, customSky:this.skyMode==='pack'&&!!this.skyRuntime?.getState().asset, ambienceShowcase: this.supported && presetConfig(this.options).postprocessing && this.getProfile().id === "ambience-showcase-v1", contactShading: !!this.contact && !!this.options.contactShading, atmosphere: !!this.grade && !!this.options.atmosphere, sunShafts: !!this.shafts, depthOfField: !!this.bokeh, bloom: !!this.bloom && this.bloom.strength > 0, localLights: !!this.local?.getStats().selected, dynamicGI: !!this.gi?.getStats().active, tracedGI:!!this.hybrid?.getStats().active, dynamicShadows: !!this.shadows?.getSampling().active, volumetric: !!this.scattering?.enabled, spatialAA: !!this.aa, materialResponse: this.materialEnabled }; }
  private materialEnabled = false;
  private local: LocalLights | null = null;
  private gi: DynamicGI | null = null;
  private hybrid:HybridGI|null=null;private hybridPromise:Promise<void>|null=null;private hybridScene:THREE.Scene|null=null;private hybridGeneration=0;private hybridModuleLoaded=false;private hybridPhase="off";private hybridError:string|null=null;
  private lastScene:THREE.Scene|null=null;private lastCamera:THREE.Camera|null=null;
  getTracedGIStats(){return this.hybrid?.getStats()??{loaded:this.hybridModuleLoaded,status:this.options.tracedGI?this.hybridPhase:"off",error:this.hybridError,active:false,mode:"authored-lighting-delta",historyLimit:8};}
  private stopHybrid(){++this.hybridGeneration;this.hybrid?.dispose();this.hybrid=null;this.hybridPromise=null;this.hybridScene=null;this.hybridPhase="off";this.hybridError=null;}
  private attachHybridDepth(){if(!this.composer)return;for(const target of [this.composer.renderTarget1,this.composer.renderTarget2])if(!target.depthTexture){target.depthTexture=new THREE.DepthTexture(target.width,target.height,THREE.UnsignedIntType);target.dispose();}}
  private ensureHybrid(scene:THREE.Scene):Promise<void>{if(!this.options.tracedGI||!presetConfig(this.options).postprocessing||!this.supported)return Promise.resolve();if(this.hybridScene===scene)return this.hybridPromise??Promise.resolve();if(this.renderer.capabilities.maxTextures<12||this.renderer.capabilities.maxTextureSize<2048){this.hybridScene=scene;this.hybridPhase="unsupported";this.hybridError="Requires12 texture units and2048 texture dimensions.";return Promise.resolve();}this.stopHybrid();this.hybridScene=scene;this.hybridPhase="loading";const generation=this.hybridGeneration;
    this.hybridPromise=import("./hybrid-gi/index").then(async module=>{this.hybridModuleLoaded=true;if(generation!==this.hybridGeneration||!this.options.tracedGI)return;if(this.renderer.capabilities.maxTextures<12){this.hybridPhase="unsupported";this.hybridError="At least12 fragment texture units are required.";return}const manager=new module.HybridGI(this.renderer);this.hybrid=manager;manager.setSize(this.width,this.height);if(this.composer){this.composer.passes.splice(1,0,manager.getPass());manager.getPass().setSize(this.width,this.height)}this.hybridPhase="building";await manager.prepare(scene,this.mapName+"|"+this.mapHash);if(generation===this.hybridGeneration){this.hybridPhase="ready";this.attachHybridDepth()}
    }).catch(error=>{if(generation!==this.hybridGeneration)return;this.hybridError=error instanceof Error?error.message:String(error);this.hybridPhase="failed";const pass=this.hybrid?.getPass();if(pass&&this.composer)this.composer.removePass(pass);this.hybrid?.dispose();this.hybrid=null;}).finally(()=>{if(generation===this.hybridGeneration)this.hybridPromise=null;});return this.hybridPromise;
  }
  async whenTracedGISettled():Promise<void>{await this.hybridPromise;}
  private updateHybridStatus(){const s=this.getTracedGIStats(),status=s.status;const reason=!this.options.tracedGI?"Off; no tracing resources allocated.":!presetConfig(this.options).postprocessing?"Requires Enhanced or Cinematic; inactive in Classic/Potato.":!this.supported?"Floating-point render targets unavailable; using original lighting.":s.error??(status==="active"?"Active · world-space lighting changes, one ray/pixel.":status==="zero-delta"?"No eligible lighting change; original baked lighting retained.":status==="building"||status==="loading"?"Loading and building the bounded map BVH…":status==="ready"?"Ready; waiting for an eligible frame.":status);
    publishHybridStatus({status,reason,loaded:s.loaded});}

  getLocalLightStats() { return this.local?.getStats() ?? null; }
  getLocalLightUniforms() { return this.local?.getUniforms() ?? null; }
  getGIStats() { return this.gi?.getStats() ?? null; }
  private shadows: SunShadows | null = null;
  getShadowStats() { return this.shadows?.getStats() ?? null; }
  getShadowSampling() { return this.shadows?.getSampling() ?? null; }
  private water: WaterCapture | null = null;
  private scene: THREE.Scene | null = null;
  private mapName = "";
  private mapHash = "";
  setMap(name: string, hash = ""): void { if(name!==this.mapName||hash!==this.mapHash){this.resetEffects();this.boundsScene=null;this.lighting=null;}this.mapName = name; this.mapHash = hash; this.setOptions(this.options); }
  getProfile() { return resolveVisualProfile(this.mapName,this.mapHash,this.options,!!this.lighting?.sun); }
  private lighting: LightingState | null=null;
  private skyRuntime: SkyPackRuntime | null=null;
  private skyBackground=new SkyBackground();
  private clouds: CloudRenderer | null=null;
  private skyStatus="";
  private skyMode: "map"|"procedural"|"pack"="map";
  private skyYaw=0;private skyExposure=1;
  private exportLocked=false;private queuedOptions:GraphicsOptions|null=null;
  private boundsScene:THREE.Scene|null=null;private worldTop=0;
  getSkyState(){const state=this.skyRuntime?.getState();const active=this.skyMode==='pack'&&!!state?.asset&&state.asset.id===this.options.skyPackId;return{mode:this.skyMode,loading:!!state?.loading,error:state?.error??null,asset:active?state!.asset:null,rotation:this.skyYaw,exposure:this.skyExposure,lightingSource:this.lighting?.source??'map',lightingClamped:!!this.lighting?.radianceLimited};}
  getSkyMetadata(){const s=this.getSkyState();return{mode:s.mode,id:s.asset?.id??null,version:s.asset?.version??null,hash:s.asset?.sha256??null,precision:s.asset?.precision??null,rotation:s.mode==='pack'?s.rotation:0,exposure:s.mode==='pack'?s.exposure:1,lightingSource:s.lightingSource,lightingClamped:s.lightingClamped,error:s.error};}
  getCloudMetadata(){const s=this.getCloudStats();return{active:!!s?.active,quality:s?.active?this.options.cloudQuality??'low':'off',coverage:s?.active?this.options.cloudCoverage??.45:0,density:s?.active?this.options.cloudDensity??1:0,seed:1,baseHeight:s?.active?Math.max(16384,this.worldTop+2048):0,steps:s?.active?s.steps:0};}
  getCloudStats(){return this.clouds?.getStats()??null;}
  private selectSky(){if(this.options.skyMode==='pack'&&this.options.skyPackId)(this.skyRuntime??=new SkyPackRuntime(this.renderer)).select(this.options.skyPackId);else this.skyRuntime?.select(null);}
  async prepareForExport():Promise<void>{this.exportLocked=true;this.queuedOptions=null;if(presetConfig(this.options).postprocessing&&this.supported)this.selectSky();if(this.skyRuntime){do{await this.skyRuntime.whenSettled();}while(this.skyRuntime.getState().loading);this.skyRuntime.pin();}if(this.options.tracedGI&&this.lastScene)await this.ensureHybrid(this.lastScene);this.hybrid?.resetHistory();}
  finishExport(options:GraphicsOptions):void{this.exportLocked=false;this.skyRuntime?.unpin();const next=this.queuedOptions??options;this.queuedOptions=null;this.setOptions(next);this.hybrid?.resetHistory();}
  resetEffects():void{this.skyBackground.dispose();this.clouds?.dispose();this.clouds=null;this.resetCinematicSampling();this.releaseEffects();setMaterialDetail(false);setMaterialShowcase(false);this.materialEnabled=false;}
  private width = 1;
  private height = 1;
  /** Half-float targets need renderable floating point color; otherwise preserve the direct path. */
  readonly supported: boolean;
  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.supported = renderer.extensions.has("EXT_color_buffer_float");
  }
  getOptions(): GraphicsOptions { return { ...this.options }; }
  setOptions(options: GraphicsOptions): void {
    if(this.exportLocked){this.queuedOptions={...options};return;}
    if (this.options.contactShading !== options.contactShading || this.options.atmosphere !== options.atmosphere || this.options.sunShafts !== options.sunShafts || this.options.depthOfField !== options.depthOfField || this.options.volumetric !== options.volumetric || this.options.spatialAA !== options.spatialAA || this.options.temporalSamples !== options.temporalSamples || this.options.dynamicShadows !== options.dynamicShadows || this.options.localLights !== options.localLights || this.options.dynamicGI !== options.dynamicGI || this.options.tracedGI !== options.tracedGI || this.options.clouds !== options.clouds) this.releaseEffects();
    this.options = { ...options };
    if (!options.dynamicShadows && !(this.getProfile().skyFill??0)) { this.shadows?.dispose(); this.shadows = null; }
    const config = presetConfig(options);
    if (!config.postprocessing || !this.supported) this.releaseEffects();
    this.applyAppearance();if(!options.tracedGI)this.updateHybridStatus();
  }
  private applyAppearance():void{const options=this.options,config=presetConfig(options);
    // On maps with HDR lighting CS:S's own bloom (source-hdr-pass.ts) replaces this glow: one bloom at a time.
    if (this.bloom) {
      this.bloom.strength = options.bloom === false || (this.lastScene && hdrWorld(this.lastScene)) ? 0 : config.bloom * this.getProfile().bloomScale;
      this.bloom.enabled = this.bloom.strength > 0;
    }
    if (this.grade) {
      this.grade.uniforms.saturation!.value = this.getProfile().saturation ?? config.saturation;
      this.grade.uniforms.contrast!.value = this.getProfile().contrast ?? config.contrast;
      this.grade.uniforms.highlightShoulder!.value = this.getProfile().highlightShoulder ?? 0;
      this.grade.uniforms.exposure!.value = this.getProfile().exposure ?? 1;
      this.grade.uniforms.haze!.value = options.atmosphere ? this.getProfile().haze ?? .08 : 0;
      this.grade.uniforms.hazeDistance!.value = this.getProfile().hazeDistance;
    }
  }
  setSize(width: number, height: number): void {
    this.width = width; this.height = height;this.hybrid?.setSize(width,height);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
    if (this.aa) this.aa.uniforms.resolution.value.set(1/(width*this.renderer.getPixelRatio()),1/(height*this.renderer.getPixelRatio()));
  }
  render(scene: THREE.Scene, camera: THREE.Camera, timeSeconds = 0): void {
    this.lastScene=scene;this.lastCamera=camera;
    const config=presetConfig(this.options),enabled=config.postprocessing&&this.supported;
    if(enabled)this.selectSky();else if(!this.exportLocked)this.skyRuntime?.select(null);
    const state=this.skyRuntime?.getState();const asset=this.options.skyMode==='pack'&&state?.asset&&state.asset.id===this.options.skyPackId?state.asset:null;
    this.skyMode=enabled?(asset?'pack':this.options.skyMode==='procedural'||(this.options.ambienceShowcase&&this.getProfile().id==='ambience-showcase-v1'&&this.options.skyMode!=='pack')?'procedural':'map'):'map';
    const userYaw = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.options.skyRotation ?? 0, -180, 180));
    const lightingSource = enabled ? effectiveLightingSource(this.options.lightingSource, this.getProfile().id, !!asset) : "map";
    // Lit by the map's sun under a sky pack: turn the sky so its sun sits where the map's shadows put it.
    const mapSun = lightingSource === "map" && asset?.lighting?.sun ? authoredSun(scene) : undefined;
    this.skyYaw = (mapSun ? alignedSkyYaw(mapSun.direction, asset!.lighting!.sun!.direction) : asset?.rotation ?? 0) + userYaw;
    this.skyExposure=(asset?.exposure??1)*2**THREE.MathUtils.clamp(this.options.skyExposure??0,-4,4);
    const status={pipeline:this,mode:this.skyMode,loading:!!state?.loading,error:state?.error??null,id:asset?.id??null,precision:asset?.precision??null};const statusKey=JSON.stringify({...status,pipeline:undefined});if(statusKey!==this.skyStatus){this.skyStatus=statusKey;if(typeof document!=="undefined")document.dispatchEvent(new CustomEvent("bunnyhop:sky-status",{detail:status}));}
    const previousSun=!!this.lighting?.sun;
    this.lighting = resolveLighting(scene, lightingSource, enabled ? asset?.lighting : undefined, this.skyYaw, this.skyExposure);
    if(this.composer&&previousSun!==!!this.lighting.sun)this.releaseEffects();
    this.applyAppearance();
    if(scene!==this.boundsScene){scene.updateMatrixWorld(true);const bounds=new THREE.Box3();scene.traverse(o=>{if(o instanceof THREE.Mesh&&o.renderOrder>=-900&&!o.geometry.getAttribute('center')){o.geometry.computeBoundingBox();if(o.geometry.boundingBox)bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));}});this.worldTop=Number.isFinite(bounds.max.y)?bounds.max.y:0;this.boundsScene=scene;}
    const cloudOn=enabled&&!!this.options.clouds&&camera instanceof THREE.PerspectiveCamera;
    let cloudKey='';
    const prepare=(view:THREE.Camera)=>{
      if(!(view instanceof THREE.PerspectiveCamera)||!cloudOn)return;
      view.updateMatrixWorld();const viewport=this.renderer.getCurrentViewport(new THREE.Vector4());
      const key=view.uuid+view.matrixWorld.elements.join(',')+view.projectionMatrix.elements.join(',')+viewport.z+':'+viewport.w;
      if(key===cloudKey)return;cloudKey=key;
      const cloud=this.clouds??=new CloudRenderer(this.renderer);cloud.setSize(Math.max(1,viewport.z),Math.max(1,viewport.w));
      cloud.update(view,{direction:this.lighting!.sun?.direction??new THREE.Vector3(0,1,0),color:this.lighting!.sun?.irradianceColor??this.lighting!.sun?.color??new THREE.Color(0,0,0),ambient:this.lighting!.ambient??new THREE.Color(.18,.2,.22)},timeSeconds,{enabled:true,quality:this.options.cloudQuality,coverage:this.options.cloudCoverage,density:this.options.cloudDensity,baseHeight:Math.max(16384,this.worldTop+2048),seed:1});
    };
    if(cloudOn){(this.clouds??=new CloudRenderer(this.renderer)).resetFrameStats();prepare(camera);}else{this.clouds?.dispose();this.clouds=null;}
    this.skyBackground.run(scene,asset,{mode:this.skyMode,yaw:this.skyYaw,exposure:this.skyExposure,sun:this.lighting.sun,clouds:cloudOn&&this.clouds?{uniforms:this.clouds.getUniforms(),prepare}:undefined},()=>this.renderFrame(scene,camera,timeSeconds));
  }
  private renderFrame(scene: THREE.Scene, camera: THREE.Camera, _timeSeconds = 0): void {
    const config = presetConfig(this.options);
    let sun=this.lighting?.sun;
    if(this.getProfile().sunDirect && sun?.irradianceColor) sun={...sun,color:sun.irradianceColor};
    this.materialEnabled = config.postprocessing && this.supported && this.options.materialResponse !== false && !!sun;
    setMaterialDetail(this.materialEnabled, sun);
    setMaterialShowcase(config.postprocessing && this.supported && this.getProfile().id === "ambience-showcase-v1");
    if (!config.postprocessing || !this.supported) {
      if (this.options.tracedGI) this.updateHybridStatus();
      this.renderer.render(scene, camera);
      return;
    }
    if (scene !== this.scene) {
      this.releaseEffects(); this.water = new WaterCapture(scene); this.scene = scene;
    }
    if (this.options.dynamicShadows || (this.lighting?.ambient && (this.getProfile().skyFill??0)>0)) (this.shadows ??= new SunShadows(this.renderer)).update(scene, camera, { cloudUniforms:this.clouds?.getUniforms(), quality: this.options.shadowQuality, distance: this.options.shadowDistance, strength: this.options.shadowStrength, directStrength: this.options.dynamicShadows?(this.getProfile().sunDirect??0)*THREE.MathUtils.clamp(this.options.directContribution??1,0,2):0, skyFill: (this.getProfile().skyFill??0)*THREE.MathUtils.clamp(this.options.ambientContribution??1,0,2), bakedScale: this.options.dynamicShadows?this.getProfile().bakedScale:1 },this.options.dynamicShadows?sun??null:null,this.lighting?.ambient);
    if (this.options.localLights) (this.local ??= new LocalLights(this.renderer)).update(scene,camera,{quality:this.options.localQuality,budget:this.options.localBudget,strength:this.options.localStrength});
    this.water!.render(this.renderer, camera, config);
    if(this.options.tracedGI&&camera instanceof THREE.PerspectiveCamera){void this.ensureHybrid(scene);this.hybrid?.update(scene,camera,_timeSeconds,sun,{strength:this.options.giStrength??.25,range:this.options.giRange??256,resetToken:[this.mapName,this.mapHash,this.getProfile().id,this.getSkyMetadata().hash,this.skyYaw,this.skyExposure,this.options.materialResponse,this.options.directContribution,this.options.localLights,this.options.localStrength,this.width,this.height].join("|"),history:!this.exportLocked&&!this.sampleCount,localEnabled:!!this.options.localLights,localStrength:this.options.localStrength??.2,directFactor:1+(this.getProfile().sunDirect??0)*THREE.MathUtils.clamp(this.options.directContribution??1,0,2)});this.updateHybridStatus();}
    if (this.options.dynamicGI&&!this.options.tracedGI) (this.gi ??= new DynamicGI(this.renderer)).update(scene,camera,{quality:this.options.giQuality,range:this.options.giRange,strength:this.options.giStrength},{localDeclarations:this.local ? LOCAL_LIGHT_DECLARATIONS : undefined,localUniforms:this.local?.getUniforms(),sunSampling:this.shadows?.getSampling(),sunColor:sun?.color,cloudUniforms:this.clouds?.getUniforms()});
    if (!this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.scenePass = new RenderPass(scene, camera);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), this.options.bloom === false ? 0 : config.bloom * this.getProfile().bloomScale, 0.35, 0.88);
      if (this.options.contactShading || this.options.atmosphere || (this.options.sunShafts && !!sun) || (this.options.volumetric && this.options.dynamicShadows && !!sun)) {
        this.contact = new SSAOPass(scene, camera, this.width, this.height, 16);
        // SSAOPass defaults to Math.random. Replace both sample sources for stable exported frames.
        this.contact.kernel.forEach((sample, i) => sample.set(particleRandom(i, 0)*2-1, particleRandom(i, 1)*2-1, particleRandom(i, 2)).normalize().multiplyScalar(.1+.9*(i/16)**2));
        this.contact.noiseTexture.dispose();
        const noise = new THREE.DataTexture(Float32Array.from({ length: 16 }, (_, i) => particleRandom(i, 7)*2-1), 4, 4, THREE.RedFormat, THREE.FloatType);
        noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.needsUpdate = true;
        this.contact.noiseTexture = noise; this.contact.ssaoMaterial.uniforms.tNoise.value = noise;
        const contact = this.contact;
        const renderContact = contact.render.bind(contact);
        contact.render = (renderer, write, read, delta, mask) => this.opaqueDepth.run(contact.scene, () => renderContact(renderer, write, read, delta, mask));
        this.contact.kernelRadius = 12; this.contact.minDistance = 0.00005; this.contact.maxDistance = 0.003;
        // Screen-space contact shading supplements baked lighting gently.
        this.contact.ssaoMaterial.fragmentShader = this.contact.ssaoMaterial.fragmentShader.replace("1.0 - occlusion", this.options.contactShading ? "1.0 - occlusion * 0.22" : "1.0");
      }
      this.grade = new ShaderPass({
        uniforms: { tDiffuse: { value: null }, saturation: { value: this.getProfile().saturation ?? config.saturation }, contrast: { value: this.getProfile().contrast ?? config.contrast }, exposure: { value: this.getProfile().exposure ?? 1 }, highlightShoulder: { value: this.getProfile().highlightShoulder ?? 0 }, tDepth: { value: null }, nearClip: { value: 2 }, farClip: { value: 60000 }, hazeDistance: { value: this.getProfile().hazeDistance }, haze: { value: this.options.atmosphere ? this.getProfile().haze ?? 0.08 : 0 } },
        vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader: "uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform float saturation,contrast,exposure,highlightShoulder,nearClip,farClip,haze,hazeDistance; varying vec2 vUv; void main(){vec4 c=texture2D(tDiffuse,vUv);float l=dot(c.rgb,vec3(.2126,.7152,.0722));c.rgb=mix(vec3(l),c.rgb,saturation);c.rgb*=exposure;c.rgb=pow(max(c.rgb,vec3(0.)),vec3(contrast))*pow(.18,1.-contrast);vec3 film=(c.rgb*(2.51*c.rgb+.03))/(c.rgb*(2.43*c.rgb+.59)+.14);c.rgb=mix(c.rgb,film,highlightShoulder);float d=texture2D(tDepth,vUv).x;float z=(nearClip*farClip)/(farClip-d*(farClip-nearClip));float fog=(1.-exp(-z/hazeDistance))*haze*step(d,.99999);c.rgb=mix(c.rgb,vec3(.42,.53,.65),fog);gl_FragColor=c;}",
      });
      if (this.options.depthOfField && camera instanceof THREE.PerspectiveCamera) this.bokeh = new BokehPass(scene, camera, { focus: this.options.focusDistance ?? 500, aperture: 0.000015, maxblur: 0.004 });
      if (this.bokeh) {
        const bokeh = this.bokeh;
        const renderBokeh = bokeh.render.bind(bokeh);
        bokeh.render = (renderer, write, read, delta, mask) => this.opaqueDepth.run(bokeh.scene, () => renderBokeh(renderer, write, read, delta, mask));
      }
      if (this.options.sunShafts && sun && this.contact) this.shafts = new ShaderPass({
        uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, sunUv: { value: new THREE.Vector2(.5,.5) }, sunColor: { value: new THREE.Color(1,1,1) }, strength: { value: 0 } },
        vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader: `uniform sampler2D tDiffuse,tDepth; uniform vec2 sunUv; uniform vec3 sunColor; uniform float strength; varying vec2 vUv;
        void main(){vec4 c=texture2D(tDiffuse,vUv); if(strength<=0.){gl_FragColor=c;return;} vec2 stepUv=(sunUv-vUv)/24.;vec2 p=vUv;float rays=0.;float weight=1.;
        for(int i=0;i<24;i++){p+=stepUv;float d=texture2D(tDepth,clamp(p,vec2(0.),vec2(1.))).x;float source=exp(-dot(p-sunUv,p-sunUv)*160.);rays+=step(.99999,d)*source*weight;weight*=.96;}
        float destination=step(.99999,texture2D(tDepth,vUv).x);c.rgb+=sunColor*rays*strength*(.35+.65*destination);gl_FragColor=c;}`,
      });
      // ShaderPass clones uniform textures. Bind the live depth attachment after construction.
      this.grade.uniforms.tDepth.value = this.contact?.normalRenderTarget.depthTexture ?? null;
      if (this.shafts) this.shafts.uniforms.tDepth.value = this.contact!.normalRenderTarget.depthTexture;
      if (this.options.volumetric) this.scattering = new VolumetricScatteringPass();
      if ((this.options.temporalSamples ?? 1) > 1) this.accumulation = new TemporalAccumulationPass();
      this.output = new OutputPass();
      if (this.options.spatialAA !== false) this.aa = createSpatialAAPass(this.width, this.height);
      this.composer.addPass(this.scenePass);if(this.hybrid)this.composer.addPass(this.hybrid.getPass());if(this.hybrid?.getStats().core.ready)this.attachHybridDepth(); if (this.gi) this.composer.addPass(this.gi.getPass()); if (this.contact) this.composer.addPass(this.contact); this.composer.addPass(this.exposure = new SourceHdrPass(this.renderer)); this.composer.addPass(this.bloom); this.composer.addPass(this.grade); if (this.shafts) this.composer.addPass(this.shafts); if (this.scattering) this.composer.addPass(this.scattering); if (this.bokeh) this.composer.addPass(this.bokeh); if (this.accumulation) this.composer.addPass(this.accumulation); this.composer.addPass(this.output); if (this.aa) this.composer.addPass(this.aa);
      this.setSize(this.width, this.height);
    }
    this.scenePass!.scene = scene; this.scenePass!.camera = camera;
    if (this.contact) {
      this.contact.scene = scene; this.contact.camera = camera;
      this.contact.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
      this.contact.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
      if (camera instanceof THREE.PerspectiveCamera) { this.contact.ssaoMaterial.uniforms.cameraNear.value = camera.near; this.contact.ssaoMaterial.uniforms.cameraFar.value = camera.far; }
    }
    if (this.shafts) {
      this.shafts.uniforms.strength.value = 0;
      if (sun && camera instanceof THREE.PerspectiveCamera) {
        const uv = projectSun(camera, sun.direction);
        if (uv) { this.shafts.uniforms.sunUv.value.copy(uv); this.shafts.uniforms.sunColor.value.copy(sun.color); this.shafts.uniforms.strength.value=.006; }
      }
    }
    if (this.grade && camera instanceof THREE.PerspectiveCamera) { this.grade.uniforms.nearClip!.value = camera.near; this.grade.uniforms.farClip!.value = camera.far; }
    if (this.bokeh && camera instanceof THREE.PerspectiveCamera) { this.bokeh.scene = scene; this.bokeh.camera = camera; this.bokeh.materialBokeh.uniforms.focus!.value = this.options.focusDistance ?? 500; this.bokeh.materialBokeh.uniforms.aspect!.value = camera.aspect; this.bokeh.materialBokeh.uniforms.nearClip!.value = camera.near; this.bokeh.materialBokeh.uniforms.farClip!.value = camera.far; }
    if (this.scattering && camera instanceof THREE.PerspectiveCamera) this.scattering.setInputs(camera, this.contact?.normalRenderTarget.depthTexture ?? null, this.shadows?.getSampling() ?? null, sun?.color ?? new THREE.Color(), { strength: this.getProfile().scatteringStrength ?? 1, density: this.getProfile().scatteringDensity ?? 1/24000, maxDistance: 2000, cloudUniforms:this.clouds?.getUniforms() });
    if (this.accumulation && this.sampleCount > 1) {
      if (!this.accumulating) { this.accumulation.beginFrame(this.sampleCount); this.accumulating = true; }
      this.accumulation.beginSample(this.sampleIndex);
    }
    const target = this.renderer.getRenderTarget();
    const viewport = this.renderer.getViewport(new THREE.Vector4());
    const scissor = this.renderer.getScissor(new THREE.Vector4());
    const scissorTest = this.renderer.getScissorTest();
    const autoClear = this.renderer.autoClear;
    const clearColor = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    // CS:S's exposure and bloom on maps with HDR lighting (source-hdr-pass.ts), on visual time like the Source look.
    if (this.exposure) {
      this.exposure.enabled = hdrWorld(scene);
      this.exposure.bloom = this.options.bloom !== false;
      this.exposure.dt = Math.max(0, _timeSeconds - this.composerTime);
    }
    this.composerTime = _timeSeconds;
    try { this.composer.render(0); } finally {
      this.renderer.setRenderTarget(target); this.renderer.setViewport(viewport); this.renderer.setScissor(scissor); this.renderer.setScissorTest(scissorTest);
      this.renderer.autoClear = autoClear; this.renderer.setClearColor(clearColor, clearAlpha);
    }
  }
  /** Current CS:S exposure on maps with HDR lighting (source-hdr-pass.ts), else 1. */
  getSourceExposure(): number { return this.exposure?.enabled ? this.exposure.auto.value : 1; }
  private exposure: SourceHdrPass | null = null;
  private composerTime = 0;
  private releaseEffects(): void {
    this.stopHybrid();
    // Reverse receiver-hook installation order: locals wrap the sun hook.
    this.local?.dispose(); this.local = null; this.gi?.dispose(); this.gi = null;
    this.shadows?.dispose(); this.shadows = null;
    this.scattering?.dispose(); this.scattering = null; this.accumulation?.dispose(); this.accumulation = null; this.accumulating = false; this.aa?.dispose(); this.aa = null;
    this.contact?.noiseTexture.dispose(); this.contact?.ssaoMaterial.dispose(); this.contact?.dispose(); this.bokeh?.dispose(); this.contact = null; this.bokeh = null;
    this.composer?.dispose(); this.exposure?.dispose(); this.exposure = null; this.bloom?.dispose(); this.grade?.dispose(); this.output?.dispose();
    this.shafts?.dispose(); this.shafts = null; this.opaqueDepth.dispose();
    this.composer = null; this.scenePass = null; this.bloom = null; this.grade = null; this.output = null;
    this.water?.dispose(); this.water = null; this.scene = null;
  }
  dispose():void{this.resetEffects();this.skyRuntime?.dispose();this.skyRuntime=null;this.boundsScene=null;this.lighting=null;this.lastScene=null;this.lastCamera=null;this.exportLocked=false;this.queuedOptions=null;}
}
