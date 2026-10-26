import { validHudLayout, type HudLayout } from "./hud-layout";
import type { RunServiceStatus } from "./run-service";
import { isStyleId, type StyleId } from "../../web/src/styles";
import { LESSON_IDS, type LessonId } from "../../web/src/tutorial/data";
import { DEFAULT_BINDS as WEB_DEFAULT_BINDS } from "../../web/src/binds";
export const LIVE_ORIGIN = "https://bunnyhop.lol";
export type MenuMessage =
  | { type: "ready"; origin: string; webglContexts: number; webglAttempts: number }
  | { type: "resume" | "restart" | "quit" }
  | { type: "selectMap"; id: string; style?: StyleId; track?: number }
  | { type: "style"; id: StyleId }
  | {type:"cosmetics";outfit:string;packedLoadout:string}
  | { type: "settings"; patch: Partial<NativeSettings> }
  | { type: "replays"; action: "list" }
  | { type: "replay"; action: "play"|"ghost"|"export"|"delete"; id: string; confirmed?: boolean }
  | { type: "replayData"; action: "play"|"ghost"; name: string; map: string; replayBase64: string }
  | { type: "replayControl"; action: "pause"|"seek"|"speed"|"stop"; paused?: boolean; tick?: number; speed?: number }
  | { type: "ghost"; enabled: boolean }
  | {type:"tutorial";action:"start"|"demo";lesson:LessonId}
  | {type:"tutorial";action:"stop"}
  | { type:"roomEvent";generation:number;id:string;event:Record<string,unknown> }
  | { type:"roomSnapshot";generation:number;id:string;snapshot:unknown }
  | { type: "sensitivity"; value: number }
  | { type: "openAuth"; url: string }
  | { type: "openExternal"; url: string }
  | { type: "menuBackdrop"; map: string | null; replay?: { runId: string; replayBase64: string } }
  /** Practice tools (web practice-mode/controller.ts). Sent from the menu, so the timed-run key gate doesn't apply. */
  | { type: "practice"; action: PracticeAction; value?: boolean }
  /** Pause menu → Main menu: release the map, back to the home screen (state map:null). */
  | { type: "leaveMap" }
  /** A gauntlet attempt (gauntlet-native.ts): locks Normal/main track and practice; null id ends it. */
  | { type: "gauntlet"; id: string | null; map?: string; progress?: GauntletHudProgress }
  /** One line on the in-game HUD's toast (gauntlet split lines). */
  | { type: "hudToast"; text: string; ms: number; tone?: "good" | "bad"; key?: "gauntlet" | "practice" }
  /** The soundtrack's previous / play-pause / next (now-playing). */
  | { type: "music"; action: "previous" | "toggle" | "next" }
  | RunServiceStatus;

export const PRACTICE_ACTIONS=["toggle","menu","noclip","save","tele","prev","next","keepVelocity"] as const;
export type PracticeAction=(typeof PRACTICE_ACTIONS)[number];
/** gauntlet/state.ts GauntletProgress: this map's index, the map count, the earlier splits' sum, your PB's split here. */
export interface GauntletHudProgress {idx:number;maps:number;before:number;pbSplit:number|null}

