import {prefs} from "../../web/src/ui/settings";
import {mouseFromPrefs} from "../../web/src/mouse-settings";
import {ProfileMousePublisher} from "./profile-mouse-publisher";
import {accountGeneration} from "../../web/src/ui/account-state";
import {api,lastKnownMe} from "../../web/src/api";
import {state,send} from "./bridge";
/** Keep the shared profile mouse editor tied to the active native device. DPI
 * remains self-reported browser-local metadata; sensitivity is host-owned. */
export function syncProfileMouse():void {if(prefs.get().sensitivity!==state.settings.sensitivity)prefs.update(p=>{p.sensitivity=state.settings.sensitivity;});}
export function bindProfileMouse(owner:HTMLElement):void {
 let syncing=false;
 const publisher=new ProfileMousePublisher({owner:()=>lastKnownMe()?.id??null,epoch:accountGeneration,readUser:async()=>{const user=await api.me();return api.meStale()?null:user;},save:(mouse,dispatch)=>api.setMouseSettings(mouse,dispatch),schedule:fn=>setTimeout(fn,1000),cancel:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)});
 const account=()=>publisher.invalidate();window.addEventListener("bunnyhop:account",account);
 const sync=()=>{if(prefs.get().sensitivity===state.settings.sensitivity)return;syncing=true;prefs.update(p=>{p.sensitivity=state.settings.sensitivity;});syncing=false;};
 sync();let seen=JSON.stringify(mouseFromPrefs(prefs.get()));

 const off=prefs.watch(p=>{const mouse=mouseFromPrefs(p),key=JSON.stringify(mouse);if(key===seen)return;seen=key;if(syncing)return;if(mouse.sensitivity!==state.settings.sensitivity)send({type:"settings",patch:{sensitivity:mouse.sensitivity}});publisher.edit(mouse);});
 let seenAttached=false;queueMicrotask(()=>{seenAttached=owner.isConnected;});
 const host=()=>{if(owner.isConnected)seenAttached=true;else if(seenAttached){window.removeEventListener("bunnyhop:host-state",host);off();publisher.invalidate();window.removeEventListener("bunnyhop:account",account);return;}sync();};
 window.addEventListener("bunnyhop:host-state",host);
}
