import {API_URL} from '../api';
import {SITE_ORIGIN,WAVEDASH} from '../platform/env';
import {SKY_LIMITS,validateSkyPack,type SkyPack} from './manifest';
export interface InstalledSkyPack {pack:SkyPack;installedAt:number}
const listeners=new Set<()=>void>();export function watchSkyPacks(fn:()=>void):()=>void{listeners.add(fn);return()=>listeners.delete(fn);}
function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('bunnyhop:sky-packs',1);r.onupgradeneeded=()=>r.result.createObjectStore('packs',{keyPath:'pack.id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function storage<T>(mode:IDBTransactionMode,action:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const d=await db();try{return await new Promise<T>((resolve,reject)=>{const tx=d.transaction('packs',mode),r=action(tx.objectStore('packs'));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{d.close();}}
export async function installedSkyPacks():Promise<InstalledSkyPack[]>{return(await storage('readonly',s=>s.getAll())).sort((a,b)=>a.installedAt-b.installedAt);}
export async function installSkyPack(input:unknown,signal?:AbortSignal):Promise<void>{const pack=await validateSkyPack(input,signal);signal?.throwIfAborted();await storage('readwrite',s=>s.put({pack,installedAt:Date.now()}));for(const fn of listeners)fn();}
export async function removeSkyPack(id:string):Promise<void>{await storage('readwrite',s=>s.delete(id));for(const fn of listeners)fn();}
/**
 * Where a sky link is fetched from: our own files (/sky-packs/…) straight from the site; any other https link through
 * /api/css-asset?kind=sky (apps/api/src/css-assets.ts: checked, size-capped, cached, and the host never sees the player).
 */
export function skyFetchUrl(address:string):string{
 if(address.startsWith('/')&&!address.startsWith('//'))return WAVEDASH?SITE_ORIGIN+address:address;
 const url=new URL(address,location.href);if(url.origin===location.origin)return url.toString();
 if(url.protocol!=='https:')throw Error('Sky links must start with https://');
 if(API_URL===null)throw Error("Sky links can't load here (no game server).");
 return `${API_URL}/css-asset?kind=sky&u=${encodeURIComponent(url.toString())}`;
}
/** A sky link's bytes, at most `limit`; `progress` gets bytes so far and the total when known. */
export async function fetchSkyBytes(address:string,signal:AbortSignal,progress:(bytes:number,total:number)=>void,limit=SKY_LIMITS.file):Promise<Uint8Array>{
 let r:Response;try{r=await fetch(skyFetchUrl(address),{signal,credentials:'omit'});}catch(error){signal.throwIfAborted();throw Error("Couldn't reach the sky's host.");}
 if(!r.ok||!r.body){const body=(await r.json().catch(()=>null)) as {message?:string}|null;throw Error(body?.message??'Sky download failed ('+r.status+')');}
 const total=Number(r.headers.get('content-length')??0);if(total>limit)throw Error('Sky file exceeds budget');
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Sky file exceeds budget');chunks.push(value);progress(size,total);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 signal.throwIfAborted();const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
export async function downloadSkyPack(address:string,signal:AbortSignal,progress:(bytes:number,total:number)=>void):Promise<void>{const bytes=await fetchSkyBytes(address,signal,progress);await installSkyPack(JSON.parse(new TextDecoder().decode(bytes)),signal);}
