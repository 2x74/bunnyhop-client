import {h} from "../../web/src/ui/dom";
import {HUD_ELEMENTS,defaultPosition,type HudLayout,type HudPosition} from "./hud-layout";
export function dragPosition(start:HudPosition,dx:number,dy:number,width:number,height:number):HudPosition {
 const clamp=(n:number)=>Math.round(Math.min(100,Math.max(0,n))*10)/10;
 return {...start,x:clamp(start.x+dx/Math.max(1,width)*100),y:clamp(start.y+dy/Math.max(1,height)*100)};
}
/** A screen-proportional placement canvas using the native HUD's percent anchors. */
export function hudEditor(read:()=>HudLayout,save:(layout:HudLayout)=>void):HTMLElement {
 const canvas=h("div",{"aria-label":"HUD placement canvas"});
 Object.assign(canvas.style,{position:"relative",width:"100%",aspectRatio:`${window.innerWidth} / ${window.innerHeight}`,border:"1px solid currentColor",overflow:"hidden",touchAction:"none"});
 const root=h("div",null,h("p.nset-hint",null,"Drag HUD labels to place them. Arrow keys move the selected element; Shift makes fine adjustments. Faded labels are hidden in game."),canvas);
 let dragging=false;
 let endDrag:(()=>void)|null=null;
 const place=(button:HTMLButtonElement,at:HudPosition)=>{button.style.left=`${at.x}%`;button.style.top=`${at.y}%`;const x=canvas.clientWidth*at.x/100,y=canvas.clientHeight*at.y/100;const dx=Math.max(-x,Math.min(-button.offsetWidth/2,canvas.clientWidth-x-button.offsetWidth)),dy=Math.max(-y,Math.min(-button.offsetHeight/2,canvas.clientHeight-y-button.offsetHeight));button.style.transform=`translate(${dx}px, ${dy}px)`;};
 const paint=()=>{if(dragging)return;for(const button of canvas.querySelectorAll<HTMLButtonElement>("button")){const id=button.dataset.id as typeof HUD_ELEMENTS[number]["id"];const at=read()[id]??defaultPosition(id);place(button,at);button.style.opacity=at.visible===false?".45":"1";}};
 for(const item of HUD_ELEMENTS){const button=h("button.btn",{type:"button","data-id":item.id,"aria-label":`Move ${item.label}`,title:"Drag to move; arrow keys move 1%, Shift moves 0.1%"},item.label);
 Object.assign(button.style,{position:"absolute",transform:"translate(-50%, -50%)",fontSize:"11px",padding:"3px",touchAction:"none"});
 button.addEventListener("focus",()=>{button.style.zIndex="2";});button.addEventListener("blur",()=>{button.style.zIndex="";});
 button.addEventListener("pointerdown",event=>{if(event.button!==0)return;event.preventDefault();endDrag?.();button.focus();const start=read()[item.id]??defaultPosition(item.id),rect=canvas.getBoundingClientRect(),x=event.clientX,y=event.clientY;button.setPointerCapture(event.pointerId);dragging=true;
 const move=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;const at=dragPosition(start,e.clientX-x,e.clientY-y,rect.width,rect.height);place(button,at);save({...read(),[item.id]:at});};
 const end=(e?:PointerEvent)=>{if(e&&e.pointerId!==event.pointerId)return;dragging=false;endDrag=null;button.removeEventListener("pointermove",move);button.removeEventListener("pointerup",end);button.removeEventListener("pointercancel",end);button.removeEventListener("lostpointercapture",end);if(button.hasPointerCapture(event.pointerId))button.releasePointerCapture(event.pointerId);paint();};endDrag=end;button.addEventListener("pointermove",move);button.addEventListener("pointerup",end);button.addEventListener("pointercancel",end);button.addEventListener("lostpointercapture",end);
 });
 button.addEventListener("keydown",event=>{const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const d=delta[event.key];if(!d)return;event.preventDefault();const step=event.shiftKey?.1:1;save({...read(),[item.id]:dragPosition(read()[item.id]??defaultPosition(item.id),d[0]*step,d[1]*step,100,100)});paint();});canvas.append(button);}
 const dispose=()=>{endDrag?.();window.removeEventListener("bunnyhop:host-state",sync);window.removeEventListener("resize",sync);observer.disconnect();resizing.disconnect();};
 const fit=()=>{if(!canvas.isConnected)return;const scroll=canvas.closest<HTMLElement>(".nset-scroll"),section=canvas.closest<HTMLElement>(".nset-sec");if(!scroll||!section||!root.clientWidth)return;const ratio=window.innerWidth/window.innerHeight;const overhead=canvas.getBoundingClientRect().top-section.getBoundingClientRect().top;const height=Math.max(80,scroll.clientHeight-overhead-36);canvas.style.width=`${Math.min(root.clientWidth,height*ratio)}px`;canvas.style.aspectRatio=String(ratio);paint();};
 const resizing=new ResizeObserver(fit);resizing.observe(root);queueMicrotask(()=>{const scroll=canvas.closest(".nset-scroll");if(scroll)resizing.observe(scroll);fit();});
 const observer=new MutationObserver(()=>{if(!canvas.isConnected)dispose();});observer.observe(document.body,{childList:true,subtree:true});
 const sync=()=>{if(!canvas.isConnected){dispose();return;}fit();paint();};window.addEventListener("bunnyhop:host-state",sync);window.addEventListener("resize",sync);paint();
 return root;
}
