import {nativeProfileFixture} from "./profile-fixture";
import {test,expect} from "bun:test";
import {chromium,type Page} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";

// The v27 features the native menu adds on top of the web port: practice in the pause menu, native Gauntlets, Report a
// player, HUD scale / practice settings, the soundtrack's now-playing control. Offline: every API answer is a fixture
// here; anything else is aborted, so nothing reaches bunnyhop.lol (no guest, no attempt, no report).
const out=resolve(import.meta.dir,"../../../target/native-menu/web-port");
const ID="AbCdEfGhIjKlMnOp";
const INDEX={maps:["bhop_eazy","bhop_a","bhop_b","bhop_1","bhop_13","bhop_2_easy"].map(name=>({name,title:name,tier:1,size:1<<20}))};
type Msg={type:string;[key:string]:unknown};
const messages=(page:Page)=>page.evaluate(()=>(window as any).messages as Msg[]);
const sent=async(page:Page,from:number)=>(await messages(page)).slice(from).filter(m=>!["cosmetics","menuAppearance","menuBackdrop","audioCue"].includes(m.type));
const count=async(page:Page)=>(await messages(page)).length;
const player=(id:string,name:string)=>({id,name,avatar:null,country:null});
const ATTEMPT={id:ID,gauntlet:{slug:"weekly-test",title:"Weekly test",maxMs:5*3600_000},state:"open",step:0,startedAt:Date.now(),lastPingAt:Date.now(),expiresAt:null,finishedAt:null,realMs:null,totalTicks:null,
  maps:[{idx:0,map:"bhop_a",track:0},{idx:1,map:"bhop_b",track:0}],next:{idx:0,map:"bhop_a"},splits:[]};
const DETAIL={slug:"weekly-test",title:"Weekly test",official:true,style:"autohop",startsAt:null,endsAt:Date.now()+86_400_000*3,publishedAt:Date.now()-1000,maxMs:5*3600_000,kind:"weekly",week:null,
  maps:[{idx:0,map:"bhop_a",title:"A",tier:1,track:0},{idx:1,map:"bhop_b",title:"B",tier:2,track:0}],finishers:0,wr:null,me:null};

/** GET-only fixtures by API path; writes are answered only where a test says so. */
function api(url:URL,method:string,writes:Record<string,unknown>={}):unknown {
  const path=url.pathname.replace(/^\/api/,"");
  if(method!=="GET") return writes[`${method} ${path}`]??null;
  if(path==="/me") return {id:"me1",name:"Tester",guest:false};
  if(path==="/gauntlets") return {weekly:{...DETAIL,maps:2,finishers:0,mapList:DETAIL.maps,top:[]},gauntlets:[],past:[]};
  if(path==="/gauntlets/weekly-test") return DETAIL;
  if(path==="/gauntlets/weekly-test/board") return {slug:"weekly-test",total:0,offset:0,entries:[],me:null};
  if(path===`/gauntlets/attempts/${ID}`) return ATTEMPT;
  if(path==="/players/p2") return nativeProfileFixture("p2","Other",false);
  if(path==="/players/p2/runs") return {total:0,runs:[]};
  return null;
}

