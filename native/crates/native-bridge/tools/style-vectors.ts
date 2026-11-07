import {StyleFilter,styleDef,STYLE_DEFS} from "../../../apps/web/src/styles";
import { IN_NO_LANDFIX, PHYSICS_VERSION } from "../../../apps/web/src/core";
let seed=0x71f1d2a3;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
// Velocity has its own generator so the command rows stay as they were before Backwards read it. Speeds run from
// 0 to about 700 u/s, so some rows fall under Backwards' 35 u/s floor.
let velocitySeed = 0x2b7e1516;
const velocityAxis = () => {
  velocitySeed = (Math.imul(velocitySeed, 1664525) + 1013904223) >>> 0;
  return Math.fround(((velocitySeed % 100001) - 50000) / 100);
};
const cases=[];for(const style of STYLE_DEFS)for(const physics of Array.from({length:PHYSICS_VERSION},(_,i)=>i+1)){
 const filter=new StyleFilter(styleDef(style.id),physics),rows=[];
 for(let i=0;i<320;i++){const axis=[-450,-300,-100,0,100,300,450];const cmd={forward:axis[rnd()%axis.length],side:axis[rnd()%axis.length],yaw:Math.fround((rnd()%100000-50000)/31),pitch:Math.fround((rnd()%1000-500)/10),buttons:rnd()&0x1fffff};
 if(i%3===1)cmd.buttons|=IN_NO_LANDFIX;
 const velocity=[velocityAxis(),velocityAxis(),velocityAxis()];
 // running toggles off for a stretch now and then, so A/D-Only's lock is both set and cleared.
 const running=i%29>=4;
 const state={grounded:i%17<5,onLadder:i%41>=35,edgeLanding:i%17<2,velocity};rows.push({cmd,state,running,expected:filter.apply(cmd,state,running)});}
 cases.push({style:style.id,physics,rows});
}console.log(JSON.stringify(cases));
