// Account/network transport only. Native code owns ticks, command hashes,
// heartbeat cadence, replay bytes and the local replay archive. This module
// never owns the gameplay clock, simulation, WebGL context or WASM verifier.
import type { Submission } from "../../web/src/api";
import { isStyleId, type StyleId } from "../../web/src/styles";

interface Identity { map: string; track: number; style: StyleId; build: string; wasm: string }
interface Generation { generation: number }
export type NativeRunEvent =
  | (Generation & { type: "reset" })
  | (Generation & Identity & { type: "beat"; tick: number; hash: string; paused: boolean })
  | (Generation & Identity & { type: "finish"; replayBase64: string });
export interface RunServiceStatus {
  type: "runService"; generation: number;
  status: "reset" | "beat" | "gap" | "checking" | "uploading" | "pending" | "verified" | "rejected" | "error" | "kept";
  message?: string; id?: string; progress?: number; rank?: number; time?: number;
  code?: string; pb?: boolean; beats?: number; gaps?: number; local?: boolean;
}
interface BeatBody { sid: string | null; map: string; track: number; style: string; tick: number; hash: string; paused: boolean }
export interface RunApi {
  runBeat(body: BeatBody): Promise<{sid: string; token: string}>;
  submitRun(bytes: Uint8Array, options: {beats: string[];room?:string|null;race?:string|null}): Promise<Submission>;
  submission(id: string): Promise<Submission>;
}
export interface VersionPolicy { wasm?: unknown; native?: unknown }
export interface RunServiceDependencies {
  api: RunApi;
  version(): Promise<VersionPolicy>;
  send(status: RunServiceStatus): void;
  origin(): string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollLimitMs?: number;
  pollDelayMs?: number;
  context?:(identity:Identity)=>{room?:string|null;race?:string|null};
}
interface Session {
  generation: number; identity: Identity | null; sid: string | null;
  tokens: (string | undefined)[]; sent: number; gaps: number; lastTick: number;
  carryPause: boolean; handshake: Promise<void> | null; finished: boolean;
}

const MAX_BEATS = 7500, MAX_REPLAY_BYTES = 8 << 20;
const LIVE_ORIGIN = "https://bunnyhop.lol";
const identityKeys = ["map","track","style","build","wasm"] as const;
const timeoutError = () => new Error("Native run service request timed out");

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(timeoutError()),Math.max(1,ms));
    promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
function validIdentity(value: Record<string,unknown>): value is Record<string,unknown> & Identity {
  return typeof value.map==="string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value.map) &&
    Number.isSafeInteger(value.track) && Number(value.track)>=0 && isStyleId(value.style) &&
    typeof value.build==="string" && /^bunnyhop-native\/[0-9a-f]{12,64}$/.test(value.build) &&
    typeof value.wasm==="string" && /^bunnyhop-web\/[0-9a-f]{12}$/.test(value.wasm);
}
export function nativeBuildAllowed(policy: VersionPolicy,event: Identity,now: number): boolean {
  if(policy.wasm!==event.wasm || !Array.isArray(policy.native)) return false;
  const entries=policy.native.filter(value=>value && typeof value==="object" && value.build===event.build);
  if(entries.length!==1) return false; // ambiguous identities fail closed
  const entry=entries[0];
  return entry.build===event.build && entry.wasm===event.wasm && typeof entry.until==="number" && Number.isFinite(entry.until) && entry.until>now;
}
export function replayBytes(base64: string): Uint8Array {
  // A repeated-group regex can exhaust the engine on valid multi-megabyte runs.
  // Validate the alphabet/padding in a linear scan before decoding the bytes.
  const padding=base64.endsWith("==")?2:base64.endsWith("=")?1:0;
  if(!base64 || base64.length%4 || base64.length>Math.ceil(MAX_REPLAY_BYTES/3)*4 || /[^A-Za-z0-9+/]/.test(base64.slice(0,base64.length-padding))) throw new Error("Invalid replay bytes");
  const raw=atob(base64);
  if(!raw.length || raw.length>MAX_REPLAY_BYTES) throw new Error("Replay exceeds upload limit");
  return Uint8Array.from(raw,character=>character.charCodeAt(0));
}

