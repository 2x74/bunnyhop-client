import {test,expect} from "bun:test";
import {chromium} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
test("native presets persist and apply supported settings; typo search and HUD dragging work",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1600,height:900}});page.setDefaultTimeout(5000);
  const html=await readFile(new URL("../../../target/native-menu/menu.html",import.meta.url),"utf8");
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",r=>r.request().url()==="https://bunnyhop.lol/settings-parity"?r.fulfill({contentType:"text/html",body:html}):r.abort());
  await page.addInitScript(()=>{localStorage.setItem("bunnyhop:onboarded","1");Object.assign(window,{messages:[]});window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto("https://bunnyhop.lol/settings-parity");await page.getByRole("button",{name:"Settings",exact:true}).click();
  const search=page.getByLabel("Search settings");await search.fill("sensitivty");
  await page.getByRole("button",{name:"sensitivity",exact:true}).click();expect(await search.inputValue()).toBe("sensitivity");
  expect(await page.getByLabel("Mouse sensitivity",{exact:true}).isVisible()).toBe(true);
  await page.getByLabel("Mouse sensitivity",{exact:true}).fill("3.25");await page.getByLabel("Mouse sensitivity",{exact:true}).blur();
  await search.fill("presets");await page.getByRole("button",{name:"Save as new…",exact:true}).click();
  await page.getByLabel("Preset name",{exact:true}).fill("Practice");await page.getByRole("dialog").getByRole("button",{name:"Save",exact:true}).click();
  await page.waitForFunction(()=> (document.querySelector('[aria-label="Settings preset"]') as HTMLSelectElement)?.value==="Practice");
  expect(await page.getByLabel("Settings preset",{exact:true}).inputValue()).toBe("Practice");
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("bunnyhop:native-settings-presets:v1")!).list[0].name)).toBe("Practice");
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("bunnyhop:native-settings-presets:v1")!).list[0].settings.sensitivity)).toBe(3.25);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{sensitivity:8}}));
  expect(await page.getByLabel("Settings preset",{exact:true}).textContent()).toContain("Practice (modified)");
  await page.getByRole("button",{name:"Save as new…",exact:true}).click();await page.getByLabel("Preset name",{exact:true}).fill("Fast");await page.getByRole("dialog").getByRole("button",{name:"Save",exact:true}).click();
  await page.waitForFunction(()=> (document.querySelector('[aria-label="Settings preset"]') as HTMLSelectElement)?.value==="Fast");
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{sensitivity:9}}));
  await page.getByLabel("Settings preset",{exact:true}).selectOption("Practice");
  await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  expect(await page.getByLabel("Settings preset",{exact:true}).inputValue()).toBe("Fast");
  await page.getByLabel("Settings preset",{exact:true}).selectOption("Practice");
  await page.getByRole("dialog").getByRole("button",{name:"Switch",exact:true}).click();
  await page.waitForFunction(()=> (window as any).messages.some((m:any)=>m.type==="settings"));
  expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="settings").at(-1).patch.sensitivity)).not.toBe(8);
  await page.getByRole("button",{name:"Rename…",exact:true}).click();await page.getByLabel("Preset name",{exact:true}).fill("Slow");await page.getByRole("dialog").getByRole("button",{name:"Rename",exact:true}).click();
  await page.waitForFunction(()=> (document.querySelector('[aria-label="Settings preset"]') as HTMLSelectElement)?.value==="Slow");
  expect(await page.getByLabel("Settings preset",{exact:true}).inputValue()).toBe("Slow");
  await page.getByRole("button",{name:"Delete…",exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:"Delete",exact:true}).click();
  await page.waitForFunction(()=> (document.querySelector('[aria-label="Settings preset"]') as HTMLSelectElement)?.value==="");
  expect(await page.getByLabel("Settings preset",{exact:true}).inputValue()).toBe("");
  await search.fill("drag");const move=page.getByRole("button",{name:"Move Timer",exact:true});await move.scrollIntoViewIfNeeded();
  const box=(await move.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+80,box.y+box.height/2-40,{steps:5});await page.mouse.up();await page.waitForTimeout(130);
  const at=await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="settings"&&m.patch.hudLayout).at(-1).patch.hudLayout.timer);
  expect(at.x).toBeGreaterThan(50);expect(at.y).toBeLessThan(83);
  await move.press("ArrowLeft");await page.waitForTimeout(130);
  expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="settings"&&m.patch.hudLayout).at(-1).patch.hudLayout.timer.x)).toBeCloseTo(at.x-1,1);
  // Selecting “No preset” removes the association without changing live settings.
  await search.fill("presets");await page.getByLabel("Settings preset",{exact:true}).selectOption("Fast");
  const confirmation=page.getByRole("dialog");if(await confirmation.count())await confirmation.getByRole("button",{name:"Switch",exact:true}).click();
  await page.getByLabel("Settings preset",{exact:true}).selectOption("");expect(await page.getByLabel("Settings preset",{exact:true}).inputValue()).toBe("");
  // A pending dialog cannot save a preset after the owning screen was removed by the host.
  await page.getByRole("button",{name:"Save as new…",exact:true}).click();await page.getByLabel("Preset name",{exact:true}).fill("Detached");
  await page.evaluate(()=>window.bunnyhopNativeMenu.open?.("home"));await page.getByRole("dialog").getByRole("button",{name:"Save",exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("bunnyhop:native-settings-presets:v1")!).list.some((p:any)=>p.name==="Detached"))).toBe(false);
  if(process.env.NATIVE_UI_ARTIFACTS){await mkdir(process.env.NATIVE_UI_ARTIFACTS,{recursive:true});await page.evaluate(()=>window.bunnyhopNativeMenu.open?.("settings","hud-editor"));await page.waitForFunction(()=>{const r=document.querySelector('[aria-label="HUD placement canvas"]')?.getBoundingClientRect();const bounds=document.querySelector(".nset-scroll")?.getBoundingClientRect();return r&&bounds&&r.top>=bounds.top&&r.bottom<=bounds.bottom-2;});expect(await page.evaluate(()=>{const canvas=document.querySelector('[aria-label="HUD placement canvas"]')!,r=canvas.getBoundingClientRect();return [...canvas.querySelectorAll("button")].every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;});})).toBe(true);await page.waitForTimeout(100);await page.screenshot({path:process.env.NATIVE_UI_ARTIFACTS+"/hud-editor-fixture.png"});}
  await page.setViewportSize({width:800,height:600});await page.evaluate(()=>window.bunnyhopNativeMenu.open?.("settings"));await page.getByLabel("Search settings").fill("drag");
  const canvas=page.getByLabel("HUD placement canvas");const bounds=(await canvas.boundingBox())!;expect(bounds.width/bounds.height).toBeCloseTo(800/600,1);
  const timer=page.getByRole("button",{name:"Move Timer",exact:true});await timer.scrollIntoViewIfNeeded();await timer.focus();const timerBox=(await timer.boundingBox())!;
  await page.mouse.move(timerBox.x+timerBox.width/2,timerBox.y+timerBox.height/2);await page.mouse.down();
  await timer.evaluate(el=>el.dispatchEvent(new PointerEvent("lostpointercapture",{pointerId:1})));
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{hudLayout:{timer:{x:30,y:40}}}}));expect(await timer.evaluate(el=>el.style.left)).toBe("30%");await page.mouse.up();
  expect(errors).toEqual([]);
 }finally{await browser.close();}
},20000);
