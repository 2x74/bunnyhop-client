/** Source -1 RGB HDR sentinel means use the LDR light key; never feed negative authored radiance into shaders. */
export function sourceLightColor(hdr:string|undefined,ldr:string|undefined,fallback:string):number[]{
 const parse=(value:string|undefined)=>value?.trim().split(/\s+/).map(Number);
 const valid=(values:number[]|undefined)=>!!values&&values.length>=3&&values.slice(0,3).every(value=>Number.isFinite(value)&&value>=0);
 const high=parse(hdr),low=parse(ldr);return valid(high)?high!:valid(low)?low!:parse(fallback)!;
}
