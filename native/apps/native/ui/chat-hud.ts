// The shared social state writes here while the WebView is hidden. The sink is
// installed by native chat; no DOM game HUD or renderer enters this bundle.
let sink:((text:string)=>void)|null=null;
export function setNativeChatSink(next:(text:string)=>void):void {sink=next;}
export function postLocalLine(text:string,_rich?:unknown[]):boolean {if(!sink)return false;sink(text);return true;}
