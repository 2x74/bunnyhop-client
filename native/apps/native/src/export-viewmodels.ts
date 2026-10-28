// Build-time only: compile the site's original meshes, material recipes and procedural pose clips.
// Runtime gameplay uses C++/OpenGL and Rust; this compiler is never embedded in the application.
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Builder } from "../../web/src/player/bunny/builder";
import { concat, rig as bunnyRig } from "../../web/src/player/bunny/rig";
import { buildBunnyGeometry } from "../../web/src/player/bunny/mesh";
import { BunnyProcedural } from "../../web/src/player/bunny/procedural";
import { COSMETICS } from "../../web/src/progression";
import { COLOURWAYS } from "../../web/src/player/bunny/palettes";
import { HAT_FX_VERTEX_PARS,HAT_FX_VERTEX_NORMAL,HAT_FX_VERTEX_POSITION,HAT_FX_FRAGMENT_PARS,HAT_FX_FRAGMENT_SOLID } from "../../web/src/player/hat-fx";
import { hatGeometry } from "../../web/src/player/bunny/hats";
import { crownGeometry } from "../../web/src/player/bunny/crown";
import { vmRig } from "../../web/src/viewmodel/rig";
import { VmProcedural, PROC_DURATION, type VmAction } from "../../web/src/viewmodel/procedural";
import { buildFpHands } from "../../web/src/viewmodel/gloves/fp";
import { fpCtx, tpCtx } from "../../web/src/viewmodel/knives/ctx";
import { inspectSetFor } from "../../web/src/viewmodel/inspects/index";
import { Arm } from "../../web/src/viewmodel/inspects/kit";
import { KnifeHold } from "../../web/src/viewmodel/knives/hold";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { gunFpCtx, gunRig } from "../../web/src/viewmodel/guns/rig";
import { GunPoser } from "../../web/src/viewmodel/guns/pose";
import { GUNS, gunById } from "../../web/src/viewmodel/guns/index";
import { bunnyGunGeometry, bunnySilencerGeometry, worldGunGeometry } from "../../web/src/viewmodel/guns/meshes";
import { FINISH_STYLE, GLOVE_STYLE, GLOVE_STYLE_IDS } from "../../web/src/loadout";
import { FINISH_CODE, FRAGMENT_PARS, VERTEX_PARS, VERTEX_MAIN, GLOVE_FRAGMENT_ALBEDO, GLOVE_FRAGMENT_LIGHT } from "../../web/src/viewmodel/finishes/shader";
const directory=resolve(process.argv[2]??"target/native-assets");
const pieces:Buffer[]=[];let byteOffset=0;
const put=(data:Float32Array)=>{const offset=byteOffset;pieces.push(Buffer.from(data.buffer,data.byteOffset,data.byteLength));byteOffset+=data.byteLength;return offset;};
const meshes:Record<string,any>={},entries:Record<string,any>={};
const blobs=new Map<string,number>();
const putUnique=(v:Float32Array)=>{const key=createHash("sha256").update(new Uint8Array(v.buffer,v.byteOffset,v.byteLength)).digest("hex");const at=blobs.get(key);if(at!==undefined)return at;const offset=put(v);blobs.set(key,offset);return offset;};
function geometry(name:string,g:any){
  const p=g.getAttribute("position"),n=g.getAttribute("normal"),c=g.getAttribute("partColor"),a=g.getAttribute("accent"),ids=g.getAttribute("skinIndex"),weights=g.getAttribute("skinWeight"),finish=g.getAttribute("finishUV");
  // Body meshes are weapon-free: selected TP weapons render as separate parts.
  if(name.startsWith("body:")){const knifeBone=bunnyRig().index("bunny.Knife");for(let i=0;i<p.count;i++)for(let j=0;j<4;j++)if(ids.array[i*4+j]===knifeBone&&weights.array[i*4+j]>0)throw new Error("Embedded default knife in body: "+name);}
  const vertices=new Float32Array(p.count*22);
  for(let i=0;i<p.count;i++){
    const at=i*22;vertices.set([p.getX(i),p.getY(i),p.getZ(i),n.getX(i),n.getY(i),n.getZ(i),c.getX(i),c.getY(i),c.getZ(i)],at);
    for(let j=0;j<4;j++){vertices[at+9+j]=ids.array[i*4+j];vertices[at+13+j]=weights.array[i*4+j];vertices[at+18+j]=finish?.array[i*4+j]??0;}
    vertices[at+17]=a.getX(i);
  }
  // Index identical vertices; source builders intentionally emit triangle soup.
  const unique:number[]=[],indices=new Uint32Array(p.count),seen=new Map<string,number>();
  for(let i=0;i<p.count;i++){const view=new Uint8Array(vertices.buffer,i*22*4,22*4);const key=Buffer.from(view).toString("base64");let at=seen.get(key);if(at===undefined){at=unique.length/22;seen.set(key,at);for(let j=0;j<22;j++)unique.push(vertices[i*22+j]);}indices[i]=at;}
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = [p.getX(i).toFixed(4), p.getY(i).toFixed(4), p.getZ(i).toFixed(4),
      ...Array.from(ids.array.slice(i * 4, i * 4 + 4))].join(",");
    keys.push(key);
    const sum = sums.get(key) ?? [0, 0, 0];
    sum[0] += n.getX(i);
    sum[1] += n.getY(i);
    sum[2] += n.getZ(i);
    sums.set(key, sum);
  }
  const smooth = new Float32Array(unique.length / 22 * 3);
  for (let i = 0; i < p.count; i++) {
    const normal = sums.get(keys[i])!;
    const length = Math.hypot(...normal) || 1;
    smooth.set(normal.map(value => value / length), indices[i] * 3);
  }
  meshes[name]={glowOffset:putUnique(smooth),offset:putUnique(new Float32Array(unique)),vertices:unique.length/22,indexOffset:putUnique(new Float32Array(indices.buffer)),indices:indices.length};g.dispose();
}
const vr=vmRig(),gr=gunRig(),br=bunnyRig();
for(const glove of GLOVE_STYLE_IDS){const b=new Builder();buildFpHands(b,glove);geometry(`hands:${glove}`,b.geometry());}
for(const def of KNIVES){const b=new Builder();def.build(fpCtx(b));geometry(`fpknife:${def.id}`,b.geometry());const tp=new Builder();def.build(tpCtx(tp,def.tp));geometry(`tpknife:${def.id}`,tp.geometry());}
for(const def of GUNS){const b=new Builder();const ctx=gunFpCtx(b);def.build(ctx);def.silencer?.build(ctx);geometry(`fpgun:${def.id}`,b.geometry());geometry(`tpgun:${def.id}`,bunnyGunGeometry(def,br.bone("R_Hand")).clone());geometry(`worldgun:${def.id}`,worldGunGeometry(def).clone());const sil=bunnySilencerGeometry(def,br.bone("R_Hand"));if(sil)geometry(`tpsilencer:${def.id}`,sil.clone());}
for(const glove of GLOVE_STYLE_IDS){
  for(const def of KNIVES){
    const proc=new VmProcedural(vr),hold=new KnifeHold(def,vr,glove),W=new Float32Array(vr.names.length*12),S=new Float32Array(W.length),clips=[];
    for(const action of ["idle","draw","slash1","slash2","stab"] as VmAction[]){
      const duration=action==="idle"?0:PROC_DURATION[action],frames=duration?Math.ceil(duration*60)+1:1,baked=new Float32Array(frames*S.length);
      for(let f=0;f<frames;f++){const t=Math.min(duration,f/60);proc.pose(action,t,W);hold.apply(W,action,t,"procedural");for(let i=0;i<vr.names.length;i++)concat(W,i*12,vr.inv,i*12,S,i*12);baked.set(S,f*S.length);}
      clips.push({name:action,duration,frames,offset:putUnique(baked)});
    }
    const inspect=inspectSetFor(def),arm=new Arm(vr);
    for(let j=0;j<inspect.clips.length;j++){
      const c=inspect.clips[j],frames=Math.ceil(c.len*60)+1,baked=new Float32Array(frames*S.length);
      for(let f=0;f<frames;f++){const t=Math.min(c.len,f/60);proc.pose("idle",0,W);hold.state.show=c.show?.(t)??0;hold.apply(W,"idle",0,"procedural");c.apply(W,t,{arm,knife:def,state:hold.state});for(let i=0;i<vr.names.length;i++)concat(W,i*12,vr.inv,i*12,S,i*12);baked.set(S,f*S.length);}
      clips.push({name:`inspect${j}`,duration:c.len,frames,offset:putUnique(baked)});
    }
    entries[`knife:${def.id}:${glove}`]={bones:vr.names.length,meshes:[`hands:${glove}`,`fpknife:${def.id}`],clips};
  }
  for(const def of GUNS){
    const clips=[];
    const actions=["idle","draw","fire","reload","reloadEmpty","inspect",...(def.timing.shells?["shellStart","shellInsert","shellEnd"]:[]),...(def.silencer?["silencerOn","silencerOff"]:[])];
    for(const action of actions)for(const silenced of def.silencer&&!action.startsWith("silencer")?[false,true]:[false]){
      const poser=new GunPoser();poser.setGun(def,glove);poser.anim.silenced=silenced;
      const duration=action==="idle"?0:action.startsWith("reload")?(def.timing.reload??2.5):action==="fire"?.8:action==="inspect"?2.4:action==="shellStart"?(def.timing.shells?.start??.45):action==="shellInsert"?(def.timing.shells?.each??.5):action==="shellEnd"?(def.timing.shells?.end??.6):action.startsWith("silencer")?114/37:Math.min(def.timing.draw,1)*.85;
      if(action==="draw")poser.draw();else if(action==="fire")poser.anim.fire();else if(action.startsWith("reload"))poser.anim.reload(duration,action==="reloadEmpty");else if(action==="inspect")poser.anim.inspect();else if(action==="shellStart")poser.anim.shellStart(duration);else if(action==="shellInsert")poser.anim.shellInsert(duration);else if(action==="shellEnd")poser.anim.shellEnd(duration);else if(action.startsWith("silencer"))poser.anim.silencer(action==="silencerOn",duration);
      // Thirty pose samples/sec with interpolation retain the authored motion while bounding expanded gun assets.
      const frames=duration?Math.ceil(duration*30)+1:1,matrix=new Float32Array(gr.count*12),baked=new Float32Array(frames*matrix.length);
      for(let f=0;f<frames;f++){poser.update(f?1/30:0);matrix.set(poser.bonesW);for(let i=0;i<gr.hands.names.length;i++)concat(poser.bonesW,i*12,gr.hands.inv,i*12,matrix,i*12);baked.set(matrix,f*matrix.length);}
      clips.push({name:action+(silenced?":silenced":""),duration,frames,offset:putUnique(baked)});
    }
    entries[`gun:${def.id}:${glove}`]={bones:gr.count,meshes:[`hands:${glove}`,`fpgun:${def.id}`],clips};
  }
  console.log(`native assets: original knives/guns and ${glove} hands`);
}
for(const look of ["bunny","tek","plush","bune"] as const)for(const body of look==="bunny"?["classic","feminine"] as const:["classic"] as const)for(const glove of GLOVE_STYLE_IDS)geometry(`body:${look}:${body}:${glove}`,buildBunnyGeometry({...KNIVES[0],build:()=>{}},glove,look,body));
for(const tier of [1,2,3] as const)geometry(`crown:${tier}`,crownGeometry(tier).clone());
for(const id of ["hat-founder-crown","hat-tophat","hat-beanie","hat-gem-orbit","hat-halo","hat-circlet","hat-propeller","hat-capybara","hat-maxwell","hat-dealer-visor","hat-lucky-coins","hat-aurora"]){const g=hatGeometry(id);if(g)geometry(id,g.clone());}
{
  const clips=[];
  for(const action of ["idle","run","crouch","air","fall"])for(const pitch of [-60,0,60]){
    const random=Math.random;Math.random=()=>0;const actor=new BunnyProcedural();Math.random=random;
    const velocity=action==="run"?[250,0,0]:action==="air"?[100,0,200]:action==="fall"?[100,0,-300]:[0,0,0];
    const state={position:[0,0,0],velocity,yaw:0,pitch,crouched:action==="crouch",grounded:action!=="air"&&action!=="fall"};
    const duration=action==="run"?115/250:2,frames=Math.ceil(duration*60)+1,skin=new Float32Array(br.names.length*12),baked=new Float32Array(frames*skin.length);
    for(let f=0;f<frames;f++){actor.update(f?1/60:0,state,velocity,f===0,false,skin);for(let i=br.csBones;i<br.names.length;i++){const parent=br.parent[i];if(parent>=0)skin.copyWithin(i*12,parent*12,parent*12+12);}baked.set(skin,f*skin.length);}
    clips.push({name:`${action}:${pitch}`,duration,frames,offset:putUnique(baked)});
  }
  entries.bunny={bones:br.names.length,meshes:[],clips};
}
const ids=["","knife","glock","usp","p228","deagle","elite","fiveseven","m3","xm1014","mac10","tmp","mp5navy","ump45","p90","galil","famas","ak47","m4a1","sg552","aug","scout","awp","g3sg1","sg550","m249"];
await mkdir(directory,{recursive:true});
const compressed=deflateSync(Buffer.concat(pieces),{level:9});
await writeFile(resolve(directory,"viewmodels.bin.z"),compressed);
await rm(resolve(directory,"viewmodels.bin"),{force:true});
await writeFile(resolve(directory,"viewmodels.json"),JSON.stringify({version:2,stride:22,bytes:byteOffset,weapons:ids.map(id=>id==="knife"?id:gunById(id)?.id??""),meshes,entries,gunMuzzles:Object.fromEntries(GUNS.map(d=>[d.id,{point:d.muzzle,part:gr.part(d.cls==="pistol"?"Slide":"Gun"),...(d.silencer?{silPoint:d.silencer.tip,silPart:gr.part("Sil")}: {})}])),ghostColors:Object.fromEntries(COSMETICS.filter(c=>c.slot==="ghost"||c.slot==="trail").map(c=>[c.id,[c.color,c.color2??c.color]])),actorRig:{names:br.names,parent:Array.from(br.parent),bind:Array.from(br.bind)},outfits:COLOURWAYS,gloves:GLOVE_STYLE,inspects:Object.fromEntries(KNIVES.map(def=>[def.id,inspectSetFor(def).clips.map(c=>({duration:c.len,enter:c.enter,exit:c.exit,open:c.open,loop:c.loop}))])),finishes:Object.fromEntries(Object.entries(FINISH_STYLE).map(([id,spec])=>[id,FINISH_CODE[spec.kind]]))}));
const glsl=(source:string,stage:"vertex"|"fragment")=>source.replace(/\battribute\b/g,"in").replace(/\bvarying\b/g,stage==="vertex"?"out":"in").replace(/\btexture2D\b/g,"texture");
await writeFile(resolve(directory,"cosmetic-vertex-pars.glsl"),glsl(VERTEX_PARS,"vertex"));
await writeFile(resolve(directory,"cosmetic-vertex-main.glsl"),glsl(VERTEX_MAIN,"vertex"));
await writeFile(resolve(directory,"cosmetic-fragment-pars.glsl"),glsl(FRAGMENT_PARS,"fragment"));
await writeFile(resolve(directory,"cosmetic-fragment-albedo.glsl"),glsl(GLOVE_FRAGMENT_ALBEDO,"fragment"));
await writeFile(resolve(directory,"cosmetic-fragment-light.glsl"),glsl(GLOVE_FRAGMENT_LIGHT,"fragment"));
console.log(`native original meshes/poses/cosmetics: ${(byteOffset/1048576).toFixed(1)} MiB native data, ${(compressed.byteLength/1048576).toFixed(1)} MiB packaged -> ${directory}`);