export class NativeRunService {
  private current: Session | null = null;
  private latestGeneration = -1;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollLimit: number;
  private readonly pollDelay: number;
  constructor(private readonly dependencies: RunServiceDependencies) {
    this.now=dependencies.now??Date.now;
    this.sleep=dependencies.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.pollLimit=Math.min(30_000,Math.max(1,dependencies.pollLimitMs??30_000));
    this.pollDelay=Math.max(0,dependencies.pollDelayMs??1000);
  }
  private active(session: Session): boolean { return this.current===session; }
  private status(session: Session,status: RunServiceStatus["status"],extra: Omit<Partial<RunServiceStatus>,"type"|"generation"|"status"> = {}): void {
    if(this.active(session)) this.dependencies.send({type:"runService",generation:session.generation,status,...extra});
  }
  private kept(session: Session,message: string): void {
    this.status(session,"kept",{message:`${message} Replay remains in your local native archive.`,local:true});
  }
  async receive(value: unknown): Promise<void> {
    if(!value || typeof value!=="object" || Array.isArray(value)) return;
    const event=value as Record<string,unknown>;
    if(!Number.isSafeInteger(event.generation) || Number(event.generation)<0) return;
    const generation=Number(event.generation);
    if(generation<this.latestGeneration) return;
    if(event.type==="reset") {
      this.latestGeneration=generation;
      this.current={generation,identity:null,sid:null,tokens:[],sent:0,gaps:0,lastTick:0,carryPause:false,handshake:null,finished:false};
      this.status(this.current,"reset"); return;
    }
    const session=this.current;
    if(!session || session.generation!==generation || session.finished) return;
    if(!validIdentity(event)) {
      if(event.type==="finish") {session.finished=true;this.kept(session,"Build release manifest is missing or stale.");}
      return;
    }
    const identity: Identity={map:event.map,track:event.track,style:event.style,build:event.build,wasm:event.wasm};
    if(session.identity && identityKeys.some(key=>session.identity![key]!==identity[key])) {
      this.kept(session,"The run identity changed before submission."); return;
    }
    session.identity??=identity;
    if(event.type==="beat") {
      if(!Number.isSafeInteger(event.tick) || Number(event.tick)<session.lastTick || typeof event.hash!=="string" || !/^[0-9a-f]{8}$/.test(event.hash) || typeof event.paused!=="boolean") {
        session.gaps++; this.status(session,"gap",{message:"A malformed heartbeat was omitted.",gaps:session.gaps}); return;
      }
      await this.beat(session,{...identity,tick:Number(event.tick),hash:event.hash,paused:event.paused});
    } else if(event.type==="finish") {
      session.finished=true; // tokens are frozen in send order; late replies are gaps
      await this.finish(session,event.replayBase64);
    }
  }
  private async beat(session: Session,event: Identity & {tick:number;hash:string;paused:boolean}): Promise<void> {
    if(session.sent>=MAX_BEATS) { session.gaps++; this.status(session,"gap",{gaps:session.gaps}); return; }
    const slot=session.sent++;
    session.lastTick=event.tick;
    // Only the initial handshake waits: later beats may answer out of order, and
    // their reserved slots preserve send order without delaying native cadence.
    if(session.handshake) await session.handshake;
    if(!this.active(session) || session.finished) return;
    const paused=event.paused||session.carryPause; session.carryPause=false;
    const request=(async()=>{
      try {
        const result=await bounded(this.dependencies.api.runBeat({sid:session.sid,map:event.map,track:event.track,style:event.style,tick:event.tick,hash:event.hash,paused}),10_000);
        if(!this.active(session)||session.finished) return;
        if(typeof result.sid!=="string" || !result.sid || typeof result.token!=="string" || !result.token || result.token.length>600) throw new Error("Invalid heartbeat response");
        session.sid??=result.sid;
        if(result.sid!==session.sid) throw new Error("Heartbeat session changed");
        session.tokens[slot]=result.token;
        this.status(session,"beat",{beats:session.tokens.filter(Boolean).length,gaps:session.gaps});
      } catch {
        if(!this.active(session)||session.finished) return;
        session.gaps++; session.carryPause ||= paused;
        this.status(session,"gap",{message:"A heartbeat could not be delivered; the gap will be included.",gaps:session.gaps});
      }
    })();
    if(!session.sid) {
      session.handshake=request;
      await request;
      if(session.handshake===request) session.handshake=null;
    } else await request;
  }
  private async finish(session: Session,base64: unknown): Promise<void> {
    const event=session.identity!;
    const context=this.dependencies.context?.(event);
    if(typeof base64!=="string") {this.kept(session,"No replay bytes were supplied.");return;}
    let bytes: Uint8Array;
    try {bytes=replayBytes(base64);} catch {this.kept(session,"The replay cannot be uploaded.");return;}
    if(this.dependencies.origin()!==LIVE_ORIGIN) {this.kept(session,"Ranked uploads require the live service.");return;}
    this.status(session,"checking",{message:"Checking native release compatibility…"});
    try {
      const version=await bounded(this.dependencies.version(),10_000);
      if(!this.active(session)) return;
      if(!nativeBuildAllowed(version,event,this.now())) {this.kept(session,"This native build is not enabled for ranked submissions.");return;}
    } catch {this.kept(session,"Could not check native release compatibility.");return;}
    const tokens=session.tokens.filter((token):token is string=>typeof token==="string");
    const gaps=session.sent-tokens.length;
    this.status(session,"uploading",{message:"Uploading replay for server verification…",beats:tokens.length,gaps});
    let result: Submission;
    try {result=await bounded(this.dependencies.api.submitRun(bytes,{beats:tokens,...context}),20_000);}
    catch {this.kept(session,"The replay could not reach the server.");return;}
    if(!this.active(session)) return;
    this.verdict(session,result);
    const deadline=this.now()+this.pollLimit;
    while(this.active(session) && (result.status==="queued"||result.status==="verifying")) {
      let remaining=deadline-this.now();
      if(remaining<=0 || !result.id) break;
      await this.sleep(Math.min(this.pollDelay,remaining));
      if(!this.active(session)) return;
      remaining=deadline-this.now(); if(remaining<=0) break;
      try {result=await bounded(this.dependencies.api.submission(result.id),remaining);}
      catch {continue;}
      if(this.active(session)) this.verdict(session,result);
    }
    if(this.active(session)&&(result.status==="queued"||result.status==="verifying")) this.status(session,"pending",{id:result.id,message:"The server is still checking your run. Its result will appear on the board.",local:true});
  }
  private verdict(session: Session,result: Submission): void {
    const status=result.status==="queued"||result.status==="verifying"?"pending":result.status;
    this.status(session,status,{id:result.id,progress:result.progress,rank:result.rank,time:result.time,pb:result.pb,code:result.code,message:result.reason});
  }
}
