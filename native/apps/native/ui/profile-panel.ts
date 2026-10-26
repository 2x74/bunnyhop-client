// The profile is the current web screen, with its complete card/editor, overview,
// point contributions, stats, social controls and virtualized verified runs.
// Only its gameplay/navigation effects cross into the native host.
import {bindProfileMouse,syncProfileMouse} from "./profile-mouse";
import { profileScreen,type ProfileOpen,type ProfileActions } from "../../web/src/ui/profile";
import { openReplayViewer } from "../../web/src/viewer/request";
import { requestRace } from "../../web/src/player/race";
import { navigate } from "../../web/src/ui/nav";
import { openAccountPanel } from "./account-panel";
import { h } from "../../web/src/ui/dom";

export function nativeProfileActions(play:(map:string,style?:string)=>void,notice:(text:string)=>void):ProfileActions {
 return {play,watch:(run,player)=>openReplayViewer({runId:run.runId,name:`${player} · ${run.map}`}),race:(run,player)=>requestRace({kind:"run",runId:run.runId,name:`${player} · ${run.map}`}),ranks:scope=>navigate({screen:"ranks",scope}),toast:notice,saveProgress:()=>openAccountPanel("save")};
}
/** `loadout` is retained for old callers; the full screen now owns its Loadout
 * tab. `open` allows native navigation to preserve card/category deep links. */
export function profilePanel(id:string,play:(map:string,style?:string)=>void,_loadout?:()=>void,open:ProfileOpen={}):HTMLElement {
 syncProfileMouse();
 const notice=h("p.native-profile-notice",{role:"status"});
 const screen=profileScreen(id,nativeProfileActions(play,text=>{notice.textContent=text;}),open);
 const root=h("div.native-profile-body",null,notice,screen);bindProfileMouse(root);return root;
}
