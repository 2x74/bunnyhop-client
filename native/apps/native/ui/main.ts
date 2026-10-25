import "../../web/src/style.css";
import "./native.css";
import { api } from "../../web/src/api";
import { accountChanged } from "../../web/src/ui/account-state";
import { h } from "../../web/src/ui/dom";
import { mapBrowser, closeMapPanel } from "../../web/src/ui/maps";
import { onNavigate } from "../../web/src/ui/nav";
import { onViewerRequest } from "../../web/src/viewer/request";
import { onRaceRequest } from "../../web/src/player/race";
import { applyState, openAuth, openExternal, send, state, onBeforeSend, LIVE_ORIGIN } from "./bridge";
import { NativeRunService } from "./run-service";
import { formatTime } from "../../web/src/timer";
import { isStyleId } from "../../web/src/styles";
import { onStyleChange, setSelectedStyle } from "../../web/src/ui/style-picker";
import { settingsPanel } from "./settings-panel";
import { replayPanel, watchRequest, raceRequest, gauntletWatchDeps, sendReplay, playLocalReplay } from "./replays";
import { watchGauntletSplit } from "./gauntlet-watch";
import { NativeRoomService } from "./room-service";
import { RoomConnection } from "../../web/src/net/room";
import { setRoomPresence,setRaceTag,currentRoom,currentRace } from "../../web/src/net/presence";
import { serverBrowser } from "../../web/src/ui/servers";
import { roomPanel } from "./rooms-panel";
import { initDock } from "../../web/src/social/dock";
import { initSocial,refreshFriends,setPlaying,setWatching } from "../../web/src/social/state";
import { ranksScreen,leaveRanksUrl } from "../../web/src/ui/ranks";
import { statsScreen } from "../../web/src/ui/stats-screen";
import { profilePanel } from "./profile-panel";
import { tutorialPanel } from "./tutorial-panel";
import { nativeNavigate } from "./navigation";
import { cosmeticsPanel,initCosmetics } from "./cosmetics";
import { creditsPanel } from "./credits";
import { homeScreen, watchMenuMotion, LAST_MAP } from "./home-menu";
import { pauseScreen } from "./pause-menu";
import { setGameInfo } from "../../web/src/feedback/state";
import { installMenuBackdrop, requestBackdrop, syncBackdrop } from "./menu-backdrop";
import { gauntletResult, gauntletScreen, gauntletsScreen, leaveGauntletUrl, type GauntletScreens } from "../../web/src/ui/gauntlets";
import { isAttemptId } from "../../web/src/gauntlet/state";
import { watchFromUrl } from "../../web/src/gauntlet/watch";
import { practiceReason } from "../../web/src/practice";
import { NativeGauntlet } from "./gauntlet-native";
import { installNowPlaying } from "./music-now";
import { leaveMapTeardown } from "./map-lifecycle";

type Screen = "home" | "maps" | "settings" | "profile" | "replays" | "servers" | "room" | "ranks" | "stats" | "tutorial" | "loadout" | "credits" | "gauntlets" | "gauntlet";
const SCREENS:readonly Screen[]=["home","maps","settings","profile","replays","servers","room","ranks","stats","tutorial","loadout","credits","gauntlets","gauntlet"];
/** The gauntlet screen's gauntlet, and the attempt whose result it shows (web menu.ts S.gauntlet). */
let gauntletView:{slug:string;attempt:string|null}={slug:"",attempt:null};
/** The gauntlet split line under the finish (gauntlet-native.ts), and whether it's a split. */
let gauntletLine:{text:string;ok:boolean}|null=null;
let screen: Screen = "home";
let profileId = "";
let rankScope="all",rankPage=1,focusMap:string|undefined;
let syncingStyle=false;
let browser: HTMLElement | null = null;
let renderGeneration = 0;
interface FinishSummary {seconds:number;jumps?:number;strafes?:number;sync?:number}
let finishSummary:FinishSummary|null=null;
const app = document.getElementById("menu")!;
const status = document.getElementById("native-status")!;
const flash = document.getElementById("native-notice")!;

