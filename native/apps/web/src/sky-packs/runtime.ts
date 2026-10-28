import * as THREE from 'three';
import {HDRLoader} from 'three/examples/jsm/loaders/HDRLoader.js';
import {CUBE_FACES,skyBytes,skyHash,validateSkyPack,type SkyLighting,type SkyPack} from './manifest';
import {findSkyPack,watchSkies} from './folder';
export interface LoadedSky {id:string;version:string;format:'cube'|'equirect';texture:THREE.Texture;rotation:number;exposure:number;lighting?:SkyLighting;clouds?:SkyPack['clouds'];sha256:string;precision:'ldr'|'half-float'|'ldr-fallback'}
export interface SkyState {asset:LoadedSky|null;loading:boolean;error:string|null}
export async function loadSkyPack(pack:SkyPack,renderer:THREE.WebGLRenderer):Promise<LoadedSky>{
 await validateSkyPack(pack);const assets=pack.format==='cube'?CUBE_FACES.map(k=>pack.faces![k]):[pack.asset!];
 if(assets.some(a=>a.width>renderer.capabilities.maxTextureSize||a.height>renderer.capabilities.maxTextureSize))throw Error('Sky exceeds device texture dimensions');
 let texture:THREE.Texture|undefined;let precision:LoadedSky['precision']='ldr';const bitmaps:ImageBitmap[]=[];
 try{
  if(pack.format==='equirect'&&pack.asset!.mime==='image/vnd.radiance'){
   const bytes=skyBytes(pack.asset!);const half=typeof WebGL2RenderingContext!=="undefined" && renderer.getContext() instanceof WebGL2RenderingContext;
   const parsed=new HDRLoader().setDataType(half?THREE.HalfFloatType:THREE.FloatType).parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);
   let data=parsed.data as Uint16Array|Float32Array|Uint8Array;let type:THREE.TextureDataType=half?THREE.HalfFloatType:THREE.UnsignedByteType;
   if(!half){const float=data as Float32Array,ldr=new Uint8Array(float.length);for(let i=0;i<float.length;i++)ldr[i]=i%4===3?255:Math.round(255*Math.max(0,float[i]!)/(1+Math.max(0,float[i]!)));data=ldr;precision='ldr-fallback';}else precision='half-float';
   texture=new THREE.DataTexture(data,parsed.width,parsed.height,THREE.RGBAFormat,type);texture.flipY=true;texture.colorSpace=THREE.LinearSRGBColorSpace;texture.minFilter=texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;
  }else{
   for(const asset of assets){const bytes=skyBytes(asset);const bitmap=await createImageBitmap(new Blob([bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer],{type:asset.mime}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});if(bitmap.width!==asset.width||bitmap.height!==asset.height){bitmap.close();throw Error('Decoded sky dimensions differ');}bitmaps.push(bitmap);}
   texture=pack.format==='cube'?new THREE.CubeTexture(bitmaps):new THREE.Texture(bitmaps[0]);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=true;
   // ImageBitmap ignores Texture.flipY; explicitly orient equirect top row toward +Y.
   if(pack.format==='equirect'){const source=bitmaps[0]!;const flipped=await createImageBitmap(source,{imageOrientation:'flipY',colorSpaceConversion:'none',premultiplyAlpha:'none'});source.close();bitmaps[0]=flipped;texture.image=flipped;}
  }
  texture.mapping=pack.format==='cube'?THREE.CubeReflectionMapping:THREE.EquirectangularReflectionMapping;texture.wrapS=pack.format==='equirect'?THREE.RepeatWrapping:THREE.ClampToEdgeWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;texture.needsUpdate=true;
  const originalDispose=texture.dispose.bind(texture);let disposed=false;texture.dispose=()=>{if(disposed)return;disposed=true;originalDispose();for(const b of bitmaps)b.close();};
  const identity=new TextEncoder().encode(JSON.stringify({id:pack.id,version:pack.version,format:pack.format,hashes:assets.map(a=>a.sha256),rotation:pack.rotation??0,exposure:pack.exposure??0,lighting:pack.lighting,clouds:pack.clouds}));
  return{id:pack.id,version:pack.version,format:pack.format,texture,rotation:THREE.MathUtils.degToRad(pack.rotation??0),exposure:2**(pack.exposure??0),lighting:pack.lighting,clouds:pack.clouds,sha256:await skyHash(identity),precision};
 }catch(error){texture?.dispose();for(const b of bitmaps)b.close();throw error;}
}
export class SkyPackRuntime {
 private state:SkyState={asset:null,loading:false,error:null};private selected:string|null=null;private generation=0;private disposed=false;private pins=0;private queued:{id:string|null;force:boolean}|null=null;private disposeRequested=false;private pending:Promise<void>=Promise.resolve();private stop:()=>void;
 constructor(private renderer:THREE.WebGLRenderer,private services={find:findSkyPack,load:loadSkyPack,watch:watchSkies}){this.stop=this.services.watch((changed?:ReadonlySet<string>)=>{const id=this.queued?this.queued.id:this.selected;if(changed&&(!id||!changed.has(id)))return;this.select(id,true);});}
 select(id:string|null,force=false):void{
  if(this.disposed)return;if(this.pins){this.queued={id,force:force||!!this.queued?.force};return;}if(!force&&id===this.selected)return;this.selected=id;const generation=++this.generation;this.state.asset?.texture.dispose();this.state={asset:null,loading:!!id,error:null};if(!id){this.pending=Promise.resolve();return;}
  this.pending=(async()=>{let asset:LoadedSky|null=null;try{const pack=await this.services.find(id);if(!pack)throw Error('Selected sky pack is not installed');asset=await this.services.load(pack,this.renderer);if(this.disposed||generation!==this.generation){asset.texture.dispose();return;}this.state={asset,loading:false,error:null};}catch(error){asset?.texture.dispose();if(!this.disposed&&generation===this.generation)this.state={asset:null,loading:false,error:String((error as Error).message??error)};}})();
 }
 pin():void{if(this.disposed)throw Error('Sky runtime disposed');if(this.state.loading)throw Error('Await sky loading before export pin');this.pins++;}
 unpin():void{if(!this.pins)return;if(--this.pins)return;if(this.disposeRequested){this.dispose();return;}const queued=this.queued;this.queued=null;if(queued)this.select(queued.id,queued.force);}
 getState():SkyState{return{...this.state};}
 whenSettled():Promise<void>{return this.pending;}
 dispose():void{if(this.disposed)return;if(this.pins){this.disposeRequested=true;return;}this.disposed=true;++this.generation;this.stop();this.state.asset?.texture.dispose();this.state={asset:null,loading:false,error:null};}
}
