// Typecheck the same account/audio/tutorial/race adapters the menu bundler uses.
// A temporary mirror keeps ordinary relative imports intact without publishing
// unused browser renderer modules merely to follow their type-only imports.
import {readFile,readdir,mkdir,writeFile,rm,copyFile} from "node:fs/promises";
import {resolve,join,dirname,relative} from "node:path";
const root=resolve(import.meta.dir,"../.."),output=join(root,"target/native-typecheck");
await rm(output,{recursive:true,force:true});
const adapters:Record<string,string>={"gpu-info":"gpu-info","ui/account-panel":"account-panel","audio":"audio","audio/index":"audio","audio/ui":"audio","tutorial/entry":"tutorial-entry","player/race":"race-bus"};
async function walk(path:string):Promise<string[]>{const out:string[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())out.push(...await walk(file));else if(file.endsWith(".ts"))out.push(file);}return out;}
const tools=[...await walk(join(root,"apps/native")),...await walk(join(root,"tools/tutorial"))].filter(path=>!path.includes("/apps/native/ui/")&&!path.endsWith("/typecheck.ts")&&!path.endsWith(".test.ts"));
const files=[...await walk(join(root,"apps/native/ui")),...await walk(join(root,"apps/web/src")),...tools];
for(const file of files){let text=await readFile(file,"utf8");text=text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g,(all,prefix,quote,specifier)=>{if(!specifier.startsWith("."))return all;const base=resolve(dirname(file),specifier),key=relative(join(root,"apps/web/src"),base).replace(/\.ts$/,"");if(!adapters[key]||(file.endsWith("apps/native/ui/race-bus.ts")&&key==="player/race"))return all;const target=join(root,"apps/native/ui",adapters[key]);let path=relative(dirname(file),target).replaceAll("\\","/");if(!path.startsWith("."))path="./"+path;return prefix+quote+path+quote;});if(file.endsWith("apps/native/ui/gpu-info.ts")){text=`import type {GpuInfo} from "../../web/src/gpu-info";\n`+text.replace("): null", "): GpuInfo | null");}
const dest=join(output,relative(root,file));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,text);}
for(const path of ["apps/web/src/player/bunny/skeleton.json","apps/web/src/viewmodel/skeleton.json"]){await mkdir(dirname(join(output,path)),{recursive:true});await copyFile(join(root,path),join(output,path));}
await writeFile(join(output,"globals.d.ts"),`declare module "*.css";interface ImportMeta{env:{VITE_API_URL?:string;VITE_WAVEDASH?:string;DEV:boolean};glob<T=unknown>(pattern:string,options:{eager?:boolean;import?:string;query?:string}):Record<string,T>}\n`);
const options={strict:true,noEmit:true,skipLibCheck:true,target:"ES2022",module:"ESNext",moduleResolution:"bundler",resolveJsonModule:true,allowSyntheticDefaultImports:true,lib:["ES2022","DOM","DOM.Iterable"]};
for(const mode of ["menu","tests","tools"]){
 const tests=mode!=="menu";
 const config=join(output,mode+".json");
 await writeFile(config,JSON.stringify({compilerOptions:{...options,types:tests?["bun"]:[]},files:["globals.d.ts",...(mode==="tools"?tools:files.filter(path=>path.includes("/apps/native/ui/")&&!path.endsWith("/smoke.ts")&&path.endsWith(".test.ts")===tests)).map(path=>relative(root,path))]},null,2));
 const child=Bun.spawn([join(root,"node_modules/.bin/tsc"),"-p",config],{cwd:root,stdout:"inherit",stderr:"inherit"});const code=await child.exited;if(code){await rm(output,{recursive:true,force:true});process.exit(code);}
}
await rm(output,{recursive:true,force:true});
console.log("Native menu adapters, exporters, packaging helpers, parity tools and offline test types passed");
