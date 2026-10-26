import {test,expect} from "bun:test";
import type {} from "./menu-backdrop";
import {chromium,type Page} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";

// The native home and pause screens are the web's (ui/home.ts, menu.ts pauseScreen): same markup, same style.css.
// Offline except a small map index, so nothing reaches the live API.
const out=resolve(import.meta.dir,"../../../target/native-menu/web-port");
const INDEX={maps:["bhop_eazy","bh_aztec","bhop_1","bhop_13","bhop_ambience","bhop_easyhop","bhop_2_easy","bhop_alley"].map(name=>({name,title:name,tier:1,size:1<<20}))};
const messages=(page:Page)=>page.evaluate(()=>(window as any).messages as {type:string;[key:string]:unknown}[]);
const last=async(page:Page)=>(await messages(page)).filter(m=>m.type!=="cosmetics"&&m.type!=="menuAppearance"&&m.type!=="playerName").at(-1);

/** The home screen's own backdrop request (sent once backgroundPick has the map index): waited for, never assumed. */
const homeBackdrop=(page:Page)=>page.waitForFunction(()=>(window as any).messages.some((m:{type:string})=>m.type==="menuBackdrop"));

/** `indexGate`: the map index is answered only once it resolves (a slow network, as on CI). */
async function open(width=1280,height=720,routes:(url:URL)=>unknown=()=>null,indexGate?:Promise<void>) {
  await mkdir(out,{recursive:true});
  const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height},reducedMotion:"reduce"});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(4000);
  await page.route("**/*",r=>{
    const url=new URL(r.request().url());
    if(url.pathname==="/native-home-unit")return r.fulfill({status:200,contentType:"text/html",body:html});
    if(url.pathname==="/index.json")return indexGate?indexGate.then(()=>r.fulfill({json:INDEX})):r.fulfill({json:INDEX});
    const body=routes(url);
    return body?r.fulfill({json:body}):r.abort();
  });
  await page.addInitScript(()=>{(window as any).messages=[];window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto("https://bunnyhop.lol/native-home-unit?attract=bhop_eazy",{waitUntil:"domcontentloaded"});
  return {browser,page,errors};
}

test("replay headers get the web's local display name, falling back to player",async()=>{
  const {browser,page,errors}=await open();
  try {
    const names=async()=>(await messages(page)).filter(m=>m.type==="playerName");
    await page.waitForFunction(()=>(window as any).messages.some((m:{type:string})=>m.type==="playerName"));
    expect(await names()).toEqual([{type:"playerName",name:"player"}]);
    // A sign-in or rename stores the name where the web's session.ts reads it; the host hears it once.
    await page.evaluate(()=>{localStorage.setItem("bunnyhop:name","Sync Goblin2429");window.dispatchEvent(new Event("bunnyhop:account"));});
    expect(await names()).toEqual([{type:"playerName",name:"player"},{type:"playerName",name:"Sync Goblin2429"}]);
    await page.evaluate(()=>window.dispatchEvent(new Event("bunnyhop:account")));
    expect((await names()).length).toBe(2);
    // With no stored name the next headers fall back to the web's "player" again.
    await page.evaluate(()=>localStorage.removeItem("bunnyhop:name"));
    await page.waitForFunction(()=>(window as any).messages.filter((m:{type:string})=>m.type==="playerName").length===3);
    expect((await names()).at(-1)).toEqual({type:"playerName",name:"player"});
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},30_000);

test("home is the web title screen: menu, maps to try, footer, and native routes",async()=>{
  const {browser,page,errors}=await open();
  try {
    expect(await page.locator("#menu.screen-home > section.home > .home-left > .home-brand .wordmark-xl").count()).toBe(1);
    expect(await page.locator(".home-menu .home-item .mb-title").allTextContents()).toEqual(["Play","Learn to bhop","Play online","Gauntlets","Profile","Ranks","Stats","Settings"]);
    // Play is focused like the web's [data-autofocus].
    expect(await page.evaluate(()=>document.activeElement?.matches(".home-item.primary"))).toBe(true);
    await page.keyboard.press("ArrowDown");expect(await page.evaluate(()=>document.activeElement?.textContent)).toBe("Learn to bhop");
    // Six maps to try, the background's map first, and the host is asked for that map's scene.
    await page.locator(".home-grid .home-tile").nth(5).waitFor();
    expect(await page.locator(".home-tile").first().getAttribute("data-name")).toBe("bhop_eazy");
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop")).toEqual([{type:"menuBackdrop",map:"bhop_eazy"}]);
    expect(await page.locator(".home-foot .home-acts > :not([hidden])").allInnerTexts()).toEqual(["Support","Inbox"]);
    expect(await page.locator(".home-links .home-link").allTextContents()).toEqual(["Feedback","Replays","Credits","What's new","Quit"]);
    // Nothing to continue: Play goes straight into the first map to try (the one behind the menu), like the web.
    await page.getByRole("button",{name:"Play",exact:true}).click();expect(await last(page)).toEqual({type:"selectMap",id:"bhop_eazy",style:"autohop",track:0});
    for(const [button,screen] of [["Learn to bhop","tutorial"],["Play online","servers"],["Ranks","ranks"],["Stats","stats"],["Settings","settings"],["Replays","replays"],["Credits","credits"],["Profile","loadout"]]) {
      await page.getByRole("button",{name:button,exact:true}).click();await page.waitForFunction(s=>document.body.dataset.screen===s,screen);
      await page.keyboard.press("Escape");expect(await page.locator("body").getAttribute("data-screen")).toBe("home");
    }
    // Gauntlets are a native screen (the web's ui/gauntlets.ts), not the website.
    const before=(await messages(page)).length;
    await page.getByRole("button",{name:/^Gauntlets/}).click();await page.waitForFunction(()=>document.body.dataset.screen==="gauntlets");
    expect((await messages(page)).slice(before).filter(m=>m.type==="openExternal")).toEqual([]);
    expect(await page.locator("section.panel-gauntlets .screen-title h2").textContent()).toBe("Gauntlets");
    await page.keyboard.press("Escape");expect(await page.locator("body").getAttribute("data-screen")).toBe("home");
    // Pages the native client has no screen for open on bunnyhop.lol in the browser.
    await page.getByRole("button",{name:"Support",exact:true}).click();expect(await last(page)).toEqual({type:"openExternal",url:"https://bunnyhop.lol/?support"});
    await page.getByRole("button",{name:"Quit",exact:true}).click();expect(await last(page)).toEqual({type:"quit"});
    await page.getByRole("button",{name:"bh_aztec",exact:false}).first().click();expect(await last(page)).toEqual({type:"selectMap",id:"bh_aztec",style:"autohop",track:0});
    await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await page.mouse.move(1275,360);
    await page.screenshot({path:resolve(out,"home-1280x720.png")});
    // Loading: the menu stays painted (a redraw for the host doesn't replay the entrance) and can't be used.
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Reading map…"}));
    expect(await page.locator("#menu").getAttribute("class")).toContain("native-steady");
    expect(await page.locator(".home-menu button:enabled").count()).toBe(0);
    expect(await page.locator("#native-status").textContent()).toBe("Reading map…");
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false}));
    expect(await page.locator("#native-status").textContent()).toBe("");
    expect(await page.evaluate(()=>getComputedStyle(document.querySelector(".home-item")!).opacity)).toBe("1");
    expect(await page.evaluate(()=>window.__nativeMenuGraphics)).toEqual({contexts:0,attempts:0});
    expect(await page.locator("canvas").count()).toBe(0);expect(errors).toEqual([]);
  } finally {await browser.close();}
},30_000);