async function open(width=1280,height=720,writes:Record<string,unknown>={}) {
  await mkdir(out,{recursive:true});
  const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height},reducedMotion:"reduce"});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(4000);
  const writesSeen:string[]=[];
  await page.route("**/*",r=>{
    const url=new URL(r.request().url()),method=r.request().method();
    if(url.pathname==="/native-parity-unit")return r.fulfill({status:200,contentType:"text/html",body:html});
    if(url.pathname==="/index.json")return r.fulfill({json:INDEX});
    if(url.hostname==="bunnyhop.lol"&&url.pathname.startsWith("/api/")){
      if(method!=="GET")writesSeen.push(`${method} ${url.pathname}`);
      const body=api(url,method,writes);
      return body?r.fulfill({json:body}):r.abort();
    }
    return r.abort();
  });
  await page.addInitScript(()=>{localStorage.setItem("bunnyhop:onboarded","1");localStorage.setItem("bunnyhop:first-seen",String(Date.now()));(window as any).messages=[];window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto("https://bunnyhop.lol/native-parity-unit",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>!!window.bunnyhopNativeMenu);
  return {browser,page,errors,writesSeen};
}
const shot=async(page:Page,name:string)=>{await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await page.mouse.move(2,2);await page.evaluate(()=>window.bunnyhopNativeMenu.settle?.(1500));await page.screenshot({path:resolve(out,name)});};
const PRACTICE={available:true,unavailable:null,mode:false,active:false,tool:null,noclip:false,menuOpen:false,count:0,current:0,keepVelocity:true};

test("pause: Practice and Checkpoints where practice works, Leave practice, and a practice finish isn't submitted",async()=>{
  for(const [width,height] of [[1280,720],[760,600]]) {
    const {browser,page,errors}=await open(width,height);
    try {
      await page.evaluate(p=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true,practice:p,settings:{binds:{practice:["KeyP"]}}}),PRACTICE);
      const rows=await page.locator(".rail-list .rail-item .ri-label").allInnerTexts();
      expect(rows.slice(0,4).map(r=>r.replace(/\s+/g," ").trim())).toEqual(["Resume","Restart","Practice Every run is practice","Checkpoints"]);
      expect(await page.locator(".rail-item",{hasText:"Practice"}).locator("kbd").textContent()).toBe("P");
      let from=await count(page);
      await page.locator(".rail-item",{hasText:/^Practice/}).click();
      expect(await sent(page,from)).toEqual([{type:"practice",action:"toggle"},{type:"resume"}]);
      from=await count(page);
      await page.getByRole("button",{name:/^Checkpoints/}).click();
      expect(await sent(page,from)).toEqual([{type:"practice",action:"menu"},{type:"resume"}]);
      await page.evaluate(p=>window.bunnyhopNativeMenu.onState({practice:{...p,mode:true,active:true,count:3,current:2}}),PRACTICE);
      expect((await page.locator(".rail-item",{hasText:"Leave practice"}).innerText()).replace(/\s+/g," ")).toContain("Back to the start");
      expect(await page.getByRole("button",{name:/^Checkpoints/}).locator("kbd").textContent()).toBe("!cp");
      // Everything fits at 720p, as on the web: Main menu stays on screen under the practice rows and a finish.
      // Finished while practising (web hud/result.ts): its line says it wasn't submitted.
      await page.evaluate(()=>window.bunnyhopNativeMenu.onState({timer:{status:2,seconds:42.5,jumps:9}}));
      expect(await page.locator(".native-finish.practice .native-finish-sub").textContent()).toBe("Not submitted: practice mode.");
      if(height>=720){const box=await page.locator(".rail-item.pause-home").boundingBox();expect(box&&box.y+box.height<=height).toBe(true);}
      await shot(page,`pause-practice-${width}x${height}.png`);
      // A third-person attempt stays unranked after returning to first person.
      await page.evaluate(p=>window.bunnyhopNativeMenu.onState({practice:{...p,active:true,thirdPerson:false,tool:"camera"},timer:{status:2,seconds:43,jumps:9}}),PRACTICE);
      expect(await page.locator(".native-finish.practice .native-finish-sub").textContent()).toBe("Not submitted: practice run (third person).");
      // Nowhere practice doesn't work: the host says so, or a replay plays.
      await page.evaluate(p=>window.bunnyhopNativeMenu.onState({practice:{...p,unavailable:"Practice is for solo play, not servers."}}),PRACTICE);
      expect(await page.locator(".rail-item",{hasText:/^Practice/}).count()).toBe(0);
      expect(await page.getByRole("button",{name:/^Checkpoints/}).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {await browser.close();}
  }
},40_000);

test("settings: HUD scale 50–175 %, practice binds with Teleport keeps speed, the bundled OST",async()=>{
  const {browser,page,errors}=await open(1280,720);
  try {
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{hudScale:100,practiceKeepVelocity:true},music:{id:"drift",title:"Drift (menu)",role:"menu",playing:true,available:true,loading:false,status:""}}));
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByLabel("Search settings").fill("hud scale");
    const range=page.getByLabel("HUD scale slider",{exact:true});
    expect([await range.getAttribute("min"),await range.getAttribute("max"),await range.getAttribute("step"),await range.inputValue()]).toEqual(["50","175","5","100"]);
    let from=await count(page);
    await range.evaluate(el=>{const input=el as HTMLInputElement;input.value="125";input.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(await sent(page,from)).toEqual([{type:"settings",patch:{hudScale:125}}]);
    from=await count(page);
    await page.getByLabel("HUD scale",{exact:true}).fill("300");await page.getByLabel("HUD scale",{exact:true}).dispatchEvent("change");
    expect(await sent(page,from)).toEqual([]);
    expect(await page.locator(".nset-status").textContent()).toBe("HUD scale: choose 50–175%.");
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{hudScale:125}}));
    await shot(page,"settings-hud-scale-1280x720.png");
    await page.getByLabel("Search settings").fill("");
    await page.getByRole("button",{name:"Keys",exact:true}).click();
    const practice=page.locator(".nset-group",{has:page.locator(".nset-group-title",{hasText:/^Practice$/})});
    expect(await practice.locator(".nset-name").allInnerTexts()).toEqual(["Practice mode","Noclip","Save checkpoint","Teleport to checkpoint","Previous checkpoint","Next checkpoint","Teleport keeps speed"]);
    expect(await practice.getByLabel("Noclip binding").textContent()).toBe("Z");
    await practice.scrollIntoViewIfNeeded();await shot(page,"settings-practice-keys-1280x720.png");
    from=await count(page);
    await practice.getByLabel("Teleport keeps speed").click();
    expect(await sent(page,from)).toEqual([{type:"settings",patch:{practiceKeepVelocity:false}}]);
    await page.getByLabel("Search settings").fill("music");
    expect(await page.getByRole("radio",{name:"bunnyhop.lol OST",exact:true}).isVisible()).toBe(true);
    expect(await page.locator(".nset-music-note").textContent()).toBe("bunnyhop.lol OST is included with the app. No download needed.");
    await shot(page,"settings-ost-1280x720.png");
    from=await count(page);
    await page.getByRole("button",{name:"Skip ▸"}).click();
    expect(await sent(page,from)).toEqual([{type:"music",action:"next"}]);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({music:{available:false,status:"Music files are missing from this install."}}));
    expect(await page.locator(".nset-music-note").textContent()).toBe("Music files are missing from this install.");
    await page.getByLabel("Search settings").fill("");
    await shot(page,"settings-keys-1280x720.png");
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("now playing: the web's control on home and pause, driving the host's music",async()=>{
  const {browser,page,errors}=await open(1280,720);
  try {
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{volume:.8,muted:false},music:{id:"drift",title:"Drift (menu)",role:"menu",playing:true,available:true,loading:false,status:""}}));
    await page.waitForSelector("#music-now.on");
    expect(await page.locator("#music-now .mn-title").textContent()).toBe("Drift");
    for(const [label,action] of [["Next track","next"],["Pause music","toggle"],["Restart / previous track","previous"]]) {
      const from=await count(page);
      await page.getByRole("button",{name:label,exact:true}).click();
      expect(await sent(page,from)).toEqual([{type:"music",action}]);
    }
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({music:{playing:false}}));
    expect(await page.locator("#music-now").getAttribute("class")).toContain("paused");
    expect(await page.getByRole("button",{name:"Play music",exact:true}).count()).toBe(1);
    await shot(page,"home-now-playing-1280x720.png");
    // Off screens other than home / pause, and when muted.
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    expect(await page.locator("#music-now.on").count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{muted:true}}));
    expect(await page.locator("#music-now.on").count()).toBe(0);
    expect(await page.evaluate(()=>document.querySelectorAll("audio,video").length)).toBe(0);
    // No OS media keys from the menu: nothing it could steal from another app.
    expect(await page.evaluate(()=>navigator.mediaSession===undefined)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("gauntlets are native screens: hub, page, Start locks the host and loads the first map, no browser",async()=>{
  for(const [width,height] of [[1280,720],[760,600]]) {
    const {browser,page,errors,writesSeen}=await open(width,height,{"POST /gauntlets/weekly-test/attempts":ATTEMPT});
    try {
      await page.getByRole("button",{name:/^Gauntlets/}).click();
      await page.waitForFunction(()=>document.body.dataset.screen==="gauntlets");
      await page.locator(".panel-gauntlets").getByText("Weekly test").first().waitFor();
      await shot(page,`gauntlets-${width}x${height}.png`);
      await page.locator(".panel-gauntlets").getByRole("button",{name:"Leaderboard"}).click();
      await page.waitForFunction(()=>document.body.dataset.screen==="gauntlet");
      await page.locator(".panel-gauntlet .screen-title h2",{hasText:"Weekly test"}).waitFor();
      await shot(page,`gauntlet-page-${width}x${height}.png`);
      // Back goes to the hub, as the web's stack does.
      await page.keyboard.press("Escape");expect(await page.locator("body").getAttribute("data-screen")).toBe("gauntlets");
      await page.locator(".panel-gauntlets").getByRole("button",{name:"Leaderboard"}).click();
      const from=await count(page);
      await page.locator(".panel-gauntlet").getByRole("button",{name:"Start",exact:true}).click();
      await page.waitForFunction(n=>(window as any).messages.slice(n).some((m:any)=>m.type==="selectMap"),from);
      const out=await sent(page,from);
      expect(out.find(m=>m.type==="openExternal")).toBeUndefined();
      expect(out.filter(m=>m.type==="gauntlet"||m.type==="selectMap").slice(0,2)).toEqual([
        {type:"gauntlet",id:ID,map:"bhop_a",progress:{idx:0,maps:2,before:0,pbSplit:null}},{type:"selectMap",id:"bhop_a",style:"autohop",track:0}]);
      expect(writesSeen).toContain("POST /api/gauntlets/weekly-test/attempts");
      // In game: Normal only (the web's modeLock), and Main menu lets the attempt go.
      await page.evaluate(id=>window.bunnyhopNativeMenu.onState({map:"bhop_a",loading:false,paused:true,style:"autohop",gauntlet:{id,map:"bhop_a"},practice:{available:false,unavailable:"No practice during a gauntlet."}}),ID);
      await page.getByRole("tab",{name:"Style"}).click();
      const before=await count(page);
      await page.locator('.style-row[data-style="sideways"]').click();
      expect(await sent(page,before)).toEqual([]);
      expect(await page.locator("#native-notice").textContent()).toBe("Gauntlets are Normal style on the main track.");
      expect(await page.locator(".rail-item",{hasText:/^Practice/}).count()).toBe(0);
      const leaving=await count(page);
      await page.getByRole("button",{name:/^Main menu/}).click();
      expect(await sent(page,leaving)).toEqual([{type:"gauntlet",id:null},{type:"leaveMap"}]);
      expect(errors).toEqual([]);
    } finally {await browser.close();}
  }
},60_000);

test("report a player from a profile opens the web's report form about them, and sends nothing by itself",async()=>{
  const {browser,page,errors,writesSeen}=await open(1280,720);
  try {
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("bunnyhop:navigate",{detail:{url:"https://bunnyhop.lol/u/p2"}})));
    await page.locator(".pc-name",{hasText:"Other"}).waitFor();
    await page.getByRole("button",{name:"More",exact:true}).click();
    await page.getByRole("menuitem",{name:"Report",exact:true}).click();
    const dialog=page.locator("dialog.fb-dialog[open]");
    await dialog.waitFor();
    expect(await dialog.locator(".fb-head").innerText()).toContain("Report a player");
    expect(await dialog.innerText()).toContain("Other");
    await shot(page,"report-profile-1280x720.png");
    await dialog.getByRole("button",{name:"Close"}).click();
    expect(writesSeen.filter(w=>w.includes("feedback")||w.includes("report"))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("pause tabs as on the web: Replays, On screen, Help; Main track on a bonus",async()=>{
  for(const [width,height] of [[1280,720],[760,600]]) {
    const {browser,page,errors}=await open(width,height);
    try {
      const replay={id:"r1",name:"bhop_eazy run",map:"bhop_eazy",style:"autohop",track:0,seconds:31.5,recordedAt:2,bytes:100};
      await page.evaluate(r=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true,track:0,replays:[r,{...r,id:"r0",recordedAt:1}],settings:{hud:true,crosshair:true,viewmodel:true,jumpStats:true,strafeTrainer:false}}),replay);
      expect(await page.locator(".pp-tab").allInnerTexts()).toEqual(["Leaderboard","Style","Replays","On screen","Help"]);
      await page.getByRole("tab",{name:"Replays"}).click();
      expect(await page.locator(".pp-replays .action-card b").allInnerTexts()).toEqual(["Watch PB replay","Watch last run","Export last run","Load replay file"]);
      expect(await page.locator(".action-card",{hasText:"Watch PB replay"}).isDisabled()).toBe(true); // no PB here
      let from=await count(page);
      await page.locator(".action-card",{hasText:"Watch last run"}).click();
      await page.locator(".action-card",{hasText:"Export last run"}).click();
      expect(await sent(page,from)).toEqual([{type:"replay",action:"play",id:"r1"},{type:"replay",action:"export",id:"r1"}]);
      await shot(page,`pause-replays-${width}x${height}.png`);
      await page.getByRole("tab",{name:"On screen"}).click();
      from=await count(page);
      await page.getByRole("checkbox",{name:"Crosshair"}).click();
      expect(await sent(page,from)).toEqual([{type:"settings",patch:{crosshair:false}}]);
      expect(await page.getByRole("checkbox",{name:"Strafe trainer"}).isChecked()).toBe(false);
      await shot(page,`pause-on-screen-${width}x${height}.png`);
      await page.getByRole("tab",{name:"Help"}).click();
      expect(await page.locator(".pp-help-group h3").allInnerTexts()).toEqual(["Run","Practice","Screen"]);
      expect(await page.locator(".pp-help-group",{hasText:"Practice"}).locator("tr",{hasText:"Noclip"}).locator("kbd").textContent()).toBe("Z");
      await shot(page,`pause-help-${width}x${height}.png`);
      await page.locator(".pp-screen-foot .link-btn",{hasText:"Every key"}).click();
      expect(await page.locator("body").getAttribute("data-screen")).toBe("settings");
      await page.keyboard.press("Escape");
      // Bonus track: Main track goes back to the main course.
      expect(await page.locator(".rail-item",{hasText:"Main track"}).count()).toBe(0);
      await page.evaluate(()=>window.bunnyhopNativeMenu.onState({track:1}));
      from=await count(page);
      await page.locator(".rail-item",{hasText:"Main track"}).click();
      expect(await sent(page,from)).toEqual([{type:"selectMap",id:"bhop_eazy",style:"autohop",track:0}]);
      expect(errors).toEqual([]);
    } finally {await browser.close();}
  }
},60_000);

test("watching a gauntlet attempt refuses a split on an earlier map build, with the reason",async()=>{
  const {browser,page,errors}=await open(1280,720);
  try {
    await page.route("**/api/gauntlets/attempts/*/watch",r=>r.fulfill({json:{attemptId:ID,state:"complete",gauntlet:{slug:"weekly-test",title:"Weekly test",kind:"weekly",maps:2},player:player("p2","Other"),totalTicks:null,realMs:null,finishedAt:null,record:null,
      splits:[{idx:0,map:"bhop_a",runId:"run_a",ticks:1,time:10,mapSha256:"0".repeat(64),verified:true}]}}));
    await page.route("**/index.json",r=>r.fulfill({json:{maps:[{name:"bhop_a",title:"A",tier:1,size:1,sha256:"a".repeat(64)}]}}));
    const from=await count(page);
    await page.evaluate(id=>window.dispatchEvent(new CustomEvent("bunnyhop:navigate",{detail:{url:`https://bunnyhop.lol/g/weekly-test/watch/${id}`}})),ID);
    await page.waitForFunction(()=>/earlier build/.test(document.getElementById("native-notice")?.textContent??""));
    expect(await page.locator("#native-notice").textContent()).toBe("Split 1 (bhop_a) was run on an earlier build of the map. The native client plays only the current build, so watch this one on bunnyhop.lol.");
    expect((await sent(page,from)).filter(m=>m.type==="replayData")).toEqual([]);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("Report in playback is about the server run being watched, never a local replay or file played after it",async()=>{
  const {browser,page,errors}=await open(1280,720);
  try {
    await page.route("**/api/runs/run_x/replay",r=>r.fulfill({status:200,contentType:"application/octet-stream",body:Buffer.from("bhr-server-run")}));
    const replay={id:"r1",name:"local run",map:"bhop_eazy",style:"autohop",track:0,seconds:31.5,recordedAt:2,bytes:100};
    await page.evaluate(r=>window.bunnyhopNativeMenu.onState({replays:[r]}),replay);
    await page.getByRole("button",{name:"Replays",exact:true}).click();
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("bunnyhop:navigate",{detail:{url:"https://bunnyhop.lol/replay/run_x"}})));
    await page.waitForFunction(()=>(window as any).messages.some((m:any)=>m.type==="replayData"));
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({playback:{active:true,id:"import-x",tick:1,totalTicks:10,paused:false,speed:1}}));
    expect(await page.locator(".native-playback-report .native-report").count()).toBe(1);
    // A local replay from the list: no Report about the earlier server run.
    await page.locator(".native-replay-row",{hasText:"local run"}).getByRole("button",{name:"Watch"}).click();
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({playback:{active:true,id:"r1",tick:2,totalTicks:10,paused:false,speed:1}}));
    expect(await page.locator(".native-playback-report .native-report").count()).toBe(0);
    // Server run again, then a .bhr file: the same.
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("bunnyhop:navigate",{detail:{url:"https://bunnyhop.lol/replay/run_x"}})));
    await page.waitForFunction(()=>(window as any).messages.filter((m:any)=>m.type==="replayData").length===2);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({playback:{active:true,id:"import-x",tick:1,totalTicks:10,paused:false,speed:1}}));
    expect(await page.locator(".native-playback-report .native-report").count()).toBe(1);
    await page.locator('input[aria-label="Import replay"]').setInputFiles({name:"mine.bhr",mimeType:"application/octet-stream",buffer:Buffer.from("bhr-local-file")});
    await page.waitForFunction(()=>(window as any).messages.filter((m:any)=>m.type==="replayData").length===3);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({playback:{active:true,id:"import-y",tick:3,totalTicks:10,paused:false,speed:1}}));
    expect(await page.locator(".native-playback-report .native-report").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("pause tabs keep the web's own look under the friends dock's styles",async()=>{
  const {browser,page}=await open(1280,720);
  try {
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true}));
    const tab=await page.locator(".pause-panel .pp-tab.on").evaluate(el=>{const s=getComputedStyle(el),root=getComputedStyle(document.documentElement);
      return {weight:s.fontWeight,size:s.fontSize,lg:root.getPropertyValue("--fs-lg").trim(),underline:s.borderBottomWidth,background:s.backgroundColor,shadow:s.boxShadow};});
    const lg=await page.evaluate(v=>{const probe=document.createElement("span");probe.style.fontSize=v;document.body.append(probe);const px=getComputedStyle(probe).fontSize;probe.remove();return px;},tab.lg);
    expect({weight:tab.weight,size:tab.size,underline:tab.underline,background:tab.background,shadow:tab.shadow}).toEqual({weight:"700",size:lg,underline:"2px",background:"rgba(0, 0, 0, 0)",shadow:"none"});
  } finally {await browser.close();}
},20_000);

