// Existing room wire transport only. All local/remote game poses are produced,
// interpolated and rendered by the native client.
import { parseClientMsg,styleIndex,WORLD_LIMIT,CLOSE,type ClientMsg,type NetMeta,type MapInfo,type NetSample,type RoomInfo,type RosterPlayer,type ServerMsg,type Snapshot,type VoteView,type PoolEntry,type RaceView } from "../../web/src/net/protocol";
import { nativeChatDecoration } from "./chat-decoration";
import { isStyleId } from "../../web/src/styles";
import type { RoomHandlers,RoomStatus } from "../../web/src/net/room";
import type { MenuMessage } from "./bridge";
export interface RoomTransport {rtt?:number;send(message:ClientMsg):void;pushSample(sample:NetSample):void;flushSamples(meta:Omit<NetMeta,"ping">,weapon?:number|null,silenced?:boolean):void;close(code?:number):void;toLocal?(serverTime:number):number;serverNow?():number}
interface Dependencies {connect(id:string,handlers:RoomHandlers):RoomTransport;ensureAccount():Promise<boolean>;send(message:MenuMessage):void;now?:()=>number}
export interface RoomView {mapInfo?:MapInfo|null;nextMap?:string|null;metaAt?:Record<string,number>;id:string|null;generation:number;status:RoomStatus;detail:string;room:RoomInfo|null;map:string;you:number;players:RosterPlayer[];chat:({name?:string;text:string;kind?:string}&Record<string,unknown>)[];nominations:{map:string;name:string}[];change:{map:string;at:number}|null;metas:Record<string,NetMeta>;vote:VoteView|null;pool:PoolEntry[];race:RaceView|null;rtv:{count:number;needed:number};}
const validMap=(map:unknown):map is string=>typeof map==="string"&&/^[a-zA-Z0-9_.-]{1,128}$/.test(map);
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
function sampleValid(sample:unknown):sample is NetSample {
  if(!sample||typeof sample!=="object")return false;const s=sample as NetSample;
  return Number.isSafeInteger(s.tick)&&s.tick>=0&&s.tick<=0xffffffff&&Number.isInteger(s.flags)&&s.flags>=0&&s.flags<=255&&[s.x,s.y,s.z].every(v=>finite(v)&&Math.abs(v)<=WORLD_LIMIT)&&[s.vx,s.vy,s.vz,s.yaw,s.pitch].every(finite);
}
const uint=(n:unknown,max=0xffffffff):n is number=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=max;
const metaValid=(m:NetMeta):boolean=>!!m&&uint(m.style,7)&&uint(m.track,64)&&uint(m.timer,3)&&uint(m.timerTicks)&&uint(m.ping,65535);
export function validSnapshot(value:Snapshot):boolean {return !!value&&uint(value.serverTime)&&Array.isArray(value.blocks)&&value.blocks.length<=64&&value.blocks.every(block=>uint(block.slot,255)&&Array.isArray(block.samples)&&block.samples.length<=8&&block.samples.every(sampleValid)&&(!block.meta||metaValid(block.meta))&&(block.weapon===undefined||uint(block.weapon,25))&&(block.silenced===undefined||typeof block.silenced==="boolean"));}
const person=(p:RosterPlayer):boolean=>!!p&&uint(p.slot,255)&&typeof p.id==="string"&&p.id.length<=128&&typeof p.name==="string"&&p.name.length<=128&&isStyleId(p.style);
const voteValid=(v:VoteView):boolean=>!!v&&uint(v.id)&&["end","rtv"].includes(v.kind)&&finite(v.endsAt)&&Array.isArray(v.options)&&v.options.length<=16&&v.options.every(option=>!!option&&typeof option==="object"&&("extend" in option?option.extend===true&&finite(option.minutes)&&option.minutes>0:validMap(option.map)))&&Array.isArray(v.counts)&&v.counts.length===v.options.length&&v.counts.every(n=>uint(n,256));
const raceValid=(r:RaceView|null):boolean=>r===null||!!r&&typeof r.id==="string"&&r.id.length<=128&&["challenge","countdown","live","settling","over"].includes(r.state)&&validMap(r.map)&&isStyleId(r.style)&&uint(r.track,64)&&["a","b"].includes(r.you)&&!!r.a&&!!r.b&&typeof r.a.name==="string"&&typeof r.b.name==="string"&&[r.expiresAt,r.goAt,r.endsAt].every(n=>n===null||finite(n));
export function validRoomEvent(message:ServerMsg):boolean {
  try {
    if(!message||typeof message!=="object"||new TextEncoder().encode(JSON.stringify(message)).byteLength>128*1024)return false;
    switch(message.t){
      case "welcome":return message.v===1&&uint(message.you,255)&&typeof message.youId==="string"&&!!message.room&&typeof message.room.id==="string"&&typeof message.room.name==="string"&&validMap(message.map?.name)&&finite(message.now)&&Array.isArray(message.players)&&message.players.length<=64&&message.players.every(person)&&!!message.rtv&&uint(message.rtv.count,256)&&uint(message.rtv.needed,256)&&Array.isArray(message.pool)&&message.pool.length<=2048&&message.pool.every(map=>validMap(map?.name))&&(!message.vote||voteValid(message.vote))&&(!message.change||validMap(message.change.map)&&finite(message.change.at))&&(message.race===undefined||raceValid(message.race));
      case "map":return validMap(message.map?.name);
      case "change":return validMap(message.change?.map)&&finite(message.change.at);
      case "chat":return typeof message.text==="string"&&message.text.length<=4096&&(message.name===undefined||typeof message.name==="string");
      case "vote":return voteValid(message.vote);
      case "voteEnd":return uint(message.id);
      case "rtv":return uint(message.count,256)&&uint(message.needed,256);
      case "nominations":return Array.isArray(message.list)&&message.list.length<=64&&message.list.every(entry=>validMap(entry.map)&&typeof entry.name==="string");
      case "join":return person(message.player);
      case "leave":return uint(message.slot,255)&&typeof message.name==="string";
      case "player":return uint(message.slot,255)&&!!message.patch&&typeof message.patch==="object"&&(message.patch.name===undefined||typeof message.patch.name==="string")&&(message.patch.style===undefined||isStyleId(message.patch.style));
      case "race":return raceValid(message.race);
      case "announce":return !!message.a&&typeof message.a.name==="string"&&typeof message.a.kind==="string"&&validMap(message.a.map)&&finite(message.a.time);
      case "host":return message.slot===null||uint(message.slot,255);
      case "kicked":return typeof message.reason==="string";
      case "achievement":return typeof message.id==="string";
      case "error":return typeof message.message==="string"&&typeof message.code==="string";
      case "gift":return Array.isArray(message.recipients)&&message.recipients.length<=1000&&uint(message.count,1000);
      default:return false;
    }
  }catch{return false;}
}
export class NativeRoomService {
  readonly view:RoomView={id:null,generation:0,status:"closed",detail:"",room:null,map:"",you:-1,players:[],chat:[],nominations:[],change:null,metas:{},vote:null,pool:[],race:null,rtv:{count:0,needed:0}};
  private transport:RoomTransport|null=null;private listeners=new Set<()=>void>();private now:()=>number;private lastPose=-Infinity;private lastSnapshot=-Infinity;private lastTick=-1;private pendingSnapshot:Snapshot|null=null;private batch:Omit<NetMeta,"ping">|null=null;private weapon:number|null=null;private silenced=false;private timer:ReturnType<typeof setInterval>|null=null;private connectionEpoch=0;private pendingMap:string|null=null;private changeTimer:ReturnType<typeof setTimeout>|null=null;
  private audioMapSecond=-1;private audioRaceSecond=-1;private audioRaceId="";private audioGifts=new Set<string>();private audioAnnouncements=new Set<string>();
  private cue(id:string):void{this.dependencies.send({type:"audioCue",id,gain:1,rate:1});}
  private audioCountdown():void{const now=this.serverNow();const change=this.view.change;if(change){const second=Math.max(0,Math.ceil((change.at-now)/1000));if(second!==this.audioMapSecond&&second<=3)this.cue(second===0?"countdown_go":"countdown_tick");this.audioMapSecond=second;}const race=this.view.race;if(race?.state==="countdown"&&race.goAt!==null){if(this.audioRaceId!==race.id){this.audioRaceId=race.id;this.audioRaceSecond=-1;}const second=Math.ceil((race.goAt-now)/1000);if(second!==this.audioRaceSecond&&second>0&&second<=3)this.cue("countdown_tick");this.audioRaceSecond=second;}}
  constructor(private dependencies:Dependencies){this.now=dependencies.now??(()=>performance.now());}
  clockNow():number{return this.now();}
  ping():number|null{return this.transport?.rtt?Math.round(this.transport.rtt):null;}
  serverNow():number{return this.transport?.serverNow?.()??Date.now();}
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private changed():void{for(const listener of this.listeners)listener();}
  async join(id:string):Promise<void>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))throw new Error("Invalid room identifier");
    this.leave();const generation=++this.view.generation;this.view.id=id;this.view.status="connecting";this.view.detail="Connecting…";this.changed();
    if(!await this.dependencies.ensureAccount()){if(this.view.generation===generation){this.view.status="closed";this.view.detail="Sign in or retry your guest account before joining.";this.changed();}return;}
    if(this.view.generation!==generation)return;
    this.connect(id,generation);
    this.timer=setInterval(()=>this.flush(),200);
  }
  private connect(id:string,generation:number):void {const epoch=++this.connectionEpoch;const current=()=>this.view.generation===generation&&this.view.id===id&&epoch===this.connectionEpoch;
    this.transport=this.dependencies.connect(id,{message:message=>{if(current())this.message(message);},snapshot:snapshot=>{if(current()&&validSnapshot(snapshot))this.queueSnapshot(snapshot);},status:(status,detail)=>{if(!current())return;this.view.status=status;this.view.detail=detail??"";this.event({t:"nativeStatus",status,detail:detail??""});this.changed();}});
  }
  private scheduleChange(change:{map:string;at:number}|null):void {if(this.changeTimer)clearTimeout(this.changeTimer);this.changeTimer=null;if(!change)return;this.pendingMap=change.map;const generation=this.view.generation,id=this.view.id;const at=this.transport?.toLocal?.(change.at)??change.at;this.changeTimer=setTimeout(()=>{this.changeTimer=null;if(this.view.generation!==generation||this.view.id!==id)return;this.connectionEpoch++;this.transport?.close(CLOSE.MAP_CHANGE);this.transport=null;this.batch=null;this.pendingSnapshot=null;this.view.status="connecting";this.view.detail=`Loading ${change.map}…`;this.event({t:"nativeMap",map:change.map});this.changed();},Math.max(0,Math.min(86_400_000,at-Date.now()+250)));}
  hostMap(map:string|null):void {if(!map||map!==this.pendingMap||!this.view.id)return;this.pendingMap=null;const {id,generation}=this.view;this.connectionEpoch++;this.transport?.close(CLOSE.MAP_CHANGE);this.batch=null;this.pendingSnapshot=null;this.view.status="connecting";this.view.detail="Joining the new map…";this.connect(id,generation);this.changed();}
  leave():void {const id=this.view.id,generation=this.view.generation;this.connectionEpoch++;this.transport?.close();this.transport=null;this.pendingMap=null;if(this.changeTimer)clearTimeout(this.changeTimer);this.changeTimer=null;if(this.timer)clearInterval(this.timer);this.timer=null;this.view.id=null;this.view.status="closed";this.view.room=null;this.view.players=[];this.view.chat=[];this.view.nominations=[];this.view.change=null;this.view.metas={};this.view.vote=null;this.view.pool=[];this.view.race=null;this.view.map="";this.view.mapInfo=null;this.view.nextMap=null;this.view.metaAt={};this.pendingSnapshot=null;this.batch=null;this.lastPose=this.lastSnapshot=-Infinity;this.lastTick=-1;this.view.generation++;if(id)this.dependencies.send({type:"roomEvent",id,generation,event:{t:"nativeLeave"}});this.changed();}
  command(value:unknown):boolean {let message:ClientMsg|null=null;try{const text=JSON.stringify(value);if(typeof text==="string")message=parseClientMsg(text);}catch{return false;}if(!message||!this.transport||this.view.status!=="open")return false;this.transport.send(message);return true;}
  pose(value:unknown):boolean {
    if(!value||typeof value!=="object"||!this.transport||this.view.status!=="open")return false;
    const pose=value as Record<string,unknown>,meta=pose.meta as Record<string,unknown>;
    if(pose.generation!==this.view.generation||pose.id!==this.view.id||pose.map!==this.view.map||!sampleValid(pose.sample)||!meta||!isStyleId(meta.style)||![meta.track,meta.timer,meta.timerTicks].every(v=>uint(v))||Number(meta.track)>64||Number(meta.timer)>3)return false;
    if(this.now()-this.lastPose<50||pose.sample.tick<=this.lastTick)return false;this.lastPose=this.now();this.lastTick=pose.sample.tick;
    this.view.metas[String(this.view.you)]={style:styleIndex(meta.style),track:Number(meta.track),timer:Number(meta.timer),timerTicks:Number(meta.timerTicks),ping:this.view.metas[String(this.view.you)]?.ping??0};(this.view.metaAt??={})[String(this.view.you)]=this.now();
    this.transport.pushSample(pose.sample);this.batch={style:styleIndex(meta.style),track:Number(meta.track),timer:Number(meta.timer),timerTicks:Number(meta.timerTicks)};
    this.weapon=Number.isInteger(pose.weapon)&&Number(pose.weapon)>=0&&Number(pose.weapon)<=25?Number(pose.weapon):null;this.silenced=pose.silenced===true;return true;
  }
  flush():void {this.audioCountdown();if(this.batch){this.transport?.flushSamples(this.batch,this.weapon,this.silenced);this.batch=null;}this.flushSnapshot();}
  private flushSnapshot():void {if(this.pendingSnapshot&&this.now()-this.lastSnapshot>=50){const snapshot=this.pendingSnapshot;this.pendingSnapshot=null;this.lastSnapshot=this.now();this.dependencies.send({type:"roomSnapshot",generation:this.view.generation,id:this.view.id!,snapshot});}}
  private queueSnapshot(snapshot:Snapshot):void {const blocks=new Map(this.pendingSnapshot?.blocks.map(block=>[block.slot,block])??[]);for(const block of snapshot.blocks){const previous=blocks.get(block.slot);if(!previous){blocks.set(block.slot,block);continue;}const samples=new Map(previous.samples.map(sample=>[sample.tick,sample]));for(const sample of block.samples)samples.set(sample.tick,sample);blocks.set(block.slot,{...previous,...block,meta:block.meta??previous.meta,samples:[...samples.values()].sort((a,b)=>a.tick-b.tick).slice(-8),...(block.weapon===undefined&&previous.weapon!==undefined?{weapon:previous.weapon}:{}),...(block.silenced===undefined&&previous.silenced!==undefined?{silenced:previous.silenced}:{})});}for(const block of snapshot.blocks)if(block.meta){this.view.metas[String(block.slot)]=block.meta;(this.view.metaAt??={})[String(block.slot)]=this.now();}this.pendingSnapshot={serverTime:snapshot.serverTime,blocks:[...blocks.values()].slice(0,64)};this.flushSnapshot();}
  private event(event:Record<string,unknown>):void{if(this.view.id)this.dependencies.send({type:"roomEvent",generation:this.view.generation,id:this.view.id,event});}
  private message(message:ServerMsg):void {
    if(!validRoomEvent(message))return;
    if(message.t==="welcome"&&message.room?.id!==this.view.id)return;
    // Compare before updating room state, so vote refreshes and reconnects
    // cannot duplicate a cue. Identity fencing above rejects stale sockets.
    if(message.t==="join")this.cue("player_join");
    else if(message.t==="chat"&&message.slot!==undefined&&message.slot!==this.view.you)this.cue("chat");
    else if(message.t==="gift"&&!this.audioGifts.has(message.batchId)){this.audioGifts.add(message.batchId);if(this.audioGifts.size>512)this.audioGifts.delete(this.audioGifts.values().next().value!);this.cue("supporter_gift");}
    else if(message.t==="achievement")this.cue("achievement");
    else if(message.t==="vote"){if(message.vote.id!==this.view.vote?.id)this.cue("vote_open");else if(message.vote.counts.reduce((a,b)=>a+b,0)>(this.view.vote?.counts.reduce((a,b)=>a+b,0)??0))this.cue("vote_tick");}
    else if(message.t==="change"&&(message.change.map!==this.view.change?.map||message.change.at!==this.view.change?.at)){this.cue("map_change");this.audioMapSecond=-1;}
    else if(message.t==="race"&&message.race){const race=message.race,prev=this.view.race;if(race.state==="live"&&prev?.id===race.id&&prev.state==="countdown")this.cue("countdown_go");else if(race.state==="challenge"&&race.you==="b"&&race.id!==prev?.id)this.cue("vote_open");else if(race.state==="over"&&race.goAt!==null&&race.winner&&(prev?.id!==race.id||prev.state!=="over"))this.cue(race.winner===race.you?"finish_pb":"chat");}
    else if(message.t==="announce"){const a=message.a;if(a.runId&&(a.kind==="wr"||(a.slot===this.view.you&&a.pb))&&!this.audioAnnouncements.has(a.runId)){this.audioAnnouncements.add(a.runId);if(this.audioAnnouncements.size>512)this.audioAnnouncements.delete(this.audioAnnouncements.values().next().value!);this.dependencies.send({type:"announce",event:a.kind==="wr"?"wr":"pb",id:a.runId,remote:a.slot!==this.view.you});}this.cue(a.kind==="wr"||a.kind==="sr"?"shine":"chat");}
    if(message.t==="welcome"){this.view.status="open";this.view.room=message.room;this.view.map=message.map.name;this.view.mapInfo=message.map;this.view.nextMap=message.nextMap;this.view.you=message.you;this.view.players=message.players;this.view.vote=message.vote;this.view.pool=message.pool;this.view.rtv=message.rtv;this.view.race=message.race??null;this.view.nominations=message.nominations??[];this.view.metas=message.metas??{};this.view.metaAt=Object.fromEntries(Object.keys(this.view.metas).map(slot=>[slot,this.now()]));this.view.change=message.change;this.scheduleChange(message.change);}
    else if(message.t==="join"){this.view.players=this.view.players.filter(p=>p.slot!==message.player.slot);if(this.view.players.length<64)this.view.players.push(message.player);}
    else if(message.t==="leave"){this.view.players=this.view.players.filter(player=>player.slot!==message.slot);delete this.view.metas[String(message.slot)];if(this.view.metaAt)delete this.view.metaAt[String(message.slot)];}
    else if(message.t==="player"){const player=this.view.players.find(player=>player.slot===message.slot);if(player)Object.assign(player,message.patch);}
    else if(message.t==="chat"){this.view.chat.push({...message});this.dependencies.send({...message,...nativeChatDecoration({...this.view.players.find(player=>player.slot===message.slot),...message} as unknown as Record<string,unknown>),type:"chatLine"} as unknown as MenuMessage);this.view.chat=this.view.chat.slice(-100);}
    else if(message.t==="nominations")this.view.nominations=message.list;
    else if(message.t==="vote")this.view.vote=message.vote;
    else if(message.t==="voteEnd")this.view.vote=null;
    else if(message.t==="rtv")this.view.rtv=message;
    else if(message.t==="map"){if(this.view.map!==message.map.name)this.pendingMap=message.map.name;this.view.map=message.map.name;this.view.mapInfo=message.map;this.view.nextMap=message.nextMap;this.view.metas={};this.view.metaAt={};this.pendingSnapshot=null;this.changed();}
    else if(message.t==="change"){this.view.change=message.change;this.scheduleChange(message.change);}
    else if(message.t==="race")this.view.race=message.race;
    else if(message.t==="error")this.view.detail=message.message;
    if(message.t==="announce")this.view.chat.push({text:`${message.a.name}: ${message.a.kind.toUpperCase()} on ${message.a.map} (${message.a.time.toFixed(3)}s)`});
    if(message.t==="kicked"){this.view.detail=message.reason;this.view.status="closed";this.connectionEpoch++;this.transport?.close();this.transport=null;this.batch=null;this.pendingSnapshot=null;this.view.players=[];this.view.vote=null;this.view.race=null;}
    if(message.t==="host"&&this.view.room)this.view.room.host=message.slot;
    this.view.chat=this.view.chat.slice(-100);
    if(message.t==="error"||message.t==="kicked")this.dependencies.send({type:"chatLine",kind:"server",text:message.t==="error"?message.message:message.reason} as unknown as MenuMessage);
    this.event({...message,...(message.t==="welcome"||message.t==="race"||message.t==="change"?{nativeClockOffsetMs:(this.transport?.serverNow?.()??Date.now())-Date.now()}: {})} as unknown as Record<string,unknown>);this.changed();
  }
}
