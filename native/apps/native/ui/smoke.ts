// Live service smoke: no mocked account/map/leaderboard records. No sign-in
// message is sent. Host messages are captured rather than performing game actions.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root=resolve(import.meta.dir,"../../..");
const out=resolve(root,"target/native-menu");
await mkdir(out,{recursive:true});
const html=await readFile(resolve(out,"menu.html"),"utf8");
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.emulateMedia({reducedMotion:"reduce"});
const errors:string[]=[], requests:{url:string,type:string,status?:number}[]=[];
page.on("pageerror",error=>errors.push(error.message));
page.on("response",response=>requests.push({url:response.url(),type:response.request().resourceType(),status:response.status()}));
await page.addInitScript(()=>{
  const w=window as unknown as {webkit:unknown;__hostMessages:unknown[];__wasmCalls:number};
  w.__hostMessages=[]; w.__wasmCalls=0;
  w.webkit={messageHandlers:{bunnyhop:{postMessage:(message:string)=>w.__hostMessages.push(JSON.parse(message))}}};
  for(const key of ["instantiate","instantiateStreaming"] as const) {
    const original=WebAssembly[key];
    (WebAssembly as unknown as Record<string,unknown>)[key]=(...args:unknown[])=>{w.__wasmCalls++;return (original as (...args:unknown[])=>unknown)(...args);};
  }
});
await page.route("https://bunnyhop.lol/native-menu-smoke",route=>route.fulfill({status:200,contentType:"text/html",body:html}));
try {
  await page.goto("https://bunnyhop.lol/native-menu-smoke",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>!!window.bunnyhopNativeMenu);
  await page.waitForResponse(response=>response.url().endsWith("/api/me"),{timeout:20000}).catch(()=>null);
  await page.screenshot({path:resolve(out,"menu-home.png")});
  await page.getByRole("button",{name:"Play",exact:true}).click();
  await page.locator(".mb-row").first().waitFor({timeout:30000});
  const mapCount=await page.locator(".mb-row").count();
  if(mapCount<1) throw new Error("Live map index did not populate");
  await page.getByRole("searchbox",{name:"Search maps"}).fill("bhop_eazy");
  await page.locator('.mb-row[data-name="bhop_eazy"]').click();
  await page.locator('.mbd-inner[data-name="bhop_eazy"]').waitFor();
  await page.screenshot({path:resolve(out,"menu-maps.png")});
  await page.locator(".mbd-play").click();
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",loading:"",error:"",paused:true,sensitivity:1.73,engine:"native",renderer:"opengl"}));
  await page.getByRole("button",{name:"Back",exact:true}).click();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("spinbutton",{name:"Mouse sensitivity"}).fill("2.4");
  await page.getByRole("spinbutton",{name:"Mouse sensitivity"}).press("Tab");
  await page.getByRole("button",{name:"Back",exact:true}).click();
  await page.locator(".name-btn").click();
  await page.locator("dialog.acct-dialog[open]").waitFor();
  await page.getByRole("button",{name:"Refresh account",exact:true}).waitFor({timeout:20000});
  await page.screenshot({path:resolve(out,"menu-account.png")});
  await page.getByRole("button",{name:"Close account",exact:true}).click();
  await page.getByRole("button",{name:/^Resume/}).click();
  const diagnostics=await page.evaluate(()=>({origin:location.origin,secure:isSecureContext,graphics:window.__nativeMenuGraphics,canvases:document.querySelectorAll("canvas").length,
    wasmCalls:(window as unknown as {__wasmCalls:number}).__wasmCalls,messages:(window as unknown as {__hostMessages:{type:string;[key:string]:unknown}[]}).__hostMessages}));
  if(errors.length) throw new Error(errors.join("\n"));
  if(diagnostics.graphics?.attempts!==0||diagnostics.graphics?.contexts!==0||diagnostics.canvases!==0||diagnostics.wasmCalls!==0) throw new Error("Menu tried to initialize gameplay rendering/simulation");
  if(!diagnostics.messages.some(message=>message.type==="selectMap"&&message.id==="bhop_eazy")) throw new Error("Map selection was not bridged");
  if(!diagnostics.messages.some(message=>message.type==="settings"&&(message.patch as {sensitivity?:number}|undefined)?.sensitivity===2.4)) throw new Error("Sensitivity was not bridged");
  if(!diagnostics.messages.some(message=>message.type==="resume")) throw new Error("Resume was not bridged");
  if(requests.some(request=>request.type==="script"||request.url.includes(".wasm"))) throw new Error("Menu requested external JavaScript/WASM");
  const report={pass:true,mapCount,diagnostics,errors,requests};
  await writeFile(resolve(out,"menu-smoke.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({pass:true,mapCount,...diagnostics},null,2));
} finally {await browser.close();}