test("menu clicks and switches emit bounded native interface audio cues",async()=>{
  const {browser,page,errors}=await open();
  try{
    const before=await count(page);await page.getByRole("button",{name:"Settings",exact:true}).click();
    const clicked=(await messages(page)).slice(before).filter(m=>m.type==="audioCue");
    expect(clicked.some(m=>m.id==="ui_click"&&m.gain===.8&&m.rate===1)).toBe(true);
    const toggled=await count(page);await page.getByRole("checkbox",{name:"Mute",exact:true}).click();
    const cues=(await messages(page)).slice(toggled).filter(m=>m.type==="audioCue");
    expect(cues.some(m=>m.id==="ui_switch"&&m.gain===.8&&m.rate===1.12)).toBe(true);expect(errors).toEqual([]);
  }finally{await browser.close();}
});

test("map loading: byte progress, cancellation, offline retry and stable transition",async()=>{
 const {browser,page,errors}=await open();
 try{
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Downloading bhop_test",loadProgress:{map:"bhop_test",stage:"download",message:"Downloading map data",received:1048576,total:4194304,filesDone:2,filesTotal:8,cached:false,offline:false}}));
  const panel=page.locator('.native-loading');await panel.waitFor();expect(await panel.locator('progress').getAttribute('value')).toBe('0.25');expect(await panel.textContent()).toContain('1.0 MB / 4.0 MB');
  await shot(page,'map-loading-progress.png');
  let from=await count(page);await panel.getByRole('button',{name:'Cancel',exact:true}).click();expect(await sent(page,from)).toEqual([{type:'mapLoad',action:'cancel'}]);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false,error:"Network unavailable"}));
  from=await count(page);await panel.getByRole('button',{name:'Retry',exact:true}).click();expect(await sent(page,from)).toEqual([{type:'mapLoad',action:'retry'}]);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Loading cached map",error:null,loadProgress:{stage:"renderer",message:"Loading cached map",received:0,total:0,filesDone:8,filesTotal:8,cached:true,offline:true}}));
  expect(await panel.textContent()).toContain('Offline');
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_test",loading:false,error:null,loadProgress:null}));
  expect(await page.locator('.native-loading').count()).toBe(0);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false,error:'Fast cached-map failure',loadProgress:{stage:'error',message:'Fast cached-map failure',received:0,total:0,filesDone:0,filesTotal:0,cached:true,offline:false}}));
  await page.locator('.native-loading').getByRole('button',{name:'Retry',exact:true}).waitFor();
  await page.locator('.native-loading').getByRole('button',{name:'Back',exact:true}).click();expect(await page.locator('.native-loading').count()).toBe(0);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false,error:'Fast cached-map failure',loadProgress:{stage:'error',message:'Fast cached-map failure',received:0,total:0,filesDone:0,filesTotal:0,cached:true,offline:false}}));
  expect(await page.locator('.native-loading').count()).toBe(0);expect(errors).toEqual([]);
 }finally{await browser.close();}
});

