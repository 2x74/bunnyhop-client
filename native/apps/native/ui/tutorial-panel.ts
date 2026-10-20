import { h } from "../../web/src/ui/dom";
import { LESSON_IDS,type LessonId } from "../../web/src/tutorial/data";
import { send,state } from "./bridge";
const LESSONS:Record<LessonId,{title:string;description:string}>={jump:{title:"Jump",description:"Chain jumps and clear the hurdles."},strafe:{title:"Air strafing",description:"Turn with the mouse while holding the matching strafe key."},speed:{title:"Build speed",description:"Link strafes through the speed gates."},final:{title:"Final course",description:"Use your jumps and strafes to finish the course."}};
export function tutorialPanel():HTMLElement {
 const root=h("div.native-tutorial"),progress=h("p.dim"),cards=h("div.native-tutorial-lessons");
 const refresh=()=>{progress.textContent=state.tutorial.active?`Current lesson: ${LESSONS[state.tutorial.lesson].title}`:"Choose a lesson. Native code controls the player, lesson progress and demonstration.";cards.replaceChildren(...LESSON_IDS.map(lesson=>h("article.native-replay-row",null,h("div",null,h("h3",null,`${state.tutorial.completed.includes(lesson)?"✓ ":""}${LESSONS[lesson].title}`),h("p.dim",null,LESSONS[lesson].description)),h("div.native-toolbar",null,h("button.btn",{type:"button",onclick:()=>send({type:"tutorial",action:"start",lesson})},"Start lesson"),h("button.btn",{type:"button",onclick:()=>send({type:"tutorial",action:"demo",lesson})},"Watch demonstration")))));};
 root.append(progress,cards,h("button.btn",{type:"button",onclick:()=>send({type:"tutorial",action:"stop"})},"Leave tutorial"));const update=()=>{if(!root.isConnected){removeEventListener("bunnyhop:host-state",update);return;}const key=JSON.stringify(state.tutorial);if(key!==previous){previous=key;refresh();}};let previous="";addEventListener("bunnyhop:host-state",update);refresh();return root;
}
