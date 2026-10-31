import {StyleFilter,styleDef,STYLE_DEFS} from "../../../apps/web/src/styles";
import { PHYSICS_VERSION } from "../../../apps/web/src/core";
let seed=0x71f1d2a3;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
const cases=[];for(const style of STYLE_DEFS)for(const physics of Array.from({length:PHYSICS_VERSION},(_,i)=>i+1)){
 const filter=new StyleFilter(styleDef(style.id),physics),rows=[];
 for(let i=0;i<320;i++){const axis=[-450,-300,-100,0,100,300,450];const cmd={forward:axis[rnd()%axis.length],side:axis[rnd()%axis.length],yaw:Math.fround((rnd()%100000-50000)/31),pitch:Math.fround((rnd()%1000-500)/10),buttons:rnd()&0x1fffff};
 const state={grounded:i%17<5,onLadder:i%41>=35,edgeLanding:i%17<2};rows.push({cmd,state,expected:filter.apply(cmd,state)});}
 cases.push({style:style.id,physics,rows});
}console.log(JSON.stringify(cases));
