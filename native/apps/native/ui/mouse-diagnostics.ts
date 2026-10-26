import {h} from '../../web/src/ui/dom';
type Sample={active:boolean;seconds:number;eventsPerSecond:number;events:number;peakBurst:number;averageAgeMs:number;maxAgeMs:number;maxPumpMs:number;relative:boolean;systemScaling:boolean;sdl:string};
let latest:Sample|null=null;
const listeners=new Set<()=>void>();
if(typeof window!=='undefined')window.addEventListener('bunnyhop:mouse-diagnostics',event=>{
 const v=(event as CustomEvent).detail;if(!v||typeof v!=='object')return;
 for(const k of ['seconds','eventsPerSecond','events','peakBurst','averageAgeMs','maxAgeMs','maxPumpMs'])if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<0)return;
 latest={...v,active:v.active===true,relative:v.relative===true,systemScaling:v.systemScaling===true,sdl:typeof v.sdl==='string'?v.sdl.slice(0,40):''};
 for(const update of listeners)update();
});
export function mouseDiagnosticsPanel():HTMLElement{
 const value=h('p',{role:'status'}),root=h('section.native-mouse-diagnostics',{'aria-label':'Mouse input diagnostics'},h('h3',null,'Mouse input diagnostics'),value,h('p.dim',null,'Enable the overlay, resume play and move the mouse continuously. This measures motion delivered to the client across all mice, not the configured USB polling rate. Event age uses SDL timestamps; it is not click-to-photon latency.'));
 const paint=()=>{const s=latest;value.textContent=!s||!s.seconds?'No captured sample yet.':`${s.active?'Current':'Last captured'} sample: ${Math.round(s.eventsPerSecond).toLocaleString()} motion events/s · ${s.peakBurst} peak events/frame · ${s.averageAgeMs.toFixed(2)} ms mean / ${s.maxAgeMs.toFixed(2)} ms max event age · ${s.maxPumpMs.toFixed(2)} ms max event processing · SDL ${s.sdl}${s.systemScaling?' · OS mouse scaling enabled':''}`;};
 // The parent settings panel owns replacement; drop disconnected subscribers.
 const update=()=>{if(!root.isConnected){listeners.delete(update);return;}paint();};listeners.add(update);paint();return root;
}
