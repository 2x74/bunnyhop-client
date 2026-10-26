import {h} from "../../web/src/ui/dom";
import {send} from "./bridge";
export interface UpdateStatus {status:string;message:string;currentVersion:string;version?:string;received:number;bytes?:number}
export function readUpdateStatus(value:unknown):UpdateStatus|null {
 if(!value||typeof value!=="object")return null;const v=value as Record<string,unknown>;
 if(typeof v.status!=="string"||!["disabled","idle","checking","available","current","downloading","ready","cancelled","error"].includes(v.status))return null;
 return {status:v.status,message:typeof v.message==="string"?v.message.slice(0,1000):"",currentVersion:typeof v.currentVersion==="string"?v.currentVersion.slice(0,80):"local",version:typeof v.version==="string"?v.version.slice(0,80):undefined,received:typeof v.received==="number"&&Number.isFinite(v.received)?Math.max(0,v.received):0,bytes:typeof v.bytes==="number"&&Number.isFinite(v.bytes)&&v.bytes>0?v.bytes:undefined};
}
export function updatePanel():HTMLElement {
 const status=h("p",{role:"status"},"Reading update status…"),version=h("p.dim"),progress=h("progress",{max:1,value:0,hidden:true});
 const check=h("button.btn",{type:"button",disabled:true,onclick:()=>send({type:"update",action:"check"})},"Check for updates");
 const download=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"update",action:"download"})},"Download verified package");
 const cancel=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"update",action:"cancel"})},"Cancel");
 const reveal=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"update",action:"reveal"})},"Open updates folder");
 const root=h("div.native-updates",null,version,status,progress,h("div",null,check,download,cancel,reveal),h("p.dim",null,"Downloads are verified against the release signing key. Installation is manual: close the game before replacing the app."));
 const onStatus=(event:Event)=>{if(!root.isConnected){window.removeEventListener("bunnyhop:update",onStatus);return;}const s=readUpdateStatus((event as CustomEvent).detail);if(!s)return;const busy=s.status==="checking"||s.status==="downloading";
  status.textContent=s.message;version.textContent=`Installed: ${s.currentVersion}${s.version?` · Release: ${s.version}`:""}`;check.disabled=busy||s.status==="disabled";download.hidden=s.status!=="available";cancel.hidden=!busy;reveal.hidden=s.status!=="ready";progress.hidden=s.status!=="downloading";progress.value=s.bytes?Math.min(1,s.received/s.bytes):0;
 };
 window.addEventListener("bunnyhop:update",onStatus);queueMicrotask(()=>send({type:"update",action:"status"}));return root;
}
