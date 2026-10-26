import {ReplayScrubber} from "./replay-scrubber";
import {replayLibrary,type ReplaySort} from "./replay-library";
import { ReplayCache } from "./replay-cache";
import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import { loadPBReplay } from "../../web/src/pb";
import type { ViewerRequest } from "../../web/src/viewer/request";
import type { RaceRequest } from "../../web/src/player/race";
import { send, state,type VideoExportOptions } from "./bridge";
import { reportButton, setWatchedRun, watchedRun } from "./report";
import { fetchMapIndex } from "../../web/src/ui/maps";
import { onWatchingSplit, stepSplit, stopWatchingSplit, watchingSplit, setAutoAdvance, updateWatchingPlayback, type GauntletWatchDeps } from "./gauntlet-watch";

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
export function replayPanel(notice:(value:string)=>void):HTMLElement {
  const root=h("div.native-replays"),list=h("div.native-replay-list"),controls=h("section.native-playback",{"aria-label":"Replay playback"}),ghost=h("label.native-ghost-toggle"),enabled=h("input",{type:"checkbox","aria-label":"Show ghost"});
  const input=h("input",{type:"file",accept:".bhr,application/octet-stream","aria-label":"Import replay"});
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
  const pause=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"pause",paused:!state.playback.paused})},"Pause");
  const stop=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"stop"})},"Stop");
  const seek=h("input",{type:"range",min:0,max:0,step:1,value:0,"aria-label":"Replay tick"});
  const scrub=new ReplayScrubber({seek:tick=>send({type:"replayControl",action:"seek",tick}),pause:paused=>send({type:"replayControl",action:"pause",paused})});
  let pendingTick:number|null=null,pendingUntil=0,scrubReplayId=state.playback.id;
  const position=()=>{const value=scrub.active?scrub.value:pendingTick??state.playback.tick,dt=state.playback.tickInterval??.01;tick.textContent=`${formatTime(value*dt)} / ${formatTime(state.playback.totalTicks*dt)} · tick ${value}`;seek.style.setProperty("--p",String(state.playback.totalTicks?value/state.playback.totalTicks:0));seek.setAttribute("aria-valuetext",`${formatTime(value*dt)} of ${formatTime(state.playback.totalTicks*dt)}`);};
  seek.addEventListener("pointerdown",()=>scrub.begin(state.playback.paused,Number(seek.value)));
  seek.addEventListener("input",()=>{if(!scrub.active)scrub.begin(state.playback.paused,Number(seek.value));scrub.update(Number(seek.value));position();});
  const finishScrub=()=>{if(!scrub.active)return;pendingTick=Number(seek.value);pendingUntil=performance.now()+1500;scrub.finish(pendingTick);position();};
  seek.addEventListener("change",finishScrub);seek.addEventListener("pointerup",finishScrub);seek.addEventListener("pointercancel",finishScrub);seek.addEventListener("blur",finishScrub);
  const stepFrame=(delta:number)=>()=>{send({type:"replayControl",action:"pause",paused:true});send({type:"replayControl",action:"seek",tick:Math.max(0,Math.min(state.playback.totalTicks,state.playback.tick+delta))});};
  const previousFrame=h("button.btn",{type:"button","aria-label":"Previous replay frame",onclick:stepFrame(-1)},"−1 frame"),nextFrame=h("button.btn",{type:"button","aria-label":"Next replay frame",onclick:stepFrame(1)},"+1 frame");
  const start=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"seek",tick:0})},"Start"),end=h("button.btn",{type:"button",onclick:()=>send({type:"replayControl",action:"seek",tick:state.playback.totalTicks})},"End");
  const speed=h("select",{"aria-label":"Replay speed"},...[.25,.5,1,2,4].map(value=>h("option",{value},`${value}×`)));speed.addEventListener("change",()=>send({type:"replayControl",action:"speed",speed:Number(speed.value)}));
  const camera=h("select",{"aria-label":"Replay camera"},...["eye","chase","free","flyby","auto"].map(value=>h("option",{value},value))) as HTMLSelectElement;
  camera.addEventListener("change",()=>send({type:"replayControl",action:"camera",camera:camera.value}));
  const videoSection=h("section.native-video-export",{"aria-label":"Export replay video"});
  const videoSize=h("select",{"aria-label":"Video resolution"},...["1280x720","1920x1080","2560x1440"].map(value=>h("option",{value},value))) as HTMLSelectElement;
  const videoFormat=h("select",{"aria-label":"Video orientation"},h("option",{value:"landscape"},"Landscape"),h("option",{value:"portrait"},"Portrait")) as HTMLSelectElement;
  const videoFps=h("select",{"aria-label":"Video FPS"},...[30,60,120].map(value=>h("option",{value},String(value)))) as HTMLSelectElement;videoFps.value="60";
  const videoQuality=h("select",{"aria-label":"Video quality"},...["standard","high","max"].map(value=>h("option",{value},value))) as HTMLSelectElement;videoQuality.value="high";
  const videoCamera=h("select",{"aria-label":"Video camera"},...["eye","chase","flyby","auto"].map(value=>h("option",{value},value))) as HTMLSelectElement;
  const videoHud=h("input",{type:"checkbox",checked:true,"aria-label":"Video HUD"}) as HTMLInputElement;
  const videoAudio=h("input",{type:"checkbox",checked:true,"aria-label":"Include gameplay audio"}) as HTMLInputElement;
  const videoMusic=h("select",{"aria-label":"Video music track"},h("option",{value:"none"},"No music")) as HTMLSelectElement;
  const videoMusicOffset=h("input",{type:"number",min:0,max:1800,step:.01,value:0,"aria-label":"Music start offset seconds"}) as HTMLInputElement;
  const videoMusicLevel=h("input",{type:"number",min:0,max:1,step:.05,value:1,"aria-label":"Export music level"}) as HTMLInputElement;
  const videoMusicLoop=h("input",{type:"checkbox",checked:true,"aria-label":"Loop export music"}) as HTMLInputElement;
  const videoMusicDuck=h("input",{type:"checkbox",checked:true,"aria-label":"Duck music under gameplay audio"}) as HTMLInputElement;
  const videoMusicNote=h("p.dim");
  const videoFrom=h("input",{type:"number",min:0,step:.01,value:0,"aria-label":"Video clip start seconds"}) as HTMLInputElement;
  const videoTo=h("input",{type:"number",min:0,step:.01,value:0,"aria-label":"Video clip end seconds"}) as HTMLInputElement;
  const videoProgress=h("progress",{max:1,value:0,"aria-label":"Video export progress"}) as HTMLProgressElement;
  const videoStatus=h("p.dim",{role:"status"});let videoId="";
  const videoStart=h("button.btn",{type:"button",onclick:()=>{
    const interval=state.playback.tickInterval??.01,from=Math.round(videoFrom.valueAsNumber/interval),to=Math.round(videoTo.valueAsNumber/interval);if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>state.playback.totalTicks){notice("Choose a clip end after its start, within this replay.");return;}
    if(!Number.isFinite(videoMusicOffset.valueAsNumber)||videoMusicOffset.valueAsNumber<0||videoMusicOffset.valueAsNumber>1800||!Number.isFinite(videoMusicLevel.valueAsNumber)||videoMusicLevel.valueAsNumber<0||videoMusicLevel.valueAsNumber>1){notice("Choose a music offset from 0 to 1800 seconds and level from 0 to 1.");return;}
    const size=videoSize.value.split("x").map(Number);if(videoFormat.value==="portrait")size.reverse();
    send({type:"videoExport",action:"start",options:{width:size[0],height:size[1],fps:Number(videoFps.value),quality:videoQuality.value as VideoExportOptions["quality"],camera:videoCamera.value as VideoExportOptions["camera"],hud:videoHud.checked,audio:videoAudio.checked,music:videoMusic.value,musicOffset:videoMusicOffset.valueAsNumber,musicLevel:videoMusicLevel.valueAsNumber,musicLoop:videoMusicLoop.checked,musicDuck:videoMusicDuck.checked,from,to}});
  }},"Save MP4 to Downloads");
  const videoCancel=h("button.btn",{type:"button",onclick:()=>send({type:"videoExport",action:"cancel"})},"Cancel export");
  videoSection.append(h("h3",null,"Export current replay"),h("p.dim",null,"Gameplay sounds, announcer and music follow your master/channel levels and mutes. Music starts at the chosen song offset when the clip begins, with short edge fades. Choose from your current music pack. Requires FFmpeg with libx264 and AAC; export runs locally."),h("div.native-toolbar",null,videoSize,videoFormat,videoFps,videoQuality,videoCamera,h("label",null,videoHud,"HUD"),h("label",null,videoAudio,"Gameplay audio")),h("div.native-toolbar",null,h("label",null,"Music ",videoMusic),h("label",null,"Song offset (s) ",videoMusicOffset),h("label",null,"Music level (0–1) ",videoMusicLevel),h("label",null,videoMusicLoop,"Loop song"),h("label",null,videoMusicDuck,"Duck under gameplay")),videoMusicNote,h("div.native-toolbar",null,h("label",null,"Start (s) ",videoFrom),h("label",null,"End (s) ",videoTo),videoStart,videoCancel),videoProgress,videoStatus);
  const tick=h("span.native-playback-position"),report=h("span.native-playback-report"),splitBar=h("div.native-gauntlet-watch");controls.append(pause,stop,start,previousFrame,nextFrame,end,seek,tick,speed,camera,report,splitBar);
  // Watching a gauntlet attempt: which split, the total before it, Previous / Next split.
  const paintSplit=()=>{const w=watchingSplit();if(!w||!state.playback.active){splitBar.replaceChildren();return;}
    const order=w.plan.splits.map(s=>s.idx).sort((a,b)=>a-b),at=order.indexOf(w.idx);
    const step=(delta:-1|1)=>()=>void stepSplit(gauntletWatchDeps,delta).catch(error=>notice((error as Error).message));
    const autoAdvance=h("input",{type:"checkbox",checked:w.autoAdvance,"aria-label":"Auto advance splits"}) as HTMLInputElement;autoAdvance.addEventListener("change",()=>setAutoAdvance(autoAdvance.checked));
    splitBar.replaceChildren(h("label",null,autoAdvance,"Auto advance"),h("span.dim",null,`${w.plan.gauntlet.title} · ${w.plan.player.name} · ${formatTime(w.before+(state.playback.seconds??0))} total · split ${w.idx+1} of ${w.plan.gauntlet.maps}${w.before?` · ${formatTime(w.before)} before`:""}`),
      h("button.btn",{type:"button",disabled:at<=0,onclick:step(-1)},"Previous split"),h("button.btn",{type:"button",disabled:at<0||at>=order.length-1,onclick:step(1)},"Next split"));};
  const offSplit=onWatchingSplit(()=>{if(root.isConnected)paintSplit();else offSplit();});
  // The web viewer's Report chip: a server run that isn't yours, about that run (the server finds its player).
  let reportKey="";
  const paintReport=()=>{const host=state.playback.player,run=host?.runId?{runId:host.runId,name:host.name??"this player"}:watchedRun();const key=state.playback.active&&run?`${run.runId}:${run.name}`:"";if(key===reportKey)return;reportKey=key;report.replaceChildren(...(key&&run?[reportButton({...(host?.id?{id:host.id}:{}),name:run.name,run:{id:run.runId,map:state.map??"",time:null}})].filter((item):item is HTMLButtonElement=>!!item):[]));};
  enabled.addEventListener("change",()=>send({type:"ghost",enabled:enabled.checked}));ghost.append(enabled,h("span",null,"Show ghost"));
  const search=h("input",{type:"search","aria-label":"Search replay vault",placeholder:"Search map or player"}),filter=h("select",{"aria-label":"Replay style"}),sort=h("select",{"aria-label":"Sort replay vault"},h("option",{value:"newest"},"Newest first"),h("option",{value:"oldest"},"Oldest first"),h("option",{value:"fastest"},"Fastest first"),h("option",{value:"map"},"Map")),summary=h("p.dim");
  for(const control of [search,filter,sort])control.addEventListener("input",()=>{previous="";refresh();});
  root.append(h("h3",null,"Local replay vault"),h("p.dim",null,"Completed runs and imported replays are stored on this computer. Watch, race a ghost, or export a replay file."),h("div.native-toolbar",null,search,filter,sort),summary,h("div.native-toolbar",null,importButton("Import and watch","play"),importButton("Import ghost","ghost"),ghostSlot,h("button.btn",{type:"button",onclick:()=>void loadGhost("pb")},"Race PB"),h("button.btn",{type:"button",onclick:()=>void loadGhost("wr")},"Race WR"),h("button.btn",{type:"button",onclick:()=>send({type:"ghostControl",action:"clear"})},"Clear ghosts"),h("button.btn",{type:"button",onclick:()=>send({type:"replays",action:"list"})},"Refresh"),ghost),input,controls,videoSection,ghostRows,list);input.hidden=true;
  let previous="",previousGhosts="";
  const refresh=()=>{
    const video=state.videoExport,busy=video.state==="capturing"||video.state==="encoding";
    videoSection.hidden=!state.playback.active&&!busy&&video.state==="idle";videoStart.disabled=busy||!video.available||!state.playback.active;videoCancel.hidden=!busy;videoProgress.hidden=!busy;videoProgress.value=video.progress;
    videoStatus.textContent=video.state==="completed"?`Saved: ${video.path}`:video.state==="error"?video.error:video.state==="canceled"?"Export canceled.":busy?`${video.state=== "capturing"?"Capturing":"Encoding"} ${video.frames}/${video.totalFrames} frames (${Math.round(video.progress*100)}%)`:video.reason;
    if(videoId!==state.playback.id){videoId=state.playback.id;videoFrom.value="0";videoTo.value=String(Math.floor(state.playback.totalTicks*(state.playback.tickInterval??.01)*100)/100);}
    for(const control of [pause,stop,start,end,previousFrame,nextFrame,seek,speed,camera,videoSize,videoFormat,videoFps,videoQuality,videoCamera,videoHud,videoAudio,videoMusic,videoMusicOffset,videoMusicLevel,videoMusicLoop,videoMusicDuck,videoFrom,videoTo])control.disabled=busy;
    const musicKey=JSON.stringify(video.musicTracks);if(videoMusic.dataset.tracks!==musicKey){const selected=videoMusic.value;videoMusic.replaceChildren(h("option",{value:"none"},"No music"),...video.musicTracks.map(track=>h("option",{value:track.id},track.title)));videoMusic.value=video.musicTracks.some(track=>track.id===selected)?selected:"none";videoMusic.dataset.tracks=musicKey;}
    const noMusic=videoMusic.value==="none";for(const control of [videoMusicOffset,videoMusicLevel,videoMusicLoop,videoMusicDuck])control.disabled=busy||noMusic;videoMusicDuck.disabled=busy||noMusic||!videoAudio.checked;
    videoMusicNote.textContent=state.settings.muted?"Master audio is muted; this export will be silent.":state.settings.muteMusic||state.settings.musicVolume===0?"Music is muted in Sound settings.":video.musicTracks.length?"The level multiplies your current music volume. Only game tracks are offered; custom songs come from your bgm folder.":"No gameplay tracks in this music pack. Add custom songs in Sound settings or choose the bunnyhop.lol pack.";
    const playback=state.playback;if(scrubReplayId!==playback.id||!playback.active){scrub.cancel(false);pendingTick=null;scrubReplayId=playback.id;}controls.hidden=!playback.active;paintReport();paintSplit();pause.textContent=playback.paused?"Play":"Pause";seek.max=String(playback.totalTicks);if(pendingTick!==null&&(Math.abs(playback.tick-pendingTick)<=2||performance.now()>pendingUntil))pendingTick=null;if(!scrub.active)seek.value=String(pendingTick??playback.tick);position();if(document.activeElement!==speed)speed.value=String(playback.speed);if(document.activeElement!==camera)camera.value=playback.camera??"eye";enabled.checked=state.ghost.enabled;
    const ghostsKey=JSON.stringify(state.ghosts);if(ghostsKey!==previousGhosts){previousGhosts=ghostsKey;ghostRows.replaceChildren(...state.ghosts.map(item=>{const shown=h("input",{type:"checkbox",checked:item.enabled,"aria-label":`Show ghost ${item.slot+1}`}) as HTMLInputElement;shown.addEventListener("change",()=>send({type:"ghostControl",action:"toggle",slot:item.slot,enabled:shown.checked}));return h("div.native-toolbar",null,h("label",null,shown,`Ghost ${item.slot+1}: ${item.name}`),h("button.btn",{type:"button",onclick:()=>send({type:"ghostControl",action:"remove",slot:item.slot})},"Remove"));}));}
    const styles=[...new Set(state.replays.map(r=>r.style))].sort(),styleKey=styles.join(",");if(filter.dataset.styles!==styleKey){const selected=filter.value;filter.replaceChildren(h("option",{value:""},"All styles"),...styles.map(style=>h("option",{value:style},styleLabel(style))));filter.value=selected;filter.dataset.styles=styleKey;}
    const shown=replayLibrary(state.replays,search.value,filter.value,sort.value as ReplaySort);summary.textContent=`${shown.length} of ${state.replays.length} replays · ${(state.replays.reduce((n,r)=>n+r.bytes,0)/1048576).toFixed(1)} MB`;
    const key=JSON.stringify([state.replays,search.value,filter.value,sort.value]);if(key===previous)return;previous=key;
    list.replaceChildren(...(shown.length?shown.map(replay=>{
      const action=(label:string,type:"play"|"ghost"|"export")=>h("button.btn",{type:"button",onclick:()=>{if(type==="play")playLocalReplay(replay.id);else send({type:"replay",action:type,id:replay.id,...(type==="ghost"?{ghostSlot:selectedGhostSlot}:{})});}},label);
      const remove=h("button.link-btn",{type:"button"},"Delete");remove.onclick=()=>{const dialog=h("dialog.acct-dialog",{"aria-label":"Delete replay"},h("div.acct-body",null,h("h3",null,"Delete this replay?"),h("p",null,replay.name),h("button.btn",{type:"button",onclick:()=>{send({type:"replay",action:"delete",id:replay.id,confirmed:true});dialog.close();}},"Delete replay"),h("button.btn",{type:"button",onclick:()=>dialog.close()},"Cancel")));dialog.addEventListener("close",()=>dialog.remove());document.body.append(dialog);dialog.showModal();};
      return h("article.native-replay-row",null,h("div",null,h("strong",null,replay.name),h("p.dim",null,`${replay.map} · ${styleLabel(replay.style)} · ${formatTime(replay.seconds)}${replay.track?` · Bonus ${replay.track}`:""} · ${new Date(replay.recordedAt).toLocaleString()} · ${(replay.bytes/1024).toFixed(0)} KB`)),...(replay.localSummary?[h("p.dim",null,`${replay.localSummary.localPb?"Device PB · ":""}${replay.localSummary.jumps} jumps · ${replay.localSummary.strafes} strafes · ${Number(replay.localSummary.sync).toFixed(1)}% sync`)]:[]),h("div.native-toolbar",null,action("Watch","play"),action("Ghost","ghost"),action("Export","export"),...(replay.screenshot?[h("button.btn",{type:"button",onclick:()=>send({type:"replay",action:"screenshot",id:replay.id})},"View result")]:[]),remove));
    }):[h("p.dim",null,state.replays.length?"No replays match these filters.":"No local replays yet. Finish a run or import a .bhr file.")]));
  };
  videoMusic.addEventListener("change",()=>refresh());videoAudio.addEventListener("change",()=>refresh());
  const update=()=>{if(!root.isConnected){scrub.cancel(false);window.removeEventListener("bunnyhop:host-state",update);return;}refresh();};window.addEventListener("bunnyhop:host-state",update);refresh();send({type:"replays",action:"list"});return root;
}
