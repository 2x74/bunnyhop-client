import * as THREE from "three";
import { SHADOW_FILTER_GLSL } from "./shadow-filter";
import { ShadowCasters, ShadowTransmission } from "./shadow-casters";
import type { AuthoredLocalLight } from "./authored-lights";
export interface LocalLightOptions { quality?: "low"|"medium"|"high"; budget?: number; strength?: number }
export interface LocalLightSampling { light: AuthoredLocalLight; texture: THREE.Texture; matrices: THREE.Matrix4[]; faceSize: number; atlasSize: THREE.Vector2; bias: number }
/** Shared dynamic irradiance evaluation for beauty and GI donor capture. All inputs are linear/world-space. */
export const LOCAL_LIGHT_DECLARATIONS = /* glsl */`
#ifndef LOCAL_LIGHTS_DECLARED
#define LOCAL_LIGHTS_DECLARED
#include <packing>
${SHADOW_FILTER_GLSL}
uniform int uLocalCount;
uniform vec3 uLocalPosition[2],uLocalDirection[2],uLocalColor[2];
uniform float uLocalRange[2],uLocalIntensity[2],uLocalKind[2],uLocalWorld[2],uLocalModels[2];
uniform vec2 uLocalCone[2],uLocalAtlasSize[2];
uniform mat4 uLocalMatrix[12];
uniform sampler2D uLocalMap0,uLocalMap1;
uniform float uLocalBias,uLocalShadowRadius;
uniform sampler2D uLocalT00,uLocalT01,uLocalT10,uLocalT11;
vec3 localTransmission(int i,vec2 at,float receiver){vec3 transmission=vec3(1.);
vec4 a=i==0?texture2D(uLocalT00,at):texture2D(uLocalT10,at),b=i==0?texture2D(uLocalT01,at):texture2D(uLocalT11,at);if(receiver>a.a)transmission*=a.rgb;if(receiver>b.a)transmission*=b.rgb;return transmission;}

int localFace(vec3 p){vec3 a=abs(p);if(a.x>=a.y&&a.x>=a.z)return p.x>0.?0:1;if(a.y>=a.z)return p.y>0.?2:3;return p.z>0.?4:5;}
vec3 localVisibility(int i,vec3 world){int face=uLocalKind[i]<.5?localFace(world-uLocalPosition[i]):0;vec4 p=uLocalMatrix[i*6+face]*vec4(world,1.);vec3 uv=p.xyz/p.w;
  if(p.w<=0.||any(lessThan(uv,vec3(0.)))||any(greaterThan(uv,vec3(1.))))return vec3(0.);
  vec2 grid=uLocalKind[i]<.5?vec2(3.,2.):vec2(1.);vec2 tile=vec2(float(face-(face/3)*3),float(face/3));
  vec2 at=(uv.xy+tile)/grid,texel=1./uLocalAtlasSize[i];vec2 lo=tile/grid+texel*.5,hi=(tile+1.)/grid-texel*.5;
  float bias=uLocalBias;vec2 gradient=stableShadowDepthGradient(vec3(at,uv.z));vec3 sum=vec3(0.);float weight=0.;
  for(int y=-1;y<=2;y++)for(int x=-1;x<=2;x++){vec3 tap=stableShadowTap(at,texel,ivec2(x,y),uLocalShadowRadius);if(tap.z<=0.)continue;vec2 q=clamp(tap.xy,lo,hi);float receiver=uv.z+dot(gradient,q-at)-bias;float z=i==0?unpackRGBAToDepth(texture2D(uLocalMap0,q)):unpackRGBAToDepth(texture2D(uLocalMap1,q));sum+=step(receiver,z)*localTransmission(i,q,receiver)*tap.z;weight+=tap.z;}
  return sum/max(weight,.00001);
}
vec3 localDirectRadianceFor(vec3 world,vec3 normal,float model){vec3 result=vec3(0.);for(int i=0;i<2;i++){if(i>=uLocalCount)break;
  float role=model>.5?uLocalModels[i]:uLocalWorld[i];if(role<.5)continue;
  vec3 delta=uLocalPosition[i]-world;float distance=length(delta);if(distance>=uLocalRange[i])continue;vec3 direction=delta/max(distance,.001);
  float diffuse=max(dot(normal,direction),0.);float fade=pow(max(0.,1.-distance/uLocalRange[i]),2.);
  float attenuation=fade/(1.+pow(distance/max(uLocalRange[i]*.15,1.),2.));
  float cone=uLocalKind[i]>.5?smoothstep(uLocalCone[i].y,uLocalCone[i].x,dot(-direction,uLocalDirection[i])):1.;
  result+=uLocalColor[i]*uLocalIntensity[i]*diffuse*attenuation*cone*role*localVisibility(i,world);
}return result;}
vec3 localDirectRadiance(vec3 world,vec3 normal){return localDirectRadianceFor(world,normal,0.);}
#endif
`;
const FACE_DIRECTIONS=[new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1)];
const FACE_UP=[new THREE.Vector3(0,-1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,-1,0)];
let programId=0;
/** One/two nearest authored lights, fixed bounded maps; scene transforms are sampled on every actual draw. */
export class LocalLights {
  private id=++programId;
  private casters=new ShadowCasters();
  private transmission=[new ShadowTransmission(),new ShadowTransmission()];
  private targets:(THREE.WebGLRenderTarget|null)[]=[null,null];
  private camera=new THREE.PerspectiveCamera();
  private patched=new Map<THREE.MeshBasicMaterial,{previous:THREE.Material["onBeforeCompile"];key:()=>string;hook:THREE.Material["onBeforeCompile"]}>();
  private uniforms={uLocalCount:{value:0},uLocalPosition:{value:[new THREE.Vector3(),new THREE.Vector3()]},uLocalDirection:{value:[new THREE.Vector3(),new THREE.Vector3()]},uLocalColor:{value:[new THREE.Color(),new THREE.Color()]},uLocalRange:{value:[1,1]},uLocalIntensity:{value:[0,0]},uLocalKind:{value:[0,0]},uLocalWorld:{value:[1,1]},uLocalModels:{value:[1,1]},uLocalCone:{value:[new THREE.Vector2(),new THREE.Vector2()]},uLocalAtlasSize:{value:[new THREE.Vector2(1,1),new THREE.Vector2(1,1)]},uLocalMatrix:{value:Array.from({length:12},()=>new THREE.Matrix4())},uLocalMap0:{value:null as THREE.Texture|null},uLocalMap1:{value:null as THREE.Texture|null},uLocalShadowRadius:{value:2},uLocalBias:{value:.00004},uLocalT00:{value:null as THREE.Texture|null},uLocalT01:{value:null as THREE.Texture|null},uLocalT10:{value:null as THREE.Texture|null},uLocalT11:{value:null as THREE.Texture|null}};
  private sampling:LocalLightSampling[]=[];
  private stats={selected:0,point:0,spot:0,faces:0,draws:0,triangles:0,faceSize:0,allocations:0};
  private disposed=false;
  constructor(private renderer:THREE.WebGLRenderer){}
  getUniforms(){return this.uniforms;}
  getSampling(){return this.sampling;}
  getStats(){return {...this.stats,filter:"continuous-tent",filterTaps:this.uniforms.uLocalShadowRadius.value===1?4:16};}
  private patch(scene:THREE.Scene){scene.traverse(object=>{
    if(!(object instanceof THREE.Mesh)||object.renderOrder< -900||object.userData.sunShadowOnly||object.geometry.getAttribute("center")||!object.layers.test(new THREE.Layers()))return;
    const model=object.name.includes("prop")||object instanceof THREE.SkinnedMesh;
    for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(!(material instanceof THREE.MeshBasicMaterial)||!material.colorWrite||!material.depthWrite||material.transparent||material.userData.sourceUnlit||this.patched.has(material))continue;
      const previous=material.onBeforeCompile,key=material.customProgramCacheKey;
      const hook:THREE.Material["onBeforeCompile"]=(shader,renderer)=>{previous.call(material,shader,renderer);Object.assign(shader.uniforms,this.uniforms);
        shader.vertexShader=shader.vertexShader.replace("#include <common>","#include <common>\nvarying vec3 vLocalWorld,vLocalNormal;").replace("#include <project_vertex>",`#include <project_vertex>
        vec4 localWorld=vec4(transformed,1.);vec3 localNormal=normal;
        #ifdef USE_SKINNING
        localNormal=objectNormal;
        #endif
        #ifdef USE_BATCHING
        localWorld=batchingMatrix*localWorld;localNormal=mat3(batchingMatrix)*localNormal;
        #endif
        #ifdef USE_INSTANCING
        localWorld=instanceMatrix*localWorld;mat3 localInstance=mat3(instanceMatrix);localNormal/=vec3(dot(localInstance[0],localInstance[0]),dot(localInstance[1],localInstance[1]),dot(localInstance[2],localInstance[2]));localNormal=localInstance*localNormal;
        #endif
        vLocalWorld=(modelMatrix*localWorld).xyz;vLocalNormal=inverseTransformDirection(normalize(normalMatrix*localNormal),viewMatrix);`);
        // Definitions must precede both local and existing sun helper functions.
        shader.fragmentShader=shader.fragmentShader.replaceAll("#include <packing>", "");
        const declarations=LOCAL_LIGHT_DECLARATIONS;
        shader.fragmentShader=shader.fragmentShader.replace("#include <common>",`#include <common>\nvarying vec3 vLocalWorld,vLocalNormal;\n${declarations}`).replace("#include <opaque_fragment>",`outgoingLight+=diffuseColor.rgb*localDirectRadianceFor(vLocalWorld,normalize(vLocalNormal)*(gl_FrontFacing?1.:-1.),${model?"1.":"0."});\n#include <opaque_fragment>`);
      };
      this.patched.set(material,{previous,key,hook});material.onBeforeCompile=hook;material.customProgramCacheKey=()=>`${key.call(material)}+local-lights-${this.id}`;material.needsUpdate=true;
    }
  });}
  update(scene:THREE.Scene,view:THREE.Camera,options:LocalLightOptions={}){
    this.uniforms.uLocalCount.value=0;this.sampling=[];Object.assign(this.stats,{selected:0,point:0,spot:0,faces:0,draws:0,triangles:0});
    if(this.disposed||this.renderer.capabilities.maxTextureSize<384)return;
    const authored:AuthoredLocalLight[]=[];scene.traverse(o=>{if(o.userData.authoredLocalLights)authored.push(...o.userData.authoredLocalLights)});
    const position=view.getWorldPosition(new THREE.Vector3());view.updateMatrixWorld();const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(view.projectionMatrix,view.matrixWorldInverse));
    const selected=authored.filter(l=>l.enabled&&l.intensity>0&&(l.worldEnabled||l.modelsEnabled)&&l.position.distanceTo(position)<l.range+1536&&frustum.intersectsSphere(new THREE.Sphere(l.position,l.range))).sort((a,b)=>a.position.distanceToSquared(position)-b.position.distanceToSquared(position)||a.id-b.id).slice(0,options.budget===2?2:1);
    if(!selected.length){this.targets.forEach(t=>t?.dispose());this.targets=[null,null];this.uniforms.uLocalMap0.value=this.uniforms.uLocalMap1.value=null;return;}
    this.patch(scene);this.uniforms.uLocalShadowRadius.value=options.quality==="low"?1:2;
    const size=Math.min(options.quality==="high"?512:options.quality==="low"?128:256,Math.floor(this.renderer.capabilities.maxTextureSize/3));this.stats.faceSize=size;
    const renderer=this.renderer,target=renderer.getRenderTarget(),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest(),clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha(),autoClear=renderer.autoClear,xr=renderer.xr.enabled,background=scene.background,infoReset=renderer.info.autoReset,calls=renderer.info.render.calls,triangles=renderer.info.render.triangles;
    try{renderer.autoClear=false;renderer.xr.enabled=false;renderer.info.autoReset=false;scene.background=null;
      selected.forEach((light,slot)=>{
        const faces=light.kind==="point"?6:1,w=size*(faces===6?3:1),h=size*(faces===6?2:1);
        let capture=this.targets[slot];if(!capture||capture.width!==w||capture.height!==h){capture?.dispose();capture=new THREE.WebGLRenderTarget(w,h,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});this.targets[slot]=capture;this.stats.allocations++;}
        renderer.setRenderTarget(capture);renderer.setViewport(0,0,w/renderer.getPixelRatio(),h/renderer.getPixelRatio());renderer.setScissorTest(false);renderer.setClearColor(0xffffff,1);renderer.clear(true,true,false);
        const matrices:THREE.Matrix4[]=[];
        for(let face=0;face<faces;face++){
          this.camera.fov=faces===6?90:Math.acos(light.outerCos)*360/Math.PI;this.camera.aspect=1;this.camera.near=1;this.camera.far=light.range;this.camera.position.copy(light.position);this.camera.up.copy(faces===6?FACE_UP[face]:Math.abs(light.direction.y)>.98?new THREE.Vector3(0,0,1):new THREE.Vector3(0,1,0));this.camera.lookAt(light.position.clone().add(faces===6?FACE_DIRECTIONS[face]:light.direction));this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
          const matrix=this.uniforms.uLocalMatrix.value[slot*6+face];matrix.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1).multiply(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);matrices.push(matrix);
          const x=faces===6?(face%3)*size:0,y=faces===6?Math.floor(face/3)*size:0;const ratio=renderer.getPixelRatio();renderer.setViewport(x/ratio,y/ratio,size/ratio,size/ratio);renderer.setScissor(x/ratio,y/ratio,size/ratio,size/ratio);renderer.setScissorTest(true);
          this.casters.run(scene,()=>renderer.render(scene,this.camera));
          const transmissionSize=Math.min(size,128),tx=faces===6?(face%3)*transmissionSize:0,ty=faces===6?Math.floor(face/3)*transmissionSize:0;
          this.transmission[slot].render(renderer,scene,this.camera,transmissionSize,{viewport:new THREE.Vector4(tx,ty,transmissionSize,transmissionSize),width:transmissionSize*(faces===6?3:1),height:transmissionSize*(faces===6?2:1)});
          renderer.setRenderTarget(capture);
        }
        this.uniforms.uLocalPosition.value[slot].copy(light.position);this.uniforms.uLocalDirection.value[slot].copy(light.direction);this.uniforms.uLocalColor.value[slot].copy(light.color);this.uniforms.uLocalRange.value[slot]=light.range;this.uniforms.uLocalIntensity.value[slot]=light.intensity*THREE.MathUtils.clamp(options.strength??.2,0,.5);this.uniforms.uLocalKind.value[slot]=faces===6?0:1;this.uniforms.uLocalWorld.value[slot]=+light.worldEnabled;this.uniforms.uLocalModels.value[slot]=+light.modelsEnabled;this.uniforms.uLocalCone.value[slot].set(light.innerCos,light.outerCos);this.uniforms.uLocalAtlasSize.value[slot].set(w,h);
        const layers=this.transmission[slot].targets;
        if(slot===0){this.uniforms.uLocalT00.value=layers[0].texture;this.uniforms.uLocalT01.value=layers[1].texture;}
        else{this.uniforms.uLocalT10.value=layers[0].texture;this.uniforms.uLocalT11.value=layers[1].texture;}
        (slot===0?this.uniforms.uLocalMap0:this.uniforms.uLocalMap1).value=capture.texture;this.sampling.push({light,texture:capture.texture,matrices,faceSize:size,atlasSize:new THREE.Vector2(w,h),bias:this.uniforms.uLocalBias.value});this.stats.faces+=faces;faces===6?this.stats.point++:this.stats.spot++;
      });
      this.uniforms.uLocalCount.value=selected.length;this.stats.selected=selected.length;this.stats.draws=renderer.info.render.calls-calls;this.stats.triangles=renderer.info.render.triangles-triangles;
      for(let slot=selected.length;slot<2;slot++){this.targets[slot]?.dispose();this.targets[slot]=null;(slot===0?this.uniforms.uLocalMap0:this.uniforms.uLocalMap1).value=null;}
    }catch(error){this.uniforms.uLocalCount.value=0;this.sampling=[];console.warn("Local lights unavailable; using baked lighting",error)}finally{scene.background=background;renderer.setRenderTarget(target);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.setClearColor(clear,alpha);renderer.autoClear=autoClear;renderer.xr.enabled=xr;renderer.info.autoReset=infoReset;}
  }
  dispose(){this.disposed=true;this.uniforms.uLocalCount.value=0;this.uniforms.uLocalMap0.value=this.uniforms.uLocalMap1.value=null;this.targets.forEach(t=>t?.dispose());this.targets=[null,null];this.casters.dispose();this.transmission.forEach(t=>t.dispose());for(const [m,p]of this.patched)if(m.onBeforeCompile===p.hook){m.onBeforeCompile=p.previous;m.customProgramCacheKey=p.key;m.dispose();m.needsUpdate=true;}this.patched.clear();this.sampling=[];}
}
