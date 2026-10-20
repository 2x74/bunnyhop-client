import { api,type CosmeticChoice } from "../../web/src/api";
import { COSMETICS,DEFAULT_COSMETICS,isUnlocked,type CosmeticSlot } from "../../web/src/progression";
import { getOutfit,getLoadout,getGhostCosmetics,setOutfit,setLoadout,setGhostCosmetics,onOutfit,onLoadout } from "../../web/src/player/cosmetics";
import { loadoutFor,packLoadout } from "../../web/src/loadout";
import { h } from "../../web/src/ui/dom";
import { send } from "./bridge";
export interface CosmeticApi {myCosmetics():Promise<{choice:CosmeticChoice;unlocked:string[]}>;saveCosmetics(patch:Partial<CosmeticChoice>):Promise<CosmeticChoice>}
export class NativeCosmetics {
 choice:CosmeticChoice={...DEFAULT_COSMETICS,...getLoadout(),outfit:getOutfit(),ghost:getGhostCosmetics().ghostId,trail:getGhostCosmetics().trailId};
 unlocked=new Set(COSMETICS.filter(c=>isUnlocked(c,1,[])).map(c=>c.id));online=false;status="";private epoch=0;private listeners=new Set<()=>void>();private saving:Promise<void>=Promise.resolve();
 constructor(private service:CosmeticApi=api){}
 subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private changed():void{for(const fn of this.listeners)fn();}
 private sync():void{setOutfit(this.choice.outfit);setLoadout(loadoutFor(this.choice,getLoadout().crown??null));setGhostCosmetics(this.choice.ghost,this.choice.trail);}
 async refresh():Promise<void>{const epoch=++this.epoch;try{const result=await this.service.myCosmetics();if(epoch!==this.epoch)return;this.choice={...DEFAULT_COSMETICS,...result.choice};this.unlocked=new Set(result.unlocked);this.online=true;this.status="";this.sync();}catch{if(epoch!==this.epoch)return;this.online=false;this.unlocked=new Set(COSMETICS.filter(c=>isUnlocked(c,1,[])).map(c=>c.id));this.status="Offline: free cosmetics are saved on this device.";}this.changed();}
 equip(slot:CosmeticSlot,id:string|null):Promise<void>{const item=COSMETICS.find(item=>item.id===id);if(id&&(!item||item.slot!==slot||!this.unlocked.has(id)))return Promise.resolve();if(!id&&slot!=="hat"&&slot!=="title")return Promise.resolve();const epoch=this.epoch;
  this.saving=this.saving.then(async()=>{if(epoch!==this.epoch)return;this.status="Saving…";this.changed();try{if(this.online){const choice=await this.service.saveCosmetics({[slot]:id});if(epoch!==this.epoch)return;this.choice={...DEFAULT_COSMETICS,...choice};this.status="Saved to your account.";}else{this.choice={...this.choice,[slot]:id};this.status="Saved on this device.";}this.sync();}catch(error){this.status=error instanceof Error?error.message:"Couldn't save cosmetics.";}this.changed();});return this.saving;
 }
}
export const cosmetics=new NativeCosmetics();
export function initCosmetics():void {const notify=()=>send({type:"cosmetics",outfit:getOutfit(),packedLoadout:packLoadout(getLoadout())});onOutfit(notify);onLoadout(notify);notify();addEventListener("bunnyhop:account",()=>{void cosmetics.refresh();});void cosmetics.refresh();}
export function cosmeticsPanel():HTMLElement {
 const root=h("div.native-cosmetics"),status=h("p.dim",{role:"status"}),items=h("div.native-cosmetic-items"),slot=h("select",{"aria-label":"Cosmetic category"},...["knife","finish","glove","outfit","body","hat","ghost","trail","background","frame","title"].map(value=>h("option",{value},value[0].toUpperCase()+value.slice(1))));
 const draw=()=>{const category=slot.value as CosmeticSlot;status.textContent=[cosmetics.status,...(["ghost","trail"].includes(category)?["This is an account appearance choice. Native ghost/trail colors are not applied yet."]:[])].filter(Boolean).join(" ");items.replaceChildren(...COSMETICS.filter(item=>item.slot===category&&cosmetics.unlocked.has(item.id)).map(item=>h("button.native-cosmetic-card",{type:"button","aria-pressed":cosmetics.choice[category]===item.id,onclick:()=>{void cosmetics.equip(category,item.id);}},item.color?h("span.native-cosmetic-swatch",{style:`background:${item.color}`}):null,h("strong",null,item.name),h("small.dim",null,cosmetics.choice[category]===item.id?"Equipped":"Equip"))),...(["hat","title"].includes(category)?[h("button.native-cosmetic-card",{type:"button",onclick:()=>{void cosmetics.equip(category,null);}},"None")]:[]));};
 slot.addEventListener("change",draw);root.append(h("p.dim",null,"Choose unlocked items. Saved account choices follow you between devices."),h("div.native-toolbar",null,slot,h("button.btn",{type:"button",onclick:()=>{void cosmetics.refresh();}},"Refresh unlocks")),status,items);const off=cosmetics.subscribe(()=>{if(root.isConnected)draw();else off();});draw();return root;
}
