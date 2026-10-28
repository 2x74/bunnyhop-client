import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export interface CloudOptions {
  enabled?: boolean; quality?: "low"|"medium"|"high"; coverage?: number; density?: number;
  baseHeight?: number; thickness?: number; shapeScale?: number; wind?: THREE.Vector2; seed?: number;
}
export interface CloudSun { direction: THREE.Vector3; color: THREE.Color; ambient: THREE.Color }
export interface CloudSampling { active: boolean; texture: THREE.Texture|null; width: number; height: number }
export const cloudBudget = (quality: CloudOptions["quality"] = "low") => quality === "high" ? {width:640,height:360,steps:48,lightSteps:6} : quality === "medium" ? {width:480,height:270,steps:24,lightSteps:3} : {width:320,height:180,steps:16,lightSteps:2};
export const createCloudShadowUniforms = ():Record<string,THREE.IUniform> => ({uCloudActive:{value:0},uCloudCoverage:{value:0},uCloudDensity:{value:0},uCloudBase:{value:16384},uCloudThickness:{value:4096},uCloudScale:{value:2400},uCloudSeed:{value:1},uCloudWindOffset:{value:new THREE.Vector2()}});
const finite=(value:number|undefined,fallback:number,min:number,max:number)=>Number.isFinite(value)?THREE.MathUtils.clamp(value!,min,max):fallback;
/** Shared world-space density and wind for both visible volume and receiver sun visibility. No texture sampler. */
export const CLOUD_DENSITY_GLSL = /* glsl */`
uniform float uCloudActive,uCloudCoverage,uCloudDensity,uCloudBase,uCloudThickness,uCloudScale,uCloudSeed;
uniform vec2 uCloudWindOffset;
float cloudHash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float cloudNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(cloudHash(i),cloudHash(i+vec3(1,0,0)),f.x),mix(cloudHash(i+vec3(0,1,0)),cloudHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(cloudHash(i+vec3(0,0,1)),cloudHash(i+vec3(1,0,1)),f.x),mix(cloudHash(i+vec3(0,1,1)),cloudHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float cloudDensityAt(vec3 world){
 if(uCloudCoverage<=.0001||uCloudDensity<=.0001)return 0.;
 float h=(world.y-uCloudBase)/uCloudThickness;if(h<=0.||h>=1.)return 0.;
 vec2 horizontal=world.xz-uCloudWindOffset;
 float spacing=uCloudScale*3.;vec2 cell=floor(horizontal/spacing);
 float field=-1.;
 // World-anchored, variably sized 3D cumulus bodies. Adjacent bodies merge naturally.
 for(int z=-1;z<=1;z++)for(int x=-1;x<=1;x++){
   vec2 id=cell+vec2(float(x),float(z));float chance=cloudHash(vec3(id,uCloudSeed+17.));
   float weather=cloudNoise(vec3(id.x*.24,uCloudSeed*.37,id.y*.24));
   float amount=uCloudCoverage*mix(.12,1.5,smoothstep(.22,.68,weather));
   if(chance>amount)continue;
   float a=cloudHash(vec3(id,uCloudSeed+43.)),b=cloudHash(vec3(id,uCloudSeed+79.)),c=cloudHash(vec3(id,uCloudSeed+103.));
   // Full-cell jitter, broad size variance and weather holes hide the underlying spatial grid.
   vec2 center=(id+vec2(a,b))*spacing;
   float radius=spacing*(.29+a*a*.57),altitude=c*.23,top=(.5+b*.45)*(1.-altitude);
   vec2 horizontalQ=horizontal-center;
   vec3 q=vec3(horizontalQ.x/radius,(h-altitude-top*.25)/(top*.4),horizontalQ.y/(radius*(.65+b*.6)));
   float body=1.-length(q);
   // Unequal overlapping 3D lobes form asymmetric cauliflower tops and merged cloud groups.
   vec2 lobeOffset=vec2(b-.5,c-.5)*radius;
   vec3 q1=vec3((horizontalQ.x-lobeOffset.x)/(radius*.67),(h-altitude-top*.6)/(top*.36),(horizontalQ.y-lobeOffset.y)/(radius*.63));
   vec3 q2=vec3((horizontalQ.x+lobeOffset.x*.8)/(radius*.52),(h-altitude-top*.48)/(top*.48),(horizontalQ.y+lobeOffset.y*.9)/(radius*.71));
   float lobe=max(1.-length(q1),1.-length(q2));
   float blend=max(.14-abs(body-lobe),0.)/.14;
   field=max(field,max(body,lobe)+blend*blend*.035);
 }
 if(field<-.2)return 0.;
 vec3 p=vec3(horizontal.x/uCloudScale,h*2.6,horizontal.y/uCloudScale)+vec3(uCloudSeed*7.13,0.,uCloudSeed*3.77);
 // Multiscale erosion creates scalloped billows and thin wispy edges, rather than smooth ellipsoids.
 float billows=(cloudNoise(p*2.3+19.1)-.5)*.36+(cloudNoise(p*7.7+37.7)-.5)*.11;
 float erosion=(1.-cloudNoise(p*17.3+71.3))*.06;
 float shaped=smoothstep(-.02,.19,field+billows-erosion);
 float base=smoothstep(0.,.07,h);
 return shaped*base*uCloudDensity;
}
float cloudAmbientFactor(){return 1.-clamp(uCloudCoverage*uCloudDensity*.22,0.,.32)*uCloudActive;}
`;
export const CLOUD_SHADOW_GLSL = CLOUD_DENSITY_GLSL + /* glsl */`
float cloudSunTransmission(vec3 world,vec3 sunDirection){
 if(uCloudActive<.5||sunDirection.y<=.01)return 1.;
 float entry=max(0.,(uCloudBase-world.y)/sunDirection.y),exit=(uCloudBase+uCloudThickness-world.y)/sunDirection.y;
 if(exit<=entry)return 1.;exit=min(exit,128000.);if(exit<=entry)return 1.;
 float stepLength=(exit-entry)/4.,optical=0.;
 for(int i=0;i<4;i++)optical+=cloudDensityAt(world+sunDirection*(entry+(float(i)+.5)*stepLength))*stepLength*.0018;
 return exp(-min(optical,16.));
}
`;
/** Samples a spatially filtered premultiplied linear cloud buffer. UV is normalized to its captured camera viewport. */
export const CLOUD_COMPOSITE_GLSL = /* glsl */`
uniform sampler2D uCloudTexture;uniform vec2 uCloudResolution;uniform float uCloudCompositeActive;
vec3 cloudOverSky(vec3 sky,vec2 uv){
 if(uCloudCompositeActive<.5)return sky;
 vec2 texel=1./uCloudResolution;vec4 cloud=texture2D(uCloudTexture,uv)*.8;
 cloud+=(texture2D(uCloudTexture,uv+vec2(texel.x,0.))+texture2D(uCloudTexture,uv-vec2(texel.x,0.))+texture2D(uCloudTexture,uv+vec2(0.,texel.y))+texture2D(uCloudTexture,uv-vec2(0.,texel.y)))*.05;
 return cloud.rgb+sky*(1.-clamp(cloud.a,0.,1.));
}
`;
const fragment = /* glsl */`
${CLOUD_DENSITY_GLSL}
uniform mat4 uCloudInverseProjection,uCloudCameraWorld;
uniform vec3 uCloudEye,uCloudSunDirection,uCloudSunColor,uCloudAmbient;
uniform vec2 uCloudResolution;varying vec2 vUv;
float cloudPhase(float mu,float g){return (1.-g*g)/max(.03,pow(1.+g*g-2.*g*mu,1.5));}
void main(){
 vec4 view=uCloudInverseProjection*vec4(vUv*2.-1.,1.,1.);
 vec3 ray=normalize(mat3(uCloudCameraWorld)*(view.xyz/view.w));
 if(abs(ray.y)<.0001){gl_FragColor=vec4(0.);return;}
 float a=(uCloudBase-uCloudEye.y)/ray.y,b=(uCloudBase+uCloudThickness-uCloudEye.y)/ray.y;
 float entry=max(0.,min(a,b)),exit=min(128000.,max(a,b));
 if(exit<=entry){gl_FragColor=vec4(0.);return;}
 float distanceFade=1.-smoothstep(50000.,100000.,entry);
 float ds=(exit-entry)/float(CLOUD_STEPS),transmission=1.;vec3 scattering=vec3(0.);
 // Fixed pixel dither; no wall clock, temporal accumulation or seek history.
 float jitter=cloudHash(vec3(floor(vUv*uCloudResolution),17.));
 float phase=clamp(.8*cloudPhase(dot(ray,uCloudSunDirection),.62)+.2*cloudPhase(dot(ray,uCloudSunDirection),-.2),.25,6.);
 for(int i=0;i<CLOUD_STEPS;i++){
  vec3 p=uCloudEye+ray*(entry+(float(i)+jitter)*ds);
  float rho=cloudDensityAt(p)*distanceFade;
  if(rho>.001){
   float sunOptical=0.;float sunDistance=uCloudSunDirection.y>.01?max(0.,(uCloudBase+uCloudThickness-p.y)/uCloudSunDirection.y):0.;
   float lightStep=min(sunDistance,16000.)/float(CLOUD_LIGHT_STEPS);
   for(int j=0;j<CLOUD_LIGHT_STEPS;j++)sunOptical+=cloudDensityAt(p+uCloudSunDirection*((float(j)+.5)*lightStep))*lightStep*.0018;
   float sunTrans=exp(-min(sunOptical,16.));
   float h=clamp((p.y-uCloudBase)/uCloudThickness,0.,1.);
   vec3 lighting=uCloudAmbient*mix(.6,1.,h)+uCloudSunColor*(sunTrans*phase*.32+.18*exp(-sunOptical*.22))*step(.01,uCloudSunDirection.y);
   float opacity=1.-exp(-rho*ds*.0018);
   scattering+=transmission*opacity*lighting;transmission*=1.-opacity;
   if(transmission<.008)break;
  }
 }
 gl_FragColor=vec4(scattering,1.-transmission);
}`;