export const NATIVE_BIND_ACTIONS=["forward","back","left","right","jump","duck","use","restart","restartBonus","restartMain","cycleStyle","attack","attack2","inspect","viewmodel","hideUi","mute","slot1","slot2","slot3","lastWeapon","drop","reload","giveUsp","giveGlock","turnLeft","turnRight","turnFast","mainMenu","practice","noclip","cpSave","cpTeleport","cpPrev","cpNext"] as const;
type NativeBindAction=(typeof NATIVE_BIND_ACTIONS)[number];
/** The web game's defaults, plus the native-only Turn modifier (settings.hpp keeps the same list). */
const DEFAULT_BINDS:Record<NativeBindAction,readonly string[]>={...WEB_DEFAULT_BINDS,turnLeft:["ArrowLeft"],turnRight:["ArrowRight"],turnFast:["Mouse4"]};
/** cl_yawspeed and the modifier's speed when nothing has been chosen. */
export const DEFAULT_YAW_SPEED=210,DEFAULT_YAW_SPEED_ALT=210;
/** "default" is the bunnyhop.lol pack; "custom" is the player's own sound/ and bgm/ folders. */
export type AudioPack="default"|"custom";
export type JumpStatsMode="sixth"|"every"|"interval";
export const JUMP_STATS_MODES:readonly JumpStatsMode[]=["sixth","every","interval"];
export const AUDIO_PACKS:readonly AudioPack[]=["default","custom"];
export interface NativeSettings {
  sensitivity:number;verticalSensitivity:number;separateVertical:boolean;
  /** Turnbinds: degrees per second (cl_yawspeed), and while Turn modifier is held. */
  yawSpeed:number;yawSpeedAlt:number;fov:number;vsync:boolean;fpsLimit:number;
  volume:number;muted:boolean;hud:boolean;crosshair:boolean;viewmodel:boolean;binds:Record<string,string[]>;
  /** The jump HUD (!ssj jump stats). On by default. */
  jumpStats:boolean;
  /** Which jumps the HUD reports: the 6th, every one, or every |jumpStatsInterval|th. */
  jumpStatsMode:JumpStatsMode;jumpStatsInterval:number;
  /** Turn rate against the ideal for your speed, while in the air. Off by default. */
  strafeTrainer:boolean;
  /** Air ticks each reading averages; 1 is every tick on its own. */
  strafeTrainerSmoothing:number;
  /** "Less deadtime!" / "Strafe more!" / "Strafe less!" under the trainer. */
  strafeTrainerHints:boolean;
  /** CS:S's auto exposure and bloom on maps with HDR lighting (the web's Source look). On by default. */
  sourceLook:boolean;
  /** Moved HUD elements, in percent of the screen. Absent means the built-in place. */
  hudLayout:HudLayout;
  /** The whole HUD's size, in percent (the web's hud.scale × 100): 50–175. */
  hudScale:number;
  /** A checkpoint teleport keeps the speed it was saved with (web prefs practice.keepVelocity). */
  practiceKeepVelocity:boolean;
  sfxPack:AudioPack;musicPack:AudioPack;
  /** Discord Rich Presence, on by default. Privacy mode hides everything. */
  discordRichPresence:boolean;discordShowMap:boolean;discordJoin:boolean;discordJoinLobbies:boolean;privacyMode:boolean;
}
export type DiscordState="disabled"|"connecting"|"ready"|"reconnecting";
export const DISCORD_STATES:readonly DiscordState[]=["disabled","connecting","ready","reconnecting"];
export interface NativeReplay {id:string;name:string;map:string;style:StyleId;track:number;seconds:number;recordedAt:number;bytes:number}
export interface PlaybackState {active:boolean;id:string;tick:number;totalTicks:number;paused:boolean;speed:number;player?:{id?:string;name?:string;runId?:string}}
/** Practice as the host has it (web practice-mode/: PracticeAttempt, Checkpoints, the !cp menu). */
export interface PracticeState {
  available:boolean;
  /** Why practice can't be used here (web rules.ts practiceUnavailable wording), or null. */
  unavailable:string|null;
  /** Practice mode: every attempt is practice until it's turned off. */
  mode:boolean;
  /** This attempt is practice (mode, or a teleport / noclip was used). */
  active:boolean;
  tool:"teleport"|"noclip"|null;
  noclip:boolean;menuOpen:boolean;
  /** Checkpoints saved, and the current one (1-based; 0 none). */
  count:number;current:number;keepVelocity:boolean;
}
export type PlayerMode="solo"|"multiplayer"|"practice"|"replay"|"gauntlet"|"tutorial";
export const PLAYER_MODES:readonly PlayerMode[]=["solo","multiplayer","practice","replay","gauntlet","tutorial"];
/** What the player is actually doing (playback's style for a replay). Feedback and reports attach it. */
export interface PlayerState {map:string|null;style:StyleId;track:number;mode:PlayerMode;practice:boolean}
export interface MusicState {id:string;title:string;role:string;playing:boolean;available:boolean;loading:boolean;status:string}

