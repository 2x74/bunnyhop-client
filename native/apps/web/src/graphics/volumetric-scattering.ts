import * as THREE from "three";
import { CLOUD_SHADOW_GLSL, createCloudShadowUniforms } from "./clouds";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export interface ScatteringShadow {
  texture: THREE.Texture | null;
  /** World position -> normalized shadow UV/depth, as Three's directional shadow matrix. */
  matrix: THREE.Matrix4;
  direction: THREE.Vector3;
  active: boolean;
  bias?: number;
}
export interface ScatteringOptions { cloudUniforms?:Record<string,THREE.IUniform>; density?: number; strength?: number; maxDistance?: number }
const vertexShader = "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}";
const scatteringFragment = /* glsl */`
#include <packing>
${CLOUD_SHADOW_GLSL}
uniform sampler2D tDepth,tShadow;
uniform mat4 inverseProjection,cameraWorld,shadowMatrix;
uniform vec3 cameraAt,sunDirection,sunColor;
uniform float shadowBias,density,strength,maxDistance;
varying vec2 vUv;
void main(){
  float depth=texture2D(tDepth,vUv).x;
  vec4 view=inverseProjection*vec4(vUv*2.-1.,depth*2.-1.,1.);view/=view.w;
  vec3 endpoint=(cameraWorld*view).xyz;
  vec3 ray=normalize(endpoint-cameraAt);
  float distance=min(length(endpoint-cameraAt),maxDistance);
  float stepLength=distance/12.;float transmittance=1.;vec3 scattering=vec3(0.);
  float g=.45;float mu=dot(ray,normalize(sunDirection));
  float phase=(1.-g*g)/(12.5663706*pow(max(.01,1.+g*g-2.*g*mu),1.5));
  float extinction=exp(-density*stepLength);
  for(int i=0;i<12;i++){
    vec3 world=cameraAt+ray*(float(i)+.5)*stepLength;
    vec4 projected=shadowMatrix*vec4(world,1.);vec3 uv=projected.xyz/projected.w;
    float visibility=0.;
    if(all(greaterThanEqual(uv,vec3(0.)))&&all(lessThanEqual(uv,vec3(1.)))){
      float blocker=unpackRGBAToDepth(texture2D(tShadow,uv.xy));
      visibility=step(uv.z-shadowBias,blocker)*cloudSunTransmission(world,sunDirection);
    }
    scattering+=transmittance*(1.-extinction)*visibility*phase*sunColor*strength;
    transmittance*=extinction;
  }
  gl_FragColor=vec4(scattering,transmittance);
}`;
const compositeFragment = /* glsl */`
uniform sampler2D tDiffuse,tScattering,tDepth;
uniform vec2 texel;
uniform mat4 inverseProjection;
uniform float maxDistance;
varying vec2 vUv;
float distanceAt(vec2 uv){float d=texture2D(tDepth,uv).x;vec4 p=inverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return min(length(p.xyz/p.w),maxDistance);}
void main(){
  vec4 scene=texture2D(tDiffuse,vUv);float distance=distanceAt(vUv);vec4 fog=vec4(0.);float total=0.;
  for(int i=0;i<4;i++){
    vec2 offset=vec2(float(i-(i/2)*2)-.5,float(i/2)-.5)*texel;
    vec2 uv=clamp(vUv+offset,vec2(0.),vec2(1.));
    float weight=exp(-abs(distanceAt(uv)-distance)/max(12.,distance*.02));
    fog+=texture2D(tScattering,uv)*weight;total+=weight;
  }
  fog/=max(total,1e-5);gl_FragColor=vec4(scene.rgb*fog.a+fog.rgb,scene.a);
}`;

/** Bounded single-scattering approximation, shadow-tested in world space; no unshadowed fallback. */
export class VolumetricScatteringPass extends Pass {
  private target = new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  readonly scatteringMaterial = new THREE.ShaderMaterial({uniforms:{...createCloudShadowUniforms(),tDepth:{value:null},tShadow:{value:null},inverseProjection:{value:new THREE.Matrix4()},cameraWorld:{value:new THREE.Matrix4()},shadowMatrix:{value:new THREE.Matrix4()},cameraAt:{value:new THREE.Vector3()},sunDirection:{value:new THREE.Vector3()},sunColor:{value:new THREE.Color()},shadowBias:{value:.0003},density:{value:1/24000},strength:{value:1},maxDistance:{value:2000}},vertexShader,fragmentShader:scatteringFragment,depthTest:false,depthWrite:false});
  private composite = new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null},tScattering:{value:this.target.texture},tDepth:{value:null},texel:{value:new THREE.Vector2(1,1)},inverseProjection:{value:new THREE.Matrix4()},maxDistance:{value:2000}},vertexShader,fragmentShader:compositeFragment,depthTest:false,depthWrite:false});
  private quad = new FullScreenQuad(this.scatteringMaterial);
  constructor(){super();this.enabled=false;}
  setInputs(camera:THREE.PerspectiveCamera,depth:THREE.Texture|null,shadow:ScatteringShadow|null,sunColor:THREE.Color,options:ScatteringOptions={}):void{
    this.enabled=!!depth&&!!shadow?.active&&!!shadow.texture;
    if(!this.enabled||!shadow)return;
    const u=this.scatteringMaterial.uniforms;Object.assign(u,options.cloudUniforms??createCloudShadowUniforms());
    u.tDepth.value=depth;u.tShadow.value=shadow.texture;u.inverseProjection.value.copy(camera.projectionMatrixInverse);u.cameraWorld.value.copy(camera.matrixWorld);camera.getWorldPosition(u.cameraAt.value);
    u.shadowMatrix.value.copy(shadow.matrix);u.sunDirection.value.copy(shadow.direction).normalize();u.sunColor.value.copy(sunColor);
    u.shadowBias.value=Math.max(0,Math.min(.01,shadow.bias??.0003));u.density.value=Math.max(0,Math.min(1/4000,options.density??1/24000));u.strength.value=Math.max(0,Math.min(2,options.strength??1));u.maxDistance.value=Math.max(64,Math.min(4000,options.maxDistance??2000));
    this.composite.uniforms.tDepth.value=depth;this.composite.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);this.composite.uniforms.maxDistance.value=u.maxDistance.value;
  }
  setSize(width:number,height:number):void{const w=Math.max(1,Math.min(1280,Math.ceil(width/2))),h=Math.max(1,Math.min(720,Math.ceil(height/2)));this.target.setSize(w,h);this.composite.uniforms.texel.value.set(1/w,1/h);}
  render(renderer:THREE.WebGLRenderer,writeBuffer:THREE.WebGLRenderTarget,readBuffer:THREE.WebGLRenderTarget):void{
    const target=renderer.getRenderTarget();
    try{this.quad.material=this.scatteringMaterial;renderer.setRenderTarget(this.target);this.quad.render(renderer);this.quad.material=this.composite;this.composite.uniforms.tDiffuse.value=readBuffer.texture;renderer.setRenderTarget(this.renderToScreen?null:writeBuffer);this.quad.render(renderer);}finally{renderer.setRenderTarget(target);}
  }
  dispose():void{this.target.dispose();this.scatteringMaterial.dispose();this.composite.dispose();this.quad.dispose();}
}
