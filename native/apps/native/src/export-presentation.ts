// Build-time conversion only; the desktop client renders text and mixes audio natively.
import { CLASSIC_SOUNDS } from "../../web/src/audio/classic-map";
import { SFX } from "../../web/src/audio/catalog";
import { supporterGiftWave } from "../../web/src/audio/gift";
import { GunAnimator,type BaseClip,type Cue } from "../../web/src/viewmodel/guns/anim";
import { gunById } from "../../web/src/viewmodel/guns/index";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exportMusic } from "./export-music";
const root=resolve(import.meta.dir,"../../..");
const out=resolve(Bun.argv[2]??join(root,"target/native-assets"));
await mkdir(join(out,"audio"),{recursive:true});
const resvgPath=Bun.resolveSync("@resvg/resvg-wasm",root);
const {initWasm,Resvg}=await import(resvgPath);
await initWasm(await readFile(join(dirname(resvgPath),"index_bg.wasm")));
const font=await readFile(join(root,"tools/hermes/fonts/JetBrainsMono-Bold.ttf"));
const escape=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const texts=Array.from({length:95},(_,i)=>`<text x="${i%16*40+2}" y="${Math.floor(i/16)*52+42}">${escape(String.fromCharCode(i+32))}</text>`).join("");
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="312"><g font-family="JetBrains Mono" font-weight="700" font-size="40" fill="white">${texts}</g></svg>`;
const r=new Resvg(svg,{font:{fontBuffers:[font],loadSystemFonts:false,defaultFontFamily:"JetBrains Mono"}});
const image=r.render();
await writeFile(join(out,"hud.rgba"),image.pixels);
image.free();r.free();
const source=join(root,"apps/web/src/assets/audio");
const manifest=JSON.parse(await readFile(join(source,"manifest.json"),"utf8"));
const nativeAudio=join(root,"apps/native/assets/audio");
const nativeManifest=JSON.parse(await readFile(join(nativeAudio,"manifest.json"),"utf8"));
Object.assign(manifest.sfx,nativeManifest.sfx);
manifest.credits=[...new Set([...(manifest.credits??[]),...(nativeManifest.credits??[])])];
const tasks:{id:string;source:string;dest:string}[]=[];
for(const [id,entry] of Object.entries(manifest.sfx) as [string,{variants:number}][])
  for(let i=1;i<=entry.variants;i++)tasks.push({id,source:Object.hasOwn(nativeManifest.sfx,id)?join(nativeAudio,`${id}-${i}.webm`):join(source,"sfx",`${id}-${i}.webm`),dest:join(out,"audio",`${id}-${i}.f32`)});
let next=0;
await Promise.all(Array.from({length:4},async()=>{
  while(next<tasks.length) {
    const task=tasks[next++];
    const input=await stat(task.source);
    const existing=await stat(task.dest).catch(()=>null);
    if(existing && existing.mtimeMs>=input.mtimeMs && existing.size>0)continue;
    const process=Bun.spawn(["ffmpeg","-v","error","-y","-i",task.source,"-ar","22050","-ac","1","-f","f32le",task.dest],{stdout:"ignore",stderr:"pipe"});
    if(await process.exited)throw Error(`Native audio conversion failed for ${task.id}: ${await new Response(process.stderr).text()}`);
  }
}));
const weaponIds=["","knife","glock","usp","p228","deagle","elite","fiveseven","m3","xm1014","mac10","tmp","mp5navy","ump45","p90","galil","famas","ak47","m4a1","sg552","aug","scout","awp","g3sg1","sg550","m249"];
manifest.classic=CLASSIC_SOUNDS;manifest.mix=Object.fromEntries(Object.entries(SFX));manifest.guns=weaponIds.map(id=>gunById(id)?.sounds??null);
// Capture the authored animation cue schedule at build time. These are the
// web animator's actual timestamps, including the silencer's individual turns.
manifest.weaponAudio=weaponIds.map(id=>{
  const def=gunById(id);if(!def)return null;const anim=new GunAnimator(def);
  const cues=(clip:BaseClip,duration:number,empty=false,on=false)=>{anim.play(clip,duration,true,empty,on);return (anim as unknown as {cues:[number,Cue,number][]}).cues;};
  const reload=def.timing.reload??2.4,shells=def.timing.shells;
  return {timing:def.timing,draw:cues("draw",Math.min(def.timing.draw,1)*.85),reload:cues("reload",reload),reloadEmpty:cues("reload",reload,true),
    shellInsert:cues("shellInsert",shells?.each??.5),shellEnd:cues("shellEnd",shells?.end??.5),silencerOn:cues("silencer",114/37,false,true),silencerOff:cues("silencer",114/37,false,false)};
});
const gift=supporterGiftWave(22050);await writeFile(join(out,"audio/supporter_gift-1.f32"),new Uint8Array(gift.buffer));manifest.sfx.supporter_gift={variants:1,durations:[gift.length/22050]};
exportMusic(out,manifest.music);
await writeFile(join(out,"audio.json"),JSON.stringify(manifest));
console.log(`Native presentation assets: 95 font glyphs, ${tasks.length} sound variants, ${manifest.music.length} bundled OST tracks`);

// Keep lesson geometry, BSP identity and original deterministic demonstration recordings together.
const tutorial=JSON.parse(await readFile(join(root,"maps/bhop_lol_tutorial.tutorial.json"),"utf8"));
await mkdir(join(out,"tutorial"),{recursive:true});
for(const lesson of tutorial.lessons){
  for(const [field,key,suffix] of [["demo","nativeDemo",""],["demoLegit","nativeDemoLegit","-legit"]]){
    if(typeof lesson[field]!=="string"||!lesson[field])continue;
    const file=`${lesson.id}${suffix}.bhr`;await writeFile(join(out,"tutorial",file),Buffer.from(lesson[field],"base64"));lesson[key]=file;delete lesson[field];
  }
}
await writeFile(join(out,"tutorial.json"),JSON.stringify(tutorial));
console.log("Native tutorial: bundled SHA-bound lessons and original BHR demonstrations");