function notice(text: string): void { flash.textContent = text; }
function readFinish(value:unknown):FinishSummary|null {
  if(!value||typeof value!=="object") return null;
  const timer=value as Record<string,unknown>;
  if(timer.status!==2||typeof timer.seconds!=="number"||!Number.isFinite(timer.seconds)||timer.seconds<0) return null;
  const summary:FinishSummary={seconds:timer.seconds};
  if(Number.isSafeInteger(timer.jumps)&&Number(timer.jumps)>=0) summary.jumps=Number(timer.jumps);
  if(Number.isSafeInteger(timer.strafes)&&Number(timer.strafes)>=0) summary.strafes=Number(timer.strafes);
  if(typeof timer.sync==="number"&&Number.isFinite(timer.sync)&&timer.sync>=0&&timer.sync<=100) summary.sync=timer.sync;
  return summary;
}
function paintFinish():void {
  const host=document.getElementById("native-finish-result");
  if(!host) return;
  if(!finishSummary) {host.replaceChildren();return;}
  const stats:string[]=[];
  if(finishSummary.jumps!==undefined) stats.push(`${finishSummary.jumps} jumps`);
  if(finishSummary.strafes!==undefined) stats.push(`${finishSummary.strafes} strafes`);
  if(finishSummary.sync!==undefined) stats.push(`${finishSummary.sync.toFixed(1)}% sync`);
  // A practice finish (web hud/result.ts): yellow, and its line says it wasn't submitted.
  const practice=state.practice.active?practiceReason({debug:false,thirdPerson:false,scripted:false,lesson:false,mode:state.practice.mode&&!state.practice.tool,tool:state.practice.tool}):null;
  host.replaceChildren(h(`section.native-finish${practice?".practice":""}`,{"aria-label":"Finished run"},
    h("p.native-finish-label",null,"Finished"),h("strong.native-finish-time",null,formatTime(finishSummary.seconds)),
    stats.length?h("p.dim.native-finish-stats",null,stats.join(" · ")):null,
    practice?h("p.dim.native-finish-sub",null,`Not submitted: ${practice}.`):null,
    gauntletLine?h(`p.native-finish-sub.${gauntletLine.ok?"ok":"dim"}`,null,gauntletLine.text):null));
}
function selectMap(id: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) return;
  roomService.leave();
  // Another map than the attempt's: the attempt stays open on the server (Resume on its page), this client lets it go.
  if(gauntlet.id&&id!==gauntlet.map)gauntlet.leave();
  try { localStorage.setItem(LAST_MAP, id); } catch { /* private storage: no Continue */ }
  if (id === state.map) send({ type: "resume" });
  // The host owns loading/error status and clears it when the download settles.
  else send({ type: "selectMap", id,style:state.style,track:0 });
}
function show(next: Screen): void {
  if(screen==="ranks"&&next!=="ranks")leaveRanksUrl();
  if(next!=="gauntlets"&&next!=="gauntlet"&&next!=="profile")leaveGauntletUrl();
  screen = next; notice(""); render();
}
/** Settings, scrolled to one of its sections (the pause tabs' "All HUD settings" / "Every key"). */
function openSettings(section:string):void {show("settings");document.getElementById(`nset-${section}`)?.scrollIntoView({block:"start"});}
/** A gauntlet's page, or an attempt's result (ui/gauntlets.ts); replaces the gauntlet screen if it's showing. */
function openGauntlet(slug:string,attempt:string|null):void {
  if(!/^[a-z0-9-]{1,64}$/.test(slug))return;
  gauntletView={slug,attempt:isAttemptId(attempt)?attempt:null};
  if(screen==="gauntlet")render();else show("gauntlet");
}
const gauntletActions:GauntletScreens={open:(slug,attempt)=>openGauntlet(slug,attempt??null)};
/** Where Back (and Esc) goes from a screen: a gauntlet's page back to the list, everything else home. */
const backOf=(from:Screen):Screen=>from==="gauntlet"&&!state.map?"gauntlets":"home";
/** A bunnyhop.lol page the native client has no screen for (Gauntlets, Support): opened in the browser. */
function openWeb(path: string): void { if(!openExternal(new URL(path,LIVE_ORIGIN).href)) notice("This page is not available in the native menu."); }
const BACK_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5M11 5.5 4.5 12 11 18.5"/></svg>';
function heading(title: string, sub?: string|null, inner?: () => boolean): HTMLElement {
  return h("header.screen-head", null,
    h("button.screen-back", { type: "button", "aria-label": "Back", title: "Back (Esc)", onclick: () => inner?.() || show(backOf(screen)), html: BACK_ARROW }),
    h("div.screen-title", null, h("h2", null, title), sub ? h("small", null, sub) : null));
}
let shown = "";
function render(): void {
  ++renderGeneration;
  const root = screen==="home"?(state.map?"pause":"home"):screen;
  document.body.dataset.screen=screen==="room"?"pause":root;
  document.body.dataset.map=state.map??"";
  document.body.classList.toggle("in-game",!!state.map);
  // The same screen drawn again for a host update (loading, an error) doesn't replay its entrance.
  app.className=`screen-${root}${shown===root?" native-steady":""}`;
  shown=root;
  browser = null;
  status.textContent = state.error || (typeof state.loading === "string" ? state.loading : state.loading ? "Loading map…" : "");
  status.dataset.kind = state.error ? "error" : "";
  syncBackdrop();
  if (screen === "home" && state.map) {
    // The newest local replay of this map and track: the Replays tab's "last run".
    const last=state.replays.filter(item=>item.map===state.map&&item.track===state.track).sort((x,y)=>y.recordedAt-x.recordedAt)[0];
    if(!app.classList.contains("native-steady"))send({type:"replays",action:"list"});
    // Practice works solo (web rules.ts practiceUnavailable): the host says where; never in a room, a gauntlet or a replay.
    const practice=state.practice.available&&!state.practice.unavailable&&!roomService.view.id&&!gauntlet.id&&!state.playback.active
      ?{on:state.practice.mode,count:state.practice.count,toggle:()=>{send({type:"practice",action:"toggle"});send({type:"resume"});},checkpoints:()=>{send({type:"practice",action:"menu"});send({type:"resume"});}}:null;
    const pause = pauseScreen({map:state.map,style:state.style,track:state.track,room:!!roomService.view.id,restartKey:state.settings.binds.restart?.[0],
      resume:()=>send({type:"resume"}),restart:()=>send({type:"restart"}),leave:leaveMap,practice,binds:state.settings.binds,
      // (No in-place track switch on the host: the map is selected again on its main track.)
      mainTrack:state.track&&!gauntlet.id?()=>send({type:"selectMap",id:state.map!,style:state.style,track:0}):null,
      replayTab:{watchPB:()=>void watchRequest({target:{pb:true}}).catch(error=>notice((error as Error).message)),
        watchLast:last?()=>playLocalReplay(last.id):null,exportLast:last?()=>send({type:"replay",action:"export",id:last.id}):null,
        load:file=>{void file.arrayBuffer().then(bytes=>sendReplay(new Uint8Array(bytes),"play",file.name)).catch(error=>notice((error as Error).message));}},
      screen:{values:{hud:state.settings.hud,crosshair:state.settings.crosshair,viewmodel:state.settings.viewmodel,jumpStats:state.settings.jumpStats,strafeTrainer:state.settings.strafeTrainer},
        set:(key,on)=>send({type:"settings",patch:{[key]:on}}),allHud:()=>openSettings("hud")},
      keys:()=>openSettings("keys"),
      servers:()=>show(roomService.view.id?"room":"servers"),maps:()=>show("maps"),learn:()=>show("tutorial"),loadout:()=>show("loadout"),settings:()=>show("settings"),
      profile:id=>{profileId=id;show("profile");},ranks:()=>show("ranks"),replays:()=>show("replays"),
      setStyle:id=>{if(state.loading)return;if(gauntlet.modeLock&&id!==state.style){notice(gauntlet.modeLock);return;}setSelectedStyle(id);render();},web:openWeb});
    pause.querySelector(".pause-head")?.append(h("div#native-finish-result"));
    for (const control of pause.querySelectorAll<HTMLButtonElement>(".rail-list button")) control.disabled = !!state.loading;
    app.replaceChildren(pause);
    if(!app.classList.contains("native-steady"))pause.querySelector<HTMLElement>("[data-autofocus]")?.focus({preventScroll:true});
    paintFinish();
  } else if (screen === "home") {
    // (Tiles land after the map index: a click during a load is refused here, not by a disabled state they missed.)
    const home = homeScreen({style:state.style,play:()=>show("maps"),pick:id=>{if(!state.loading)selectMap(id);},settings:()=>show("settings"),loadout:()=>show("loadout"),
      profile:id=>{profileId=id;show("profile");},ranks:()=>show("ranks"),stats:()=>show("stats"),
      servers:()=>show(roomService.view.id?"room":"servers"),learn:()=>show("tutorial"),replays:()=>show("replays"),credits:()=>show("credits"),
      quit:()=>send({type:"quit"}),web:openWeb,gauntlets:()=>show("gauntlets"),background:(map,pb)=>{if(screen==="home"&&!state.map)requestBackdrop(map,pb);}});
    for (const control of home.querySelectorAll<HTMLButtonElement>(".home-menu button, .home-tile")) control.disabled = !!state.loading;
    app.replaceChildren(home);
    if(!app.classList.contains("native-steady"))home.querySelector<HTMLElement>("[data-autofocus]")?.focus({preventScroll:true});
  } else if (screen === "maps") {
    const maps = mapBrowser({ current: state.map, style: state.style, onPick: selectMap,focus:focusMap,gauntlets:api.available()?()=>show("gauntlets"):null });
    browser = maps;
    focusMap=undefined;
    app.replaceChildren(h("section.panel.panel-wide.native-maps", null, heading("Choose a map",state.map?`playing ${state.map}`:null,()=>closeMapPanel(maps)), maps));
  } else if (screen === "gauntlets") {
    app.replaceChildren(h("section.panel.panel-wide.panel-gauntlets", null, heading("Gauntlets"), gauntletsScreen(gauntletActions)));
  } else if (screen === "gauntlet") {
    // (The title is the gauntlet's once it has loaded.)
    const head=heading("Gauntlet"),title=(text:string)=>void(head.querySelector("h2")!.textContent=text);
    const g=gauntletView;
    app.replaceChildren(h("section.panel.panel-wide.panel-gauntlet", null, head, g.attempt?gauntletResult(g.slug,g.attempt,gauntletActions,{title}):gauntletScreen(g.slug,gauntletActions,{title})));
  } else if (screen === "settings") {
    app.replaceChildren(h("section.panel.native-settings", null, heading("Settings"),settingsPanel()));
  } else if (screen === "credits") {
    app.replaceChildren(h("section.panel.native-credits", null, heading("Credits"),creditsPanel()));
  } else if(screen==="replays") {
    app.replaceChildren(h("section.panel.native-replay-screen",null,heading("Replays"),replayPanel(notice)));
  } else if(screen==="servers") {
    app.replaceChildren(h("section.panel.panel-wide.native-servers",null,heading("Play online"),serverBrowser({map:state.map,onSolo:()=>show("maps")})));
  } else if(screen==="room") {
    app.replaceChildren(h("section.panel.panel-wide.native-room-screen",null,heading("Current room"),roomPanel(roomService,id=>{profileId=id;show("profile");},notice)));
  } else if(screen==="ranks") {
    app.replaceChildren(h("section.panel.panel-wide.native-ranks",null,heading("Ranks"),ranksScreen(rankScope,{page:rankPage,onChange:(scope,page)=>{rankScope=scope;rankPage=page;}})));
  } else if(screen==="stats") {
    const tabs=h("div");app.replaceChildren(h("section.panel.panel-wide.native-stats",null,heading("Statistics"),tabs,statsScreen({tabsHost:tabs,play:()=>show("maps")})));
  } else if(screen==="loadout") {
    app.replaceChildren(h("section.panel.native-loadout",null,heading("Loadout"),cosmeticsPanel()));
  } else if(screen==="tutorial") {
    app.replaceChildren(h("section.panel.native-tutorial-screen",null,heading("Tutorial"),tutorialPanel()));
  } else app.replaceChildren(h("section.panel.panel-wide.native-profile",null,heading("Player"),profilePanel(profileId,selectMap,()=>show("loadout"))));

}

