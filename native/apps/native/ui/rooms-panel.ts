import {Scoreboard} from "../../web/src/net/scoreboard";
import {openLeaderboardDialog} from "../../web/src/ui/leaderboard";
import {roomScoreboard} from "./room-scoreboard";
import "./room-scoreboard.css";
import { h } from "../../web/src/ui/dom";
import { isExtend } from "../../web/src/net/protocol";
import { copyLobbyInvite } from "../../web/src/net/lobby";
import { state } from "./bridge";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import type { NativeRoomService } from "./room-service";
import { openReport, reportButton } from "./report";

export function roomPanel(service:NativeRoomService,profile:(id:string)=>void,notice:(message:string)=>void,submit?:(text:string)=>void):HTMLElement {
  const race=h("section.native-room-race"),nominations=h("p.dim"),countdown=h("p.native-room-countdown",{role:"status"});
  const scoreHost=h("section.native-room-scoreboard",{"aria-label":"Room scoreboard"}),scoreboard=new Scoreboard(scoreHost);scoreboard.show(true);scoreboard.el.setAttribute("role","region");
  const records=h("button.btn",{type:"button",onclick:()=>{if(service.view.map)openLeaderboardDialog(service.view.map,state.style,{track:state.track});}},"Map records");
  const root=h("div.native-room"),header=h("div.native-room-head"),players=h("div.native-room-roster"),chat=h("div.native-room-chat",{role:"log","aria-label":"Room chat"}),vote=h("div.native-room-vote"),form=h("form.native-room-chat-form"),input=h("input",{type:"text",maxlength:128,"aria-label":"Room message",placeholder:"Say something or enter a !command"}),nominate=h("select",{"aria-label":"Nominate map"});
  form.append(input,h("button.btn",{type:"submit"},"Send"));form.addEventListener("submit",event=>{event.preventDefault();
    if(submit){if(input.value.trim())submit(input.value);input.value="";return;}
    // !report <name> (web social/commands.ts, net/mp.ts): the report form on someone in the room, never a chat line.
    const report=/^[!/]report(?:\s+(.*))?$/i.exec(input.value.trim());
    if(report){const query=(report[1]??"").trim().toLowerCase(),players=service.view.players.filter(player=>player.slot!==service.view.you);const player=query?players.find(item=>item.name.toLowerCase()===query)??players.find(item=>item.name.toLowerCase().startsWith(query)):undefined;openReport(player?{id:player.id,name:player.name}:query?{name:(report[1]??"").trim()}:undefined);input.value="";return;}
    if(input.value.trim()&&service.command({t:"chat",text:input.value.trim()}))input.value="";else notice("The room is not connected.");});
  const invite=h("button.btn",{type:"button",onclick:()=>{if(service.view.id)void copyLobbyInvite(service.view.id).then(ok=>notice(ok?"Invite link copied.":"Could not copy invite link."));}},"Copy lobby invite");
  const leave=h("button.btn",{type:"button",onclick:()=>service.leave()},"Leave room");
  const rtv=h("button.btn",{type:"button",onclick:()=>service.command({t:"rtv"})},"Rock the vote");
  const submitNomination=h("button.btn",{type:"button",onclick:()=>service.command({t:"nominate",map:nominate.value})},"Nominate");
  root.append(header,h("div.native-toolbar",null,leave,invite,records,rtv,nominate,submitNomination),countdown,race,vote,nominations,scoreHost,h("div.native-room-columns",null,players,h("section",null,chat,form)));
  let rosterKey="",chatKey="",poolKey="",voteKey="",raceKey="";
  const refresh=()=>{
    const view=service.view;const board=roomScoreboard(view,service.clockNow(),service.serverNow(),service.ping());scoreboard.render(board.head,board.rows);records.disabled=!view.map;invite.hidden=!view.room?.private;header.replaceChildren(h("h3",null,view.room?.name??"Room"),h("p.dim",null,`${view.status}${view.map?` · ${view.map}`:""}${view.detail?` · ${view.detail}`:""}`));input.disabled=view.status!=="open";rtv.disabled=submitNomination.disabled=view.status!=="open";
    rtv.textContent=`Rock the vote${view.rtv.needed?` (${view.rtv.count}/${view.rtv.needed})`:""}`;
    nominations.textContent=view.nominations.length?`Nominated: ${view.nominations.map(n=>`${n.map} (${n.name})`).join(" · ")}`:"No nominations yet.";
    countdown.textContent=view.change?`Next map: ${view.change.map}`:"";
    const rk=JSON.stringify([view.players,view.metas]);if(rk!==rosterKey){rosterKey=rk;players.replaceChildren(h("h3",null,`Players (${view.players.length})`),...view.players.map(player=>h("div.native-room-player",null,h("button.link-btn",{type:"button",onclick:()=>profile(player.id)},player.name),h("small.dim",null,styleLabel(player.style)),h("small.dim",null,view.metas[String(player.slot)]?`${view.metas[String(player.slot)].ping}ms · ${formatTime(view.metas[String(player.slot)].timerTicks/100)}`:""),player.spec!=null?h("small.dim",null,"Spectating"):null,player.slot===view.room?.host?h("small.dim",null,"Host"):null,player.slot===view.you?h("span.dim",null,"You"):h("button.btn",{type:"button",onclick:()=>service.command({t:"spec",target:player.slot})},"Spectate"),player.slot===view.you?null:h("button.btn",{type:"button",onclick:()=>service.command({t:"chat",text:`/race #${player.slot} ${state.style} ${state.track}`})},"Race"),player.slot===view.you?null:reportButton({id:player.id,name:player.name}))),h("button.btn",{type:"button",onclick:()=>service.command({t:"spec",target:null})},"Stop spectating"));}
    const raceState=JSON.stringify(view.race);if(raceState!==raceKey){raceKey=raceState;const r=view.race;race.replaceChildren(...(r?[h("h3",null,`Race: ${r.a.name} vs ${r.b.name}`),h("p.dim",null,`${r.state} · ${styleLabel(r.style)}${r.track?` · Bonus ${r.track}`:""}${r.outcome?` · ${r.outcome}`:""}`),...(r.state==="challenge"&&r.you==="b"?[h("button.btn",{type:"button",onclick:()=>service.command({t:"chat",text:"/accept"})},"Accept"),h("button.btn",{type:"button",onclick:()=>service.command({t:"chat",text:"/decline"})},"Decline")]:[]),...(["countdown","live"].includes(r.state)?[h("button.btn",{type:"button",onclick:()=>service.command({t:"chat",text:"/forfeit"})},"Forfeit")]:[])]:[]));}
    const ck=JSON.stringify(view.chat);if(ck!==chatKey){chatKey=ck;const near=chat.scrollTop+chat.clientHeight>=chat.scrollHeight-30;chat.replaceChildren(...view.chat.map(line=>h("p",{"data-kind":line.kind??"say"},line.staff?h("small",null,`${String(line.staff)} · `):null,line.name?h("b",null,`${line.name}: `):null,line.text)));if(near)chat.scrollTop=chat.scrollHeight;}
    const pk=JSON.stringify(view.pool);if(pk!==poolKey){poolKey=pk;nominate.replaceChildren(...view.pool.map(map=>h("option",{value:map.name},map.name)));}
    const vk=JSON.stringify(view.vote);if(vk!==voteKey){voteKey=vk;vote.replaceChildren(...(view.vote?[h("h3",null,"Map vote"),...view.vote.options.map((option,index)=>h("button.btn",{type:"button",onclick:()=>service.command({t:"vote",option:index})},`${isExtend(option)?`Extend ${option.minutes} minutes`:option.map} · ${view.vote!.counts[index]??0}`))]:[]));}
  };
  const off=service.subscribe(()=>{if(root.isConnected)refresh();else off();});const timer=setInterval(()=>{if(root.isConnected)refresh();else{clearInterval(timer);off();}},250);refresh();return root;
}