export interface NativeClientInfo {version:string;build:string;gpu:string;viewport:[number,number];dpr:number}
export interface NativeMenuState {
  map: string | null;
  loading: boolean | string;
  error: string | null;
  sensitivity: number;
  paused: boolean;
  style:StyleId;track:number;settings:NativeSettings;replays:NativeReplay[];
  discord:{state:DiscordState;message:string};playback:PlaybackState;ghost:{enabled:boolean;id:string;name:string};tutorial:{active:boolean;lesson:LessonId;completed:LessonId[]};
  practice:PracticeState;gauntlet:{id:string|null;map:string|null};player:PlayerState|null;
  /** The soundtrack (null: this host doesn't report music). */
  music:MusicState|null;
  /** The native app itself, for the feedback form: release version, build id, GL renderer, game window. */
  client:NativeClientInfo|null;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { bunnyhop?: { postMessage: (value: string) => void } } };
    bunnyhopNativeMenu: { onState: (value: unknown) => void; onAuth: (value?: unknown) => void; onRunEvent: (value: unknown) => void; version: number; open?:(screen:string,focus?:string)=>void;
      /** The host left the map (every leave_map, also its own Main menu bind): stop the room, the gauntlet and their timers now. */
      onLeaveMap?:()=>void; joinRoom?:(id:string)=>void; onRoomPose?:(value:unknown)=>void; onRoomCommand?:(value:unknown)=>void; settle?:(timeoutMs?:number)=>Promise<{ended:number;pendingImages:number}> };
    __nativeMenuGraphics?: { contexts: number; attempts: number };
  }
}

let beforeSend:((message:MenuMessage)=>void)|null=null;
export function onBeforeSend(listener:(message:MenuMessage)=>void):void {beforeSend=listener;}
export function send(message: MenuMessage): void {
  beforeSend?.(message);
  const host = window.webkit?.messageHandlers?.bunnyhop;
  if (host) host.postMessage(JSON.stringify(message));
  // Local development and browser smoke tests can observe the same exact messages.
  window.dispatchEvent(new CustomEvent("bunnyhop:native-message", { detail: message }));
}

export function openAuth(raw: string): void {
  const url = new URL(raw, LIVE_ORIGIN);
  if (url.origin !== LIVE_ORIGIN || !url.pathname.startsWith("/api/auth/")) return;
  send({ type: "openAuth", url: url.href });
}

/** Hosts the client will hand to the system browser: credits links, the site's own pages, the Discord invite. */
export const EXTERNAL_HOSTS = ["github.com", "1998.lol", "bunnyhop.lol", "discord.gg"] as const;
/**
 * Opens a link outside the client. The menu webview refuses every navigation
 * away from the loaded document, so an <a href> here does nothing at all —
 * a link has to leave the process to go anywhere.
 *
 * Checked here and again natively: this side keeps a bad URL from being sent,
 * the native side is what actually decides, since nothing arriving over the
 * bridge gets to be trusted on its own.
 */
export function openExternal(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (!EXTERNAL_HOSTS.some(host => url.hostname === host || url.hostname.endsWith("." + host))) return false;
  send({ type: "openExternal", url: url.href });
  return true;
}

/** The web's HUD_SCALE (hud/layout.ts: 0.5–1.75, steps of 0.05) in percent. */
export const HUD_SCALE_PERCENT={min:50,max:175,step:5} as const;
const ATTEMPT_ID=/^[\w-]{16}$/,MAP_NAME=/^[a-zA-Z0-9_.-]{1,128}$/;
export const isMapName=(value:unknown):value is string=>typeof value==="string"&&MAP_NAME.test(value);
export const isAttemptId=(value:unknown):value is string=>typeof value==="string"&&ATTEMPT_ID.test(value);
const nonNegativeInt=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const shortText=(value:unknown,max=200):string|null=>typeof value==="string"?value.slice(0,max):null;