test("backdrop: the map's picture, then the host's live scene or still, cuts and stale calls",async()=>{
  const {browser,page,errors}=await open();
  try {
    const look=()=>page.evaluate(()=>({source:document.documentElement.dataset.nativeBackdrop??"",live:document.body.classList.contains("attract-live"),cut:document.body.classList.contains("attract-cut"),
      layer:getComputedStyle(document.getElementById("native-backdrop")!).opacity,art:!!document.querySelector("#native-backdrop .native-backdrop-art"),
      body:getComputedStyle(document.body).backgroundColor,html:getComputedStyle(document.documentElement).backgroundColor}));
    await page.waitForFunction(()=>document.querySelector("#native-backdrop .native-backdrop-art"));
    expect((await look()).art).toBe(true);
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native","bhop_other"));
    expect((await look()).source).toBe("");
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native","bhop_eazy"));
    expect(await look()).toMatchObject({source:"scene",live:true,cut:false,layer:"0",body:"rgba(0, 0, 0, 0)",html:"rgba(0, 0, 0, 0)"});
    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("cut","bhop_eazy"));
    await page.waitForFunction(()=>getComputedStyle(document.getElementById("native-backdrop")!).opacity==="1");
    expect((await look()).cut).toBe(true);
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native","bhop_eazy"));
    expect((await look()).cut).toBe(false);
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("none","bhop_eazy"));
    expect(await look()).toMatchObject({source:"",art:true});
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("javascript:alert(1)","bhop_eazy"));
    expect((await look()).source).toBe("");
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4b8AAAAASUVORK5CYII=";
    await page.evaluate(src=>window.bunnyhopNativeBackdrop?.("data:image/png;base64,"+src,"bhop_eazy"),png);
    await page.waitForFunction(()=>document.documentElement.dataset.nativeBackdrop==="static");
    expect(await page.locator("#native-backdrop img.native-backdrop-still").count()).toBe(1);
    expect((await messages(page)).some(m=>m.type==="menuAppearance"&&m.reducedMotion===false)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("pause is the web pause screen: resume, restart, style, main menu, and the game shows through the live scene",async()=>{
  const {browser,page,errors}=await open();
  try {
    // The home screen asked for its backdrop before the map loads (the request is async: the map index comes first).
    await homeBackdrop(page);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true,settings:{binds:{restart:["KeyR"]}},timer:{status:2,seconds:61.234,jumps:12,strafes:34,sync:98.3}}));
    expect(await page.evaluate(()=>({screen:document.body.dataset.screen,map:document.body.dataset.map,inGame:document.body.classList.contains("in-game")}))).toEqual({screen:"pause",map:"bhop_eazy",inGame:true});
    expect(await page.locator("section.pause .pause-map").textContent()).toBe("bhop_eazy");
    expect(await page.locator(".rail-list .rail-item.primary").textContent()).toBe("ResumeEsc");
    expect(await page.locator(".native-finish-time").textContent()).toBe("01:01.234");
    expect(await page.locator(".native-finish-stats").textContent()).toBe("12 jumps · 34 strafes · 98.3% sync");
    await page.getByRole("tab",{name:"Style"}).click();
    await page.getByRole("radio",{name:/Low Gravity/}).click();expect(await last(page)).toEqual({type:"style",id:"lowgrav"});
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({style:"sideways"}));
    expect(await page.locator('.style-row[data-style="sideways"]').getAttribute("aria-checked")).toBe("true");
    await page.getByRole("button",{name:/^Restart/}).click();expect(await last(page)).toEqual({type:"restart"});
    await page.getByRole("button",{name:/^Resume/}).click();expect(await last(page)).toEqual({type:"resume"});
    await page.keyboard.press("Escape");expect(await last(page)).toEqual({type:"resume"});
    // The web's last row: Main menu (never Quit), and Backspace does the same without asking.
    expect(await page.locator(".rail-list .pause-home").innerText()).toMatch(/^Main menu\s*Backspace$/);
    expect(await page.getByRole("button",{name:"Quit",exact:true}).count()).toBe(0);
    await page.getByRole("button",{name:/^Main menu/}).click();expect(await last(page)).toEqual({type:"leaveMap"});
    await page.keyboard.press("Backspace");expect(await last(page)).toEqual({type:"leaveMap"});
    for(const [button,screen] of [["Change map","maps"],["Settings","settings"],["Loadout","loadout"]]) {
      await page.getByRole("button",{name:button,exact:true}).click();expect(await page.locator("body").getAttribute("data-screen")).toBe(screen);
      await page.keyboard.press("Escape");expect(await page.locator("body").getAttribute("data-screen")).toBe("pause");
    }
    // The host's game frame behind: the backdrop layer is see-through once the host says the scene is live.
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native","bhop_eazy"));
    expect(await page.evaluate(()=>({layer:getComputedStyle(document.getElementById("native-backdrop")!).opacity,body:getComputedStyle(document.body).backgroundColor}))).toEqual({layer:"0",body:"rgba(0, 0, 0, 0)"});
    // Home screen's map asked for again after the map is left; no request while one is loaded.
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop").length).toBe(1);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Reading map…"}));
    expect(await page.locator(".rail-list button:enabled").count()).toBe(0);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false}));
    await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await page.mouse.move(1275,360);
    await page.screenshot({path:resolve(out,"pause-1280x720.png")});
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"",timer:{status:0}}));
    expect(await page.locator("body").getAttribute("data-screen")).toBe("home");
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop")).toEqual([{type:"menuBackdrop",map:"bhop_eazy"},{type:"menuBackdrop",map:"bhop_eazy"}]);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},30_000);