for(const [name,source,stage] of [["hat-vertex-pars",HAT_FX_VERTEX_PARS,"vertex"],["hat-vertex-normal",HAT_FX_VERTEX_NORMAL,"vertex"],["hat-vertex-position",HAT_FX_VERTEX_POSITION,"vertex"],["hat-fragment-pars",HAT_FX_FRAGMENT_PARS,"fragment"],["hat-fragment-solid",HAT_FX_FRAGMENT_SOLID,"fragment"]] as const)await writeFile(resolve(directory,name+".glsl"),glsl(source,stage));

// Hosted actor clips share the pinned verifier decoder; package no procedural-only release.
const actorExport=Bun.spawnSync([process.execPath,resolve(import.meta.dir,"export-actor-animations.ts"),directory],{stdout:"inherit",stderr:"inherit"});if(actorExport.exitCode)throw new Error("Hosted actor animation export failed");

const gestureExport=Bun.spawnSync([process.execPath,resolve(import.meta.dir,"export-tp-inspects.ts"),directory],{stdout:"inherit",stderr:"inherit"});if(gestureExport.exitCode)throw new Error("Third-person inspect export failed");

const runnerExport=Bun.spawnSync([process.execPath,resolve(import.meta.dir,"export-runner.ts"),directory],{stdout:"inherit",stderr:"inherit"});if(runnerExport.exitCode)throw new Error("Original runner export failed");

// Extract the upstream shader literals without importing its browser-owned materials module.
const glowSource = await readFile(resolve(import.meta.dir, "../../web/src/player/glow.ts"), "utf8");
for (const [name, constant] of [["glow-noise", "auraNoise"], ["glow-fragment", "auraFragment"]]) {
  const source = glowSource.match(new RegExp(`const ${constant} = /\\* glsl \\*/ \x60([\\s\\S]*?)\x60;`))?.[1];
  if (!source) throw new Error(`Missing upstream glow shader ${constant}`);
  await writeFile(resolve(directory, name + ".glsl"), source);
}
