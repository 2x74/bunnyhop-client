// Menu-only unlock emblems. Use the web's own vector badge/CSS swatch fallback;
// native gameplay owns 3D and this module never creates a WebGL context.
import type {PreviewItem} from "../../web/src/notify/item-preview";
import {badgeToken} from "../../web/src/ui/badges";
import {loadoutSwatch} from "../../web/src/ui/loadout-ui";
import {h} from "../../web/src/ui/dom";
export interface LiveEmblem {readonly el:HTMLElement;show():void}
export function liveEmblem(item:PreviewItem,_runGoing=false):LiveEmblem|null {
 const cosmetic="cosmetic" in item?item.cosmetic:null;const el="achievement" in item?badgeToken(item.achievement,{size:"lg"}):cosmetic&&["knife","finish","glove"].includes(cosmetic.slot)?loadoutSwatch(cosmetic,cosmetic.slot as "knife"|"finish"|"glove"):cosmetic?h("span.native-item-emblem",{role:"img","aria-label":cosmetic.name,style:`color:${cosmetic.color??"currentColor"}`},cosmetic.name):null;
 return el?{el,show:()=>el.classList.add("shown")}:null;
}
