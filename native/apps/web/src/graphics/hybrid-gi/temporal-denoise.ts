import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { preserveHybridState } from "./pass-state";
export interface DenoiseBuffers { normalDepth: THREE.Texture; albedo: THREE.Texture; depthTexture: THREE.Texture; width: number; height: number }
export interface DenoiseOptions { resetToken: string; history: boolean; strength?: number }
export const HISTORY_FRAMES = 8;
const VERTEX = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const TEMPORAL = `varying vec2 vUv;uniform sampler2D rawGI,currentNormal,currentDepth,previousGI,previousGeometry;
uniform vec2 texel;uniform mat4 inverseVP,previousVP,previousView;uniform float historyEnabled;
vec3 worldPosition(vec2 uv,float z){vec4 p=inverseVP*vec4(uv*2.-1.,z*2.-1.,1.);return p.xyz/p.w;}
vec3 finiteSigned(vec3 c){return vec3(isnan(c.x)||isinf(c.x)?0.:clamp(c.x,-64.,64.),isnan(c.y)||isinf(c.y)?0.:clamp(c.y,-64.,64.),isnan(c.z)||isinf(c.z)?0.:clamp(c.z,-64.,64.));}
void main(){vec4 nd=texture2D(currentNormal,vUv),sampleGI=texture2D(rawGI,vUv);float z=texture2D(currentDepth,vUv).r;
if(nd.a<.5||sampleGI.a<.5||z>=.999999){gl_FragColor=vec4(0.);return;}
vec3 current=finiteSigned(sampleGI.rgb),lo=current,hi=current;
for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 uv=clamp(vUv+vec2(float(x),float(y))*texel,texel*.5,1.-texel*.5);vec4 neighbor=texture2D(rawGI,uv);vec4 nn=texture2D(currentNormal,uv);if(neighbor.a>.5&&nn.a>.5&&dot(normalize(nn.rgb*2.-1.),normalize(nd.rgb*2.-1.))>.8){vec3 c=finiteSigned(neighbor.rgb);lo=min(lo,c);hi=max(hi,c);}}
vec3 result=current;float count=1.;
if(historyEnabled>.5){vec3 world=worldPosition(vUv,z);vec4 projected=previousVP*vec4(world,1.);vec2 oldUV=projected.xy/projected.w*.5+.5;
if(projected.w>0.&&all(greaterThan(oldUV,texel*.5))&&all(lessThan(oldUV,1.-texel*.5))){vec4 geometry=texture2D(previousGeometry,oldUV),old=texture2D(previousGI,oldUV);float expectedZ=projected.z/projected.w*.5+.5;
// Device depth tolerance is converted from view distance, not a broad near/far-dependent constant.
float viewZ=max(.01,-(previousView*vec4(world,1.)).z);float depthDerivative=max(abs(dFdx(expectedZ)),abs(dFdy(expectedZ)));
float tolerance=max(2.e-6,depthDerivative*.75+2.e-4/viewZ);
if(old.a>=.99&&abs(geometry.a-expectedZ)<=tolerance&&dot(normalize(geometry.rgb*2.-1.),normalize(nd.rgb*2.-1.))>.9){count=min(old.a+1.,8.);vec3 history=clamp(finiteSigned(old.rgb),lo,hi);result=mix(history,current,1./count);}}}
gl_FragColor=vec4(finiteSigned(result),count);}`;
const GEOMETRY = `varying vec2 vUv;uniform sampler2D normalMap,depthMap;void main(){gl_FragColor=vec4(texture2D(normalMap,vUv).rgb,texture2D(depthMap,vUv).r);}`;
const SPATIAL = `varying vec2 vUv;uniform sampler2D sourceGI,normalMap,depthMap;uniform vec2 texel;uniform mat4 inverseProjection;
float viewDepth(vec2 uv,float z){vec4 p=inverseProjection*vec4(uv*2.-1.,z*2.-1.,1.);return -p.z/p.w;}
void main(){vec4 n=texture2D(normalMap,vUv),center=texture2D(sourceGI,vUv);if(n.a<.5||center.a<.5){gl_FragColor=vec4(0.);return;}float z=viewDepth(vUv,texture2D(depthMap,vUv).r);vec3 normal=normalize(n.rgb*2.-1.),sum=vec3(0.);float weights=0.;
for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){vec2 uv=clamp(vUv+vec2(float(x),float(y))*texel,texel*.5,1.-texel*.5);vec4 nn=texture2D(normalMap,uv),c=texture2D(sourceGI,uv);float dz=abs(viewDepth(uv,texture2D(depthMap,uv).r)-z);float spatial=exp(-.5*float(x*x+y*y));float edge=exp(-dz/max(.5,z*.005))*pow(max(0.,dot(normal,normalize(nn.rgb*2.-1.))),32.);float w=spatial*edge*step(.5,nn.a)*step(.5,c.a);sum+=c.rgb*w;weights+=w;}
gl_FragColor=vec4(weights>1.e-5?sum/weights:center.rgb,1.);}`;
/** Signed delta irradiance. Histories contain no beauty/color-buffer samples or wall-clock state. */
export class TemporalDenoisePass {
  private radiance: THREE.WebGLRenderTarget[] = []; private geometry: THREE.WebGLRenderTarget[] = []; private filtered: THREE.WebGLRenderTarget | null = null;
  private width = 0; private height = 0; private slot = 0; private valid = false; private lastTime = NaN; private token = "";
  private previousVP = new THREE.Matrix4(); private previousView = new THREE.Matrix4(); private previousProjection = new THREE.Matrix4();
  private previousPosition = new THREE.Vector3(); private previousQuaternion = new THREE.Quaternion();
  private temporal = new THREE.ShaderMaterial({vertexShader:VERTEX,fragmentShader:TEMPORAL,depthTest:false,depthWrite:false,uniforms:{rawGI:{value:null},currentNormal:{value:null},currentDepth:{value:null},previousGI:{value:null},previousGeometry:{value:null},texel:{value:new THREE.Vector2()},inverseVP:{value:new THREE.Matrix4()},previousVP:{value:this.previousVP},previousView:{value:this.previousView},historyEnabled:{value:0}}});
  private copy = new THREE.ShaderMaterial({vertexShader:VERTEX,fragmentShader:GEOMETRY,depthTest:false,depthWrite:false,uniforms:{normalMap:{value:null},depthMap:{value:null}}});
  private spatial = new THREE.ShaderMaterial({vertexShader:VERTEX,fragmentShader:SPATIAL,depthTest:false,depthWrite:false,uniforms:{sourceGI:{value:null},normalMap:{value:null},depthMap:{value:null},texel:{value:new THREE.Vector2()},inverseProjection:{value:new THREE.Matrix4()}}});
  private quad = new FullScreenQuad(this.temporal); private disposed = false;
  private stats = { draws: 0, allocations: 0, resets: 0, historyUsed: false, width: 0, height: 0, bytes: 0 };
  constructor(private renderer: THREE.WebGLRenderer) {}
  reset(): void { this.valid = false; this.lastTime = NaN; this.stats.resets++; }
  getStats() { return {...this.stats}; }
  private resize(width:number,height:number) { if(this.width===width&&this.height===height)return;this.releaseTargets();this.width=width;this.height=height;
    const create=(linear=false,type:THREE.TextureDataType=THREE.HalfFloatType)=>new THREE.WebGLRenderTarget(width,height,{type,depthBuffer:false,minFilter:linear?THREE.LinearFilter:THREE.NearestFilter,magFilter:linear?THREE.LinearFilter:THREE.NearestFilter});
    this.radiance=[create(true),create(true)];this.geometry=[create(false,THREE.FloatType),create(false,THREE.FloatType)];this.filtered=create(true);this.stats.allocations+=5;this.stats.width=width;this.stats.height=height;this.stats.bytes=width*height*56;this.reset(); }
  update(camera: THREE.Camera, time:number, raw:THREE.Texture, buffers:DenoiseBuffers, options:DenoiseOptions):THREE.Texture {
    if(this.disposed)throw Error("Denoiser disposed");this.resize(buffers.width,buffers.height);camera.updateMatrixWorld();
    const position=camera.getWorldPosition(new THREE.Vector3()),quaternion=camera.getWorldQuaternion(new THREE.Quaternion());
    const projectionChanged=this.previousProjection.elements.some((v,i)=>Math.abs(v-camera.projectionMatrix.elements[i])>1.e-6);
    const continuous=Number.isFinite(time)&&time>this.lastTime&&time-this.lastTime<=.1&&position.distanceTo(this.previousPosition)<=128&&Math.abs(quaternion.dot(this.previousQuaternion))>=Math.cos(THREE.MathUtils.degToRad(15)/2);
    const use=options.history&&this.valid&&continuous&&this.token===options.resetToken&&!projectionChanged;
    if(this.valid&&!use)this.stats.resets++;this.stats.historyUsed=use;this.stats.draws=0;
    const next=1-this.slot,restore=preserveHybridState(this.renderer);try{
      this.renderer.xr.enabled=false;this.renderer.setScissorTest(false);this.renderer.autoClear=false;this.renderer.toneMapping=THREE.NoToneMapping;
      const u=this.temporal.uniforms;u.rawGI.value=raw;u.currentNormal.value=buffers.normalDepth;u.currentDepth.value=buffers.depthTexture;u.previousGI.value=this.radiance[this.slot].texture;u.previousGeometry.value=this.geometry[this.slot].texture;u.texel.value.set(1/this.width,1/this.height);u.inverseVP.value.multiplyMatrices(camera.matrixWorld,camera.projectionMatrixInverse);u.historyEnabled.value=use?1:0;
      this.quad.material=this.temporal;this.renderer.setRenderTarget(this.radiance[next]);this.quad.render(this.renderer);this.stats.draws++;
      this.copy.uniforms.normalMap.value=buffers.normalDepth;this.copy.uniforms.depthMap.value=buffers.depthTexture;this.quad.material=this.copy;this.renderer.setRenderTarget(this.geometry[next]);this.quad.render(this.renderer);this.stats.draws++;
      const s=this.spatial.uniforms;s.sourceGI.value=this.radiance[next].texture;s.normalMap.value=buffers.normalDepth;s.depthMap.value=buffers.depthTexture;s.texel.value.set(1/this.width,1/this.height);s.inverseProjection.value.copy(camera.projectionMatrixInverse);this.quad.material=this.spatial;this.renderer.setRenderTarget(this.filtered);this.quad.render(this.renderer);this.stats.draws++;
      this.slot=next;this.valid=options.history;this.lastTime=time;this.token=options.resetToken;this.previousVP.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.previousView.copy(camera.matrixWorldInverse);this.previousProjection.copy(camera.projectionMatrix);this.previousPosition.copy(position);this.previousQuaternion.copy(quaternion);
      return this.filtered!.texture;
    }catch(error){this.reset();throw error;}finally{restore();}
  }
  private releaseTargets(){for(const t of [...this.radiance,...this.geometry])t.dispose();this.filtered?.dispose();this.radiance=[];this.geometry=[];this.filtered=null;this.valid=false;}
  dispose(){if(this.disposed)return;this.disposed=true;this.releaseTargets();this.temporal.dispose();this.copy.dispose();this.spatial.dispose();this.quad.dispose();this.stats.bytes=0;}
}
