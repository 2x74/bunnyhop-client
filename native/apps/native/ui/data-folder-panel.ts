import {h} from "../../web/src/ui/dom";
import {send} from "./bridge";

/** Settings -> Game data, mirrored from the host (client.cpp "dataFolder"). */
export interface DataFolderStatus {
 path:string;defaultPath:string;isDefault:boolean;configured:string;unavailable:boolean;
 pending:string|null;picking:boolean;notice:string;choice:{path:string;problem:string}|null;
}
const str=(v:unknown,max=4096):string|null=>typeof v==="string"?v.slice(0,max):null;
export function readDataFolderStatus(value:unknown):DataFolderStatus|null {
 if(!value||typeof value!=="object")return null;const v=value as Record<string,unknown>;
 const path=str(v.path),defaultPath=str(v.defaultPath),configured=str(v.configured)??path;
 if(!path||!defaultPath||configured===null||typeof v.isDefault!=="boolean")return null;
 let choice:DataFolderStatus["choice"]=null;
 if(v.choice&&typeof v.choice==="object"){const c=v.choice as Record<string,unknown>;const cp=str(c.path),problem=str(c.problem,1000);if(cp!==null&&problem!==null)choice={path:cp,problem};}
 return {path,defaultPath,isDefault:v.isDefault,configured,unavailable:v.unavailable===true,pending:str(v.pending),picking:v.picking===true,notice:str(v.notice,1000)??"",choice};
}

export function dataFolderPanel():HTMLElement {
 const current=h("code.native-data-path",null,"…"),tag=h("span.dim");
 const warning=h("p.native-data-warning",{role:"alert",hidden:true});
 const pending=h("p",{hidden:true});
 const notice=h("p.dim",{role:"status"});
 const cancelPending=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"dataFolder",action:"cancelPending"})},"Cancel move");
 const forget=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"dataFolder",action:"forget"})},"Use the default folder from now on");
 const change=h("button.btn",{type:"button",onclick:()=>send({type:"dataFolder",action:"pick"})},"Change folder…");
 const useDefault=h("button.btn",{type:"button",hidden:true,onclick:()=>send({type:"dataFolder",action:"useDefault"})},"Move back to the default folder");
 const reveal=h("button.btn",{type:"button",onclick:()=>send({type:"dataFolder",action:"reveal"})},"Open folder");
 // Shown once a folder is picked: the move runs at startup, so "now" restarts the game.
 const question=h("p"),problem=h("p.native-data-warning",{role:"alert"});
 const moveNow=h("button.btn.primary",{type:"button",onclick:()=>send({type:"dataFolder",action:"move",when:"now"})},"Move now (restarts the game)");
 const moveLater=h("button.btn",{type:"button",onclick:()=>send({type:"dataFolder",action:"move",when:"later"})},"When the game next launches");
 const pickAgain=h("button.btn",{type:"button",onclick:()=>send({type:"dataFolder",action:"pick"})},"Pick another folder");
 const cancelChoice=h("button.btn",{type:"button",onclick:()=>send({type:"dataFolder",action:"cancelChoice"})},"Cancel");
 const prompt=h("div.native-data-prompt",{hidden:true,role:"dialog","aria-label":"Move game data"},question,problem,h("div",null,moveNow,moveLater,pickAgain,cancelChoice));
 const root=h("div.native-data",null,
  h("p",null,"Game data folder: ",current," ",tag),warning,h("div",null,forget),pending,h("div",null,cancelPending),
  h("div",null,change,useDefault,reveal),prompt,notice,
  h("p.dim",null,"Maps and other downloads, replays, settings and your sound/ and bgm/ folders live here. Your login stays where it is. Moves happen while the game starts, so nothing is in use."));
 const onStatus=(event:Event)=>{
  if(!root.isConnected){window.removeEventListener("bunnyhop:data-folder",onStatus);return;}
  const s=readDataFolderStatus((event as CustomEvent).detail);if(!s)return;
  current.textContent=s.path;tag.textContent=s.isDefault?"(default)":"";
  warning.hidden=!s.unavailable;warning.textContent=s.unavailable?`${s.configured} isn't available (is the drive connected?). Using the default folder this session.`:"";forget.hidden=!s.unavailable;
  pending.hidden=!s.pending;pending.textContent=s.pending?`Moves to ${s.pending} the next time the game starts.`:"";cancelPending.hidden=!s.pending;
  change.disabled=s.picking||s.unavailable;useDefault.hidden=s.isDefault||s.unavailable;
  notice.textContent=s.picking?"Choose a folder in the window that opened…":s.notice;
  prompt.hidden=!s.choice;
  if(s.choice){
   const ok=!s.choice.problem;
   question.hidden=!ok;question.textContent=ok?`Would you like to move all of your data to ${s.choice.path} now? Or would you prefer if it happens when the game next launches?`:"";
   problem.hidden=ok;problem.textContent=s.choice.problem;moveNow.hidden=!ok;moveLater.hidden=!ok;pickAgain.hidden=ok;
  }
 };
 window.addEventListener("bunnyhop:data-folder",onStatus);queueMicrotask(()=>send({type:"dataFolder",action:"status"}));return root;
}
