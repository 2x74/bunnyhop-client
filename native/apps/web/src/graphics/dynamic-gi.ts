import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { CLOUD_SHADOW_GLSL, createCloudShadowUniforms } from "./clouds";
import type { ScatteringShadow } from "./volumetric-scattering";
export interface GIOptions { quality?: "low" | "medium"; range?: number; strength?: number; compensation?: number }
export interface GILighting { cloudUniforms?:Record<string, THREE.IUniform>; localDeclarations?: string; localUniforms?: Record<string, THREE.IUniform>; sunSampling?: (ScatteringShadow & {transmission?:{colors:THREE.Texture[];depths?:THREE.Texture[];layers:number}}) | null; sunColor?: THREE.Color }
const vertex = "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}";
const trace = /* glsl */`
uniform sampler2D tRadiance,tAlbedo,tNormal,tDepth;
uniform mat4 projection,inverseProjection;
uniform float range,strength;uniform vec2 noiseScale;
varying vec2 vUv;
vec3 at(vec2 uv){float d=texture2D(tDepth,uv).x;vec4 p=inverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return p.xyz/p.w;}
float edgeFade(vec2 uv){return smoothstep(0.,.06,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));}
void main(){
  vec4 albedo=texture2D(tAlbedo,vUv);if(albedo.a<.5){gl_FragColor=vec4(0.);return;}
  vec3 origin=at(vUv),n=normalize(texture2D(tNormal,vUv).xyz*2.-1.);
  vec3 tangent=normalize(cross(n,abs(n.z)<.9?vec3(0.,0.,1.):vec3(0.,1.,0.))),bitangent=cross(n,tangent);
  vec3 incoming=vec3(0.);float hits=0.;
  float rotation=fract(sin(dot(floor(vUv*noiseScale),vec2(12.9898,78.233)))*43758.5453)*6.2831853;
  // Fixed cosine-weighted quadrature. No temporal noise/history affects replay reconstruction.
  for(int rayIndex=0;rayIndex<GI_RAYS;rayIndex++){
    float r=sqrt((float(rayIndex)+.5)/float(GI_RAYS));float theta=float(rayIndex)*2.39996323+rotation;
    vec3 direction=tangent*(r*cos(theta))+bitangent*(r*sin(theta))+n*sqrt(1.-r*r);
    float previousGap=-1.;float previousDistance=0.;
    for(int stepIndex=0;stepIndex<GI_STEPS;stepIndex++){
      float f=(float(stepIndex)+1.)/float(GI_STEPS);float distance=range*f*f;
      vec3 samplePosition=origin+n*.5+direction*distance;
      vec4 clip=projection*vec4(samplePosition,1.);if(clip.w<=0.)break;
      vec2 uv=clip.xy/clip.w*.5+.5;if(any(lessThan(uv,vec2(.002)))||any(greaterThan(uv,vec2(.998))))break;
      vec3 surface=at(uv);float gap=surface.z-samplePosition.z;
      // Refine the first visible-depth crossing: coarse Source-unit steps must not
      // miss thin surfaces. Reject depth discontinuities instead of stepping through them.
      if(gap>0.&&previousGap<=0.){
        float nearDistance=previousDistance,farDistance=distance;
        for(int refine=0;refine<5;refine++){
          float middle=(nearDistance+farDistance)*.5;
          vec3 middlePosition=origin+n*.5+direction*middle;
          vec4 middleClip=projection*vec4(middlePosition,1.);
          vec2 middleUV=middleClip.xy/middleClip.w*.5+.5;
          float middleGap=at(middleUV).z-middlePosition.z;
          if(middleGap>0.)farDistance=middle;else nearDistance=middle;
        }
        distance=farDistance;samplePosition=origin+n*.5+direction*distance;
        clip=projection*vec4(samplePosition,1.);uv=clip.xy/clip.w*.5+.5;
        surface=at(uv);float thickness=max(1.,distance*.012);
        if(distance>2.&&length(surface-samplePosition)<thickness&&texture2D(tAlbedo,uv).a>.5){
          vec3 sourceNormal=normalize(texture2D(tNormal,uv).xyz*2.-1.);
          float facing=max(0.,dot(sourceNormal,-direction));
          vec3 radiance=texture2D(tRadiance,uv).rgb;
          incoming+=radiance*facing*(1.-distance/range)*edgeFade(uv);hits+=step(.00001,dot(radiance,vec3(1.)));
        }
        break;
      }
      if(gap>0.)break;
      previousGap=gap;previousDistance=distance;
    }
  }
  // Cosine sampling integrates receiver Lambertian response; capture contains donor albedo / pi.
  vec3 bounce=albedo.rgb*incoming*(strength/float(GI_RAYS))*edgeFade(vUv);
  gl_FragColor=vec4(min(max(bounce,vec3(0.)),vec3(.12)),hits/float(GI_RAYS));
}`;
const compose=/* glsl */`
uniform sampler2D tDiffuse,tGI,tDepth;uniform mat4 inverseProjection;uniform vec2 texel;uniform float compensation;varying vec2 vUv;
float zAt(vec2 uv){vec4 p=inverseProjection*vec4(uv*2.-1.,texture2D(tDepth,uv).x*2.-1.,1.);return p.z/p.w;}
void main(){vec4 scene=texture2D(tDiffuse,vUv);vec3 bounce=vec3(0.);float weightSum=0.;float z=zAt(vUv);
for(int i=0;i<9;i++){vec2 offset=vec2(float(i-(i/3)*3)-1.,float(i/3)-1.)*texel*1.25;vec2 uv=clamp(vUv+offset,vec2(.001),vec2(.999));float weight=exp(-abs(zAt(uv)-z)/max(1.,abs(z)*.01));bounce+=texture2D(tGI,uv).rgb*weight;weightSum+=weight;}
bounce/=max(1e-5,weightSum);float confidence=smoothstep(.00001,.003,max(bounce.r,max(bounce.g,bounce.b)));
// Explicit conservative compensation of baked diffuse energy, only where a real bounce was sampled.
vec3 compensated=scene.rgb*(1.-compensation*confidence);gl_FragColor=vec4(compensated+bounce,scene.a);}
`;
export class DynamicGIPass extends Pass {
  private target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  private width=1;private height=1;private quality="low";
  readonly material=new THREE.ShaderMaterial({defines:{GI_RAYS:8,GI_STEPS:12},uniforms:{tRadiance:{value:null},tAlbedo:{value:null},tNormal:{value:null},tDepth:{value:null},projection:{value:new THREE.Matrix4()},inverseProjection:{value:new THREE.Matrix4()},range:{value:256},strength:{value:.25},noiseScale:{value:new THREE.Vector2(320,180)}},vertexShader:vertex,fragmentShader:trace,depthTest:false,depthWrite:false});
  private composite=new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null},tGI:{value:this.target.texture},tDepth:{value:null},inverseProjection:{value:new THREE.Matrix4()},texel:{value:new THREE.Vector2()},compensation:{value:.04}},vertexShader:vertex,fragmentShader:compose,depthTest:false,depthWrite:false});
  private quad=new FullScreenQuad(this.material);
  constructor(){super();this.enabled=false;}
  setInputs(camera:THREE.PerspectiveCamera,capture:THREE.WebGLRenderTarget,options:GIOptions):void{this.enabled=true;if(this.quality!==(options.quality??"low")){this.quality=options.quality??"low";this.material.defines.GI_RAYS=this.quality==="medium"?12:8;this.material.defines.GI_STEPS=this.quality==="medium"?16:12;this.material.needsUpdate=true;this.setSize(this.width,this.height);}Object.assign(this.material.uniforms,{tRadiance:{value:capture.textures[0]},tAlbedo:{value:capture.textures[1]},tNormal:{value:capture.textures[2]},tDepth:{value:capture.depthTexture}});this.material.uniforms.projection.value.copy(camera.projectionMatrix);this.material.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);this.material.uniforms.range.value=THREE.MathUtils.clamp(options.range??256,16,512);this.material.uniforms.strength.value=THREE.MathUtils.clamp(options.strength??.25,0,1);this.composite.uniforms.tDepth.value=capture.depthTexture;this.composite.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);this.composite.uniforms.compensation.value=THREE.MathUtils.clamp(options.compensation??.04,0,.15);}
  setSize(width:number,height:number):void{this.width=width;this.height=height;const scale=Math.min(1,(this.quality==="medium"?480:320)/Math.max(1,width),(this.quality==="medium"?270:180)/Math.max(1,height));const w=Math.max(1,Math.ceil(width*scale)),h=Math.max(1,Math.ceil(height*scale));this.target.setSize(w,h);this.material.uniforms.noiseScale.value.set(w,h);this.composite.uniforms.texel.value.set(1/w,1/h);}
  render(renderer:THREE.WebGLRenderer,write:THREE.WebGLRenderTarget,read:THREE.WebGLRenderTarget):void{const previous=renderer.getRenderTarget();try{renderer.setRenderTarget(this.target);this.quad.material=this.material;this.quad.render(renderer);this.composite.uniforms.tDiffuse.value=read.texture;renderer.setRenderTarget(this.renderToScreen?null:write);this.quad.material=this.composite;this.quad.render(renderer);}finally{renderer.setRenderTarget(previous);}}
  dispose():void{this.enabled=false;this.target.dispose();this.material.dispose();this.composite.dispose();this.quad.dispose();}
}
let captureId=0;
/** One-bounce visible-surface radiance transport; no baked lightmap/specular/previous-GI feedback. */
export class DynamicGI {
  readonly supported:boolean;
  private capture:THREE.WebGLRenderTarget|null=null;
  private invisible=new THREE.MeshBasicMaterial({visible:false});
  private pass=new DynamicGIPass();
  private captures=new Map<string,THREE.MeshBasicMaterial>();
  private emissions=new Map<string,THREE.IUniform>();
  private cloudUniforms=createCloudShadowUniforms();
  private variant="emission";private declarations="";private localUniforms:Record<string,THREE.IUniform>={};
  private readonly id=++captureId;
  private failed=false;
  private uniforms={giSunMap:{value:null as THREE.Texture|null},giSunTransmission0:{value:null as THREE.Texture|null},giSunTransmission1:{value:null as THREE.Texture|null},giSunLayers:{value:0},giSunMatrix:{value:new THREE.Matrix4()},giSunDirection:{value:new THREE.Vector3()},giSunColor:{value:new THREE.Color()},giSunActive:{value:0},giSunBias:{value:.0003}};
  private stats={draws:0,triangles:0,width:0,height:0,active:false,sources:"none",rays:8,steps:12};
  constructor(private renderer:THREE.WebGLRenderer){this.supported=renderer.extensions.has("EXT_color_buffer_float")&&renderer.capabilities.maxTextures>=16;}
  getPass():DynamicGIPass{return this.pass;}
  getStats(){return{...this.stats,supported:this.supported,failed:this.failed};}
  private captureMaterial(original:THREE.MeshBasicMaterial,model=false):THREE.MeshBasicMaterial{
    const captureKey=original.uuid+":"+model;
    let material=this.captures.get(captureKey);if(material){this.emissions.get(captureKey)!.value=Math.max(0,Math.min(4,Number(original.userData.giEmission)||0));return material;}
    material=original.clone();material.lightMap=null;material.envMap=null;material.fog=false;material.toneMapped=false;material.vertexColors=!!original.userData.giVertexColorsAreAlbedo;
    const emission={value:Math.max(0,Math.min(4,Number(original.userData.giEmission)||0))};this.emissions.set(captureKey,emission);
    material.onBeforeCompile=(shader,renderer)=>{
      if(typeof original.userData.giDiffuseHook==="function")original.userData.giDiffuseHook(shader,renderer);
      Object.assign(shader.uniforms,this.uniforms,this.localUniforms,this.cloudUniforms,{giEmission:emission,giModel:{value:model?1:0}});
      shader.vertexShader=shader.vertexShader.replace("#include <common>","#include <common>\nvarying vec3 vGIWorld;").replace("#include <project_vertex>",`#include <project_vertex>
vec4 giPosition=vec4(transformed,1.);
#ifdef USE_BATCHING
giPosition=batchingMatrix*giPosition;
#endif
#ifdef USE_INSTANCING
giPosition=instanceMatrix*giPosition;
#endif
vGIWorld=(modelMatrix*giPosition).xyz;`);
      shader.fragmentShader=shader.fragmentShader.replace("#include <common>",`#include <common>
#include <packing>
varying vec3 vGIWorld;layout(location=1) out vec4 giAlbedo;layout(location=2) out vec4 giNormal;
uniform float giEmission,giModel;
${CLOUD_SHADOW_GLSL}
${(this.variant==="local"||this.variant==="mixed")?this.declarations+(this.variant==="local"?"\nvec3 giSunRadiance(vec3 n){return vec3(0.);}":""):"vec3 localDirectRadianceFor(vec3 p,vec3 n,float role){return vec3(0.);}"}
${(this.variant==="sun"||this.variant==="mixed")?`uniform sampler2D giSunMap,giSunTransmission0,giSunTransmission1;uniform mat4 giSunMatrix;uniform vec3 giSunDirection,giSunColor;uniform float giSunActive,giSunBias,giSunLayers;
vec3 giSunRadiance(vec3 n){vec4 q=giSunMatrix*vec4(vGIWorld,1.);vec3 uv=q.xyz/q.w;if(giSunActive<.5||any(lessThan(uv,vec3(0.)))||any(greaterThan(uv,vec3(1.))))return vec3(0.);vec3 visibility=vec3(step(uv.z-giSunBias,unpackRGBAToDepth(texture2D(giSunMap,uv.xy))));if(giSunLayers>.5&&uv.z-giSunBias>texture2D(giSunTransmission0,uv.xy).a)visibility*=texture2D(giSunTransmission0,uv.xy).rgb;if(giSunLayers>1.5&&uv.z-giSunBias>texture2D(giSunTransmission1,uv.xy).a)visibility*=texture2D(giSunTransmission1,uv.xy).rgb;return giSunColor*max(0.,dot(n,giSunDirection))*visibility*cloudSunTransmission(vGIWorld,giSunDirection);}`:this.variant==="local"?"":"vec3 giSunRadiance(vec3 n){return vec3(0.);}"}
`).replace("#include <opaque_fragment>",`vec3 nGI=normalize(cross(dFdx(vGIWorld),dFdy(vGIWorld)));
vec3 directGI=localDirectRadianceFor(vGIWorld,nGI,giModel)+giSunRadiance(nGI);
gl_FragColor=vec4(diffuseColor.rgb*(directGI/3.14159265+giEmission),1.);
giAlbedo=vec4(diffuseColor.rgb,1.);giNormal=vec4(normalize(mat3(viewMatrix)*nGI)*.5+.5,1.);`);
    };
    material.customProgramCacheKey=()=>`gi-capture-${this.id}-${this.variant}-${this.declarations.length}-${original.alphaTest>0}`;
    this.captures.set(captureKey,material);return material;
  }
  update(scene:THREE.Scene,camera:THREE.Camera,options:GIOptions={},lighting:GILighting={}):void{
    this.pass.enabled=false;this.stats.active=false;this.stats.sources="none";if(this.failed||!this.supported||!(camera instanceof THREE.PerspectiveCamera))return;
    const localCount=Number(lighting.localUniforms?.uLocalCount?.value)||0;
    const localActive=localCount>0 && (lighting.localUniforms?.uLocalIntensity?.value??[]).slice(0,localCount).some((v:number)=>v>0);
    const sunActive=!!lighting.sunSampling?.active&&!!lighting.sunSampling.texture&&(!lighting.sunColor||(lighting.sunColor.r+lighting.sunColor.g+lighting.sunColor.b)>0);
    let emissive=false;scene.traverseVisible(object=>{if(!(object instanceof THREE.Mesh)||object.renderOrder< -900||object.userData.sunShadowOnly)return;for(const material of Array.isArray(object.material)?object.material:[object.material])if(material.visible&&!material.transparent&&Number(material.userData.giEmission)>0)emissive=true;});
    if(!localActive&&!sunActive&&!emissive)return;
    const variant=localActive&&sunActive?"mixed":localActive?"local":sunActive?"sun":"emission";
    if(variant!==this.variant){this.variant=variant;for(const material of this.captures.values())material.needsUpdate=true;}


    if(this.declarations!==(lighting.localDeclarations??"").replace(/#include\s+<packing>/g,"")){this.declarations=(lighting.localDeclarations??"").replace(/#include\s+<packing>/g,"");for(const material of this.captures.values())material.needsUpdate=true;}
    this.localUniforms=lighting.localUniforms??{};this.cloudUniforms=lighting.cloudUniforms??createCloudShadowUniforms();
    const sun=lighting.sunSampling;this.uniforms.giSunActive.value=sun?.active&&sun.texture?1:0;this.uniforms.giSunMap.value=sun?.texture??null;if(sun){this.uniforms.giSunMatrix.value.copy(sun.matrix);this.uniforms.giSunDirection.value.copy(sun.direction);this.uniforms.giSunBias.value=sun.bias??.0003;}this.uniforms.giSunColor.value.copy(lighting.sunColor??new THREE.Color(1,1,1));
    this.uniforms.giSunLayers.value=sun?.transmission?.layers??0;
    this.uniforms.giSunTransmission0.value=sun?.transmission?.colors[0]??null;this.uniforms.giSunTransmission1.value=sun?.transmission?.colors[1]??null;

    const size=this.renderer.getDrawingBufferSize(new THREE.Vector2()),scale=Math.min(1,(options.quality==="medium"?768:512)/size.x,(options.quality==="medium"?432:288)/size.y),w=Math.max(1,Math.ceil(size.x*scale)),h=Math.max(1,Math.ceil(size.y*scale));
    if(!this.capture){this.capture=new THREE.WebGLRenderTarget(w,h,{count:3,type:THREE.HalfFloatType,depthBuffer:true,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});this.capture.depthTexture=new THREE.DepthTexture(w,h,THREE.UnsignedIntType);}else this.capture.setSize(w,h);
    const swapped:[THREE.Mesh,THREE.Material|THREE.Material[]][]=[];const hidden:[THREE.Object3D,boolean][]=[];
    scene.traverse(object=>{if(!object.visible)return;if(object instanceof THREE.Line||object instanceof THREE.Points||object instanceof THREE.Sprite){hidden.push([object,true]);object.visible=false;return;}if(!(object instanceof THREE.Mesh))return;if(object.renderOrder< -900||object.geometry.getAttribute("center")||object.userData.sunShadowOnly){hidden.push([object,true]);object.visible=false;return;}const original=Array.isArray(object.material)?object.material:[object.material];const materials=original.map(m=>{if(!(m instanceof THREE.MeshBasicMaterial)||!m.visible||m.transparent||!m.depthWrite||!m.colorWrite)return this.invisible;const cloned=this.captureMaterial(m,object.name.includes("prop")||object instanceof THREE.SkinnedMesh);cloned.color.copy(m.color);cloned.map=m.map;cloned.opacity=m.opacity;return cloned;});swapped.push([object,object.material]);object.material=Array.isArray(object.material)?materials:materials[0];});
    const r=this.renderer,target=r.getRenderTarget(),background=scene.background,override=scene.overrideMaterial,clear=r.getClearColor(new THREE.Color()),alpha=r.getClearAlpha(),autoClear=r.autoClear,viewport=r.getViewport(new THREE.Vector4()),scissor=r.getScissor(new THREE.Vector4()),scissorTest=r.getScissorTest(),xr=r.xr.enabled,infoReset=r.info.autoReset,calls=r.info.render.calls,triangles=r.info.render.triangles;
    try{scene.background=null;scene.overrideMaterial=null;r.autoClear=true;r.xr.enabled=false;r.info.autoReset=false;r.setScissorTest(false);r.setRenderTarget(this.capture);r.setClearColor(0,0);r.clear();r.render(scene,camera);this.stats={draws:r.info.render.calls-calls,triangles:r.info.render.triangles-triangles,width:w,height:h,active:true,sources:(this.variant==="mixed"?"local+sun":this.variant)+(emissive&&this.variant!=="emission"?"+emission":""),rays:options.quality==="medium"?12:8,steps:options.quality==="medium"?16:12};this.pass.setInputs(camera,this.capture,options);}catch(error){this.failed=true;this.stats.active=false;this.pass.enabled=false;console.warn("Dynamic GI unavailable; preserving baked lighting",error);}finally{for(const[object,material]of swapped){object.material=material;}for(const[object,visible]of hidden)object.visible=visible;scene.background=background;scene.overrideMaterial=override;r.setRenderTarget(target);r.setClearColor(clear,alpha);r.autoClear=autoClear;r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(scissorTest);r.xr.enabled=xr;r.info.autoReset=infoReset;}
  }
  dispose():void{this.capture?.dispose();this.capture=null;for(const material of this.captures.values())material.dispose();this.captures.clear();this.emissions.clear();this.invisible.dispose();this.pass.dispose();this.stats.active=false;}
}
