import {test,expect} from "bun:test";
import {chromium} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
test("audio channels, announcer configuration and classic content status cross the native bridge",async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1300}});page.setDefaultTimeout(5000);
  const html=await readFile(new URL("../../../target/native-menu/menu.html",import.meta.url),"utf8");const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",r=>r.request().url()==="https://bunnyhop.lol/audio-settings"?r.fulfill({contentType:"text/html",body:html}):r.abort());
  await page.addInitScript(()=>{localStorage.setItem("bunnyhop:onboarded","1");Object.assign(window,{messages:[]});window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto("https://bunnyhop.lol/audio-settings");await page.getByRole("button",{name:"Settings",exact:true}).click();await page.locator('[data-section="audio"]').click();
  const patch=async(key:string)=>page.evaluate(key=>(window as any).messages.filter((m:any)=>m.type==="settings"&&Object.hasOwn(m.patch,key)).at(-1)?.patch[key],key);
  for(const [label,key] of [["Mute sound effects","muteSfx"],["Mute UI cues","muteUi"],["Mute wind / ambience","muteAmbience"],["Classic CS:S sounds","classicSounds"]]){await page.getByLabel(label,{exact:true}).check();expect(await patch(key)).toBe(true);}
  await page.getByLabel("Wind / ambience level",{exact:true}).fill("0.35");await page.getByLabel("Wind / ambience level",{exact:true}).blur();expect(await patch("ambienceVolume")).toBe(.35);
  await page.getByLabel("Enable announcer",{exact:true}).check();expect((await patch("announcer")).enabled).toBe(true);
  await page.getByLabel("Speed threshold",{exact:true}).fill("1800");await page.getByLabel("Speed threshold",{exact:true}).blur();expect((await patch("announcer")).speedThreshold).toBe(1800);
  await page.getByLabel("Personal best",{exact:true}).selectOption("holyshit");expect((await patch("announcer")).pb).toBe("holyshit");
  await page.getByLabel("Personal best",{exact:true}).locator("..").getByRole("button",{name:"Preview"}).click();
  expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="announce").at(-1))).toMatchObject({event:"pb",preview:"holyshit"});
  await page.getByLabel("Longjump",{exact:true}).selectOption("godlike");expect((await patch("announcer")).lj).toBe("godlike");
  await page.getByLabel("Longjump distance threshold",{exact:true}).fill("270");await page.getByLabel("Longjump distance threshold",{exact:true}).blur();expect((await patch("announcer")).ljThreshold).toBe(270);
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({audio:{classicLoading:true,classicActive:false,classicStatus:"Loading Classic CS:S sounds…",sfxStatus:"",error:""}}));
  expect(await page.getByTestId("classic-audio-status").textContent()).toContain("Loading Classic");
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({audio:{classicLoading:false,classicActive:true,classicStatus:"Classic CS:S sounds active",sfxStatus:"",error:""}}));expect(await page.getByTestId("classic-audio-status").textContent()).toBe("Classic CS:S sounds active");
  // Capture the entire Audio section so all channel controls and the enabled LJ controls are reviewable.
  await page.evaluate(()=>{const original=document.querySelector("#nset-audio")!;const panel=original.cloneNode(true) as HTMLElement;const selects=panel.querySelectorAll("select");original.querySelectorAll("select").forEach((select,i)=>selects[i].value=select.value);document.body.replaceChildren(panel);Object.assign(document.body.style,{display:"block",overflow:"visible",height:"auto",width:"1200px",margin:"0",padding:"24px",container:"nset / inline-size"});});
  const dir=new URL("../../../artifacts/native-audio-gap-review/",import.meta.url);await mkdir(dir,{recursive:true});await page.locator("#nset-audio").screenshot({path:new URL("audio-settings.png",dir).pathname});
  expect(errors).toEqual([]);
 }finally{await browser.close();}
},20_000);