test("your own profile keeps its way to the Loadout",async()=>{
  const me={id:"alice",name:"alice",provider:"email",avatarUrl:null};
  const {browser,page}=await open(1280,720,url=>url.pathname==="/api/me"?me:url.pathname==="/api/players/alice"?{player:me,mine:true,level:{level:3},rank:{group:{name:"Hopper"}},stats:{maps:1,wrs:0,pbs:1,clearedMaps:["bhop_eazy"]}}:null);
  try {
    await page.getByRole("button",{name:"Profile",exact:true}).click();
    await page.locator(".native-profile-loadout").click();
    expect(await page.locator("body").getAttribute("data-screen")).toBe("loadout");
  } finally {await browser.close();}
},20_000);

test("home fits a small window and a 1440×900 one",async()=>{
  for(const [width,height] of [[1440,900],[800,600]]) {
    const {browser,page,errors}=await open(width,height);
    try {
      await page.locator(".home-grid .home-tile").first().waitFor();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const play=await page.getByRole("button",{name:"Play",exact:true}).boundingBox();
      expect(play!.x).toBeGreaterThanOrEqual(0);expect(play!.y+play!.height).toBeLessThan(height);
      await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await page.mouse.move(width-5,height/2);
      await page.screenshot({path:resolve(out,`home-${width}x${height}.png`)});
      expect(errors).toEqual([]);
    } finally {await browser.close();}
  }
},30_000);

