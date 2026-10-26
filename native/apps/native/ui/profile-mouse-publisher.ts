import type {RequestDispatch} from "../../web/src/api";
import type {MouseSettings} from "../../web/src/mouse-settings";
export interface MousePublisherDeps {
 owner():string|null;epoch():number;readUser():Promise<{id:string}|null>;save(mouse:MouseSettings,dispatch:RequestDispatch):Promise<unknown>;
 schedule(run:()=>void):unknown;cancel(timer:unknown):void;
}
/** An edit belongs to the identity and account generation at edit time. */
export class ProfileMousePublisher {
 private timer:unknown=null;private revision=0;
 constructor(private deps:MousePublisherDeps){}
 invalidate():void {this.revision++;if(this.timer!==null)this.deps.cancel(this.timer);this.timer=null;}
 edit(mouse:MouseSettings):void {
  this.invalidate();const revision=this.revision,owner=this.deps.owner(),epoch=this.deps.epoch();if(!owner)return;
  const valid=()=>revision===this.revision&&owner===this.deps.owner()&&epoch===this.deps.epoch();
  this.timer=this.deps.schedule(()=>{this.timer=null;if(!valid())return;void this.deps.readUser().then(user=>{if(user?.id===owner&&valid())return this.deps.save({...mouse},Object.assign(async (send:()=>Promise<Response>)=>{if(!valid())throw Error("Account changed");const response=await send();if(!valid())throw Error("Account changed");return response;},{current:valid}));}).catch(()=>{});});
 }
}
