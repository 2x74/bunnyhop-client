import {h} from "../../web/src/ui/dom";
import {confirmDialog,textDialog} from "../../web/src/ui/settings-transfer";
import {settingsPatch,type NativeSettings} from "./bridge";
import {migrateTurnSpeed} from "./turn-speed";
export interface SettingsPreset {name:string;settings:Partial<NativeSettings>}
interface Store {active:string;list:SettingsPreset[]}
const KEY="bunnyhop:native-settings-presets:v1";
export function presetNameProblem(name:string,existing:string[],current=""):string|null {const clean=name.trim();return !clean?"Enter a name.":clean.length>40?"Use 40 characters or fewer.":existing.some(n=>n.toLowerCase()===clean.toLowerCase()&&n!==current)?"That name is already in use.":null;}
/** Presets saved before fast turn hold the old modifier speed (turn-speed.ts). */
const savedSettings=(value:unknown):unknown=>value&&typeof value==="object"&&!Array.isArray(value)
  ?migrateTurnSpeed(value as Record<string,unknown>):value;
export function parsePresets(value:unknown):Store {
 const raw=value as Partial<Store>|null;const list:SettingsPreset[]=[];
 if(Array.isArray(raw?.list))for(const p of raw.list.slice(0,30)){if(!p||typeof p.name!=="string"||presetNameProblem(p.name,list.map(p=>p.name)))continue;const settings=settingsPatch(savedSettings(p.settings));if(Object.keys(settings).length)list.push({name:p.name.trim(),settings});}
 return {active:list.some(p=>p.name===raw?.active)?raw!.active!:"",list};
}
export function settingsPresets(read:()=>NativeSettings,apply:(settings:Partial<NativeSettings>)=>void):HTMLElement {
 let store:Store;try{store=parsePresets(JSON.parse(localStorage.getItem(KEY)??"null"));}catch{store={active:"",list:[]};}
 const select=h("select",{"aria-label":"Settings preset"}) as HTMLSelectElement;
 const status=h("p.nset-hint",{role:"status"});
 const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify(store));status.textContent="Preset saved on this device.";}catch{status.textContent="Presets could not be saved on this device.";}};
 const current=()=>store.list.find(p=>p.name===store.active);
 const snapshot=()=>JSON.parse(JSON.stringify(settingsPatch(read()))) as Partial<NativeSettings>;
 const modified=(p:SettingsPreset)=>JSON.stringify(p.settings)!==JSON.stringify(snapshot());
 const paint=()=>{const cur=current();select.replaceChildren(h("option",{value:""},"No preset"),...store.list.map(p=>h("option",{value:p.name},p.name+(p===cur&&modified(p)?" (modified)":""))));select.value=store.active;save.disabled=!cur;rename.disabled=!cur;remove.disabled=!cur;};
 const save=h("button.btn",{type:"button",onclick:()=>{const cur=current();if(cur){cur.settings=snapshot();persist();paint();}}},"Save changes");
 const create=h("button.btn",{type:"button",onclick:async()=>{if(store.list.length>=30){status.textContent="You can save up to 30 presets.";return;}const name=await textDialog({title:"Save settings preset",label:"Preset name",confirm:"Save",maxLength:40,problem:n=>presetNameProblem(n,store.list.map(p=>p.name))});if(name===null||!root.isConnected)return;store.active=name.trim();store.list.push({name:store.active,settings:snapshot()});persist();paint();}},"Save as new…");
 const rename=h("button.btn",{type:"button",onclick:async()=>{const cur=current();if(!cur)return;const name=await textDialog({title:"Rename preset",label:"Preset name",confirm:"Rename",value:cur.name,maxLength:40,problem:n=>presetNameProblem(n,store.list.map(p=>p.name),cur.name)});if(name===null||!root.isConnected)return;cur.name=name.trim();store.active=cur.name;persist();paint();}},"Rename…");
 const remove=h("button.btn",{type:"button",onclick:async()=>{const cur=current();if(!cur||!await confirmDialog({title:`Delete ${cur.name}?`,body:"Your current settings stay as they are.",confirm:"Delete",danger:true})||!root.isConnected)return;store.list=store.list.filter(p=>p!==cur);store.active="";persist();paint();}},"Delete…");
 // A switch waiting on its confirmation is dropped if a newer selection was made
 // meanwhile, so the latest choice always wins.
 let selection=0;
 select.addEventListener("change",async()=>{const ticket=++selection;const next=store.list.find(p=>p.name===select.value);if(!next){store.active="";persist();paint();return;}if(next===current()){paint();return;}paint();const cur=current();if((cur?modified(cur):!store.list.some(p=>!modified(p)))&&!await confirmDialog({title:`Switch to ${next.name}?`,body:"Unsaved changes to your current settings will be replaced.",confirm:"Switch"}))return;if(!root.isConnected||ticket!==selection)return;apply(JSON.parse(JSON.stringify(next.settings)));store.active=next.name;persist();paint();});
 const root=h("div",null,h("div.btn-row",null,select,save,create,rename,remove),status);
 const observer=new MutationObserver(()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",sync);observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});
 const sync=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",sync);observer.disconnect();return;}paint();};window.addEventListener("bunnyhop:host-state",sync);paint();return root;
}