/** A bounded finite 3D cloud slab rendered into a linear premultiplied buffer; no temporal history. */
export class CloudRenderer {
  readonly supported: boolean;
  private target: THREE.WebGLRenderTarget|null=null;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private width=1;private height=1;private quality: CloudOptions["quality"]="low";
  private failed=false;private updates=0;
  private sampling:CloudSampling={active:false,texture:null,width:0,height:0};
  private uniforms:Record<string,THREE.IUniform>={uCloudActive:{value:0},uCloudCompositeActive:{value:0},uCloudCoverage:{value:.48},uCloudDensity:{value:.8},uCloudBase:{value:16384},uCloudThickness:{value:4096},uCloudScale:{value:2400},uCloudSeed:{value:1},uCloudWindOffset:{value:new THREE.Vector2()},uCloudTexture:{value:null},uCloudResolution:{value:new THREE.Vector2(1,1)},uCloudInverseProjection:{value:new THREE.Matrix4()},uCloudCameraWorld:{value:new THREE.Matrix4()},uCloudEye:{value:new THREE.Vector3()},uCloudSunDirection:{value:new THREE.Vector3(0,1,0)},uCloudSunColor:{value:new THREE.Color()},uCloudAmbient:{value:new THREE.Color()}};
  constructor(private renderer:THREE.WebGLRenderer){this.supported=renderer.extensions.has("EXT_color_buffer_float");this.material=new THREE.ShaderMaterial({uniforms:this.uniforms,defines:{CLOUD_STEPS:16,CLOUD_LIGHT_STEPS:2},vertexShader:"varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",fragmentShader:fragment,depthTest:false,depthWrite:false,toneMapped:false});this.quad=new FullScreenQuad(this.material);}
  getUniforms():Record<string,THREE.IUniform>{return this.uniforms;}
  getSampling():CloudSampling{return{...this.sampling};}
  getStats(){return{...this.sampling,texture:undefined,quality:this.quality,steps:cloudBudget(this.quality).steps,lightSteps:cloudBudget(this.quality).lightSteps,updates:this.updates,supported:this.supported,failed:this.failed};}
  resetFrameStats():void{this.updates=0;}
  setSize(width:number,height:number):void{this.width=Math.max(1,width);this.height=Math.max(1,height);}
  update(camera:THREE.PerspectiveCamera,sun:CloudSun,timeSeconds:number,options:CloudOptions):CloudSampling{
    this.sampling.active=false;this.uniforms.uCloudActive.value=0;this.uniforms.uCloudCompositeActive.value=0;
    if(!options.enabled||!this.supported||this.failed){this.releaseTarget();return this.getSampling();}
    const quality=options.quality??"low",budget=cloudBudget(quality);if(quality!==this.quality){this.quality=quality;this.material.defines.CLOUD_STEPS=budget.steps;this.material.defines.CLOUD_LIGHT_STEPS=budget.lightSteps;this.material.needsUpdate=true;}
    const scale=Math.min(1,budget.width/this.width,budget.height/this.height),width=Math.max(1,Math.ceil(this.width*scale)),height=Math.max(1,Math.ceil(this.height*scale));
    this.target??=new THREE.WebGLRenderTarget(width,height,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});this.target.setSize(width,height);
    this.uniforms.uCloudCoverage.value=finite(options.coverage,.48,0,1);this.uniforms.uCloudDensity.value=finite(options.density,.8,0,2);this.uniforms.uCloudBase.value=finite(options.baseHeight,16384,-100000,100000);this.uniforms.uCloudThickness.value=finite(options.thickness,4096,256,8192);this.uniforms.uCloudScale.value=finite(options.shapeScale,2400,512,16000);this.uniforms.uCloudSeed.value=finite(options.seed,1,0,1024);
    const seconds=Number.isFinite(timeSeconds)?timeSeconds:0;const wind=options.wind??new THREE.Vector2(28,12);this.uniforms.uCloudWindOffset.value.set(finite(wind.x,28,-256,256)*seconds,finite(wind.y,12,-256,256)*seconds);
    camera.updateMatrixWorld();this.uniforms.uCloudInverseProjection.value.copy(camera.projectionMatrixInverse);this.uniforms.uCloudCameraWorld.value.copy(camera.matrixWorld);camera.getWorldPosition(this.uniforms.uCloudEye.value);this.uniforms.uCloudSunDirection.value.copy(sun.direction).normalize();this.uniforms.uCloudSunColor.value.copy(sun.color);this.uniforms.uCloudAmbient.value.copy(sun.ambient);this.uniforms.uCloudResolution.value.set(width,height);
    const r=this.renderer,target=r.getRenderTarget(),cubeFace=r.getActiveCubeFace?.()??0,mipLevel=r.getActiveMipmapLevel?.()??0,infoReset=r.info?.autoReset,viewport=r.getViewport(new THREE.Vector4()),scissor=r.getScissor(new THREE.Vector4()),scissorTest=r.getScissorTest(),clear=r.getClearColor(new THREE.Color()),alpha=r.getClearAlpha(),auto=r.autoClear,xr=r.xr.enabled;
    try{r.autoClear=true;r.xr.enabled=false;if(r.info)r.info.autoReset=false;r.setScissorTest(false);r.setRenderTarget(this.target);r.setClearColor(0,0);r.clear();this.quad.render(r);this.updates++;this.uniforms.uCloudTexture.value=this.target.texture;this.uniforms.uCloudActive.value=1;this.uniforms.uCloudCompositeActive.value=1;this.sampling={active:true,texture:this.target.texture,width,height};}
    catch(error){this.failed=true;this.releaseTarget();console.warn("Cloud rendering unavailable; retaining selected sky",error);}
    finally{r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(scissorTest);r.setClearColor(clear,alpha);r.autoClear=auto;r.xr.enabled=xr;if(r.info&&infoReset!==undefined)r.info.autoReset=infoReset;r.setRenderTarget(target,cubeFace,mipLevel);}
    return this.getSampling();
  }
  private releaseTarget():void{this.target?.dispose();this.target=null;this.uniforms.uCloudTexture.value=null;this.sampling={active:false,texture:null,width:0,height:0};}
  dispose():void{this.releaseTarget();this.uniforms.uCloudActive.value=0;this.uniforms.uCloudCompositeActive.value=0;this.material.dispose();this.quad.dispose();}
}
