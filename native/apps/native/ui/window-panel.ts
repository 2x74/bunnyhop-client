import {h} from "../../web/src/ui/dom";
import {state,send,WINDOW_MODES,type NativeSettings,type WindowMode} from "./bridge";
const labels:Record<WindowMode,string>={windowed:"Windowed",borderless:"Borderless fullscreen",fullscreen:"Fullscreen (display mode)"};
export function windowPanel(save:(patch:Partial<NativeSettings>)=>void):HTMLElement {
 const root=h("div.nset-group.native-window-panel"),rows=h("div.nset-group-rows");
 const row=(title:string,control:HTMLElement,hint:string)=>h("div.nset-row",{"data-search":`${title} ${hint}`.toLowerCase()},h("span.nset-name",null,title,h("small.nset-hint",null,hint)),control);
 const mode=h("select",{"aria-label":"Window mode"},...WINDOW_MODES.map(id=>h("option",{value:id},labels[id]))) as HTMLSelectElement;
 mode.onchange=()=>save({windowMode:mode.value as WindowMode});
 rows.append(row("Window mode",mode,"Alt+Enter switches between windowed and borderless fullscreen. Fullscreen uses the display's desktop mode."));
 const toggles=new Map<"alwaysOnTop"|"rememberWindowBounds"|"minimizeOnFocusLoss",HTMLInputElement>();
 for(const [key,label,hint] of [["alwaysOnTop","Always on top","Keep this game above other windows when the window manager supports it."],["rememberWindowBounds","Remember window size and position","Restore logical window size, position and maximized state next launch. Off-screen saved windows are moved onto a connected display."],["minimizeOnFocusLoss","Minimize fullscreen when switching apps","Fullscreen only. Off keeps the game visible while you use another app."]] as const){const input=h("input.switch",{type:"checkbox","aria-label":label,checked:state.settings[key]}) as HTMLInputElement;input.onchange=()=>save({[key]:input.checked});toggles.set(key,input);rows.append(row(label,input,hint));}
 const center=h("button.btn",{type:"button",onclick:()=>send({type:"window",action:"center"})},"Center window") as HTMLButtonElement;
 const maximize=h("button.btn",{type:"button",onclick:()=>send({type:"window",action:"maximize"})},"Maximize / restore") as HTMLButtonElement;
 const minimize=h("button.btn",{type:"button",onclick:()=>send({type:"window",action:"minimize"})},"Minimize") as HTMLButtonElement;
 rows.append(row("Window controls",h("div.native-toolbar",null,center,maximize,minimize),"Center and maximize are available in windowed mode."));
 rows.append(row("Desktop shortcuts",h("div",null,h("kbd",null,"F10")," Settings · ",h("kbd",null,"Alt+Enter")," Fullscreen"),"Check and download signed releases under Updates. Installation remains manual."));
 root.append(h("h3.nset-group-title",null,"Game window"),rows);
 const refresh=()=>{mode.value=state.settings.windowMode;for(const [key,input]of toggles)input.checked=state.settings[key];center.disabled=maximize.disabled=state.settings.windowMode!=="windowed";};
 const host=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",host);return;}refresh();};window.addEventListener("bunnyhop:host-state",host);refresh();return root;
}