function refreshAccount(): void { accountChanged(); }
function receive(value: unknown): void {
  if (value && typeof value === "object" && (value as { type?: string }).type === "auth") { refreshAccount(); return; }
  const structural=()=>JSON.stringify({map:state.map,loading:state.loading,error:state.error,paused:state.paused,style:state.style,track:state.track});
  const before=structural();
  let finishChanged=false;
  if(value&&typeof value==="object"&&"timer" in value) {
    const next=readFinish((value as {timer:unknown}).timer);
    finishChanged=JSON.stringify(next)!==JSON.stringify(finishSummary);finishSummary=next;
  }
  // The pause screen also follows practice, the local replays (its Replays tab's last run) and the HUD switches.
  const paused=()=>JSON.stringify([state.practice,state.replays.length,state.replays[0]?.id,state.settings.hud,state.settings.crosshair,state.settings.viewmodel,state.settings.jumpStats,state.settings.strafeTrainer]);
  const pauseBefore=paused();
  if (applyState(value) && structural()!==before) render();
  else if(screen==="home"&&state.map&&paused()!==pauseBefore) render();
  else if(finishChanged&&screen==="home") paintFinish();
  if(finishChanged&&!finishSummary)gauntletLine=null;
  gauntlet.onHostState();
  roomService.hostMap(state.map);
  syncingStyle=true;setSelectedStyle(state.style);syncingStyle=false;
  if(state.map)setPlaying(state.map,state.style);setWatching(state.playback.active?state.map:false);
  window.dispatchEvent(new CustomEvent("bunnyhop:host-state",{detail:state}));
}
const roomService=new NativeRoomService({connect:(id,handlers)=>new RoomConnection(id,()=>state.style,handlers),ensureAccount:async()=>{try{return !!await api.me();}catch{return false;}},send});
roomService.subscribe(()=>{const view=roomService.view;setRoomPresence(view.id&&view.room?{id:view.id,name:view.room.name}:null);});
onBeforeSend(message=>{if(roomService.view.id&&((message.type==="replay"&&["play","ghost"].includes(message.action))||message.type==="replayData"||(message.type==="tutorial"&&message.action!=="stop")))roomService.leave();});
setRaceTag(board=>{const race=roomService.view.race;return race&&race.state==="live"&&race.map===board.map&&race.style===board.style&&race.track===board.track?race.id:null;});
/** Everything running for the map stops (map-lifecycle.ts). The host calls it as onLeaveMap for every leave_map. */
const teardownMap=leaveMapTeardown({room:roomService,gauntlet:{leave:()=>gauntlet.leave()},clear:()=>{finishSummary=null;gauntletLine=null;paintFinish();if(screen==="room")show("home");}});
function leaveMap():void {if(!state.map)return;teardownMap();send({type:"leaveMap"});}
const gauntlet=new NativeGauntlet({api,send,map:()=>state.map,loading:()=>!!state.loading,notice,
  account:async()=>{const user=await api.me();return api.meStale()?undefined:user?.id??null;},
  result:(slug,attempt)=>openGauntlet(slug,attempt),
  line:(text,ok)=>{gauntletLine=text?{text,ok}:null;paintFinish();},
  // Enter or a click goes to the next map at once (web gauntlet/mode.ts goTo).
  listenGo:go=>{
    const onKey=(event:KeyboardEvent)=>{if(event.code==="Enter"||event.code==="NumpadEnter"){event.preventDefault();go();}};
    const onClick=(event:MouseEvent)=>{if(event.button===0)go();};
    addEventListener("keydown",onKey,true);addEventListener("mousedown",onClick,true);
    return()=>{removeEventListener("keydown",onKey,true);removeEventListener("mousedown",onClick,true);};
  }});
