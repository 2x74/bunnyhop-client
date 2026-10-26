import type {RequestDispatch} from "../../web/src/api";
export interface ActivitySample {seconds:number;jumps:number;active:boolean;maps:{map:string;seconds:number;jumps:number;attempts:number}[]}
export interface ActivityDeps {
 now():number;generation():number;account():Promise<string|null|undefined>;
 report(seconds:number,dispatch:RequestDispatch):Promise<unknown>;
 store?:{read():unknown;write(value:{owner:string;seconds:number}|null):void};
 local(delta:{map:string;seconds:number;jumps:number;attempts:number;loaded:boolean}):void;
}
/** Host counters are monotonic. Repeated delivery never credits twice; account
 * changes discard unsent account time while device-local map history persists. */
export class NativeActivityService {
 private previous:ActivitySample|null=null;private maps=new Map<string,ActivitySample["maps"][number]>();
 private owner:string|null|undefined;private confirmed:string|null|undefined;private lookup=0;
 private accountBaseline:number|null=null;
 private restored=false;
 private pending=0;private lastSent=-Infinity;private lastAttempt=-Infinity;private started=0;private sending=false;
 constructor(private deps:ActivityDeps){this.started=deps.now();}
 private persist():void{try{this.deps.store?.write(this.owner&&this.pending>0?{owner:this.owner,seconds:Math.min(120,this.pending)}:null);}catch{/* device storage is optional */}}
 async refreshAccount():Promise<void>{const token=++this.lookup;this.owner=undefined;this.accountBaseline=null;const id=await this.deps.account().catch(()=>undefined);if(token!==this.lookup||id===undefined)return;if(id!==this.confirmed){this.pending=0;this.accountBaseline=null;this.lastSent=this.lastAttempt=-Infinity;this.started=this.deps.now();}this.confirmed=id;this.owner=id;if(id!==undefined&&!this.restored){this.restored=true;try{const saved=this.deps.store?.read() as {owner?:unknown;seconds?:unknown}|null;if(id&&saved?.owner===id&&typeof saved.seconds==="number"&&Number.isFinite(saved.seconds))this.pending=Math.min(120,Math.max(0,saved.seconds));}catch{/* malformed or unavailable storage */}}if(id!==undefined)this.persist();}
 receive(raw:unknown):void{
  if(!raw||typeof raw!=="object")return;const s=raw as ActivitySample;
  if(!Number.isFinite(s.seconds)||s.seconds<0||!Number.isSafeInteger(s.jumps)||s.jumps<0||typeof s.active!=="boolean"||!Array.isArray(s.maps)||s.maps.length>256)return;
  if(s.maps.some(m=>!m||typeof m.map!=="string"||!/^[\w.-]{1,128}$/.test(m.map)||![m.seconds,m.jumps,m.attempts].every(n=>Number.isFinite(n)&&n>=0)||!Number.isSafeInteger(m.jumps)||!Number.isSafeInteger(m.attempts)))return;
  if(this.previous&&(s.seconds<this.previous.seconds||s.jumps<this.previous.jumps)){this.previous=null;this.maps.clear();this.pending=0;this.accountBaseline=null;}
  const seconds=this.accountBaseline===null?0:Math.min(120,Math.max(0,s.seconds-this.accountBaseline));
  if(this.owner){this.pending=Math.min(120,this.pending+seconds);this.accountBaseline=s.seconds;}
  for(const m of s.maps){const old=this.maps.get(m.map);const delta={map:m.map,loaded:!old,seconds:this.previous?Math.max(0,m.seconds-(old?.seconds??0)):0,jumps:this.previous?Math.min(10000,Math.max(0,m.jumps-(old?.jumps??0))):0,attempts:this.previous?Math.min(1000,Math.max(0,m.attempts-(old?.attempts??0))):0};this.deps.local(delta);this.maps.set(m.map,{...m});}
  this.previous={...s,maps:[]};if(this.owner!==undefined)this.persist();
  if(!s.active||this.deps.now()-Math.max(this.started,this.lastSent)>=60000)void this.flush();
 }
 async flush():Promise<void>{
  const owner=this.owner,seconds=Math.floor(this.pending),now=this.deps.now();if(!owner||this.sending||seconds<1||now-this.lastAttempt<10000)return;
  const generation=this.deps.generation();this.sending=true;let dispatched=false;
  try{const fetched=await this.deps.account();if(fetched!==owner||this.owner!==owner||generation!==this.deps.generation())return;
   const current=()=>this.owner===owner&&generation===this.deps.generation();
   const dispatch:RequestDispatch=send=>{if(!current())return Promise.reject(new Error("Playtime account changed"));this.pending=Math.max(0,this.pending-seconds);this.persist();this.lastAttempt=this.deps.now();dispatched=true;return send();};dispatch.current=current;
   await this.deps.report(seconds,dispatch);
   if(current())this.lastSent=this.deps.now();
  }catch(error){if(dispatched&&this.owner===owner&&generation===this.deps.generation()){const status=(error as {status?:number})?.status;if(!status||status===429||status>=500)this.pending=Math.min(120,this.pending+seconds);}}
  finally{this.sending=false;if(this.owner!==undefined)this.persist();}
 }
}
