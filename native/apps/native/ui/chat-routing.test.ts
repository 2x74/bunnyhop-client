import {test,expect} from "bun:test";
import {dispatchNativeChat} from "./chat-routing";
import {chatCommands,suggestChat,type ChatContext} from "../../web/src/chat-commands";
function fixture(where:"room"|"solo"="room"){
 const replies:string[]=[],actions:unknown[]=[],sent:unknown[]=[];
 const context:ChatContext={where,reply:text=>replies.push(text),restart:track=>actions.push(["restart",track]),restartBonus:()=>actions.push("bonus"),setStartPoint:()=>actions.push("setStart"),clearStartPoint:()=>actions.push("clearStart"),game:{key:()=>null,practice:cmd=>actions.push(cmd),style:()=>"autohop",setStyle:id=>actions.push(id),record:kind=>actions.push(kind)},room:where==="room"?{spectating:()=>false,stopSpectating:()=>actions.push("stop"),spectate:name=>actions.push(["spec",name]),hidePlayers:()=>{},toggleScores:()=>{},openNominateMenu:()=>actions.push("nominate"),invite:()=>{},race:arg=>actions.push(["race",arg])}:null};
 return {replies,actions,sent,context,line:(text:string)=>dispatchNativeChat(text,context,m=>{sent.push(m);return true;})};
}
test("all built-in commands and aliases resolve without accidental ordinary chat broadcast",()=>{
 for(const command of chatCommands())for(const name of [command.name,...command.aliases??[]]){
  const f=fixture(command.where==="solo"?"solo":"room");f.line(`!${name}`);
  // Server-only entries broadcast; help is explicitly a local server log.
  if(command.server&&!command.run)expect(f.sent).toEqual([{t:"chat",text:`!${name}`}]);
  else if(command.name==="help"||command.group==="practice")expect(f.sent).toEqual([{t:"chat",text:`!${name}`,local:true}]);
  else expect(f.sent).toEqual([]);
 }
});
test("native local restart/style/start/practice actions never reach the room",()=>{
 const f=fixture();for(const command of ["!r","/restart","!sm_restart","!m","!b","!setstart","!clearstart","!style hsw","!pb","!wr"])f.line(command);
 expect(f.sent).toEqual([]);expect(f.actions).toContainEqual(["restart",0]);expect(f.actions).toContain("hsw");expect(f.actions).toContain("setStart");expect(f.actions).toContain("clearStart");
 f.line("!noclip");expect(f.sent).toEqual([{t:"chat",text:"!noclip",local:true}]);expect(f.actions).toContain("noclip");
});
test("plain chat and server commands send exactly once; unknown commands are private logs",()=>{
 const f=fixture();f.line("hello");f.line("rtv");f.line("!nominate bhop_test");f.line("!notarealcommand");expect(f.sent).toEqual([{t:"chat",text:"hello"},{t:"chat",text:"rtv"},{t:"chat",text:"!nominate bhop_test"},{t:"chat",text:"!notarealcommand",local:true}]);expect(f.replies.length).toBe(1);
});
test("solo commands reply locally, suggestions and unavailable room commands never send",()=>{
 const f=fixture("solo");f.line("hello");f.line("rtv");f.line("!practice");f.line("!spec");expect(f.sent).toEqual([]);expect(f.actions).toEqual(["toggle"]);expect(f.replies.length).toBe(3);expect(suggestChat("!rest","solo").length).toBeGreaterThan(0);
});
test("disconnected server commands answer clearly; local commands still work",()=>{
 const f=fixture();dispatchNativeChat("rtv",f.context,()=>false);dispatchNativeChat("!r",f.context,()=>{throw Error("local command transmitted");});expect(f.replies).toEqual(["The room is not connected."]);expect(f.actions).toEqual([["restart",undefined]]);
});