const runService=new NativeRunService({api,account:async()=>{const user=await api.me();return api.meStale()?null:user?.id??null;},
  context:(identity,generation)=>({room:currentRoom(),race:currentRace(identity),gauntlet:gauntlet.tag(identity,generation,finishSummary?.seconds??null)}),
  holdGauntlet:(attempt,generation)=>gauntlet.holds(attempt,generation),version:()=>api.version(),origin:()=>location.origin,send:message=>{
  send(message);
  gauntlet.onRunStatus(message,finishSummary?.seconds??null);
  if(message.message) notice(message.message);
  if(message.status==="verified") refreshAccount();
}});
window.addEventListener("bunnyhop:account",()=>{runService.refreshAccount();void api.me().then(user=>{if(!api.meStale())gauntlet.onAccount(user?.id??null);},()=>{});});
window.bunnyhopNativeMenu = { onState: receive, onAuth: refreshAccount, onRunEvent:value=>{void runService.receive(value);},open:(next,focus)=>{if(next==="rooms")next="servers";if(next==="leave"){leaveMap();return;}if(next==="gauntlet"&&!gauntletView.slug)next="gauntlets";if(SCREENS.includes(next as Screen))show(next as Screen);if(next==="room"&&focus==="chat")document.querySelector<HTMLInputElement>(".native-room-chat-form input")?.focus();},onRoomPose:value=>{roomService.pose(value);},onRoomCommand:value=>{roomService.command(value);},
  // A friend pressed Join on your Discord activity. The host has already checked the secret.
  settle,
  onLeaveMap:teardownMap,
  joinRoom:id=>{if(typeof id!=="string"||!/^(?:[a-z0-9][a-z0-9-]{0,31}|p-[a-z2-7]{10})$/.test(id))return;void roomService.join(id).catch(()=>notice("Couldn't join that room."));show("room");},
  version: 2 };
