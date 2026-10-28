import {validateAssetHeader, type PackAsset} from '../texture-packs/manifest';
export type SkyAsset = {mime:'image/png'|'image/webp'|'image/vnd.radiance';sha256:string;width:number;height:number;data:string};
export interface SkyLighting {sun?:{direction:[number,number,number];color:[number,number,number];intensity:number};ambient?:{color:[number,number,number];intensity:number}}
export interface SkyPack {schemaVersion:1;kind:'bunnyhop-sky';id:string;name:string;version:string;description?:string;format:'cube'|'equirect';asset?:SkyAsset;faces?:Record<CubeFace,SkyAsset>;rotation?:number;exposure?:number;lighting?:SkyLighting;clouds?:'clear'|'sparse'|'photographic';provenance?:unknown}
export const CUBE_FACES=['px','nx','py','ny','pz','nz'] as const;export type CubeFace=typeof CUBE_FACES[number];
export const SKY_LIMITS={dimension:4096,cubeDimension:2048,compressed:32*1024**2,decoded:64*1024**2,file:45*1024**2};
export function skyBytes(asset:SkyAsset):Uint8Array {if(!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)||asset.data.length%4)throw Error('Invalid sky base64');return Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));}
export async function skyHash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer)),v=>v.toString(16).padStart(2,'0')).join('');}
export function hdrDimensions(bytes:Uint8Array):[number,number]{const header=new TextDecoder('ascii').decode(bytes.subarray(0,Math.min(8192,bytes.length)));if(!/^#\?(RADIANCE|RGBE)\r?\n/.test(header)||!header.includes('FORMAT=32-bit_rle_rgbe'))throw Error('Unsupported Radiance header');const m=header.match(/\n-Y (\d+) \+X (\d+)\r?\n/);if(!m)throw Error('Only canonical -Y +X HDR orientation is supported');return[Number(m[2]),Number(m[1])];}
const finite=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
function color(c:unknown):boolean{return Array.isArray(c)&&c.length===3&&c.every(n=>finite(n,0,16));}
export async function validateSkyPack(input:unknown,signal?:AbortSignal):Promise<SkyPack>{
 const encoded=JSON.stringify(input);if(!encoded||encoded.length>SKY_LIMITS.file||new TextEncoder().encode(encoded).length>SKY_LIMITS.file)throw Error('Sky manifest exceeds file budget');
 const p=input as SkyPack;if(!p||p.schemaVersion!==1||p.kind!=='bunnyhop-sky'||!['cube','equirect'].includes(p.format)||typeof p.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id)||typeof p.name!=='string'||!p.name.length||p.name.length>100||typeof p.version!=='string'||!p.version.length||p.version.length>40)throw Error('Invalid sky pack manifest');
 if(p.description!==undefined&&(typeof p.description!=='string'||p.description.length>2000)||p.clouds!==undefined&&!['clear','sparse','photographic'].includes(p.clouds)||p.provenance!==undefined&&JSON.stringify(p.provenance).length>16384)throw Error('Invalid sky metadata');
 if(p.rotation!==undefined&&!finite(p.rotation,-360,360)||p.exposure!==undefined&&!finite(p.exposure,-8,8))throw Error('Invalid sky rotation/exposure');
 if(p.lighting){const s=p.lighting.sun,a=p.lighting.ambient;if(s&&(!Array.isArray(s.direction)||s.direction.length!==3||!s.direction.every(n=>finite(n,-1,1))||Math.hypot(...s.direction)<.99||Math.hypot(...s.direction)>1.01||!color(s.color)||!finite(s.intensity,0,8)))throw Error('Invalid sky sun metadata');if(a&&(!color(a.color)||!finite(a.intensity,0,2)))throw Error('Invalid sky ambient metadata');}
 let assets:SkyAsset[];if(p.format==='cube'){if(!p.faces||p.asset||Object.keys(p.faces).length!==6)throw Error('Cube sky requires exactly six faces');assets=CUBE_FACES.map(k=>p.faces![k]);}else{if(!p.asset||p.faces)throw Error('Equirect sky requires one asset');assets=[p.asset];}
 let compressed=0,decoded=0;for(const asset of assets){signal?.throwIfAborted();if(!asset||typeof asset.data!=='string'||!['image/png','image/webp','image/vnd.radiance'].includes(asset.mime)||!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isInteger(asset.width)||!Number.isInteger(asset.height)||asset.width<1||asset.height<1||asset.width>SKY_LIMITS.dimension||asset.height>SKY_LIMITS.dimension)throw Error('Invalid sky image');
  if(p.format==='cube'&&(asset.mime==='image/vnd.radiance'||asset.width!==asset.height||asset.width>SKY_LIMITS.cubeDimension||asset.width!==assets[0]!.width))throw Error('Cube faces must be matching square LDR images');
  if(p.format==='equirect'&&asset.width!==2*asset.height)throw Error('Equirect sky must have 2:1 aspect');
  compressed+=Math.ceil(asset.data.length*3/4);decoded+=asset.width*asset.height*(asset.mime==='image/vnd.radiance'?16:4)*4/3;if(compressed>SKY_LIMITS.compressed||decoded>SKY_LIMITS.decoded)throw Error('Sky pack exceeds memory budget');
  const bytes=skyBytes(asset);if(asset.mime==='image/vnd.radiance'){const [w,h]=hdrDimensions(bytes);if(w!==asset.width||h!==asset.height)throw Error('HDR dimensions differ from manifest');}else validateAssetHeader(asset as PackAsset,bytes);
  if(await skyHash(bytes)!==asset.sha256)throw Error('Sky asset hash mismatch');signal?.throwIfAborted();
 }
 return p;
}
