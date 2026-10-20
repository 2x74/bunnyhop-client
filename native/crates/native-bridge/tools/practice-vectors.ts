import {noclipMove} from "../../../apps/web/src/practice-mode/noclip";
let seed=0x45455131;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
const cases=[];
for(const dt of [Math.fround(.01),1/64,1/30]){
 const state={position:[16300,-16300,50] as [number,number,number],velocity:[-30,200,0] as [number,number,number]},initial=structuredClone(state),rows=[];
 for(let i=0;i<600;i++){
  const f=i%71<30?450:i%71<45?-450:0,side=i%63<20?450:i%63<40?-450:0;
  const yaw=Math.fround((rnd()%7200-3600)/10),pitch=Math.fround((rnd()%1780-890)/10),buttons=(i%37<4?2:0)|(i%53<17?4:0);
  const cmd={forward:f,side,yaw,pitch,buttons};
  noclipMove(state,{forwardmove:f,sidemove:side,yaw,pitch,up:!!(buttons&2),slow:!!(buttons&4)},dt);
  rows.push({cmd,expected:structuredClone(state)});
 }
 cases.push({dt,initial,rows});
}
console.log(JSON.stringify(cases));