window.addEventListener("bunnyhop:native-state", (event) => receive((event as CustomEvent).detail));
window.addEventListener("bunnyhop:native-auth", refreshAccount);
window.addEventListener("bunnyhop-native-auth", (event) => {
  if ((event as CustomEvent<{status?:string}>).detail?.status === "complete") refreshAccount();
});
onNavigate((request) => {
  if (request.screen === "profile") { profileId = request.id; show("profile"); }
  else if (request.screen === "maps") {focusMap=request.focus;show("maps");}
  else if(request.screen==="servers")show("servers");
  else if(request.screen==="ranks"){rankScope=request.scope??"all";rankPage=request.page??1;show("ranks");}
  else if(request.screen==="stats")show("stats");
  else if(request.screen==="loadout")show("loadout");
  else if(request.screen==="gauntlets")show("gauntlets");
  else if(request.screen==="gauntlet")openGauntlet(request.slug,request.attempt??null);
  else if(request.screen==="support")openWeb("/?support");
  else notice("This screen is not available in the native menu yet.");
});
// These existing UI request buses must never fall back to a web-game navigation.
onViewerRequest(request=>{void watchRequest(request).catch(error=>notice(error.message));});
onRaceRequest(request=>{void raceRequest(request).catch(error=>notice(error.message));});
onStyleChange(id=>{if(syncingStyle)return;state.style=id;send({type:"style",id});});
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return;
  event.preventDefault();
  nativeNavigate(anchor.href);
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  if (browser && closeMapPanel(browser)) return;
  if (screen !== "home") show(backOf(screen));
  else if (state.map && !state.loading) send({ type: "resume" });
});
window.addEventListener("bunnyhop:tutorial",()=>show("tutorial"));
window.addEventListener("bunnyhop:navigate",event=>{
  let url:URL;try{url=new URL((event as CustomEvent<{url:string}>).detail.url,"https://bunnyhop.lol");}catch{return;}
  // Another site (the Discord invite): the browser, if it's one the client opens at all.
  if(url.origin!=="https://bunnyhop.lol"){if(!openExternal(url.href))notice("This external link is not available in the native menu.");return;}
  if(url.pathname.startsWith("/api/auth/")){openAuth(url.href);return;}
  const room=url.searchParams.get("server")??url.searchParams.get("lobby");
  if(room){show("room");void roomService.join(room).catch(error=>notice(error.message));return;}
  // A gauntlet attempt (ui/gauntlets.ts Start / Resume: /?map=<map>&gauntlet=<id>): played here, not in the browser.
  const attempt=url.searchParams.get("gauntlet");
  if(isAttemptId(attempt)){show("home");void gauntlet.start(attempt,url.searchParams.get("map"));return;}
  // Watching an attempt (/g/<slug>/watch/<id>[?i=n]): split n's replay in native playback.
  const watch=watchFromUrl(url);
  if(watch){void watchGauntletSplit(gauntletWatchDeps,watch.attemptId,watch.idx).catch(error=>notice((error as Error).message));return;}
  const page=/^\/g\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if(page){openGauntlet(page[1],url.searchParams.get("attempt"));return;}
  if(url.pathname==="/gauntlets"){show("gauntlets");return;}
  const replay=/^\/replay\/([\w-]+)$/.exec(url.pathname);if(replay){void watchRequest({target:{runId:replay[1]}}).catch(error=>notice(error.message));return;}
  const player=/^\/u\/([\w-]+)$/.exec(url.pathname);if(player){profileId=player[1];show("profile");return;}
  const map=url.searchParams.get("map");if(map){if(isStyleId(url.searchParams.get("style")))setSelectedStyle(url.searchParams.get("style") as typeof state.style);selectMap(map);return;}
  if(url.pathname==="/servers")show("servers");else if(url.pathname==="/ranks")show("ranks");else if(url.pathname==="/stats")show("stats");else if(url.pathname.startsWith("/maps")){focusMap=url.pathname.split("/")[2];show("maps");}
  else if(url.pathname==="/"&&!url.search)show("home");
  // A page only the website has (About, Support): opened there.
  else openWeb(url.pathname+url.search);
});
// WebKit stops a hidden page's animation clock (the host's menu view before it's shown, a hidden smoke window, an
// occluded window): every entrance, the tiles' landing and the backdrop's fade would wait at their first frame, opacity
// 0, and a snapshot shows an empty menu. While the clock stands still, html.native-clock-stopped ends them at once
// (native.css); once it runs again they play as on the web.
let clockCheck=0;
function endAnimations():number {
  for(const svg of document.querySelectorAll<SVGSVGElement>(".hop-trail svg")) svg.setCurrentTime(10);
  // Ones already started (the backdrop's fade, a picture's fade-in, rows landing) jump to their end.
  let ended=0;
  for(const animation of document.getAnimations()) if(animation.playState!=="finished"&&Number.isFinite(animation.effect?.getComputedTiming().endTime)) {animation.finish();ended++;}
  // An async decode waits for a paint that may never come: pictures decode with the next snapshot instead.
  for(const image of document.querySelectorAll<HTMLImageElement>('img[decoding="async"]')) image.decoding="sync";
  return ended;
}
/**
 * For a screenshot: the menu as it will rest. Every entrance, fade and landing row ends now, pictures on screen finish
 * loading (up to `timeoutMs`), and anything those started ends too. The live app never calls it; the web's animations
 * play as usual.
 */
