import { test,expect } from "bun:test";
import {chromium} from "playwright";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

test("offline menu routes styles, native settings, replay controls, tutorials and free cosmetics without gameplay contexts",async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
 await page.route("**/*",route=>route.request().url()==="https://bunnyhop.lol/native-features-unit"?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
 await page.addInitScript(()=>{(window as unknown as {messages:unknown[]}).messages=[];window.addEventListener("bunnyhop:native-message",event=>(window as unknown as {messages:unknown[]}).messages.push((event as CustomEvent).detail));});
 await page.goto("https://bunnyhop.lol/native-features-unit",{waitUntil:"domcontentloaded"});
 expect(await page.locator("select.native-style option").count()).toBe(8);
 await page.locator("select.native-style").selectOption("lowgrav");
 expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"style",id:"lowgrav"});
 await page.evaluate(()=>window.bunnyhopNativeMenu.onState({style:"sideways"}));expect(await page.locator("select.native-style").inputValue()).toBe("sideways");
 await page.getByRole("button",{name:"Settings",exact:true}).click();await page.getByLabel("Field of view",{exact:true}).fill("110");await page.getByLabel("Field of view",{exact:true}).blur();
 expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"settings",patch:{fov:110}});
 await page.getByRole("button",{name:"Back",exact:true}).click();await page.getByRole("button",{name:"Replays",exact:true}).click();
 await page.evaluate(()=>window.bunnyhopNativeMenu.onState({replays:[{id:"test-replay",name:"Native test replay",map:"bhop_eazy",style:"scroll",track:0,seconds:12.34,recordedAt:1,bytes:100}],playback:{active:true,id:"test-replay",tick:100,totalTicks:1000,paused:false,speed:1},ghost:{enabled:true,id:"g",name:"Ghost"}}));
 await page.getByRole("button",{name:"Watch",exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"replay",action:"play",id:"test-replay"});
 await page.getByRole("button",{name:"Pause",exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"replayControl",action:"pause",paused:true});
 await page.getByLabel("Replay speed").selectOption("2");expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"replayControl",action:"speed",speed:2});
 await page.getByRole("button",{name:"Delete",exact:true}).click();expect(await page.getByRole("dialog",{name:"Delete replay"}).isVisible()).toBe(true);await page.getByRole("button",{name:"Delete replay",exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"replay",action:"delete",id:"test-replay",confirmed:true});
 await page.getByRole("button",{name:"Back",exact:true}).click();await page.getByRole("button",{name:"Tutorial",exact:true}).click();await page.getByRole("button",{name:"Start lesson",exact:true}).nth(2).click();expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"tutorial",action:"start",lesson:"speed"});
 await page.getByRole("button",{name:"Back",exact:true}).click();await page.getByRole("button",{name:"Loadout",exact:true}).click();await page.getByLabel("Cosmetic category").selectOption("outfit");await page.locator(".native-cosmetic-card").first().click();
 await page.waitForFunction(()=>(window as unknown as {messages:{type:string}[]}).messages.some(message=>message.type==="cosmetics"));
 const graphics=await page.evaluate(()=>({gl:window.__nativeMenuGraphics,canvases:document.querySelectorAll("canvas").length}));expect(graphics).toEqual({gl:{contexts:0,attempts:0},canvases:0});expect(errors).toEqual([]);
 await page.getByRole("button",{name:"Back",exact:true}).click();await page.screenshot({path:resolve(import.meta.dir,"../../../target/native-menu/menu-features-offline.png")});
 }finally{await browser.close();}
},15_000);

test("native account changes close old social transport and replace friend data without reloading the menu",async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1280,height:900}});let account="alice";const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
 await page.route("**/*",route=>{const url=new URL(route.request().url());if(url.pathname==="/native-social-unit")return route.fulfill({status:200,contentType:"text/html",body:html});if(url.pathname==="/api/me")return route.fulfill({json:{id:account,name:account,provider:"email",avatarUrl:null}});if(url.pathname==="/api/me/friends")return route.fulfill({json:{appearOffline:false,canMessage:true,friends:[{id:`${account}-friend`,name:`${account} friend`,avatarUrl:null,since:0,where:null,lastSeen:null,unread:0}],following:[],followers:[],blocked:[],unreadNotes:0}});return route.abort();});
 await page.addInitScript(()=>{const sockets:{url:string;closed:boolean}[]=[];(window as unknown as {sockets:unknown[]}).sockets=sockets;class Socket{static OPEN=1;static CLOSED=3;readyState=1;onopen:(()=>void)|null=null;onmessage:((event:unknown)=>void)|null=null;onclose:(()=>void)|null=null;record:{url:string;closed:boolean};constructor(url:string){this.record={url,closed:false};sockets.push(this.record);setTimeout(()=>this.onopen?.(),0);}send(){}close(){this.record.closed=true;this.readyState=3;this.onclose?.();}}(window as unknown as {WebSocket:unknown}).WebSocket=Socket;});
 await page.goto("https://bunnyhop.lol/native-social-unit",{waitUntil:"domcontentloaded"});await page.waitForFunction(()=>(window as unknown as {sockets:{url:string}[]}).sockets.some(socket=>socket.url.includes("/social/ws")));
 await page.locator("button.fd-friends").click();await page.getByText("alice friend",{exact:true}).waitFor();account="bob";await page.evaluate(()=>window.bunnyhopNativeMenu.onAuth());await page.waitForFunction(()=>(window as unknown as {sockets:{closed:boolean}[]}).sockets[0].closed);await page.waitForFunction(()=>document.querySelector(".name-text")?.textContent==="bob");await page.locator("button.fd-friends").click();await page.getByText("bob friend",{exact:true}).waitFor();expect(await page.getByText("alice friend",{exact:true}).count()).toBe(0);expect(page.url()).toBe("https://bunnyhop.lol/native-social-unit");
 }finally{await browser.close();}
},10_000);

