// Actual web gesture layer on running, crouching, airborne and looking poses.
import {writeFile} from 'node:fs/promises';
import {rig,concat} from '../../web/src/player/bunny/rig';
import {BunnyProcedural} from '../../web/src/player/bunny/procedural';
import {TpInspect,type TpBones} from '../../web/src/viewmodel/inspects/third';
import {inspectSetFor} from '../../web/src/viewmodel/inspects/index';
import {KNIVES} from '../../web/src/viewmodel/knives/index';
import {TP_CARROT} from '../../web/src/viewmodel/knives/ctx';
// The authored bayonet hold uses performance.now() for idle wrist sway. Freeze it while
// baking / comparing knife-local tracks so wall-clock timing cannot change the asset.
Object.defineProperty(performance,"now",{value:()=>0,configurable:true});
Math.random=()=>0;
const r=rig(),W=new Float32Array(r.names.length*12),tmp=new Float32Array(12),out:any[]=[];
for(const knife of KNIVES){const tp=new TpInspect(knife.id==='carrot'?null:knife),proc=new BunnyProcedural(),key={};const bones:TpBones={index:n=>r.names.indexOf(n),parent:r.parent,count:r.names.length,posed:(i,m)=>concat(W,i*12,r.bind,i*12,m,0),pre:(i,m)=>{concat(m,0,W,i*12,tmp,0);W.set(tmp,i*12);}};
 const frames:any[]=[];for(let f=0;f<240;f++){const dt=1/60,vel=[250,80,Math.sin(f*.1)*200],state={position:[0,0,0],velocity:vel,yaw:f*3,pitch:Math.sin(f*.03)*60,crouched:f%80>55,grounded:f%100<60};proc.update(dt,state,vel,f===0,false,W);const base=Array.from(W);const signal=f===0||f===180?1:f===42||f===68?2:0,attack=f===150,reset=f===175,held=f>80&&f<140;
 if(reset)tp.reset();if(attack)tp.cancel('attack');tp.signal(signal);tp.setHeld(held);tp.update(dt);tp.apply(bones,key,'bunny.Knife',knife.tp??TP_CARROT);frames.push({dt,signal,attack,reset,held,base,expected:Array.from(W)});}
 for(let clip=0;clip<inspectSetFor(knife).clips.length;clip++)for(const t of [0,.13,.43,.91,1.31,1.73,2.2]){tp.combo.seek(clip,t);tp.update(0);proc.update(.016,{position:[0,0,0],velocity:[170,0,0],yaw:80,pitch:-35,crouched:true,grounded:true},[170,0,0],false,false,W);const base=Array.from(W);tp.apply(bones,key,'bunny.Knife',knife.tp??TP_CARROT);frames.push({seek:{clip,t:Math.min(t,inspectSetFor(knife).clips[clip].len-1e-6)},dt:0,base,expected:Array.from(W)});}
 out.push({knife:knife.id,frames});}
await writeFile(process.argv[2]??'/tmp/native-tp-oracle.json',JSON.stringify({names:r.names,parent:Array.from(r.parent),bind:Array.from(r.bind),cases:out}));
console.log(`${out.reduce((n,c)=>n+c.frames.length,0)} third-person web oracle frames`);
