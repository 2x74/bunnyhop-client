/** Lightweight status text; does not import, construct, or traverse traced-GI resources. */
export interface HybridStatus { status:string; reason:string; loaded:boolean }
let current:HybridStatus={status:"off",reason:"Off; tracing resources are not loaded.",loaded:false};
const nodes=new Set<HTMLElement>();
export function publishHybridStatus(status:HybridStatus):void{
 if(current.status===status.status&&current.reason===status.reason&&current.loaded===status.loaded)return;
 current={...status};for(const node of nodes){if(!node.isConnected){nodes.delete(node);continue}node.textContent=`Traced lighting: ${current.reason}`;}
}
export function hybridStatusNode():HTMLElement{const node=document.createElement("p");node.className="setting-note";node.textContent=`Traced lighting: ${current.reason}`;nodes.add(node);return node;}
