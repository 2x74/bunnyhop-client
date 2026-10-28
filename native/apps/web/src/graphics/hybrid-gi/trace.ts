import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { MeshBVH, MeshBVHUniformStruct, FloatVertexAttributeTexture } from "three-mesh-bvh";
import { HYBRID_TRACE_FRAGMENT } from "./trace-shader";
import type { HybridSnapshot, HybridLighting, HybridReceiver, HybridTraceOptions, HybridLocalLight } from "./types";

export function hybridLightingSignature(lighting:HybridLighting,state:"current"|"baseline"):string{
  const sun=state==="current"?lighting.currentSun:lighting.baselineSun,locals=state==="current"?lighting.currentLocal:lighting.baselineLocal;
  return JSON.stringify({sun:sun?.enabled&&sun.color.r+sun.color.g+sun.color.b>0?[sun.direction.toArray(),sun.color.toArray()]:null,lights:locals.slice(0,2).filter(l=>l.enabled&&l.intensity>0).map(l=>[l.id,l.position.toArray(),l.direction.toArray(),l.color.toArray(),l.intensity,l.range,l.kind,l.innerCos,l.outerCos]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))});
}
export function boundedDynamicBoxes(boxes:THREE.Box3[]):THREE.Box3[]{const valid=boxes.filter(b=>!b.isEmpty());if(valid.length<=16)return valid;const merged=new THREE.Box3();for(const box of valid.slice(15))merged.union(box);return [...valid.slice(0,15),merged];}
/** Optional live software-BVH diffuse delta transport, independent of the offline path tracer. */
export class TraceCore {
  readonly supported:boolean;
  private snapshot:HybridSnapshot|null=null;
  private geometry:THREE.BufferGeometry|null=null;
  private bvh:MeshBVHUniformStruct|null=null;
  private normal=new FloatVertexAttributeTexture();
  private uvMaterial=new FloatVertexAttributeTexture();
  private worker:Worker|null=null;
  private pendingCancel:(()=>void)|null=null;
  private disposed=false;
  private generation=0;
  private signature="";private previousTime:number|null=null;
  private target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  private uniforms={bvh:{value:null as MeshBVHUniformStruct|null},vertexNormal:{value:this.normal},vertexUVMaterial:{value:this.uvMaterial},materialTable:{value:null as THREE.Texture|null},albedoMaps:{value:null as THREE.Texture|null},receiverDepth:{value:null as THREE.Texture|null},receiverNormal:{value:null as THREE.Texture|null},inverseProjection:{value:new THREE.Matrix4()},cameraWorld:{value:new THREE.Matrix4()},resolution:{value:new THREE.Vector2(1,1)},rayRange:{value:256},sampleIndex:{value:0},dynamicCount:{value:0},dynamicMin:{value:Array.from({length:16},()=>new THREE.Vector3())},dynamicMax:{value:Array.from({length:16},()=>new THREE.Vector3())},sunDirection:{value:[new THREE.Vector3(),new THREE.Vector3()]},sunColor:{value:[new THREE.Color(0,0,0),new THREE.Color(0,0,0)]},sunEnabled:{value:[0,0]},lightPosition:{value:Array.from({length:4},()=>new THREE.Vector3())},lightDirection:{value:Array.from({length:4},()=>new THREE.Vector3())},lightColor:{value:Array.from({length:4},()=>new THREE.Color(0,0,0))},lightParams:{value:Array.from({length:4},()=>new THREE.Vector4())},lightFlags:{value:Array.from({length:4},()=>new THREE.Vector2())}};
  private material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,defines:{BVH_STACK_DEPTH:60},uniforms:this.uniforms,vertexShader:"out vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",fragmentShader:HYBRID_TRACE_FRAGMENT,depthTest:false,depthWrite:false,toneMapped:false});
  private quad=new FullScreenQuad(this.material);
  private stats={active:false,ready:false,status:"unprepared",error:null as string|null,width:0,height:0,triangles:0,materials:0,raysPerPixel:1,alphaQueriesPerRay:4,nodeVisitsPerQuery:256,maximumQueriesPerPixel:28,dynamicBounds:0,mergedDynamicBounds:0,buildMilliseconds:0,changedLighting:false};
  constructor(private renderer:THREE.WebGLRenderer){this.supported=renderer.extensions.has("EXT_color_buffer_float")&&renderer.capabilities.maxTextures>=12;}
  getStats(){return{...this.stats,supported:this.supported,mode:"authored-lighting-delta",samplers:10};}
  getSampling(){return{texture:this.target.texture,active:this.stats.active,width:this.stats.width,height:this.stats.height};}
  async prepare(snapshot:HybridSnapshot,signal?:AbortSignal):Promise<void>{
    if(this.disposed)throw Error("TraceCore disposed");if(!this.supported)throw Error("Hybrid tracing unsupported");if(signal?.aborted)throw new DOMException("Aborted","AbortError");
    this.pendingCancel?.();const generation=++this.generation;this.stats.active=false;this.stats.ready=false;this.stats.status="building";
    const position=snapshot.geometry.getAttribute("position"),index=snapshot.geometry.index,normal=snapshot.geometry.getAttribute("normal"),uv=snapshot.geometry.getAttribute("uv"),materialIndex=snapshot.geometry.getAttribute("materialIndex");
    if(!index||!position||!normal||!uv||!materialIndex||position.count===0||index.count%3!==0||normal.count!==position.count||uv.count!==position.count||materialIndex.count!==position.count||index.count/3>500000||snapshot.materialCount<1||snapshot.materialCount>64||snapshot.geometry.groups.length>0||snapshot.materialTexture.image.width!==4||snapshot.materialTexture.image.height!==snapshot.materialCount)throw Error("Hybrid snapshot exceeds bounds or required attribute contract");
    let pendingGPU:MeshBVHUniformStruct|null=null;const geometry=new THREE.BufferGeometry(),positions=new Float32Array(position.count*3),indices=new Uint32Array(index.count);for(let i=0;i<position.count;i++)positions.set([position.getX(i),position.getY(i),position.getZ(i)],i*3);for(let i=0;i<index.count;i++)indices[i]=index.getX(i);
    const started=performance.now();const worker=new Worker(new URL("./bvh.worker.ts",import.meta.url),{type:"module"});this.worker=worker;
    try{
      const built=await new Promise<{serialized:Parameters<typeof MeshBVH.deserialize>[0];position:Float32Array;index:Uint32Array}>((resolve,reject)=>{
        const cleanup=()=>{signal?.removeEventListener("abort",cancel);this.pendingCancel=null;};
        const cancel=()=>{worker.terminate();cleanup();reject(new DOMException("Aborted","AbortError"));};this.pendingCancel=cancel;signal?.addEventListener("abort",cancel,{once:true});
        worker.onmessage=event=>{cleanup();event.data.error?reject(Error(event.data.error)):resolve(event.data);};worker.onerror=event=>{cleanup();reject(Error(event.message));};worker.postMessage({position:positions,index:indices},[positions.buffer,indices.buffer]);
      });
      if(generation!==this.generation||this.disposed||signal?.aborted)throw new DOMException("Aborted","AbortError");if(!snapshot.validate())throw Error("Scene changed while hybrid BVH was building");
      geometry.setAttribute("position",new THREE.BufferAttribute(built.position,3));geometry.setIndex(new THREE.BufferAttribute(built.index,1));const tree=MeshBVH.deserialize(built.serialized,geometry,{setIndex:false});const gpu=new MeshBVHUniformStruct();pendingGPU=gpu;gpu.updateFrom(tree);
      const packed=new Float32Array(position.count*3);for(let i=0;i<position.count;i++)packed.set([uv.getX(i),uv.getY(i),materialIndex.getX(i)],i*3);
      const normals=new Float32Array(position.count*3);for(let i=0;i<position.count;i++)normals.set([normal.getX(i),normal.getY(i),normal.getZ(i)],i*3);
      this.normal.updateFrom(new THREE.BufferAttribute(normals,3));this.uvMaterial.updateFrom(new THREE.BufferAttribute(packed,3));this.bvh?.dispose();this.geometry?.dispose();this.bvh=gpu;pendingGPU=null;this.geometry=geometry;this.snapshot=snapshot;this.previousTime=null;
      this.uniforms.bvh.value=gpu;this.uniforms.materialTable.value=snapshot.materialTexture;this.uniforms.albedoMaps.value=snapshot.albedoMaps;Object.assign(this.stats,{ready:true,status:"ready",error:null,triangles:index.count/3,materials:snapshot.materialCount,buildMilliseconds:performance.now()-started});
    }catch(error){pendingGPU?.dispose();geometry.dispose();if(generation===this.generation){this.stats.status="failed";this.stats.error=error instanceof Error?error.message:String(error);}throw error;}finally{worker.terminate();if(this.worker===worker)this.worker=null;}
  }
  private setLight(light:HybridLocalLight|undefined,index:number){this.uniforms.lightFlags.value[index].set(light?.enabled?1:0,light?.kind==="spot"?1:0);if(!light)return;this.uniforms.lightPosition.value[index].copy(light.position);this.uniforms.lightDirection.value[index].copy(light.direction).normalize();this.uniforms.lightColor.value[index].copy(light.color);this.uniforms.lightParams.value[index].set(Math.max(0,light.intensity),Math.max(0,light.range),light.innerCos,light.outerCos);}
  setSize(width:number,height:number){this.stats.width=Math.max(1,Math.min(320,Math.floor(width)));this.stats.height=Math.max(1,Math.min(180,Math.floor(height)));}
  update(camera:THREE.PerspectiveCamera,timeSeconds:number,receiver:HybridReceiver,lighting:HybridLighting,options:HybridTraceOptions={}){
    this.stats.active=false;if(this.disposed||!this.stats.ready||!this.snapshot)return this.getSampling();
    if(!this.snapshot.validate()){this.stats.status="invalid-scene";this.stats.error="Static geometry/material changed; rebuild required";return this.getSampling();}
    const changed=hybridLightingSignature(lighting,"current")!==hybridLightingSignature(lighting,"baseline");this.stats.changedLighting=changed;
    if(!changed){this.stats.status="zero-delta";if(this.signature){const r=this.renderer,t=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),color=r.getClearColor(new THREE.Color()),alpha=r.getClearAlpha();try{r.setRenderTarget(this.target);r.setClearColor(0,0);r.clear();}finally{r.setClearColor(color,alpha);r.setRenderTarget(t,face,mip);}}this.signature="";return this.getSampling();}this.signature="active";
    const width=Math.max(1,Math.min(320,Math.floor(Number.isFinite(options.width)?options.width!:320))),height=Math.max(1,Math.min(180,Math.floor(Number.isFinite(options.height)?options.height!:180)));this.target.setSize(width,height);this.uniforms.resolution.value.set(width,height);
    this.uniforms.receiverDepth.value=receiver.depth;this.uniforms.receiverNormal.value=receiver.normal;this.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);this.uniforms.cameraWorld.value.copy(camera.matrixWorld);this.uniforms.rayRange.value=THREE.MathUtils.clamp(Number.isFinite(options.range)?options.range!:256,16,2048);this.uniforms.sampleIndex.value=Number.isFinite(options.sampleIndex??timeSeconds*60)?Math.floor(options.sampleIndex??timeSeconds*60):0;
    for(let state=0;state<2;state++){const sun=state===0?lighting.currentSun:lighting.baselineSun;this.uniforms.sunEnabled.value[state]=sun?.enabled?1:0;if(sun){this.uniforms.sunDirection.value[state].copy(sun.direction).normalize();this.uniforms.sunColor.value[state].copy(sun.color);}const locals=state===0?lighting.currentLocal:lighting.baselineLocal;for(let i=0;i<2;i++)this.setLight(locals[i],state*2+i);}
    const resetBounds=options.sampleIndex===0||this.previousTime===null||timeSeconds<this.previousTime||timeSeconds-this.previousTime>.1;this.previousTime=timeSeconds;const originalBoxes=this.snapshot.dynamicBounds(resetBounds);if(originalBoxes.some(box=>[...box.min.toArray(),...box.max.toArray()].some(value=>!Number.isFinite(value)))){this.stats.status="invalid-dynamic-bounds";this.stats.error="Moving geometry bounds are nonfinite";return this.getSampling();}const boxes=boundedDynamicBoxes(originalBoxes);this.uniforms.dynamicCount.value=boxes.length;boxes.forEach((b,i)=>{this.uniforms.dynamicMin.value[i].copy(b.min);this.uniforms.dynamicMax.value[i].copy(b.max);});
    const r=this.renderer,target=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),viewport=r.getViewport(new THREE.Vector4()),scissor=r.getScissor(new THREE.Vector4()),test=r.getScissorTest(),autoReset=r.info.autoReset,xr=r.xr.enabled;
    try{r.info.autoReset=false;r.xr.enabled=false;r.setRenderTarget(this.target);r.setScissorTest(false);this.quad.render(r);Object.assign(this.stats,{active:true,status:"active",error:null,width,height,dynamicBounds:originalBoxes.length,mergedDynamicBounds:Math.max(0,originalBoxes.length-16)});}catch(error){this.stats.status="failed";this.stats.error=error instanceof Error?error.message:String(error);}finally{r.info.autoReset=autoReset;r.xr.enabled=xr;r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(test);r.setRenderTarget(target,face,mip);}
    return this.getSampling();
  }
  dispose(){if(this.disposed)return;this.disposed=true;++this.generation;this.pendingCancel?.();this.worker?.terminate();this.worker=null;this.bvh?.dispose();this.geometry?.dispose();this.normal.dispose();this.uvMaterial.dispose();this.target.dispose();this.material.dispose();this.quad.dispose();this.snapshot=null;this.stats.active=false;this.stats.ready=false;this.stats.status="disposed";}
}
