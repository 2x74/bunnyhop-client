// Build-time conversion only; the desktop client renders text and mixes audio natively.
import { SFX } from "../../web/src/audio/catalog";
import { gunById } from "../../web/src/viewmodel/guns/index";
import { mkdir, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
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
// Never reintroduce review-only samples, including stale PCM from a previous build.
const omittedCues=new Set(["announcer_perfect","announcer_godlike","announcer_holyshit"]);
for(const id of omittedCues)delete manifest.sfx[id];
for(const file of await readdir(join(out,"audio")))
  if([...omittedCues].some(id=>file.startsWith(id+"-")))await rm(join(out,"audio",file));
const tasks:{id:string;source:string;dest:string}[]=[];
for(const [id,entry] of Object.entries(manifest.sfx) as [string,{variants:number}][])
  for(let i=1;i<=entry.variants;i++)tasks.push({id,source:join(source,"sfx",`${id}-${i}.webm`),dest:join(out,"audio",`${id}-${i}.f32`)});
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
manifest.mix=Object.fromEntries(Object.entries(SFX).filter(([id])=>!omittedCues.has(id)));manifest.guns=weaponIds.map(id=>gunById(id)?.sounds??null);
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