export const state: NativeMenuState = { map: null, loading: false, error: null, sensitivity: 2, paused: true,style:"autohop",track:0,
  settings:{sensitivity:2,verticalSensitivity:2,separateVertical:false,yawSpeed:DEFAULT_YAW_SPEED,yawSpeedAlt:DEFAULT_YAW_SPEED_ALT,fov:90,sourceLook:true,vsync:true,fpsLimit:0,volume:.8,muted:false,hud:true,crosshair:true,viewmodel:true,jumpStats:true,jumpStatsMode:"sixth",jumpStatsInterval:6,strafeTrainer:false,strafeTrainerSmoothing:1,strafeTrainerHints:true,hudLayout:{},hudScale:100,practiceKeepVelocity:true,sfxPack:"default",musicPack:"default",discordRichPresence:true,discordShowMap:true,discordJoin:true,discordJoinLobbies:false,privacyMode:false,binds:Object.fromEntries(NATIVE_BIND_ACTIONS.map(action=>[action,[...DEFAULT_BINDS[action]]]))},
  replays:[],discord:{state:"disabled",message:""},playback:{active:false,id:"",tick:0,totalTicks:0,paused:true,speed:1},ghost:{enabled:false,id:"",name:""},tutorial:{active:false,lesson:"jump",completed:[]},
  practice:{available:false,unavailable:null,mode:false,active:false,tool:null,noclip:false,menuOpen:false,count:0,current:0,keepVelocity:true},gauntlet:{id:null,map:null},player:null,music:null,client:null};

export const nativeKeyCode=(code:unknown):code is string=>typeof code==="string"&&/^(?:Key[A-Z]|Digit[0-9]|F[1-9]|F11|F12|Mouse[1-5]|MouseWheel|MWheelUp|MWheelDown|(?:Control|Shift|Alt)(?:Left|Right)|Space|Tab|Enter|Backspace|Arrow(?:Up|Down|Left|Right)|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Slash)$/.test(code);

export function settingsPatch(value:unknown):Partial<NativeSettings> {
  if(!value||typeof value!=="object"||Array.isArray(value)) return {};
  const input=value as Record<string,unknown>,out:Record<string,unknown>={};
  for(const [key,min,max] of [["sensitivity",.01,100],["verticalSensitivity",.01,100],["fov",60,130],["volume",0,1],["yawSpeed",.01,1000],["yawSpeedAlt",.01,1000]] as const) if(typeof input[key]==="number"&&Number.isFinite(input[key])&&Number(input[key])>=min&&Number(input[key])<=max) out[key]=input[key];
  if(typeof input.fpsLimit==="number"&&Number.isFinite(input.fpsLimit)&&(input.fpsLimit===0||(input.fpsLimit>=30&&input.fpsLimit<=1000))) out.fpsLimit=input.fpsLimit;
  for(const key of ["separateVertical","sourceLook","vsync","muted","hud","crosshair","viewmodel","jumpStats","strafeTrainer","strafeTrainerHints","discordRichPresence","discordShowMap","discordJoin","discordJoinLobbies","privacyMode"]) if(typeof input[key]==="boolean") out[key]=input[key];
  // Only these two words ever cross the bridge, so a pack choice can never
  // become a path the native side would go looking for.
  if(JUMP_STATS_MODES.includes(input.jumpStatsMode as JumpStatsMode)) out.jumpStatsMode=input.jumpStatsMode;
  if(Number.isInteger(input.jumpStatsInterval)&&Number(input.jumpStatsInterval)>=2&&Number(input.jumpStatsInterval)<=50) out.jumpStatsInterval=input.jumpStatsInterval;
  if(Number.isInteger(input.strafeTrainerSmoothing)&&Number(input.strafeTrainerSmoothing)>=1&&Number(input.strafeTrainerSmoothing)<=50) out.strafeTrainerSmoothing=input.strafeTrainerSmoothing;
  if(validHudLayout(input.hudLayout)) out.hudLayout=input.hudLayout;
  if(Number.isInteger(input.hudScale)&&Number(input.hudScale)>=HUD_SCALE_PERCENT.min&&Number(input.hudScale)<=HUD_SCALE_PERCENT.max) out.hudScale=input.hudScale;
  if(typeof input.practiceKeepVelocity==="boolean") out.practiceKeepVelocity=input.practiceKeepVelocity;
  for(const key of ["sfxPack","musicPack"] as const) if(AUDIO_PACKS.includes(input[key] as AudioPack)) out[key]=input[key];
  if(input.binds&&typeof input.binds==="object"&&!Array.isArray(input.binds)) {
    const binds:Record<string,string[]>={};
    for(const action of NATIVE_BIND_ACTIONS) {
      const codes=(input.binds as Record<string,unknown>)[action];
      if(Array.isArray(codes)&&codes.length<=4&&codes.every(nativeKeyCode)) binds[action]=[...new Set(codes)];
    }
    out.binds=binds;
  }
  return out as Partial<NativeSettings>;
}

