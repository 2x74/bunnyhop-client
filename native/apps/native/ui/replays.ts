import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import { loadPBReplay } from "../../web/src/pb";
import type { ViewerRequest } from "../../web/src/viewer/request";
import type { RaceRequest } from "../../web/src/player/race";
import { send, state } from "./bridge";
import { reportButton, setWatchedRun, watchedRun } from "./report";
import { fetchMapIndex } from "../../web/src/ui/maps";
import { onWatchingSplit, stepSplit, stopWatchingSplit, watchingSplit, type GauntletWatchDeps } from "./gauntlet-watch";

/** Gauntlet attempt watching (gauntlet-watch.ts) over this file's playback and the map index's digests. */
export const gauntletWatchDeps:GauntletWatchDeps={
  plan:attemptId=>api.gauntletWatch(attemptId),
  sha:async map=>(await fetchMapIndex()).find(entry=>entry.name===map)?.sha256??null,
  play:(runId,name)=>watchRequest({target:{runId,name}}),
};

const MAX_BYTES=8<<20;
import { base64Bytes } from "./base64";
export { base64Bytes };
/** Every replay that starts playing replaces the one before: no server run (Report) or gauntlet split carries over. */
function playing():void {setWatchedRun(null);stopWatchingSplit();}
export function sendReplay(bytes:Uint8Array,action:"play"|"ghost",name:string,map=""):void {
  if(!bytes.length||bytes.length>MAX_BYTES)throw new Error("Replay must be between 1 byte and 8 MiB.");
  if(action==="play")playing();
  send({type:"replayData",action,name:name.slice(0,128),map,replayBase64:base64Bytes(bytes)});
}
/** A replay from the local archive (the Replays list, the pause menu's last run). */
export function playLocalReplay(id:string):void {playing();send({type:"replay",action:"play",id});}
export async function watchRequest(request:ViewerRequest):Promise<void> {
  const target=request.target;
  stopWatchingSplit();
  // (Only a server run has a player to report: set after sendReplay, which clears the last one.)
  if("runId" in target) {const bytes=await api.replay(target.runId);sendReplay(bytes,"play",target.name??target.runId);setWatchedRun({runId:target.runId,name:target.name??"this player",map:"",time:null});}
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
  const tick=h("span.native-playback-position"),report=h("span.native-playback-report"),splitBar=h("div.native-gauntlet-watch");controls.append(pause,stop,seek,tick,speed,report,splitBar);
  // Watching a gauntlet attempt: which split, the total before it, Previous / Next split.
  const paintSplit=()=>{const w=watchingSplit();if(!w||!state.playback.active){splitBar.replaceChildren();return;}
    const order=w.plan.splits.map(s=>s.idx).sort((a,b)=>a-b),at=order.indexOf(w.idx);
    const step=(delta:-1|1)=>()=>void stepSplit(gauntletWatchDeps,delta).catch(error=>notice((error as Error).message));
    splitBar.replaceChildren(h("span.dim",null,`${w.plan.gauntlet.title} · ${w.plan.player.name} · split ${w.idx+1} of ${w.plan.gauntlet.maps}${w.before?` · ${formatTime(w.before)} before`:""}`),
      h("button.btn",{type:"button",disabled:at<=0,onclick:step(-1)},"Previous split"),h("button.btn",{type:"button",disabled:at<0||at>=order.length-1,onclick:step(1)},"Next split"));};
  const offSplit=onWatchingSplit(()=>{if(root.isConnected)paintSplit();else offSplit();});
  // The web viewer's Report chip: a server run that isn't yours, about that run (the server finds its player).
  let reportKey="";
  const paintReport=()=>{const host=state.playback.player,run=host?.runId?{runId:host.runId,name:host.name??"this player"}:watchedRun();const key=state.playback.active&&run?`${run.runId}:${run.name}`:"";if(key===reportKey)return;reportKey=key;report.replaceChildren(...(key&&run?[reportButton({...(host?.id?{id:host.id}:{}),name:run.name,run:{id:run.runId,map:state.map??"",time:null}})].filter((item):item is HTMLButtonElement=>!!item):[]));};
  enabled.addEventListener("change",()=>send({type:"ghost",enabled:enabled.checked}));ghost.append(enabled,h("span",null,"Show ghost"));
  root.append(h("div.native-toolbar",null,importButton("Import and watch","play"),importButton("Import ghost","ghost"),h("button.btn",{type:"button",onclick:()=>send({type:"replays",action:"list"})},"Refresh"),ghost),input,controls,list);input.hidden=true;
  let previous="";
  const refresh=()=>{
    const playback=state.playback;controls.hidden=!playback.active;paintReport();paintSplit();pause.textContent=playback.paused?"Play":"Pause";seek.max=String(playback.totalTicks);if(document.activeElement!==seek)seek.value=String(playback.tick);tick.textContent=`${playback.tick} / ${playback.totalTicks}`;if(document.activeElement!==speed)speed.value=String(playback.speed);enabled.checked=state.ghost.enabled;
    const key=JSON.stringify(state.replays);if(key===previous)return;previous=key;
    list.replaceChildren(...(state.replays.length?state.replays.map(replay=>{
      const action=(label:string,type:"play"|"ghost"|"export")=>h("button.btn",{type:"button",onclick:()=>{if(type==="play")playLocalReplay(replay.id);else send({type:"replay",action:type,id:replay.id});}},label);
      const remove=h("button.link-btn",{type:"button"},"Delete");remove.onclick=()=>{const dialog=h("dialog.acct-dialog",{"aria-label":"Delete replay"},h("div.acct-body",null,h("h3",null,"Delete this replay?"),h("p",null,replay.name),h("button.btn",{type:"button",onclick:()=>{send({type:"replay",action:"delete",id:replay.id,confirmed:true});dialog.close();}},"Delete replay"),h("button.btn",{type:"button",onclick:()=>dialog.close()},"Cancel")));dialog.addEventListener("close",()=>dialog.remove());document.body.append(dialog);dialog.showModal();};
      return h("article.native-replay-row",null,h("div",null,h("strong",null,replay.name),h("p.dim",null,`${replay.map} · ${styleLabel(replay.style)} · ${formatTime(replay.seconds)}${replay.track?` · Bonus ${replay.track}`:""}`)),h("div.native-toolbar",null,action("Watch","play"),action("Ghost","ghost"),action("Export","export"),remove));
    }):[h("p.dim",null,"No local replays yet. Finish a run or import a .bhr file.")]));
  };
  const update=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",update);return;}refresh();};window.addEventListener("bunnyhop:host-state",update);refresh();send({type:"replays",action:"list"});return root;
}
