import { installedSkyPacks, installSkyPack } from '../sky-packs/store';
import { installedPacks, installPack, enablePack } from '../texture-packs/store';
/** No network/storage access until explicit preset selection calls ensureCinematicAssets. */
export interface CinematicAssets {skyPackId:'cloudy-day';status:string;restore:()=>Promise<void>}
const BACKUP='bunnyhop:cinematic-assets-v1';
const SKY='/sky-packs/cloudy-day.bhsky.json';
const MATERIALS=[{id:'ambience-materials',url:'/texture-packs/ambience-materials.bhpack.json',limit:4*1024**2},{id:'original-pbr-demo',url:'/texture-packs/original-pbr-demo.bhpack.json',limit:20*1024**2}];
let pending:Promise<unknown>=Promise.resolve();
function serial<T>(run:()=>Promise<T>):Promise<T>{const result=pending.then(run,run);pending=result.catch(()=>{});return result;}
/** Curated same-origin manifests have tighter transport limits than arbitrary portable imports. */
async function manifest(path:string,limit:number,signal:AbortSignal):Promise<unknown>{
 signal.throwIfAborted();const url=new URL(path,location.href);if(url.origin!==location.origin)throw Error('Cinematic assets must be same-origin');
 const response=await fetch(url,{signal});if(!response.ok||!response.body)throw Error(`Cinematic asset download failed (${response.status})`);
 const declared=Number(response.headers.get('content-length')??0);if(declared>limit)throw Error('Cinematic asset exceeds download budget');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>limit)throw Error('Cinematic asset exceeds download budget');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 signal.throwIfAborted();const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export function ensureCinematicAssets(signal:AbortSignal):Promise<CinematicAssets>{return serial(async()=>{
 signal.throwIfAborted();const skies=await installedSkyPacks();signal.throwIfAborted();
 if(!skies.some(s=>s.pack.id==='cloudy-day')){const input=await manifest(SKY,12*1024**2,signal);if((input as {id?:unknown})?.id!=='cloudy-day')throw Error('Unexpected cinematic sky identity');await installSkyPack(input,signal);}
 const records=await installedPacks();signal.throwIfAborted();const previous=new Map<string,boolean>();
 for(const asset of MATERIALS){const existing=records.find(r=>r.pack.id===asset.id);previous.set(asset.id,existing?.enabled??false);if(!existing){const input=await manifest(asset.url,asset.limit,signal);if((input as {id?:unknown})?.id!==asset.id)throw Error('Unexpected cinematic material identity');await installPack(input,signal);}}
 const existingBackup=backup();if(!existingBackup)localStorage.setItem(BACKUP,JSON.stringify({schemaVersion:1,enabled:Object.fromEntries(previous)}));
 const changed:string[]=[];const undo=async()=>{for(const id of changed)await enablePack(id,previous.get(id)??false);};
 try{for(const asset of MATERIALS){signal.throwIfAborted();if(!previous.get(asset.id)){changed.push(asset.id);await enablePack(asset.id,true);}}signal.throwIfAborted();}catch(error){await undo();if(!existingBackup)localStorage.removeItem(BACKUP);throw error;}
 return{skyPackId:'cloudy-day',status:'Photographic HDR sky ready. Material packs apply on the next map load; your current run continues.',restore:restoreCinematicAssets};
 });}

function backup():Record<string,boolean>|null {
 const raw=localStorage.getItem(BACKUP);if(!raw)return null;const input=JSON.parse(raw);
 if(input?.schemaVersion!==1||!input.enabled||MATERIALS.some(a=>typeof input.enabled[a.id]!=='boolean')||Object.keys(input.enabled).some(id=>!MATERIALS.some(a=>a.id===id)))throw Error('Invalid saved cinematic material state');
 return input.enabled;
}
/** Durable ownership backup survives reload; only curated enable flags are restored. */
export function restoreCinematicAssets():Promise<void>{return serial(async()=>{const saved=backup();if(!saved)return;for(const asset of MATERIALS)await enablePack(asset.id,saved[asset.id]);localStorage.removeItem(BACKUP);});}
