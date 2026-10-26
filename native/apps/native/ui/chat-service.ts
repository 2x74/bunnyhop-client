import {protocolChatText,ChatSuggestionFence,cycleSpectator,resolveRaceCommand} from "./chat-input";
import { dispatchNativeChat } from "./chat-routing";
import { api } from "../../web/src/api";
import { suggestChat,registerChatCommand,type ChatContext,type ReplyOpts } from "../../web/src/chat-commands";
import { registerSocialCommands } from "../../web/src/social/commands";
import { weaponByName } from "../../web/src/weapon-rules";
import { getPB } from "../../web/src/pb";
import { formatTime } from "../../web/src/timer";
import { copyLobbyInvite } from "../../web/src/net/lobby";
import { state,send } from "./bridge";
import { openGiftDialog } from "../../web/src/ui/gifting";
import { openReport } from "./report";
import { setNativeChatSink } from "./chat-hud";
import type { NativeRoomService } from "./room-service";

// Kept explicit so the host can validate actions without accepting arbitrary
// console commands or JS. The native host remains authoritative for all rules.
export type ChatAction={type:"chatAction";action:"restart"|"restartBonus"|"setStart"|"clearStart"|"weapon"|"scores"|"hidePlayers"|"openRoom"|"jumpStats";track?:number;weapon?:string;weaponId?:number;hidden?:boolean};
export interface NativeChatLine {type:"chatLine";text:string;name?:string;kind?:string;ms?:number;[key:string]:unknown}
export type NativeChatMessage=ChatAction|NativeChatLine|{type:"chatSuggestions";items:string[];request:number;input:string};
const emit=(value:NativeChatMessage)=>send(value as unknown as Parameters<typeof send>[0]);
let registered=false;
export class NativeChatService {
 private hidden=false;private accountEpoch=0;private suggestions=new ChatSuggestionFence();
 constructor(private room:NativeRoomService,private openRoom:()=>void){
  setNativeChatSink(text=>this.reply(text));
  if(!registered){registered=true;registerSocialCommands();
   for(const weapon of ["usp","glock","knife"])registerChatCommand({name:weapon,where:"both",group:"guns",help:`get the ${weapon}`,run:ctx=>{if(!ctx.room?.spectating())emit({type:"chatAction",action:"weapon",weapon,weaponId:weaponByName(weapon)});}});
   registerChatCommand({name:"gun",aliases:["give","guns","weapons"],where:"both",group:"guns",help:"get a weapon",args:"[name]",run:(ctx,arg)=>{if(!arg){emit({type:"chatAction",action:"weapon",weapon:"menu"});return;}if(!weaponByName(arg))return ctx.reply(`Unknown weapon "${arg}".`);if(!ctx.room?.spectating())emit({type:"chatAction",action:"weapon",weapon:arg.slice(0,64),weaponId:weaponByName(arg)});}});
   registerChatCommand({name:"ssj",where:"both",group:"more",help:"toggle jump stats",run:()=>emit({type:"chatAction",action:"jumpStats"})});
  }
 }
 resetAccount():void {this.accountEpoch++;this.room.leave();}
 reply(text:string,opts?:ReplyOpts):void {emit({type:"chatLine",kind:"local",text:(opts?.label?opts.label+": ":"")+text,ms:opts?.long?30000:12000});}
 suggest(value:unknown):void {const query=this.suggestions.take(value);if(query)emit({type:"chatSuggestions",...query,items:suggestChat(query.input,this.room.view.id?"room":"solo")});}
 submit(value:unknown):void {
  if(typeof value!=="string")return;const text=protocolChatText(value.trim());if(!text)return;
  if(!this.room.view.id&&/^[!/]report(?:\s|$)/i.test(text))this.openRoom();
  const epoch=this.accountEpoch,reply=(text:string,opts?:ReplyOpts)=>{if(epoch===this.accountEpoch)this.reply(text,opts);};
  const player=(query:string)=>{const q=query.trim().toLowerCase();return this.room.view.players.find(p=>`#${p.slot}`===q||p.name.toLowerCase()===q)??this.room.view.players.find(p=>p.name.toLowerCase().startsWith(q));};
  const ctx:ChatContext={where:this.room.view.id?"room":"solo",reply,
   restart:track=>emit({type:"chatAction",action:"restart",...(track===undefined?{}:{track})}),restartBonus:()=>emit({type:"chatAction",action:"restartBonus"}),setStartPoint:()=>emit({type:"chatAction",action:"setStart"}),clearStartPoint:()=>emit({type:"chatAction",action:"clearStart"}),
   game:{key:action=>state.settings.binds[action]?.[0]??null,style:()=>state.style,setStyle:id=>send({type:"style",id}),practice:action=>send({type:"practice",action}),record:(kind,answer)=>{if(!state.map)return answer("Load a map first.");if(kind==="pb"){const pb=getPB(state.map,state.style,state.track);answer(pb?`Your PB: ${formatTime(pb.time)}`:"No PB yet.");}else void api.leaderboard(state.map,state.style,{track:state.track,limit:1}).then(board=>{if(epoch!==this.accountEpoch)return;const top=board.entries[0];answer(top?`WR: ${formatTime(top.time)} by ${top.player.name}`:"No record yet.");},()=>answer("Couldn't load the leaderboard."));}},
   room:this.room.view.id?{spectating:()=>this.room.view.players.find(p=>p.slot===this.room.view.you)?.spec!=null,stopSpectating:()=>{this.room.command({t:"spec",target:null});},spectate:query=>{if(!query){this.openRoom();return;}const p=player(query);if(p&&p.slot!==this.room.view.you)this.room.command({t:"spec",target:p.slot});else reply(`No player "${query}".`);},hidePlayers:toggle=>{this.hidden=toggle?!this.hidden:false;emit({type:"chatAction",action:"hidePlayers",hidden:this.hidden});},toggleScores:()=>emit({type:"chatAction",action:"scores"}),openNominateMenu:()=>this.openRoom(),invite:()=>{if(!this.room.view.room?.private)return reply("Create a private lobby to copy an invite link.");void copyLobbyInvite(this.room.view.id!).then(ok=>reply(ok?"Invite link copied.":"Couldn't copy invite link."));},race:arg=>{if(!arg){this.openRoom();return;}const resolved=resolveRaceCommand(arg,this.room.view.players,this.room.view.you,state.style);if("error" in resolved)return reply(resolved.error);this.room.command({t:"chat",text:resolved.text});},report:query=>{const p=query?player(query):null;this.openRoom();openReport(p?{id:p.id,name:p.name}:query?{name:query}:undefined);},gift:arg=>{const p=arg?player(arg):null;if(arg&&!p)return reply(`No player "${arg}".`);this.openRoom();openGiftDialog({roomId:this.room.view.id!,...(p?{recipientId:p.id,recipientName:p.name}:{})});}}:null};
  dispatchNativeChat(text,ctx,message=>this.room.command(message));
 }
 control(value:unknown):void {if(!value||typeof value!=="object")return;const {action,option}=value as {action:string;option?:number};if(action==="stop"){this.room.command({t:"spec",target:null});return;}if(action==="vote"&&Number.isInteger(option)){this.room.command({t:"vote",option});return;}if(action!=="next"&&action!=="previous")return;const current=this.room.view.players.find(p=>p.slot===this.room.view.you)?.spec;const target=cycleSpectator(this.room.view.players,this.room.view.you,current,action==="next"?1:-1);if(target!==null)this.room.command({t:"spec",target});}
}
