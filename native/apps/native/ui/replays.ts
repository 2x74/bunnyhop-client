import {replayLibrary,type ReplaySort} from "./replay-library";
import { ReplayCache } from "./replay-cache";
import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import { loadPBReplay } from "../../web/src/pb";
import type { ViewerRequest } from "../../web/src/viewer/request";
import type { RaceRequest } from "../../web/src/player/race";
import { runSeconds, send, state, type NativeReplay } from "./bridge";
import { setWatchedRun } from "./report";
import { fetchMapIndex } from "../../web/src/ui/maps";
import { onWatchingSplit, stepSplit, stopWatchingSplit, watchingSplit, setAutoAdvance, updateWatchingPlayback, type GauntletWatchDeps } from "./gauntlet-watch";
import { ReplayViewer } from "./replay-viewer";

const serverReplays=new ReplayCache(id=>api.replay(id));
let watchingInstalled=false;
function installWatching():void{if(watchingInstalled||typeof window==="undefined")return;watchingInstalled=true;window.addEventListener("bunnyhop:host-state",()=>{void updateWatchingPlayback(gauntletWatchDeps,{...state.playback,map:state.map}).catch(error=>send({type:"hudToast",text:(error as Error).message,ms:5000}));});}
/** Gauntlet attempt watching (gauntlet-watch.ts) over this file's playback and the map index's digests. */
export const gauntletWatchDeps:GauntletWatchDeps={
  plan:attemptId=>api.gauntletWatch(attemptId),
  sha:async map=>(await fetchMapIndex()).find(entry=>entry.name===map)?.sha256??null,
  play:async(runId,name)=>{installWatching();const bytes=await serverReplays.get(runId);sendReplay(bytes,"play",name,"",true);setWatchedRun({runId,name,map:"",time:null});
    try{const hash=await crypto.subtle.digest("SHA-256",bytes.slice().buffer);return "import-"+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("")+".bhr";}catch{return;}
  },
  prefetch:(runId,map,sha)=>{send({type:"prefetchMap",map,sha});return serverReplays.get(runId);},
  cancelPrefetch:()=>send({type:"prefetchMap",map:null}),
};

const MAX_BYTES=8<<20;
let selectedGhostSlot=0;
import { base64Bytes } from "./base64";
export { base64Bytes };
/** Every replay that starts playing replaces the one before: no server run (Report) or gauntlet split carries over. */
function playing():void {setWatchedRun(null);stopWatchingSplit();}
export function sendReplay(bytes:Uint8Array,action:"play"|"ghost",name:string,map="",preserveWatch=false,ghostSlot=selectedGhostSlot):void {
  if(!bytes.length||bytes.length>MAX_BYTES)throw new Error("Replay must be between 1 byte and 8 MiB.");
  if(action==="play"&&!preserveWatch)playing();
  send({type:"replayData",action,...(action==="ghost"?{ghostSlot}:{}),name:name.slice(0,128),map,replayBase64:base64Bytes(bytes)});
}
/** A replay from the local archive (the Replays list, the pause menu's last run). */
export function playLocalReplay(id:string):void {playing();send({type:"replay",action:"play",id});}
export async function watchRequest(request:ViewerRequest):Promise<void> {
  const target=request.target;
  stopWatchingSplit();
  // (Only a server run has a player to report: set after sendReplay, which clears the last one.)
  if("runId" in target) {const bytes=await serverReplays.get(target.runId);sendReplay(bytes,"play",target.name??target.runId);setWatchedRun({runId:target.runId,name:target.name??"this player",map:"",time:null});}
  else if("bytes" in target)sendReplay(target.bytes,"play",target.name??"Imported replay");
  else {const pb=target.pb===true?{map:state.map??"",style:state.style,track:state.track}:target.pb;const bytes=await loadPBReplay(pb.map,pb.style??state.style,pb.track??0);if(!bytes)throw new Error("No replay is saved for this PB.");sendReplay(bytes,"play",`${pb.map} PB`,pb.map);}
}
export async function raceRequest(request:RaceRequest):Promise<void> {
  if(request.kind==="clear")send({type:"ghostControl",action:"clear"});
  else if(request.kind==="bytes")sendReplay(request.bytes,"ghost",request.name??"Imported ghost");
  else sendReplay(await api.replay(request.runId),"ghost",request.name??request.runId);
}

