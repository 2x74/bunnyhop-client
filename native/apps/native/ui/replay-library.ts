import type {NativeReplay} from './bridge';
export type ReplaySort='newest'|'oldest'|'fastest'|'map';
export function replayLibrary(replays:readonly NativeReplay[],query:string,style:string,sort:ReplaySort):NativeReplay[]{
 const q=query.trim().toLocaleLowerCase();return replays.filter(r=>(!q||`${r.name} ${r.map}`.toLocaleLowerCase().includes(q))&&(!style||r.style===style)).sort((a,b)=>sort==='oldest'?a.recordedAt-b.recordedAt:sort==='fastest'?a.seconds-b.seconds:sort==='map'?a.map.localeCompare(b.map)||b.recordedAt-a.recordedAt:b.recordedAt-a.recordedAt);
}
