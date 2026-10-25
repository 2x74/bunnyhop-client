import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { accountAvatar } from "../../web/src/ui/account-state";
import { followButton } from "../../web/src/social/dock";
import { knowRelation,openFriends } from "../../web/src/social/state";
import { playerStatsSection } from "../../web/src/ui/stats-screen";
import { openReplayViewer } from "../../web/src/viewer/request";
import { requestRace } from "../../web/src/player/race";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";

// Profile data, social actions and verified runs use the same API as the web
// menus. Replay buttons transfer bytes to the native playback/ghost owner.
// Your own profile keeps the web profile's way to the Loadout (its Loadout tab) as a button.
export function profilePanel(id:string,play:(map:string)=>void,loadout?:()=>void):HTMLElement {
 const root=h("div.native-profile-body"),identity=h("section",null,h("p.dim",null,"Loading profile…")),runs=h("section"),stats=h("section");
 root.append(identity,runs,stats);
 void api.profile(id).then(profile=>{
  if(profile.social?.you)knowRelation(id,profile.social.you);
  identity.replaceChildren(h("div.native-identity",null,accountAvatar(profile.player),h("h2",null,profile.player.name)),h("p",null,`Level ${profile.level.level} · ${profile.rank.group.name}`),h("p.dim",null,`${profile.stats.maps} maps completed · ${profile.stats.wrs} world records · ${profile.stats.pbs} personal bests`),...(!profile.mine?[h("div.native-toolbar",null,followButton(profile.player),h("button.btn",{type:"button",onclick:()=>openFriends(id)},"Message"))]:loadout?[h("div.native-toolbar",null,h("button.btn.native-profile-loadout",{type:"button",onclick:loadout},"Loadout"))]:[]));
  stats.append(playerStatsSection(id,{compact:true}));
 },()=>identity.replaceChildren(h("p.dim",null,"Couldn't load this profile. Try again.")));
 let offset=0,total=0;const rows=h("div"),label=h("p.dim"),pb=h("input",{type:"checkbox",checked:true,"aria-label":"Personal bests only"}),previous=h("button.btn",{type:"button",onclick:()=>{offset=Math.max(0,offset-40);void load();}},"Previous"),next=h("button.btn",{type:"button",onclick:()=>{offset+=40;void load();}},"Next");
 const load=async()=>{previous.disabled=next.disabled=true;try{const page=await api.playerRuns(id,{offset,limit:40,pbOnly:pb.checked});total=page.total;label.textContent=total?`${offset+1}–${Math.min(offset+40,total)} of ${total}`:"No verified runs yet.";rows.replaceChildren(...page.runs.map(run=>h("article.native-replay-row",null,h("div",null,h("strong",null,run.map),h("p.dim",null,`${styleLabel(run.style)} · ${formatTime(run.time)}${run.track?` · Bonus ${run.track}`:""}${run.rank?` · #${run.rank}`:""}`)),h("div.native-toolbar",null,h("button.btn",{type:"button",onclick:()=>openReplayViewer({runId:run.runId,name:run.map})},"Watch"),h("button.btn",{type:"button",onclick:()=>requestRace({kind:"run",runId:run.runId,name:run.map})},"Ghost"),h("button.btn",{type:"button",onclick:()=>play(run.map)},"Play")))));}catch{label.textContent="Couldn't load runs. Try again.";}previous.disabled=offset===0;next.disabled=offset+40>=total;};
 pb.addEventListener("change",()=>{offset=0;void load();});runs.append(h("h3",null,"Verified runs"),h("label",null,pb," Personal bests only"),rows,h("div.native-toolbar",null,previous,label,next));void load();return root;
}