async function settle(timeoutMs=3000):Promise<{ended:number;pendingImages:number}> {
  let ended=endAnimations();
  const deadline=performance.now()+Math.max(0,Math.min(timeoutMs,10000));
  const pending=()=>[...document.images].filter(image=>image.isConnected&&!!image.currentSrc&&!image.complete);
  while(pending().length&&performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
  await new Promise(resolve=>setTimeout(resolve,0));
  ended+=endAnimations();
  return {ended,pendingImages:pending().length};
}
function watchAnimationClock(delay=300):void {
  window.clearTimeout(clockCheck);
  const start=document.timeline.currentTime;
  clockCheck=window.setTimeout(()=>{
    const stopped=document.timeline.currentTime===start;
    document.documentElement.classList.toggle("native-clock-stopped",stopped);
    // SMIL (the hop trail's dot) has its own clock: to its end, where the web's comes to rest.
    if(stopped) endAnimations();
    watchAnimationClock(stopped?1000:5000);
  },delay);
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")document.documentElement.classList.remove("native-clock-stopped");watchAnimationClock();});
watchAnimationClock();
// Feedback form ("Attach game info", feedback/modal.ts gameContext): what the native host says, its own settings.
setGameInfo(()=>({inGame:!!state.map,client:"native",...(state.map?{map:state.map,style:state.style,track:state.track,paused:state.paused}:{}),
  ...(state.playback.active?{watchingReplay:true}:{}),nativeSettings:{sensitivity:state.settings.sensitivity,fov:state.settings.fov,vsync:state.settings.vsync,fpsLimit:state.settings.fpsLimit}}));
initSocial();initDock();initCosmetics();installNowPlaying();
installMenuBackdrop();
watchMenuMotion();
render();
const graphics = window.__nativeMenuGraphics;
send({ type: "ready", origin: location.origin, webglContexts: graphics?.contexts ?? 0, webglAttempts: graphics?.attempts ?? 0 });