/** Watching a gauntlet attempt: which split, the total before it, Previous / Next split, auto advance. */
function paintSplit(bar:HTMLElement,notice:(text:string)=>void):void {
  const watching=watchingSplit();
  if(!watching||!state.playback.active){bar.replaceChildren();return;}
  const order=watching.plan.splits.map(split=>split.idx).sort((a,b)=>a-b);
  const at=order.indexOf(watching.idx);
  const step=(delta:-1|1)=>()=>void stepSplit(gauntletWatchDeps,delta).catch(error=>notice((error as Error).message));
  const autoAdvance=h("input",{type:"checkbox",checked:watching.autoAdvance,"aria-label":"Auto advance splits"}) as HTMLInputElement;
  autoAdvance.addEventListener("change",()=>setAutoAdvance(autoAdvance.checked));
  const plan=watching.plan;
  const total=formatTime(watching.before+(state.playback.seconds??0));
  const before=watching.before?` · ${formatTime(watching.before)} before`:"";
  const line=`${plan.gauntlet.title} · ${plan.player.name} · ${total} total · split ${watching.idx+1} of ${plan.gauntlet.maps}${before}`;
  bar.replaceChildren(
    h("button.rv-btn.rv-chip",{type:"button",disabled:at<=0,onclick:step(-1)},"Previous split"),
    h("span.rv-gx-pos",null,line),
    h("button.rv-btn.rv-chip",{type:"button",disabled:at<0||at>=order.length-1,onclick:step(1)},"Next split"),
    h("label.rv-check",null,autoAdvance,"Auto advance"));
}

/** The viewer while a replay plays (replay-viewer.ts). It sits over the page, outside the menu's panel. */
export function replayViewer(notice:(text:string)=>void):{el:HTMLElement;dispose:()=>void} {
  const splitBar=h("div.native-gauntlet-watch");
  const viewer=new ReplayViewer({notice,splitBar});
  const offSplit=onWatchingSplit(()=>paintSplit(splitBar,notice));
  const update=()=>{paintSplit(splitBar,notice);viewer.update();};
  window.addEventListener("bunnyhop:host-state",update);
  update();
  return {el:viewer.el,dispose:()=>{offSplit();window.removeEventListener("bunnyhop:host-state",update);viewer.dispose();}};
}