export function applyState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const next = value as Record<string, unknown>;
  if (next.map === null || next.map === "") state.map = null;
  else if (typeof next.map === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(next.map)) state.map = next.map;
  if (typeof next.loading === "boolean" || typeof next.loading === "string") state.loading = next.loading;
  if (next.error === null || typeof next.error === "string") state.error = next.error;
  if (typeof next.sensitivity === "number" && Number.isFinite(next.sensitivity) && next.sensitivity > 0) state.sensitivity = next.sensitivity;
  if (typeof next.paused === "boolean") state.paused = next.paused;
  if(isStyleId(next.style)) state.style=next.style;
  if(Number.isSafeInteger(next.track)&&Number(next.track)>=0) state.track=Number(next.track);
  if(next.settings) {const patch=settingsPatch(next.settings);state.settings={...state.settings,...patch,binds:{...state.settings.binds,...patch.binds}};state.sensitivity=state.settings.sensitivity;}
  else state.settings.sensitivity=state.sensitivity;
  if(Array.isArray(next.replays)) state.replays=next.replays.slice(0,5000).filter((item):item is NativeReplay=>!!item&&typeof item==="object"&&typeof item.id==="string"&&item.id.length<=256&&typeof item.name==="string"&&typeof item.map==="string"&&isStyleId(item.style)&&[item.track,item.seconds,item.recordedAt,item.bytes].every(value=>typeof value==="number"&&Number.isFinite(value)&&value>=0));
  if(next.playback&&typeof next.playback==="object") {
    const playback=next.playback as Record<string,unknown>;
    for(const key of ["active","paused"] as const) if(typeof playback[key]==="boolean") state.playback[key]=playback[key];
    for(const key of ["tick","totalTicks","speed"] as const) if(typeof playback[key]==="number"&&Number.isFinite(playback[key])&&Number(playback[key])>=0) state.playback[key]=Number(playback[key]);
    if(typeof playback.id==="string") state.playback.id=playback.id;
  }
  if(next.discord&&typeof next.discord==="object") {const discord=next.discord as Record<string,unknown>;if(DISCORD_STATES.includes(discord.state as DiscordState))state.discord.state=discord.state as DiscordState;if(typeof discord.message==="string")state.discord.message=discord.message.slice(0,200);}
  if(next.client&&typeof next.client==="object") {
    const client=next.client as Record<string,unknown>,viewport=client.viewport;
    const size=(v:unknown)=>typeof v==="number"&&Number.isInteger(v)&&v>0&&v<=65535;
    state.client={version:typeof client.version==="string"?client.version.slice(0,40):"",build:typeof client.build==="string"?client.build.slice(0,80):"",
      gpu:typeof client.gpu==="string"?client.gpu.slice(0,200):"",viewport:Array.isArray(viewport)&&viewport.length===2&&viewport.every(size)?[viewport[0],viewport[1]]:[0,0],
      dpr:typeof client.dpr==="number"&&Number.isFinite(client.dpr)&&client.dpr>0&&client.dpr<=8?client.dpr:1};
  }
  if(next.ghost&&typeof next.ghost==="object") {const ghost=next.ghost as Record<string,unknown>;if(typeof ghost.enabled==="boolean") state.ghost.enabled=ghost.enabled;for(const key of ["id","name"] as const) if(typeof ghost[key]==="string") state.ghost[key]=ghost[key];}
  if(next.tutorial&&typeof next.tutorial==="object") {const tutorial=next.tutorial as Record<string,unknown>;if(typeof tutorial.active==="boolean")state.tutorial.active=tutorial.active;if(LESSON_IDS.includes(tutorial.lesson as LessonId))state.tutorial.lesson=tutorial.lesson as LessonId;if(Array.isArray(tutorial.completed))state.tutorial.completed=LESSON_IDS.filter(id=>(tutorial.completed as unknown[]).includes(id));}
  if(next.practice&&typeof next.practice==="object") {
    const practice=next.practice as Record<string,unknown>,out=state.practice;
    for(const key of ["available","mode","active","noclip","menuOpen","keepVelocity"] as const) if(typeof practice[key]==="boolean") out[key]=practice[key];
    if(practice.unavailable===null) out.unavailable=null; else if(typeof practice.unavailable==="string") out.unavailable=practice.unavailable.slice(0,200);
    if(practice.tool===null||practice.tool==="teleport"||practice.tool==="noclip") out.tool=practice.tool;
    if(nonNegativeInt(practice.count)) out.count=Math.min(Number(practice.count),1000);
    if(nonNegativeInt(practice.current)) out.current=Math.min(Number(practice.current),out.count);
  }
  if(next.gauntlet===null) state.gauntlet={id:null,map:null};
  else if(next.gauntlet&&typeof next.gauntlet==="object") {
    const gauntlet=next.gauntlet as Record<string,unknown>;
    if(gauntlet.id===null||isAttemptId(gauntlet.id)) state.gauntlet.id=gauntlet.id;
    if(gauntlet.map===null||isMapName(gauntlet.map)) state.gauntlet.map=gauntlet.map;
  }
  if(next.player===null) state.player=null;
  else if(next.player&&typeof next.player==="object") {
    const player=next.player as Record<string,unknown>;
    if((player.map===null||isMapName(player.map))&&isStyleId(player.style)&&nonNegativeInt(player.track)&&PLAYER_MODES.includes(player.mode as PlayerMode))
      state.player={map:player.map,style:player.style,track:Number(player.track),mode:player.mode as PlayerMode,practice:player.practice===true};
  }
  if(next.playback&&typeof next.playback==="object") {
    const who=(next.playback as Record<string,unknown>).player;
    if(who===null) delete state.playback.player;
    else if(who&&typeof who==="object") {
      const raw=who as Record<string,unknown>,player:NonNullable<PlaybackState["player"]>={};
      if(typeof raw.id==="string"&&/^[\w-]{1,64}$/.test(raw.id)) player.id=raw.id;
      if(typeof raw.runId==="string"&&/^[\w-]{1,64}$/.test(raw.runId)) player.runId=raw.runId;
      const name=shortText(raw.name,64);if(name) player.name=name;
      state.playback.player=player;
    }
  }
  if(next.music===null) state.music=null;
  else if(next.music&&typeof next.music==="object") {
    const music=next.music as Record<string,unknown>;
    const out:MusicState={...(state.music??{id:"",title:"",role:"",playing:false,available:false,loading:false,status:""})};
    for(const key of ["id","title","role","status"] as const){const text=shortText(music[key]);if(text!==null)out[key]=text;}
    for(const key of ["playing","available","loading"] as const) if(typeof music[key]==="boolean") out[key]=music[key];
    state.music=out;
  }
  return true;
}