test("credits screen renders and its links go to the system browser",async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
 await page.route("**/*",route=>route.request().url()==="https://bunnyhop.lol/native-credits-unit"?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
 await page.addInitScript(()=>{(window as unknown as {messages:unknown[]}).messages=[];window.addEventListener("bunnyhop:native-message",event=>(window as unknown as {messages:unknown[]}).messages.push((event as CustomEvent).detail));});
 await page.goto("https://bunnyhop.lol/native-credits-unit",{waitUntil:"domcontentloaded"});
 await page.getByRole("button",{name:"Credits",exact:true}).click();
 expect(await page.locator(".native-credits .credits-people li").count()).toBe(2);
 await page.getByRole("button",{name:"bunnyhop.lol",exact:true}).click();
 expect(await page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1))).toEqual({type:"openExternal",url:"https://bunnyhop.lol/"});
 expect(errors).toEqual([]);
 }finally{await browser.close();}
},15_000);

test("settings search, HUD positions and strafe trainer options",async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1600,height:900}}),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
 await page.route("**/*",route=>route.request().url()==="https://bunnyhop.lol/native-hud-unit"?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
 await page.addInitScript(()=>{(window as unknown as {messages:unknown[]}).messages=[];window.addEventListener("bunnyhop:native-message",event=>(window as unknown as {messages:unknown[]}).messages.push((event as CustomEvent).detail));});
 const last=()=>page.evaluate(()=>(window as unknown as {messages:unknown[]}).messages.at(-1));
 await page.goto("https://bunnyhop.lol/native-hud-unit",{waitUntil:"domcontentloaded"});page.setDefaultTimeout(3000);
 await page.getByRole("button",{name:"Settings",exact:true}).click();
 // Untouched elements show their built-in place: the timer is centred, 154/900 up from the bottom.
 expect(await page.getByLabel("Timer X",{exact:true}).inputValue()).toBe("50");
 expect(await page.getByLabel("Timer Y",{exact:true}).inputValue()).toBe("82.9");
 await page.locator(".nset-advanced > summary",{hasText:"positions"}).click();
 await page.getByLabel("Timer Y",{exact:true}).fill("40");await page.getByLabel("Timer Y",{exact:true}).blur();
 expect(await last()).toEqual({type:"settings",patch:{hudLayout:{timer:{x:50,y:40}}}});
 await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{hudLayout:{timer:{x:50,y:40}}}}));
 await page.locator(`button[title="Put Timer back where it was"]`).click();
 expect(await last()).toEqual({type:"settings",patch:{hudLayout:{}}});
 // Strafe trainer: smoothing and hints follow the trainer switch.
 expect(await page.getByLabel("Average over",{exact:true}).isDisabled()).toBe(true);
 await page.getByLabel("Strafe trainer",{exact:true}).check();
 expect(await last()).toEqual({type:"settings",patch:{strafeTrainer:true}});
 await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{strafeTrainer:true}}));
 expect(await page.getByLabel("Average over",{exact:true}).isDisabled()).toBe(false);
 await page.getByRole("radio",{name:"Every N"}).click();
 expect(await last()).toEqual({type:"settings",patch:{jumpStatsMode:"interval"}});
 // Search narrows every section to matching rows, and finds rows inside Advanced.
 await page.getByLabel("Search settings").fill("deadtime");
 expect(await page.locator(".nset-row:visible").count()).toBe(1);
 expect(await page.getByLabel("Hints",{exact:true}).isVisible()).toBe(true);
 await page.getByLabel("Search settings").fill("crosshair");
 expect(await page.getByLabel("Crosshair X",{exact:true}).isVisible()).toBe(true);
 await page.getByLabel("Search settings").fill("zzzz");
 expect(await page.getByText("No settings match.").isVisible()).toBe(true);
 await page.getByLabel("Search settings").fill("");
 expect(await page.getByLabel("Field of view",{exact:true}).isVisible()).toBe(true);
 // Turnbinds: yaw speed slider and box show the same number; the modifier has its own speed and bind.
 await page.getByLabel("Search settings").fill("yawspeed");
 expect(await page.getByLabel("Yaw speed",{exact:true}).inputValue()).toBe("118.888888");
 await page.getByLabel("Yaw speed",{exact:true}).fill("170");await page.getByLabel("Yaw speed",{exact:true}).blur();
 expect(await last()).toEqual({type:"settings",patch:{yawSpeed:170}});
 expect(await page.getByLabel("Yaw speed slider",{exact:true}).inputValue()).toBe("170");
 expect(await page.getByLabel("Modifier yaw speed",{exact:true}).inputValue()).toBe("210");
 await page.getByLabel("Modifier yaw speed",{exact:true}).fill("90");await page.getByLabel("Modifier yaw speed",{exact:true}).blur();
 expect(await last()).toEqual({type:"settings",patch:{yawSpeedAlt:90}});
 await page.getByLabel("Search settings").fill("");
 expect(await page.getByLabel("Turn modifier (alt yaw speed) binding").first().textContent()).toContain("4");
 expect(await page.getByLabel("Turn left (+left) binding").textContent()).not.toBe("Unbound");
 await page.getByRole("button",{name:"HUD",exact:true}).first().click();await page.waitForTimeout(400);
 await page.screenshot({path:resolve(import.meta.dir,"../../../target/native-menu/settings-hud.png")});
 expect(errors).toEqual([]);
 }finally{await browser.close();}
},20_000);
