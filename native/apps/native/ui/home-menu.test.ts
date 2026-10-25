import {test,expect} from "bun:test";
import type {} from "./home-menu";
import {chromium} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";

test("home navigation, pause, loading and responsive presentation remain accessible",async()=>{
  const out=resolve(import.meta.dir,"../../../target/native-menu/redesign");await mkdir(out,{recursive:true});
  const html=await readFile(resolve(out,"../menu.html"),"utf8");
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:720},reducedMotion:"reduce"});
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(3000);
    await page.route("**/*",r=>r.request().url()==="https://bunnyhop.lol/menu-redesign-test"?r.fulfill({status:200,contentType:"text/html",body:html}):r.abort());
    await page.addInitScript(()=>{(window as any).messages=[];window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
    await page.goto("https://bunnyhop.lol/menu-redesign-test",{waitUntil:"domcontentloaded"});
    expect(await page.locator(".native-home-actions .primary").getAttribute("aria-label")).toBe("Play");
    expect(await page.getByRole("group",{name:"Your game",exact:true}).getByRole("button").count()).toBe(4);
    await page.getByRole("button",{name:"Play",exact:true}).focus();
    await page.keyboard.press("ArrowDown");expect(await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"))).toBe("Play online");
    await page.keyboard.press("End");expect(await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"))).toBe("Quit");
    await page.keyboard.press("Home");expect(await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"))).toBe("Play");
    for(const [button,screen] of [["Play","maps"],["Play online","servers"],["Tutorial","tutorial"],["Loadout","loadout"],["Ranks","ranks"],["Statistics","stats"],["Replays","replays"],["Settings","settings"],["Credits","credits"]]) {
      await page.getByRole("button",{name:button,exact:true}).click();expect(await page.locator("body").getAttribute("data-screen")).toBe(screen);
      await page.keyboard.press("Escape");expect(await page.locator("body").getAttribute("data-screen")).toBe("home");
    }
    await page.getByRole("combobox",{name:"Play style"}).selectOption("scroll");
    expect(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==="style"&&m.id==="scroll"))).toBe(true);
    await page.getByRole("button",{name:"Quit",exact:true}).click();
    expect(await page.evaluate(()=>(window as any).messages.at(-1).type)).toBe("quit");
    await page.getByRole("combobox",{name:"Play style"}).selectOption("autohop");
    await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
    await page.mouse.move(1270,70);
    await page.screenshot({path:resolve(out,"home-1280x720.png")});
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"bhop_eazy",paused:true,timer:{status:2,seconds:61.234,jumps:12,strafes:34,sync:98.3}}));
    expect(await page.locator(".native-current h2").textContent()).toBe("bhop_eazy");
    expect(await page.locator(".native-home-actions .primary").getAttribute("aria-label")).toBe("Resume");
    expect(await page.locator(".native-finish-time").textContent()).toBe("01:01.234");
    await page.getByRole("button",{name:"Restart",exact:true}).click();expect(await page.evaluate(()=>(window as any).messages.at(-1).type)).toBe("restart");
    await page.getByRole("button",{name:"Resume",exact:true}).click();expect(await page.evaluate(()=>(window as any).messages.at(-1).type)).toBe("resume");
    await page.keyboard.press("Escape");expect(await page.evaluate(()=>(window as any).messages.at(-1).type)).toBe("resume");
    await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
    await page.screenshot({path:resolve(out,"pause-1280x720.png")});
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:"Reading map…"}));
    expect(await page.locator(".native-home-actions button:enabled").count()).toBe(0);
    expect(await page.getByRole("combobox",{name:"Play style"}).isDisabled()).toBe(true);
    await page.evaluate(()=>window.bunnyhopNativeMenu.onState({loading:false}));
    // Test the host-provided PNG path as well as the standalone fallback. The
    // native scene smoke produces optional visual evidence; CI uses a 1px PNG.
    let scene:string;
    try {scene=(await readFile(resolve(out,"native-scene.png"))).toString("base64");}
    catch {scene="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4b8AAAAASUVORK5CYII=";}
    await page.evaluate(source=>window.bunnyhopNativeBackdrop?.("data:image/png;base64,"+source),scene);
    await page.waitForFunction(()=>document.documentElement.dataset.nativeBackdrop==="static");
    await page.screenshot({path:resolve(out,"pause-static-1280x720.png")});
    for(const paused of [true,false]) {
      await page.setViewportSize({width:640,height:600});
      if(!paused)await page.evaluate(()=>window.bunnyhopNativeMenu.onState({map:"",timer:{status:0}}));
      await page.getByRole("combobox",{name:"Play style"}).scrollIntoViewIfNeeded();
      const bounds=await page.getByRole("button",{name:"Quit",exact:true}).boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThan(600);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.mouse.move(639,0);
      await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
      await page.screenshot({path:resolve(out,`${paused?"pause":"home"}-640x600.png`)});
    }
    await page.setViewportSize({width:1280,height:720});
    await page.screenshot({path:resolve(out,"home-static-1280x720.png")});
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("javascript:alert(1)"));
    expect(await page.locator("html").getAttribute("data-native-backdrop")).toBe("static");
    await page.evaluate(()=>window.bunnyhopNativeBackdrop?.("native"));
    expect(await page.locator("html").getAttribute("data-native-backdrop")).toBe("scene");
    expect(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==="menuAppearance"&&m.reducedMotion===true))).toBe(true);
    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.waitForFunction(()=>(window as any).messages.some((m:any)=>m.type==="menuAppearance"&&m.reducedMotion===false));
    expect(await page.evaluate(()=>window.__nativeMenuGraphics)).toEqual({contexts:0,attempts:0});
    expect(await page.locator("canvas").count()).toBe(0);expect(errors).toEqual([]);
  } finally {await browser.close();}
},30_000);