test("review regressions: feedback context, loads, backdrop re-request and release",async()=>{
  const {browser,page,errors}=await open();
  try {
    await page.locator(".home-grid .home-tile").nth(5).waitFor();
    // A tile clicked while a map loads is refused (they land after the disabled pass).
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Reading map…"}));
    const before=(await messages(page)).length;
    await page.locator(".home-tile").nth(1).dispatchEvent("click");
    expect((await messages(page)).slice(before).some(m=>m.type==="selectMap")).toBe(false);
    // The home pick is asked for again after a failed load (the host dropped it meanwhile).
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false,error:"Couldn't read map"}));
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop")).toEqual([{type:"menuBackdrop",map:"bhop_eazy"},{type:"menuBackdrop",map:"bhop_eazy"}]);
    // The host's release ('none' for no map) is accepted.
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native","bhop_eazy"));
    expect(await page.evaluate(()=>document.documentElement.dataset.nativeBackdrop)).toBe("scene");
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("none",""));
    expect(await page.evaluate(()=>document.documentElement.dataset.nativeBackdrop??"")).toBe("");
    // Style rows refuse a change during a load too.
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",error:null,paused:true,settings:{fov:100,sensitivity:1.5}}));
    await page.getByRole("tab",{name:"Style"}).click();
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Reading map…"}));
    const styleBefore=(await messages(page)).length;
    await page.locator('.style-row[data-style="scroll"]').dispatchEvent("click");
    expect((await messages(page)).slice(styleBefore).some(m=>m.type==="style")).toBe(false);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false}));
    // Feedback's attached context is the native host's: its map, own settings, release, GPU and game window (not the
    // menu web view's size or scale), and no web build or prefs.
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({client:{version:"0.3.7",build:"bunnyhop-native/0123456789abcdef01234567",gpu:"Apple M4 Pro",viewport:[1920,1080],dpr:2}}));
    await page.getByRole("button",{name:"Feedback",exact:true}).click();
    await page.locator("dialog[open] .fb-kind").first().click();
    await page.getByRole("button",{name:"See all of it"}).click();
    const context=JSON.parse(await page.locator("dialog[open] pre").first().textContent()??"{}");
    expect(context).toMatchObject({client:"native",inGame:true,map:"bhop_eazy",style:"autohop",track:0,screen:"pause",settings:{sensitivity:1.5,fov:100,vsync:true,fpsLimit:0},
      nativeVersion:"0.3.7",nativeBuild:"bunnyhop-native/0123456789abcdef01234567",gpu:{renderer:"Apple M4 Pro"},viewport:"1920x1080",dpr:2});
    for(const key of ["webBuild","fps","page","nativeSettings"]) expect(key in context).toBe(false);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},30_000);