function confirmDelete(replay:NativeReplay):void {
  const dialog=h("dialog.acct-dialog",{"aria-label":"Delete replay"},h("div.acct-body",null,
    h("h3",null,"Delete this replay?"),h("p",null,replay.name),
    h("button.btn",{type:"button",onclick:()=>{send({type:"replay",action:"delete",id:replay.id,confirmed:true});dialog.close();}},"Delete replay"),
    h("button.btn",{type:"button",onclick:()=>dialog.close()},"Cancel")));
  dialog.addEventListener("close",()=>dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function replayRow(replay:NativeReplay):HTMLElement {
  const action=(label:string,type:"play"|"ghost"|"export")=>h("button.btn.btn-sm",{type:"button",onclick:()=>{
    if(type==="play")playLocalReplay(replay.id);
    else send({type:"replay",action:type,id:replay.id,...(type==="ghost"?{ghostSlot:selectedGhostSlot}:{})});
  }},label);
  const remove=h("button.link-btn",{type:"button",onclick:()=>confirmDelete(replay)},"Delete");
  const meta=[replay.map,styleLabel(replay.style),replay.track?`Bonus ${replay.track}`:"",new Date(replay.recordedAt).toLocaleString(),`${(replay.bytes/1024).toFixed(0)} KB`].filter(Boolean).join(" · ");
  const summary=replay.localSummary;
  const stats=summary?`${summary.localPb?"Device PB · ":""}${summary.jumps} jumps · ${summary.strafes} strafes · ${Number(summary.sync).toFixed(1)}% sync`:"";
  const screenshot=replay.screenshot?[h("button.btn.btn-sm",{type:"button",onclick:()=>send({type:"replay",action:"screenshot",id:replay.id})},"View result")]:[];
  return h("article.native-replay-row",null,
    h("div.native-replay-what",null,h("strong",null,replay.name),h("small.dim",null,meta),stats?h("small.dim",null,stats):null),
    h("span.native-replay-time",null,formatTime(runSeconds(replay)??0)),
    h("div.native-replay-actions",null,action("Watch","play"),action("Ghost","ghost"),action("Export","export"),...screenshot,remove));
}

/** The local replay vault: the Replays screen when nothing is playing. */
export function replayPanel(notice:(value:string)=>void):HTMLElement {
  const root=h("div.native-replays"),list=h("div.native-replay-list"),ghost=h("label.native-ghost-toggle"),enabled=h("input",{type:"checkbox","aria-label":"Show ghost"}) as HTMLInputElement;
  const input=h("input",{type:"file",accept:".bhr,application/octet-stream","aria-label":"Import replay",hidden:true}) as HTMLInputElement;
  const ghostSlot=h("select",{"aria-label":"Ghost slot"},...[0,1,2,3].map(value=>h("option",{value},`Ghost ${value+1}`))) as HTMLSelectElement;ghostSlot.value=String(selectedGhostSlot);ghostSlot.addEventListener("change",()=>{selectedGhostSlot=Number(ghostSlot.value);});
  const ghostRows=h("div.native-ghost-slots",{"aria-label":"Loaded ghosts"});
  const loadGhost=async(source:"pb"|"wr")=>{
    const {map,style,track}=state,slot=selectedGhostSlot;if(!map){notice("Load a map first.");return;}
    try{if(source==="pb"){const bytes=await loadPBReplay(map,style,track);if(!bytes)throw new Error("No replay is saved for this PB.");sendReplay(bytes,"ghost",`${map} PB`,map,false,slot);}
      else{const board=await api.leaderboard(map,style,{track,limit:1});const wr=board.wr??board.entries.find(entry=>entry.rank===1);if(!wr)throw new Error("This board has no world-record replay.");sendReplay(await serverReplays.get(wr.runId),"ghost",`${wr.player.name} WR`,map,false,slot);}}
    catch(error){notice((error as Error).message);}
  };
  let mode:"play"|"ghost"="play";
  input.addEventListener("change",async()=>{const file=input.files?.[0];if(!file)return;try{if(file.size>MAX_BYTES)throw new Error("Replay exceeds 8 MiB.");sendReplay(new Uint8Array(await file.arrayBuffer()),mode,file.name);notice(`Loading ${file.name}…`);}catch(error){notice(String((error as Error).message));}finally{input.value="";}});
  const importButton=(label:string,action:"play"|"ghost")=>h("button.btn",{type:"button",onclick:()=>{mode=action;input.click();}},label);
  enabled.addEventListener("change",()=>send({type:"ghost",enabled:enabled.checked}));ghost.append(enabled,h("span",null,"Show ghost"));
  const search=h("input.rb-q",{type:"search","aria-label":"Search replay vault",placeholder:"Search map or player"}) as HTMLInputElement;
  const filter=h("select",{"aria-label":"Replay style"}) as HTMLSelectElement;
  const sort=h("select",{"aria-label":"Sort replay vault"},h("option",{value:"newest"},"Newest first"),h("option",{value:"oldest"},"Oldest first"),h("option",{value:"fastest"},"Fastest first"),h("option",{value:"map"},"Map")) as HTMLSelectElement;
  const summary=h("p.dim.native-replay-summary");
  for(const control of [search,filter,sort])control.addEventListener("input",()=>{previous="";refresh();});
  root.append(
    h("p.dim.native-replay-lead",null,"Finished runs and imported replays on this computer. Watch, race as a ghost, or save the file."),
    h("div.native-toolbar",null,search,filter,sort,summary),
    h("div.native-toolbar",null,importButton("Import and watch","play"),importButton("Import ghost","ghost"),ghostSlot,
      h("button.btn",{type:"button",onclick:()=>void loadGhost("pb")},"Race PB"),h("button.btn",{type:"button",onclick:()=>void loadGhost("wr")},"Race WR"),
      h("button.btn",{type:"button",onclick:()=>send({type:"ghostControl",action:"clear"})},"Clear ghosts"),
      h("button.btn",{type:"button",onclick:()=>send({type:"replays",action:"list"})},"Refresh"),ghost),
    input,ghostRows,list);
  let previous="",previousGhosts="";
  const paintGhosts=()=>{
    const key=JSON.stringify(state.ghosts);
    if(key===previousGhosts)return;
    previousGhosts=key;
    ghostRows.replaceChildren(...state.ghosts.map(item=>{
      const shown=h("input",{type:"checkbox",checked:item.enabled,"aria-label":`Show ghost ${item.slot+1}`}) as HTMLInputElement;
      shown.addEventListener("change",()=>send({type:"ghostControl",action:"toggle",slot:item.slot,enabled:shown.checked}));
      return h("div.native-toolbar",null,h("label",null,shown,`Ghost ${item.slot+1}: ${item.name}`),h("button.btn",{type:"button",onclick:()=>send({type:"ghostControl",action:"remove",slot:item.slot})},"Remove"));
    }));
  };
  const paintStyles=()=>{
    const styles=[...new Set(state.replays.map(replay=>replay.style))].sort(),key=styles.join(",");
    if(filter.dataset.styles===key)return;
    const selected=filter.value;
    filter.replaceChildren(h("option",{value:""},"All styles"),...styles.map(style=>h("option",{value:style},styleLabel(style))));
    filter.value=selected;
    filter.dataset.styles=key;
  };
  const refresh=()=>{
    enabled.checked=state.ghost.enabled;
    paintGhosts();
    paintStyles();
    const shown=replayLibrary(state.replays,search.value,filter.value,sort.value as ReplaySort);
    const megabytes=(state.replays.reduce((total,replay)=>total+replay.bytes,0)/1048576).toFixed(1);
    summary.textContent=`${shown.length} of ${state.replays.length} replays · ${megabytes} MB`;
    const key=JSON.stringify([state.replays,search.value,filter.value,sort.value]);if(key===previous)return;previous=key;
    const empty=state.replays.length?"No replays match these filters.":"No local replays yet. Finish a run or import a .bhr file.";
    list.replaceChildren(...(shown.length?shown.map(replayRow):[h("p.dim",null,empty)]));
  };
  const update=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",update);return;}refresh();};window.addEventListener("bunnyhop:host-state",update);refresh();send({type:"replays",action:"list"});return root;
}
