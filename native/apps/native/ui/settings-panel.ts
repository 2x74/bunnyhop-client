import { h } from "../../web/src/ui/dom";
import { ACTIONS, keyLabel } from "../../web/src/ui/settings";
import { mouseCode } from "../../web/src/binds";
import { AUDIO_PACKS, NATIVE_BIND_ACTIONS, send, settingsPatch, state, nativeKeyCode, type AudioPack, type NativeSettings } from "./bridge";

export function settingsPanel():HTMLElement {
  const root=h("div.native-settings-body"),result=h("p.dim",{role:"status"});
  const controls=new Map<keyof NativeSettings,HTMLInputElement|HTMLSelectElement>();
  function save(patch:Partial<NativeSettings>):void {const valid=settingsPatch(patch);if(Object.keys(valid).length){send({type:"settings",patch:valid});result.textContent="Settings sent to the native client.";}}
  function number(label:string,key:keyof NativeSettings,min:number,max:number,step:number):void {
    const input=h("input",{type:"number",min,max,step,value:Number(state.settings[key]),"aria-label":label});if(key==="sensitivity")input.className="native-sensitivity";controls.set(key,input);
    input.addEventListener("change",()=>{const value=input.valueAsNumber;if(!Number.isFinite(value)||value<min||value>max||(key==="fpsLimit"&&value!==0&&value<30)){result.textContent="Choose a value in the shown range.";return;}save({[key]:value});});
    root.append(h("label.set-row",null,h("span.set-name",null,label),input));
  }
  function toggle(label:string,key:keyof NativeSettings):void {
    const input=h("input",{type:"checkbox",checked:!!state.settings[key],"aria-label":label});controls.set(key,input);
    input.addEventListener("change",()=>save({[key]:input.checked}));root.append(h("label.set-row",null,h("span.set-name",null,label),input));
  }
  // The bunnyhop.lol pack or the player's own folder. |note| says where the
  // folder is, since nothing else in the client ever names it.
  function pack(label:string,key:"sfxPack"|"musicPack",defaultLabel:string,note:string):void {
    const select=h("select",{"aria-label":label});
    const text:Record<AudioPack,string>={default:defaultLabel,custom:"Custom"};
    for(const value of AUDIO_PACKS) select.append(h("option",{value},text[value]));
    select.value=String(state.settings[key]);controls.set(key,select);
    select.addEventListener("change",()=>save({[key]:select.value as AudioPack}));
    root.append(h("label.set-row",null,h("span.set-name",null,label),select),h("p.dim",null,note));
  }
  root.append(h("h3",null,"Mouse"));number("Mouse sensitivity","sensitivity",.01,100,.01);toggle("Separate vertical sensitivity","separateVertical");number("Vertical sensitivity","verticalSensitivity",.01,100,.01);
  root.append(h("h3",null,"Display"));number("Field of view","fov",60,130,1);toggle("Vertical sync","vsync");number("FPS limit (0 is unlimited)","fpsLimit",0,1000,1);toggle("HUD","hud");toggle("Crosshair","crosshair");toggle("Viewmodel","viewmodel");toggle("Jump stats","jumpStats");
  root.append(h("h3",null,"Audio"));number("Volume","volume",0,1,.01);toggle("Mute","muted");
  pack("Sound effects","sfxPack","bunnyhop.lol SFX",
    "Custom sounds come from the sound folder in your Bunnyhop Native data directory. Name a file after the cue it replaces, such as jump.wav — any of WAV, MP3, FLAC or Ogg, whatever the extension says. Cues you have not supplied keep the bunnyhop.lol sound.");
  pack("Music","musicPack","bunnyhop.lol OST",
    "Custom music comes from the bgm folder beside it, played in filename order.");
  root.append(result,h("h3",null,"Key bindings"),h("p.dim",null,"Select a binding, then press a key, mouse button or wheel direction. Escape cancels. Escape and F10 stay reserved."));
  const binds=h("div.native-bindings");root.append(binds);let capturing:string|null=null;let appendBinding=false;const buttons=new Map<string,HTMLButtonElement>();
  for(const action of NATIVE_BIND_ACTIONS) {
    const label=ACTIONS.find(item=>item.id===action)?.label??action;
    const button=h("button.btn",{type:"button","aria-label":`${label} binding`,onclick:()=>{capturing=action;appendBinding=false;button.textContent="Press a key…";}});
    const add=h("button.link-btn",{type:"button",onclick:()=>{capturing=action;appendBinding=true;button.textContent="Press an additional key…";}},"Add");
    const clear=h("button.link-btn",{type:"button",onclick:()=>save({binds:{[action]:[]}})},"Clear");
    buttons.set(action,button);binds.append(h("div.set-row",null,h("span.set-name",null,label),h("div.native-bind-buttons",null,button,add,clear)));
  }
  let previous:Partial<NativeSettings>={};
  const refresh=()=>{
    for(const [key,input] of controls) if(document.activeElement!==input&&previous[key]!==state.settings[key]) {if(input instanceof HTMLInputElement&&input.type==="checkbox")input.checked=!!state.settings[key];else input.value=String(state.settings[key]);}
    previous={...state.settings};
    const vertical=controls.get("verticalSensitivity");if(vertical)vertical.disabled=!state.settings.separateVertical;
    for(const [action,button] of buttons)if(capturing!==action)button.textContent=(state.settings.binds[action]??[]).map(keyLabel).join(" / ")||"Unbound";
  };
  const capture=(event:Event)=>{
    if(!capturing)return;let code:string|null=null;
    if(event instanceof KeyboardEvent) {if(event.type!=="keydown")return;if(event.code==="Escape"){capturing=null;refresh();event.preventDefault();event.stopImmediatePropagation();return;}code=event.code;}
    else if(event instanceof WheelEvent) code=event.deltaY<0?"MWheelUp":"MWheelDown";
    else if(event instanceof MouseEvent) {if(event.type!=="mousedown")return;code=mouseCode(event.button);}
    if(!nativeKeyCode(code)){result.textContent="That key is reserved or not supported by the native client.";return;}
    event.preventDefault();event.stopImmediatePropagation();const action=capturing;capturing=null;
    const patch:Record<string,string[]>={};for(const [other,codes] of Object.entries(state.settings.binds))if(other!==action&&codes.includes(code))patch[other]=codes.filter(value=>value!==code);
    const codes=appendBinding?[...new Set([...(state.settings.binds[action]??[]),code])]:[code];if(codes.length>4){result.textContent="Each action supports up to four bindings.";refresh();return;}
    patch[action]=codes;save({binds:patch});buttons.get(action)!.textContent=keyLabel(code);
  };
  for(const name of ["keydown","mousedown","wheel"])root.addEventListener(name,capture,{capture:true,passive:false});
  const onState=()=>{if(!root.isConnected){window.removeEventListener("bunnyhop:host-state",onState);return;}refresh();};window.addEventListener("bunnyhop:host-state",onState);refresh();return root;
}
