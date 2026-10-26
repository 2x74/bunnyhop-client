// Read-only provisional finish comparison; stale map/attempt responses never reach the host.
export interface WorldRecordContext {map:string;style:string;track:number;generation:number}
export class NativeWorldRecord {
  private key="";private revision=0;
  constructor(private read:(map:string,style:string,track:number)=>Promise<{time:number}|null>,private send:(context:WorldRecordContext,seconds:number|null)=>void){}
  update(context:WorldRecordContext|null):void {
    const key=context?JSON.stringify(context):"";if(key===this.key)return;this.key=key;const revision=++this.revision;
    if(!context)return;this.send(context,null);
    void this.read(context.map,context.style,context.track).then(top=>{if(revision!==this.revision)return;const time=top?.time;this.send(context,typeof time==="number"&&Number.isFinite(time)&&time>0?time:null);}).catch(()=>{});
  }
}
