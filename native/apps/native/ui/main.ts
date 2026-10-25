import "../../web/src/style.css";
import "./native.css";
import { api } from "../../web/src/api";
import { accountChip } from "../../web/src/ui/account";
import { accountChanged } from "../../web/src/ui/account-state";
import { wordmark } from "../../web/src/ui/brand";
import { h, arrowNav } from "../../web/src/ui/dom";
import { mapBrowser, closeMapPanel, fetchMapIndex } from "../../web/src/ui/maps";
import { registerMapImages, mapArt } from "../../web/src/ui/thumbs";
import { onNavigate } from "../../web/src/ui/nav";
import { onViewerRequest } from "../../web/src/viewer/request";
import { onRaceRequest } from "../../web/src/player/race";
import { applyState, openAuth, send, state, onBeforeSend } from "./bridge";
import { NativeRunService } from "./run-service";
import { formatTime } from "../../web/src/timer";
import { STYLE_DEFS, isStyleId } from "../../web/src/styles";
import { onStyleChange, setSelectedStyle } from "../../web/src/ui/style-picker";
import { settingsPanel } from "./settings-panel";
import { replayPanel, watchRequest, raceRequest } from "./replays";
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

type Screen = "home" | "maps" | "settings" | "profile" | "replays" | "servers" | "room" | "ranks" | "stats" | "tutorial" | "loadout" | "credits";
let screen: Screen = "home";
let profileId = "";
let rankScope="all",rankPage=1,focusMap:string|undefined;
let syncingStyle=false;
let browser: HTMLElement | null = null;
let renderGeneration = 0;
interface FinishSummary {seconds:number;jumps?:number;strafes?:number;sync?:number}
let finishSummary:FinishSummary|null=null;
const app = document.getElementById("native-menu")!;
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
  host.replaceChildren(h("section.native-finish",{"aria-label":"Finished run"},
    h("p.native-finish-label",null,"Finished"),h("strong.native-finish-time",null,formatTime(finishSummary.seconds)),
    stats.length?h("p.dim.native-finish-stats",null,stats.join(" · ")):null));
}
function selectMap(id: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) return;
  roomService.leave();
  if (id === state.map) send({ type: "resume" });
  else { notice(`Loading ${id}…`); send({ type: "selectMap", id,style:state.style,track:0 }); }
}
function show(next: Screen): void { if(screen==="ranks"&&next!=="ranks")leaveRanksUrl();screen = next; notice(""); render(); }
function button(label: string, action: () => void, primary = false, sub = ""): HTMLButtonElement {
  return h(`button.menu-btn.home-item${primary ? ".primary" : ""}`, { type: "button", onclick: action },
    h("span.mb-label", null, h("span.mb-title", null, label), sub ? h("small", null, sub) : null));
}
function heading(title: string): HTMLElement {
  return h("header.screen-head", null,
    h("button.screen-back", { type: "button", "aria-label": "Back", onclick: () => show("home") }, "←"),
    h("div.screen-title", null, h("h2", null, title)));
}

function render(): void {
  ++renderGeneration;
  document.body.dataset.screen=screen==="home"?(state.map?"pause":"home"):screen==="room"?"pause":screen;
  browser = null;
  status.textContent = state.error || (typeof state.loading === "string" ? state.loading : state.loading ? "Loading map…" : "");
  status.dataset.kind = state.error ? "error" : "";
  if (screen === "home") {
    const menu = h("nav.home-menu.native-home-actions", { "aria-label": "Main menu" });
    if (state.map) {
      menu.append(button("Resume", () => send({ type: "resume" }), true, state.map),
        button("Restart", () => send({ type: "restart" })));
    }
    menu.append(button("Play", () => show("maps"), !state.map),button(roomService.view.id?"Current room":"Play online",()=>show(roomService.view.id?"room":"servers")),button("Tutorial",()=>show("tutorial")),button("Loadout",()=>show("loadout")),button("Ranks",()=>show("ranks")),button("Statistics",()=>show("stats")),button("Replays",()=>show("replays")), button("Settings", () => show("settings")), button("Credits", () => show("credits")), button("Quit", () => send({ type: "quit" })));
    for (const control of menu.querySelectorAll<HTMLButtonElement>("button")) control.disabled = !!state.loading;
    const current = h("section.native-current", { "aria-label": state.map ? "Current map" : "Play bunnyhop" });
    if (state.map) {
      current.append(mapArt(state.map, null, { className: "native-current-art" }), h("h2", null, state.map), h("p.dim", null, "Esc opens this menu."));
      void fetchMapIndex().then((maps) => {
        if (screen!=="home" || !current.isConnected || !state.map) return;
        registerMapImages(maps);
        current.querySelector(".native-current-art")?.replaceWith(mapArt(state.map, null, { className: "native-current-art" }));
      });
    } else current.append(h("h1", null, "Keep your speed."), h("p.dim", null, "Pick a map and start hopping."), h("p.native-controls", null, "WASD move · Mouse look · Space / wheel jump · Ctrl crouch"));
    const style=h("select.native-style",{"aria-label":"Play style"},...STYLE_DEFS.map(item=>h("option",{value:item.id,title:item.rule},item.name)));style.value=state.style;style.addEventListener("change",()=>{if(isStyleId(style.value)){setSelectedStyle(style.value);}});
    app.replaceChildren(h("section.native-home.screen-home", null,
      h("div.native-home-left", null, h("div.home-brand", null, wordmark("xl")),h("div#native-finish-result"),h("label.native-style-row",null,h("span.dim",null,"Style"),style), menu), current));
    paintFinish();
    arrowNav(menu, ".home-item");
  } else if (screen === "maps") {
    browser = mapBrowser({ current: state.map, style: state.style, onPick: selectMap,focus:focusMap });
    focusMap=undefined;
    app.replaceChildren(h("section.panel.panel-wide.native-maps", null, heading("Play"), browser));
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
  } else app.replaceChildren(h("section.panel.panel-wide.native-profile",null,heading("Player"),profilePanel(profileId,selectMap)));

}

