import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import { loadPBReplay } from "../../web/src/pb";
import type { ViewerRequest } from "../../web/src/viewer/request";
import type { RaceRequest } from "../../web/src/player/race";
import { send, state } from "./bridge";

const MAX_BYTES=8<<20;
export function base64Bytes(bytes:Uint8Array):string {let text="";for(let at=0;at<bytes.length;at+=16384)text+=String.fromCharCode(...bytes.subarray(at,at+16384));return btoa(text);}
export function sendReplay(bytes:Uint8Array,action:"play"|"ghost",name:string,map=""):void {
  if(!bytes.length||bytes.length>MAX_BYTES)throw new Error("Replay must be between 1 byte and 8 MiB.");
  send({type:"replayData",action,name:name.slice(0,128),map,replayBase64:base64Bytes(bytes)});
}
export async function watchRequest(request:ViewerRequest):Promise<void> {
  const target=request.target;
  if("runId" in target) sendReplay(await api.replay(target.runId),"play",target.name??target.runId);
  else if("bytes" in target)sendReplay(target.bytes,"play",target.name??"Imported replay");
  else {const pb=target.pb===true?{map:state.map??"",style:state.style,track:state.track}:target.pb;const bytes=await loadPBReplay(pb.map,pb.style??state.style,pb.track??0);if(!bytes)throw new Error("No replay is saved for this PB.");sendReplay(bytes,"play",`${pb.map} PB`,pb.map);}
}
export async function raceRequest(request:RaceRequest):Promise<void> {
  if(request.kind==="clear")send({type:"ghost",enabled:false});
  else if(request.kind==="bytes")sendReplay(request.bytes,"ghost",request.name??"Imported ghost");
  else sendReplay(await api.replay(request.runId),"ghost",request.name??request.runId);
}
export function replayPanel(notice:(value:string)=>void):HTMLElement {
  const root=h("div.native-replays"),list=h("div.native-replay-list"),controls=h("section.native-playback",{"aria-label":"Replay playback"}),ghost=h("label.native-ghost-toggle"),enabled=h("input",{type:"checkbox","aria-label":"Show ghost"});
  const input=h("input",{type:"file",accept:".bhr,application/octet-stream","aria-label":"Import replay"});
  let mode:"play"|"ghost"="play";
  input.addEventListener("change",async()=>{const file=input.files?.[0];if(!file)return;try{if(file.size>MAX_BYTES)throw new Error("Replay exceeds 8 MiB.");sendReplay(new Uint8Array(await file.arrayBuffer()),mode,file.name);notice(`Loading ${file.name}…`);}catch(error){notice(String((error as Error).message));}finally{input.value="";}});
  const importButton=(label:string,action:"play"|"ghost")=>h("button.btn",{type:"button",onclick:()=>{mode=action;input.click();}},label);
  const pause=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"pause",paused:!state.playback.paused})},"Pause");
  const stop=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"stop"})},"Stop");
  const seek=h("input",{type:"range",min:0,max:0,step:1,value:0,"aria-label":"Replay tick"});seek.addEventListener("change",()=>send({type:"replayControl",action:"seek",tick:Number(seek.value)}));
  const speed=h("select",{"aria-label":"Replay speed"},...[.25,.5,1,2,4].map(value=>h("option",{value},`${value}×`)));speed.addEventListener("change",()=>send({type:"replayControl",action:"speed",speed:Number(speed.value)}));
  const tick=h("span.native-playback-position");controls.append(pause,stop,seek,tick,speed);
  enabled.addEventListener("change",()=>send({type:"ghost",enabled:enabled.checked}));ghost.append(enabled,h("span",null,"Show ghost"));
  root.append(h("div.native-toolbar",null,importButton("Import and watch","play"),importButton("Import ghost","ghost"),h("button.btn",{type:"button",onclick:()=>send({type:"replays",action:"list"})},"Refresh"),ghost),input,controls,list);input.hidden=true;
  let previous="";
  const refresh=()=>{
    const playback=state.playback;controls.hidden=!playback.active;pause.textContent=playback.paused?"Play":"Pause";seek.max=String(playback.totalTicks);if(document.activeElement!==seek)seek.value=String(playback.tick);tick.textContent=`${playback.tick} / ${playback.totalTicks}`;if(document.activeElement!==speed)speed.value=String(playback.speed);enabled.checked=state.ghost.enabled;
    const key=JSON.stringify(state.replays);if(key===previous)return;previous=key;
    list.replaceChildren(...(state.replays.length?state.replays.map(replay=>{
      const action=(label:string,type:"play"|"ghost"|"export")=>h("button.btn",{type:"button",onclick:()=>send({type:"replay",action:type,id:replay.id})},label);
      const remove=h("button.link-btn",{type:"button"},"Delete");remove.onclick=()=>{const dialog=h("dialog.acct-dialog",{"aria-label":"Delete replay"},h("div.acct-body",null,h("h3",null,"Delete this replay?"),h("p",null,replay.name),h("button.btn",{type:"button",onclick:()=>{send({type:"replay",action:"delete",id:replay.id,confirmed:true});dialog.close();}},"Delete replay"),h("button.btn",{type:"button",onclick:()=>dialog.close()},"Cancel")));dialog.addEventListener("close",()=>dialog.remove());document.body.append(dialog);dialog.showModal();};
      return h("article.native-replay-row",null,h("div",null,h("strong",null,replay.name),h("p.dim",null,`${replay.map} · ${styleLabel(replay.style)} · ${formatTime(replay.seconds)}${replay.track?` · Bonus ${replay.track}`:""}`)),h("div.native-toolbar",null,action("Watch","play"),action("Ghost","ghost"),action("Export","export"),remove));
    }):[h("p.dim",null,"No local replays yet. Finish a run or import a .bhr file.")]));
  };
  const update=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",update);return;}refresh();};window.addEventListener("bunnyhop:host-state",update);refresh();send({type:"replays",action:"list"});return root;
}