test("one column (a small window): the maps to try can be scrolled to",async()=>{
  const {browser,page,errors}=await open(800,600);
  try {
    const last=page.locator(".home-grid .home-tile").nth(5);await last.waitFor();
    expect(await page.evaluate(()=>getComputedStyle(document.getElementById("menu")!).overflowY)).toBe("auto");
    await page.mouse.move(400,300);await page.mouse.wheel(0,3000);
    await page.waitForFunction(()=>document.getElementById("menu")!.scrollTop>0);
    const box=await last.boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(600);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("settle() ends the entrance for a screenshot, at once",async()=>{
  const {browser,page,errors}=await open();
  try {
    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.locator(".home-grid .home-tile").nth(5).waitFor();
    await page.getByRole("button",{name:"Stats",exact:true}).click();await page.keyboard.press("Escape");
    // The web entrance is playing again (home redrawn) ...
    expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==="running").length)).toBeGreaterThan(0);
    const result=await page.evaluate(()=>window.bunnyhopNativeMenu.settle!(1000));
    expect(result.ended).toBeGreaterThan(0);
    // ... and has ended: every finite animation done, the menu fully painted.
    expect(await page.evaluate(()=>({running:document.getAnimations().filter(a=>a.playState==="running"&&Number.isFinite(a.effect?.getComputedTiming().endTime)).length,
      item:getComputedStyle([...document.querySelectorAll(".home-menu .home-item")].at(-1)!).opacity}))).toEqual({running:0,item:"1"});
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);

test("a map that loads before the home screen's backdrop pick: no home request while it's loaded, one on the way back",async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  const {browser,page,errors}=await open(1280,720,()=>null,gate);
  try {
    // The map loads while the index (and so backgroundPick) is still out, the CI ordering.
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true}));
    expect(await page.locator("body").getAttribute("data-screen")).toBe("pause");
    // (Listening before the index is let go, so its response can't come first.)
    const index=page.waitForResponse(response=>response.url().endsWith("/index.json"));
    release();
    // The pick lands under the pause screen (index answered, the network quiet): the home's request is dropped, not
    // sent for a loaded map.
    await index;
    await page.waitForLoadState("networkidle");
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop")).toEqual([]);
    // Back home: the request goes out once.
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:""}));
    expect(await page.locator("body").getAttribute("data-screen")).toBe("home");
    await homeBackdrop(page);
    expect((await messages(page)).filter(m=>m.type==="menuBackdrop")).toEqual([{type:"menuBackdrop",map:"bhop_eazy"}]);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
},20_000);
