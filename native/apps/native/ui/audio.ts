// Menu events use the host mixer, sharing the same buses and custom sound pack.
import { send } from "./bridge";
import { SFX } from "../../web/src/audio/catalog";
import { setNotifySound } from "../../web/src/notify";
import type {AnnouncerEvent,AnnouncerLine} from "./audio-settings";
export const UI_CUES=["ui_hover","ui_press","ui_click","ui_confirm","ui_back","ui_card","ui_switch","ui_open","ui_close","ui_error"] as const;
let installed=false,lastHover:Element|null=null,lastAt=0;
export function uiSound(id:unknown,gain=1,rate=1):void {
  if(typeof id!=="string"||!UI_CUES.includes(id as typeof UI_CUES[number])||!Number.isFinite(gain)||!Number.isFinite(rate))return;
  send({type:"audioCue",id,gain:Math.max(0,Math.min(1,gain)),rate:Math.max(.25,Math.min(4,rate))});
}
export function sfx(id:unknown,gain=1,rate=1):void{if(typeof id!=="string"||!Object.hasOwn(SFX,id)||!Number.isFinite(gain)||!Number.isFinite(rate))return;send({type:"audioCue",id,gain:Math.max(0,Math.min(1,gain)),rate:Math.max(.25,Math.min(4,rate))});}
export function announce(event:AnnouncerEvent,id?:string,remote=false,preview:AnnouncerLine|false=false):void{send({type:"announce",event,...(id?{id}:{}),remote,...(preview?{preview}:{})});}
export function toggleSound(on:boolean):void{uiSound("ui_switch",.8,on?1.12:.88);}
export function rankGroupImproved(uid:string,index:number):boolean{try{const key=`bunnyhop:audio-rank-group:${uid}`,prev=localStorage.getItem(key);localStorage.setItem(key,String(index));return prev!==null&&index>=0&&index<Number(prev);}catch{return false;}}
export function uiOpen():void{uiSound("ui_open");}
export function uiClose():void{uiSound("ui_close");}
export function installNativeUiAudio():void {
  if(installed)return;installed=true;setNotifySound(sfx);
  document.addEventListener("pointerover",event=>{const el=(event.target as Element|null)?.closest?.("button,a[href],select,input[type=checkbox]")??null;if(el===lastHover)return;lastHover=el;const now=performance.now();if(!el||(el as HTMLButtonElement).disabled||now-lastAt<45)return;lastAt=now;uiSound("ui_hover",.65);},{capture:true});
  document.addEventListener("pointerdown",event=>{const el=(event.target as Element|null)?.closest?.("button,a[href]");if(el&&!(el as HTMLButtonElement).disabled)uiSound("ui_press",.65);},{capture:true});
  document.addEventListener("click",event=>{const el=(event.target as Element|null)?.closest?.("button,a[href]");if(!el||(el as HTMLButtonElement).disabled)return;uiSound(el.matches(".back,[aria-label^=Back],[aria-label^=Close]")?"ui_back":el.matches(".primary")?"ui_confirm":"ui_click",.8);},{capture:true});
  document.addEventListener("change",event=>{const el=event.target;if(el instanceof HTMLInputElement&&el.type==="checkbox")uiSound("ui_switch",.8,el.checked?1.12:.88);},{capture:true});
}
