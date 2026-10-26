import {writeFileSync} from "node:fs";
import {LjTracker} from "./longjump_web_reference";
const state=(tick:number,patch:any={})=>({tick,position:[0,0,0],velocity:[250,0,0],grounded:false,crouched:false,onLadder:false,jumpStatsValid:true,...patch});
const cmd=(k:number)=>({forward:k%5?450:0,side:k<38?-450:450,yaw:k,pitch:0,buttons:0});
const cases:any[]=[];
function flight(name:string,o:any={}){
 const tracker=new LjTracker(),ticks:any[]=[];let tick=0,pre=state(0,{grounded:true,velocity:[o.preSpeed??250,0,0],crouched:!!o.takeoffCrouch}),reports=0;
 const feed=(post:any,c:any,events:number,dt=.01)=>{const report=tracker.feed(pre,post,c,events,dt,o.style??"autohop");if(report)reports++;ticks.push({pre,post,cmd:c,events,dt,style:o.style??"autohop",report});pre=post;};
 for(let k=0;k<(o.ground??15);k++)feed(state(++tick,{grounded:true,velocity:[o.preSpeed??250,0,0],crouched:!!o.takeoffCrouch}),cmd(0),0);
 for(let k=1;k<=125;k++){
  const landed=k===(o.landAt??75)&&!o.drop||k===o.landAt;
  const z=o.drop?(k<37?k*1.5:54-(k-36)*3):k===75?(o.height??1.5):40;
  const post=state(++tick,{position:[k*3,0,z],velocity:[250+k,0,k<37?150:-150],grounded:landed,jumpStatsValid:o.missing?undefined:k!==o.invalidAt,onLadder:k===o.ladderAt,crouched:o.duckAt? k>=o.duckAt:false});
  if(k===o.skipAt){post.tick++;tick++;}
  feed(post,cmd(k),k===1?(o.walkoff?0:2):k===o.eventsAt?(o.event??1):landed?4:0,o.dt??.01);
  if(landed)break;
 }
 cases.push({name,ticks,reports});
}
flight("standing");flight("bhop",{ground:0});flight("nine ticks is BH",{ground:8});flight("ten ticks is LJ",{ground:9});
for(const invalidAt of [1,37,75])flight(`dirty ${invalidAt}`,{invalidAt});
for(const event of [1,8])flight(`broken ${event}`,{eventsAt:35,event});
for(const style of ["hsw","scroll","legit","lowgrav","autostrafe","wonly","sideways"])flight(style,{style});
flight("missing telemetry",{missing:true});flight("changed height",{height:8});flight("height edge",{height:2});
flight("drop",{drop:true});flight("dirty drop",{drop:true,invalidAt:55});flight("lower platform",{drop:true,landAt:55});
flight("ladder",{ladderAt:25});flight("skipped tick",{skipAt:25});flight("walkoff",{walkoff:true});
flight("pre-speed limit",{preSpeed:300});flight("pre-speed BH",{preSpeed:301});flight("ducked takeoff",{takeoffCrouch:true});flight("negative height edge",{height:-2});
flight("timeout",{dt:.02});flight("too short",{landAt:15});flight("air duck",{duckAt:25});
writeFileSync(process.argv[2],JSON.stringify(cases));
console.log(`Web LJ oracle: ${cases.length} cases, ${cases.reduce((n,c)=>n+c.ticks.length,0)} ticks, ${cases.reduce((n,c)=>n+c.reports,0)} reports`);
