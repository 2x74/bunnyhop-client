import {prefs} from "../../web/src/ui/settings";
import {state,send} from "./bridge";
let installed=false;
/** Shared account editor's device switches control the real native shader, not an unrelated browser preference. */
export function installGlowSettings():void {
 if(installed)return;installed=true;let syncing=false;
 const sync=()=>{const settings=state.settings;if(prefs.get().showPlayerGlow===settings.showPlayerGlow&&prefs.get().firstPersonGlow===settings.firstPersonGlow)return;syncing=true;prefs.update(p=>{p.showPlayerGlow=settings.showPlayerGlow;p.firstPersonGlow=settings.firstPersonGlow;});syncing=false;};
 sync();prefs.watch(p=>{if(syncing)return;const patch:Partial<typeof state.settings>={};if(p.showPlayerGlow!==state.settings.showPlayerGlow)patch.showPlayerGlow=p.showPlayerGlow;if(p.firstPersonGlow!==state.settings.firstPersonGlow)patch.firstPersonGlow=p.firstPersonGlow;if(Object.keys(patch).length)send({type:"settings",patch});});window.addEventListener("bunnyhop:host-state",sync);
}