function refreshAccount(): void { accountChanged(); }
function receive(value: unknown): void {
  if (value && typeof value === "object" && (value as { type?: string }).type === "auth") { refreshAccount(); return; }
  const structural=()=>JSON.stringify({map:state.map,loading:state.loading,error:state.error,paused:state.paused});
  const before=structural();
  let finishChanged=false;
  if(value&&typeof value==="object"&&"timer" in value) {
    const next=readFinish((value as {timer:unknown}).timer);
    finishChanged=JSON.stringify(next)!==JSON.stringify(finishSummary);finishSummary=next;
  }
  if (applyState(value) && structural()!==before) render();
  else if(finishChanged&&screen==="home") paintFinish();
  roomService.hostMap(state.map);
  syncingStyle=true;setSelectedStyle(state.style);syncingStyle=false;
  if(state.map)setPlaying(state.map,state.style);setWatching(state.playback.active?state.map:false);
  const selector=document.querySelector<HTMLSelectElement>(".native-style");if(selector&&document.activeElement!==selector)selector.value=state.style;
  window.dispatchEvent(new CustomEvent("bunnyhop:host-state",{detail:state}));
}
const roomService=new NativeRoomService({connect:(id,handlers)=>new RoomConnection(id,()=>state.style,handlers),ensureAccount:async()=>{try{return !!await api.me();}catch{return false;}},send});
roomService.subscribe(()=>{const view=roomService.view;setRoomPresence(view.id&&view.room?{id:view.id,name:view.room.name}:null);});
onBeforeSend(message=>{if(roomService.view.id&&((message.type==="replay"&&["play","ghost"].includes(message.action))||message.type==="replayData"||(message.type==="tutorial"&&message.action!=="stop")))roomService.leave();});
setRaceTag(board=>{const race=roomService.view.race;return race&&race.state==="live"&&race.map===board.map&&race.style===board.style&&race.track===board.track?race.id:null;});
const runService=new NativeRunService({api,context:identity=>({room:currentRoom(),race:currentRace(identity)}),version:()=>api.version(),origin:()=>location.origin,send:message=>{
  send(message);
  if(message.message) notice(message.message);
  if(message.status==="verified") refreshAccount();
}});
window.bunnyhopNativeMenu = { onState: receive, onAuth: refreshAccount, onRunEvent:value=>{void runService.receive(value);},open:(next,focus)=>{if(next==="rooms")next="servers";if(["home","maps","settings","profile","replays","servers","room","ranks","stats","tutorial","loadout","credits"].includes(next))show(next as Screen);if(next==="room"&&focus==="chat")document.querySelector<HTMLInputElement>(".native-room-chat-form input")?.focus();},onRoomPose:value=>{roomService.pose(value);},onRoomCommand:value=>{roomService.command(value);},version: 2 };
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
  if (screen !== "home") show("home");
  else if (state.map && !state.loading) send({ type: "resume" });
});
window.addEventListener("bunnyhop:tutorial",()=>show("tutorial"));
window.addEventListener("bunnyhop:navigate",event=>{
  let url:URL;try{url=new URL((event as CustomEvent<{url:string}>).detail.url,"https://bunnyhop.lol");}catch{return;}
  if(url.origin!=="https://bunnyhop.lol"){notice("This external link is not available in the native menu.");return;}
  if(url.pathname.startsWith("/api/auth/")){openAuth(url.href);return;}
  const room=url.searchParams.get("server")??url.searchParams.get("lobby");
  if(room){show("room");void roomService.join(room).catch(error=>notice(error.message));return;}
  const replay=/^\/replay\/([\w-]+)$/.exec(url.pathname);if(replay){void watchRequest({target:{runId:replay[1]}}).catch(error=>notice(error.message));return;}
  const player=/^\/u\/([\w-]+)$/.exec(url.pathname);if(player){profileId=player[1];show("profile");return;}
  const map=url.searchParams.get("map");if(map){if(isStyleId(url.searchParams.get("style")))setSelectedStyle(url.searchParams.get("style") as typeof state.style);selectMap(map);return;}
  if(url.pathname==="/servers")show("servers");else if(url.pathname==="/ranks")show("ranks");else if(url.pathname==="/stats")show("stats");else if(url.pathname.startsWith("/maps")){focusMap=url.pathname.split("/")[2];show("maps");}
});
document.getElementById("native-account")!.append(accountChip());
initSocial();initDock();initCosmetics();
render();
const graphics = window.__nativeMenuGraphics;
send({ type: "ready", origin: location.origin, webglContexts: graphics?.contexts ?? 0, webglAttempts: graphics?.attempts ?? 0 });
