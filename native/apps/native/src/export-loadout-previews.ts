// Explicit regeneration tool. Uses the native OpenGL renderer offline; the generated PNG catalog is browser-safe.
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {deflateSync} from "node:zlib";
import {COSMETICS} from "../../web/src/progression";
const executable=process.argv[2]??"/tmp/bunnyhop-export-previews",assets=resolve(process.argv[3]??"target/native-assets"),output=resolve(process.argv[4]??"apps/native/ui/authored-previews.json"),temp=resolve(process.argv[5]??"target/preview-export");
await mkdir(temp,{recursive:true});
const metadata=JSON.parse(await readFile(resolve(assets,"viewmodels.json"),"utf8"));
const jobs:CJob[]=[];interface CJob{id:string;kind:string;outfit:string;loadout:string}
for(const c of COSMETICS){if(!["knife","finish","glove","outfit","hat","body","ghost"].includes(c.slot))continue;if(c.slot==="knife"&&!metadata.meshes["fpknife:"+c.id.replace(/^knife-/,"")])continue;if(c.slot==="hat"&&!metadata.meshes[c.id])continue;
 const outfit=c.slot==="outfit"?c.id:"outfit-cream",knife=c.slot==="knife"?c.id:"knife-carrot",finish=c.slot==="finish"?c.id:"fin-garden",glove=c.slot==="glove"?c.id:"glove-knit",hat=c.slot==="hat"?c.id:"";
 jobs.push({id:c.id,kind:c.slot==="ghost"?"ghost":c.slot==="hat"?"hat":c.slot==="outfit"||c.slot==="body"?"actor":"fp",outfit,loadout:`2;${knife};${finish};${glove};;${hat};${c.slot==="body"?c.id:"body-a"}`});
}
await writeFile(resolve(temp,"jobs.json"),JSON.stringify(jobs));
const child=Bun.spawn([executable,assets,resolve(temp,"jobs.json"),temp],{stdout:"inherit",stderr:"inherit"});if(await child.exited!==0)throw Error("Native preview renderer failed");
const crc=(bytes:Uint8Array)=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let j=0;j<8;j++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return(n^0xffffffff)>>>0;};
const chunk=(type:string,data:Uint8Array)=>{const t=Buffer.from(type),n=Buffer.alloc(4),tail=Buffer.alloc(4);n.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,tail]);};
const images:Record<string,string>={};let pngBytes=0;
for(const job of jobs){let raw=await readFile(resolve(temp,job.id+".rgba"));let w=1024,h=768;
 // Keep high resolution where the original character crops were only ~70px wide.
 if(!["actor","ghost","hat"].includes(job.kind)){const small=Buffer.alloc(512*384*4);for(let y=0;y<384;y++)for(let x=0;x<512;x++)for(let c=0;c<4;c++){let sum=0;for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)sum+=raw[((y*2+dy)*1024+x*2+dx)*4+c];small[(y*512+x)*4+c]=Math.round(sum/4);}raw=small;w=512;h=384;}let x0=w,y0=h,x1=0,y1=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(raw[(y*w+x)*4+3]>5){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}if(x0>x1)throw Error("Blank authored preview: "+job.id);
 x0=Math.max(0,x0-8);x1=Math.min(w-1,x1+8);y0=Math.max(0,y0-8);y1=Math.min(h-1,y1+8);const width=x1-x0+1,height=y1-y0+1,scan=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)raw.copy(scan,y*(width*4+1)+1,((y0+y)*w+x0)*4,((y0+y)*w+x1+1)*4);
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(scan)),chunk("IEND",Buffer.alloc(0))]);pngBytes+=png.length;images[job.id]="data:image/png;base64,"+png.toString("base64");
}
if(pngBytes>4*1024*1024)throw Error("Authored preview catalog exceeds 4MiB budget");await writeFile(output,JSON.stringify({version:1,width:1024,height:768,source:"native original meshes/poses/cosmetic shaders",pngBytes,images}));console.log(`Authored preview catalog: ${jobs.length} images, ${(pngBytes/1024).toFixed(1)} KiB PNG -> ${output}`);
