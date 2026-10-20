import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("identical host state and timer-only updates retain visible menu controls",async()=>{
  const html=await readFile(resolve(import.meta.dir,"../../../target/native-menu/menu.html"),"utf8");
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:720}});
    const errors:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    // Fully offline: this regression must not create guest accounts or access
    // production API endpoints. API failures use the real UI's offline state.
    await page.route("**/*",route=>route.request().url()==="https://bunnyhop.lol/native-menu-unit"
      ?route.fulfill({status:200,contentType:"text/html",body:html}):route.abort());
    await page.goto("https://bunnyhop.lol/native-menu-unit",{waitUntil:"domcontentloaded"});
    const immediate=await page.evaluate(()=>{
      const value=()=>({button:Number(getComputedStyle(document.querySelector(".home-item")!).opacity),brand:Number(getComputedStyle(document.querySelector(".wm-text")!).opacity)});
      const initial=value();
      window.bunnyhopNativeMenu.onState({loading:"Reading map content"});
      return {initial,loading:value()};
    });
    expect(immediate.initial.button).toBeGreaterThan(0);expect(immediate.initial.brand).toBe(1);
    expect(immediate.loading.button).toBeGreaterThan(0);expect(immediate.loading.brand).toBe(1);
    const stable=await page.evaluate(async()=>{
      const state={map:"",loading:"",error:"",paused:true,sensitivity:2,engine:"native",renderer:"opengl"};
      window.bunnyhopNativeMenu.onState(state);
      const original=document.querySelector(".native-home-actions");
      for(let tick=0;tick<12;tick++) {
        window.bunnyhopNativeMenu.onState({...state,timer:{tick}});
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      window.bunnyhopNativeMenu.onState({...state,timer:{status:2,seconds:61.234,jumps:12,strafes:34,sync:98.3}});
      const time=document.querySelector(".native-finish-time")?.textContent;
      const summary=document.querySelector(".native-finish-stats")?.textContent;
      // A local development finish returns a retention notice without a request.
      // Its message must not erase the authoritative native finish summary.
      window.bunnyhopNativeMenu.onRunEvent({type:"reset",generation:9});
      window.bunnyhopNativeMenu.onRunEvent({type:"finish",generation:9,map:"bhop_eazy",track:0,style:"autohop",build:"bunnyhop-native/local",wasm:"",replayBase64:""});
      await Promise.resolve();
      return {same:document.querySelector(".native-home-actions")===original,
        opacity:getComputedStyle(document.querySelector(".home-item")!).opacity,
        time,summary,afterNotice:document.querySelector(".native-finish-time")?.textContent,notice:document.getElementById("native-notice")?.textContent,
        webgl:window.__nativeMenuGraphics,canvases:document.querySelectorAll("canvas").length};
    });
    expect(stable.same).toBe(true);expect(Number(stable.opacity)).toBeGreaterThan(.99);
    expect(stable.time).toBe("01:01.234");expect(stable.afterNotice).toBe(stable.time);
    expect(stable.summary).toBe("12 jumps · 34 strafes · 98.3% sync");expect(stable.notice).toContain("manifest is missing or stale");
    expect(stable.webgl).toEqual({contexts:0,attempts:0});expect(stable.canvases).toBe(0);expect(errors).toEqual([]);
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    const input=await page.evaluate(()=>{
      const original=document.querySelector<HTMLInputElement>(".native-sensitivity")!;original.value="1.55";
      window.bunnyhopNativeMenu.onState({timer:{status:0,seconds:NaN,jumps:Infinity}});
      return {same:original===document.querySelector(".native-sensitivity"),value:original.value};
    });
    expect(input).toEqual({same:true,value:"1.55"});
  } finally {await browser.close();}
},10_000);