test("replay vault filters and scrubbing restores prior playback without stale playhead jumps",async()=>{
 const {browser,page,errors}=await open();try{
  await page.evaluate(()=>{window.bunnyhopNativeMenu.onState({map:'bhop_a',replays:[{id:'a.bhr',name:'Alice',map:'bhop_a',style:'autohop',track:0,seconds:10,recordedAt:1700000000000,bytes:1200,screenshot:true,localSummary:{schema:1,map:'bhop_a',style:'autohop',track:0,time:10,jumps:12,strafes:40,sync:88,finishedAt:1700000000000,client:'native',localPb:true}},{id:'b.bhr',name:'Bob',map:'bhop_b',style:'scroll',track:0,seconds:11,recordedAt:1700000001000,bytes:1400}],playback:{active:true,id:'a.bhr',tick:100,totalTicks:1000,paused:false,speed:1,tickInterval:.01}});window.bunnyhopNativeMenu.open?.('replays');});
  expect(await page.locator('.native-replay-row').count()).toBe(2);await page.getByRole('searchbox',{name:'Search replay vault'}).fill('Alice');expect(await page.locator('.native-replay-row').count()).toBe(1);expect(await page.locator('.native-replay-row').textContent()).toContain('Device PB');
  let from=await count(page);await page.getByRole('button',{name:'View result',exact:true}).click();expect(await sent(page,from)).toEqual([{type:'replay',action:'screenshot',id:'a.bhr'}]);
  from=await count(page);await page.getByRole('slider',{name:'Replay tick',exact:true}).evaluate(slider=>{const input=slider as HTMLInputElement;input.dispatchEvent(new PointerEvent('pointerdown'));for(let i=200;i<=800;i++){input.value=String(i);input.dispatchEvent(new Event('input'));}window.bunnyhopNativeMenu.onState({playback:{active:true,id:'a.bhr',tick:101,totalTicks:1000,paused:true,speed:1}});input.dispatchEvent(new Event('change'));});
  const commands=await sent(page,from);expect(commands).toEqual([{type:'replayControl',action:'pause',paused:true},{type:'replayControl',action:'seek',tick:200},{type:'replayControl',action:'seek',tick:800},{type:'replayControl',action:'pause',paused:false}]);
  expect(await page.getByRole('slider',{name:'Replay tick',exact:true}).inputValue()).toBe('800');await shot(page,'replay-vault-scrub.png');expect(errors).toEqual([]);
 }finally{await browser.close();}
});

test("solo SSJ commands toggle in the host without relying on stale menu settings",async()=>{
 const {browser,page,errors,writesSeen}=await open();try{
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_test",settings:{jumpStats:true}}));
  const from=await count(page);
  await page.evaluate(()=>{window.bunnyhopNativeMenu.onChatSubmit!("!ssj");window.bunnyhopNativeMenu.onChatSubmit!("!ssj");});
  expect(await sent(page,from)).toEqual([{type:"chatAction",action:"jumpStats"},{type:"chatAction",action:"jumpStats"}]);
  expect(errors).toEqual([]);expect(writesSeen).toEqual([]);
 }finally{await browser.close();}
});
