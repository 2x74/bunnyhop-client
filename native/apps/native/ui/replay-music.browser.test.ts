import {test,expect} from "bun:test";
import {chromium} from "playwright";
import {readFile} from "node:fs/promises";

test("MP4 soundtrack selection uses the native pack, explicit offsets, levels and independent gameplay audio",async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1100}});page.setDefaultTimeout(5000);
  const html=await readFile(new URL("../../../target/native-menu/menu.html",import.meta.url),"utf8"),errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",r=>r.request().url()==="https://bunnyhop.lol/replay-music"?r.fulfill({contentType:"text/html",body:html}):r.abort());
  await page.addInitScript(()=>{localStorage.setItem("bunnyhop:onboarded","1");Object.assign(window,{messages:[]});window.addEventListener("bunnyhop:native-message",e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto("https://bunnyhop.lol/replay-music");await page.getByRole("button",{name:"Replays",exact:true}).click();
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({playback:{active:true,id:"test",tick:37,totalTicks:1000,tickInterval:.01,paused:true,speed:1},videoExport:{available:true,state:"idle",musicTracks:[{id:"game-airstrafe",title:"Airstrafe"},{id:"custom.wav",title:"My song"},{id:42,title:"invalid"}]}}));
  const track=page.getByLabel("Video music track",{exact:true}),save=page.getByRole("button",{name:"Save MP4 to Downloads",exact:true});
  expect(await track.inputValue()).toBe("none");expect(await track.locator("option").allTextContents()).toEqual(["No music","Airstrafe","My song"]);
  expect(await page.getByLabel("Music start offset seconds",{exact:true}).isDisabled()).toBe(true);
  await save.click();expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="videoExport").at(-1))).toMatchObject({action:"start",options:{audio:true,music:"none",musicOffset:0,musicLevel:1}});
  await track.selectOption("custom.wav");await page.getByLabel("Music start offset seconds",{exact:true}).fill("12.5");await page.getByLabel("Export music level",{exact:true}).fill("0.4");await page.getByLabel("Loop export music",{exact:true}).uncheck();await page.getByLabel("Include gameplay audio",{exact:true}).uncheck();
  expect(await page.getByLabel("Duck music under gameplay audio",{exact:true}).isDisabled()).toBe(true);
  await save.click();expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==="videoExport").at(-1))).toEqual({type:"videoExport",action:"start",options:{width:1280,height:720,fps:60,quality:"high",camera:"eye",hud:true,audio:false,music:"custom.wav",musicOffset:12.5,musicLevel:.4,musicLoop:false,musicDuck:true,from:0,to:1000}});
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({settings:{muteMusic:true}}));expect(await page.getByText("Music is muted in Sound settings.",{exact:true}).isVisible()).toBe(true);
  // Switching music packs invalidates a stale selection and never substitutes an arbitrary song.
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({videoExport:{musicTracks:[{id:"game-airstrafe",title:"Airstrafe"}]}}));expect(await track.inputValue()).toBe("none");
  await page.evaluate(()=>window.bunnyhopNativeMenu.onState({videoExport:{state:"capturing"}}));expect(await track.isDisabled()).toBe(true);expect(await save.isDisabled()).toBe(true);
  expect(errors).toEqual([]);
 }finally{await browser.close();}
},20_000);
