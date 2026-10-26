import {styleByName} from "../../web/src/chat-commands";
import type {StyleId} from "../../web/src/styles";
/** Protocol length is JS UTF-16 units. Never leave a half surrogate behind. */
export function protocolChatText(value:string,maximum=128):string {
 let out="";for(const point of value){const code=point.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff)continue;if(out.length+point.length>maximum)break;out+=point;}return out;
}
export class ChatSuggestionFence {
 private latest=0;
 take(value:unknown):{input:string;request:number}|null {
  if(typeof value==="string")return {input:protocolChatText(value),request:++this.latest};
  if(!value||typeof value!=="object")return null;const {text,request}=value as {text:unknown;request:unknown};
  if(typeof text!=="string"||typeof request!=="number"||!Number.isSafeInteger(request)||request<0||request<this.latest)return null;
  this.latest=request;return {input:protocolChatText(text),request};
 }
}
export function cycleSpectator(players:{slot:number;spec?:number|null}[],you:number,current:number|null|undefined,direction:1|-1):number|null {
 const available=players.filter(p=>p.slot!==you&&p.spec==null).sort((a,b)=>a.slot-b.slot);if(!available.length)return null;
 const at=available.findIndex(p=>p.slot===current);if(at<0)return available[direction===1?0:available.length-1].slot;
 return available[(at+direction+available.length)%available.length].slot;
}
export type RaceCommandResult={text:string}|{error:string};
/** Web race.ts name resolution: longest full name, then unique prefix/#slot.
 * Default race board is main, independently of the player's current bonus. */
export function resolveRaceCommand(arg:string,players:{slot:number;name:string}[],you:number,selected:StyleId,bonusTracks?:readonly number[]):RaceCommandResult {
 const text=arg.trim(),low=text.toLowerCase();if(["cancel","on","off"].includes(low))return {text:`/race ${low}`};
 const others=players.filter(p=>p.slot!==you);let who=others.filter(p=>low===p.name.toLowerCase()||low.startsWith(p.name.toLowerCase()+" ")).sort((a,b)=>b.name.length-a.name.length)[0];let rest=who?text.slice(who.name.length):"";
 if(!who){const [first,...more]=text.split(/\s+/),slot=/^#(\d+)$/.exec(first);const matches=slot?others.filter(p=>p.slot===Number(slot[1])):others.filter(p=>p.name.toLowerCase().startsWith(first.toLowerCase()));if(matches.length!==1)return {error:matches.length?`"${first}" matches ${matches.length} players. Type more of the name, or !race for the menu.`:`No player "${first}" to race.`};who=matches[0];rest=more.join(" ");}
 let style=selected,track=0;for(const word of rest.split(/\s+/).filter(Boolean)){const low=word.toLowerCase(),bonus=/^(?:b|bonus)(\d{0,2})$/.exec(low);if(low==="main"||low==="m")track=0;else if(bonus)track=bonus[1]?Number(bonus[1]):1;else if(/^\d{1,2}$/.test(low))track=Number(low);else {const id=styleByName(word);if(!id)return {error:`No style "${word}". !style lists them.`};style=id;}}
 if(track>64)return {error:"Use main or a bonus number up to 64."};if(track&&bonusTracks&&!bonusTracks.includes(track))return {error:bonusTracks.length?`This map has no Bonus ${track}.`:"This map has no bonus."};return {text:`/race #${who.slot} ${style} ${track}`};
}
