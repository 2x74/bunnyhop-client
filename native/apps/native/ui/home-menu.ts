import { h } from "../../web/src/ui/dom";

type Destination = "maps"|"servers"|"room"|"tutorial"|"loadout"|"ranks"|"stats"|"replays"|"settings"|"credits";
interface HomeActions {
  map:string|null;room:boolean;navigate:(screen:Destination)=>void;
  resume:()=>void;restart:()=>void;quit:()=>void;
}
function action(label:string, run:()=>void, primary=false, description=""):HTMLButtonElement {
  return h(`button.menu-btn.home-item${primary?".primary":""}`,{type:"button","aria-label":label,onclick:run},
    h("span.mb-label",null,h("span.mb-title",null,label),description?h("small",null,description):null),
    h("span.native-action-arrow",{"aria-hidden":"true"},primary?"↗":"→"));
}
export function homeActions(options:HomeActions):HTMLElement {
  const {map,room,navigate,resume,restart,quit}=options;
  const nav=h("nav.home-menu.native-home-actions",{"aria-label":"Main menu"});
  nav.append(action(map?"Resume":"Play",map?resume:()=>navigate("maps"),true,map||"Choose your next course"));
  const play=h("div.native-action-group.native-play-actions",{"role":"group","aria-label":"Play options"});
  if(map)play.append(action("Play",()=>navigate("maps")),action("Restart",restart));
  play.append(action(room?"Current room":"Play online",()=>navigate(room?"room":"servers")),action("Tutorial",()=>navigate("tutorial")));
  const explore=h("div.native-action-group",{"role":"group","aria-label":"Your game"},
    h("p.native-group-label",null,"Your game"));
  for(const [label,destination] of [["Loadout","loadout"],["Ranks","ranks"],["Statistics","stats"],["Replays","replays"]] as const)
    explore.append(action(label,()=>navigate(destination)));
  const utility=h("div.native-action-group.native-utility-actions",{"role":"group","aria-label":"Preferences and app"},
    action("Settings",()=>navigate("settings")),action("Credits",()=>navigate("credits")),action("Quit",quit));
  nav.append(play,explore,utility);
  return nav;
}
/** Flat course plan for standalone browser/GTK menus. Native-capable hosts hide it
 * only after a scene has been successfully created. No canvas or web renderer. */
export function courseIllustration():HTMLElement {
  const art=h("div.native-course-plan",{"aria-hidden":"true"});
  art.innerHTML=`<svg viewBox="0 0 540 350" fill="none"><defs><pattern id="course-grid" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="currentColor" opacity=".13"/></pattern></defs><rect width="540" height="350" fill="url(#course-grid)"/><path d="M55 285C165 285 95 205 205 205S245 125 345 125S405 55 475 55" stroke="currentColor" stroke-width="2" stroke-dasharray="4 7" opacity=".4"/><g fill="#282620" stroke="currentColor" stroke-opacity=".5"><rect x="25" y="257" width="60" height="56" rx="8"/><rect x="175" y="177" width="60" height="56" rx="8"/><rect x="315" y="97" width="60" height="56" rx="8"/><rect x="445" y="27" width="60" height="56" rx="8"/></g><g fill="currentColor" font-size="13" font-family="system-ui" text-anchor="middle"><text x="55" y="290">01</text><text x="205" y="210">02</text><text x="345" y="130">03</text><path d="m465 56 7 7 13-16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g></svg>`;
  return art;
}
/** This small presentation message is separate from persisted gameplay settings. */
export function watchMenuMotion():void {
  const preference=matchMedia("(prefers-reduced-motion: reduce)");
  const notify=()=>{
    const message={type:"menuAppearance",reducedMotion:preference.matches};
    window.webkit?.messageHandlers?.bunnyhop?.postMessage(JSON.stringify(message));
    window.dispatchEvent(new CustomEvent("bunnyhop:native-message",{detail:message}));
  };
  preference.addEventListener("change",notify);notify();
}


declare global { interface Window { bunnyhopNativeBackdrop?:(source:string)=>void } }
/** The host supplies either its live surface capability or a bounded native PNG. */
export function installMenuBackdrop():void {
  window.bunnyhopNativeBackdrop=(source:string)=>{
    if(source==="native") { document.documentElement.dataset.nativeBackdrop="scene";return; }
    if(source.length>2_000_000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source))return;
    const image=new Image();
    image.onload=()=>{
      document.documentElement.style.setProperty("--native-scene-image",`url("${source}")`);
      document.documentElement.dataset.nativeBackdrop="static";
    };
    image.src=source;
  };
}
