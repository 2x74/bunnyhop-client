export type AnnouncerLine="off"|"perfect"|"godlike"|"holyshit";
export type AnnouncerEvent="pb"|"wr"|"speed"|"highSpeed"|"streak"|"lj";
export interface AnnouncerPrefs {
 enabled:boolean;finish:boolean;movement:boolean;local:boolean;server:boolean;volume:number;
 pb:AnnouncerLine;wr:AnnouncerLine;speed:AnnouncerLine;highSpeed:AnnouncerLine;streak:AnnouncerLine;lj:AnnouncerLine;
 speedThreshold:number;highSpeedThreshold:number;streakThreshold:number;ljThreshold:number;
}
export const DEFAULT_ANNOUNCER:AnnouncerPrefs={enabled:false,finish:true,movement:true,local:true,server:true,volume:.8,pb:"perfect",wr:"godlike",speed:"godlike",highSpeed:"holyshit",streak:"perfect",lj:"perfect",speedThreshold:1500,highSpeedThreshold:2500,streakThreshold:3,ljThreshold:250};
export function announcerPatch(value:unknown,current:AnnouncerPrefs):AnnouncerPrefs|null {
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const p=value as Record<string,unknown>,out={...current};
 for(const [key,v] of Object.entries(p)){
  if(!Object.hasOwn(DEFAULT_ANNOUNCER,key))return null;
  if(["enabled","finish","movement","local","server"].includes(key)){if(typeof v!=="boolean")return null;}
  else if(["pb","wr","speed","highSpeed","streak","lj"].includes(key)){if(typeof v!=="string"||!["off","perfect","godlike","holyshit"].includes(v))return null;}
  else {const lo=key==="volume"?0:key==="streakThreshold"?2:key==="ljThreshold"?200:300,hi=key==="volume"?1:key==="streakThreshold"?100:key==="ljThreshold"?1000:10000;if(typeof v!=="number"||!Number.isFinite(v)||v<lo||v>hi||(key!=="volume"&&!Number.isInteger(v)))return null;}
  Object.assign(out,{[key]:v});
 }return out;
}
