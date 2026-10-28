import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
export interface CinematicSample { time:number; jitter:[number,number] }
function radicalInverse(index:number,base:number):number{let value=0,scale=1/base;while(index>0){value+=(index%base)*scale;index=Math.floor(index/base);scale/=base;}return value;}
/** Centered stratified replay subframes; shutter zero provides antialiasing without time blur. */
export function cinematicSampleSchedule(time:number,fps:number,options:{samples?:number;shutterAngle?:number}={}):CinematicSample[]{
  const count=options.samples===8?8:options.samples===4?4:options.samples===2?2:1;
  const shutter=Math.max(0,Math.min(180,options.shutterAngle??0))/360/Math.max(1,fps);
  const offsets=Array.from({length:count},(_,i)=>[radicalInverse(i+1,2)-.5,radicalInverse(i+1,3)-.5] as [number,number]);
  const center=offsets.reduce((sum,v)=>[sum[0]+v[0]/count,sum[1]+v[1]/count] as [number,number],[0,0] as [number,number]);
  return offsets.map((jitter,i)=>({time:Math.max(0,time+((i+.5)/count-.5)*shutter),jitter:count===1?[0,0]:[jitter[0]-center[0],jitter[1]-center[1]]}));
}
export function withCameraJitter<T>(camera:THREE.PerspectiveCamera,width:number,height:number,jitter:[number,number],draw:()=>T):T{
  const view=camera.view?{...camera.view}:null;
  const projection=camera.projectionMatrix.clone(),inverse=camera.projectionMatrixInverse.clone();
  if(view?.enabled)camera.setViewOffset(view.fullWidth,view.fullHeight,view.offsetX+jitter[0],view.offsetY+jitter[1],view.width,view.height);
  else camera.setViewOffset(width,height,jitter[0],jitter[1],width,height);
  try{return draw();}finally{camera.view=view;camera.projectionMatrix.copy(projection);camera.projectionMatrixInverse.copy(inverse);}
}
const vertexShader="varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}";
/** Linear HDR accumulation belongs immediately before OutputPass; reset for each exported frame. */
export class TemporalAccumulationPass extends Pass{
  private target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  private count=1;private index=0;private expected=0;private frame=false;
  private add=new THREE.ShaderMaterial({uniforms:{map:{value:null},weight:{value:1}},vertexShader,fragmentShader:"uniform sampler2D map;uniform float weight;varying vec2 vUv;void main(){gl_FragColor=texture2D(map,vUv)*weight;}",transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor,blendEquation:THREE.AddEquation,depthTest:false,depthWrite:false});
  private copy=new THREE.ShaderMaterial({uniforms:{map:{value:this.target.texture}},vertexShader,fragmentShader:"uniform sampler2D map;varying vec2 vUv;void main(){gl_FragColor=texture2D(map,vUv);}",depthTest:false,depthWrite:false});
  private quad=new FullScreenQuad(this.add);
  constructor(){super();this.enabled=false;}
  beginFrame(samples:number):void{if(![1,2,4,8].includes(samples))throw new Error("Cinematic accumulation supports 1, 2, 4 or 8 samples");this.count=samples;this.expected=0;this.frame=true;this.enabled=true;}
  beginSample(index:number):void{if(!this.frame||index!==this.expected||index>=this.count)throw new Error("Cinematic samples must render in increasing order");this.index=index;}
  endFrame():void{if(this.expected!==this.count)throw new Error("Cinematic frame is incomplete");this.reset();}
  reset():void{this.frame=false;this.enabled=false;this.expected=0;}
  setSize(width:number,height:number):void{this.target.setSize(Math.max(1,width),Math.max(1,height));this.reset();}
  render(renderer:THREE.WebGLRenderer,write:THREE.WebGLRenderTarget,read:THREE.WebGLRenderTarget):void{
    if(!this.frame||this.index!==this.expected)throw new Error("Cinematic sample not scheduled");
    const target=renderer.getRenderTarget(),clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha(),autoClear=renderer.autoClear;
    try{renderer.autoClear=false;renderer.setRenderTarget(this.target);if(this.index===0){renderer.setClearColor(0,0);renderer.clear(true,false,false);}this.add.uniforms.map.value=read.texture;this.add.uniforms.weight.value=1/this.count;this.quad.material=this.add;this.quad.render(renderer);this.quad.material=this.copy;renderer.setRenderTarget(this.renderToScreen?null:write);this.quad.render(renderer);this.expected++;}finally{renderer.setRenderTarget(target);renderer.setClearColor(clear,alpha);renderer.autoClear=autoClear;}
  }
  dispose():void{this.reset();this.target.dispose();this.add.dispose();this.copy.dispose();this.quad.dispose();}
}
/** Official Three FXAA shader, operating on final output-space colors immediately after OutputPass. */
export function createSpatialAAPass(width:number,height:number):ShaderPass{const pass=new ShaderPass(FXAAShader);pass.uniforms.resolution.value.set(1/Math.max(1,width),1/Math.max(1,height));return pass;}
