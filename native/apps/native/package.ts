// Local/package builds only. Publication and ranked-build admission are separate reviewed steps.
import{cpSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync,chmodSync,statSync,lstatSync}from"node:fs";
import{basename,dirname,join,relative,resolve}from"node:path";
import{parseArgs}from"node:util";
import{createHash}from"node:crypto";
import{executableHash,MACHO_MODE}from"./packaging/executable-identity";
import{bundleLinuxDependencies}from"./packaging/linux-elf";
import{CANONICAL_PHYSICS,CANONICAL_TIMER_RULES,CANONICAL_WASM_SHA256,CANONICAL_WASM_BYTES}from"./ensure-wasm";
import{APP_NAME,APP_ID,MAC_APP,ICON_HASHES,packageBranding,verifyPackageBranding}from"./packaging/branding";
import{verifyMusicAssets}from"./src/export-music";
const root=resolve(import.meta.dir,"../..");
const sha=(b:Uint8Array|string)=>createHash("sha256").update(b).digest("hex");
export function run(args:string[],cwd=root):string{const r=Bun.spawnSync(args,{cwd,stdout:"pipe",stderr:"pipe",env:process.env});if(r.exitCode)throw new Error(`${args[0]} failed (${r.exitCode}): ${Buffer.from(r.stderr).toString()}`);return Buffer.from(r.stdout).toString();}
export function treeFiles(path:string):string[]{
 if(lstatSync(path).isSymbolicLink()||!statSync(path).isDirectory())throw new Error("Resource root is not a regular directory");
 const out:string[]=[];const visit=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){const full=join(dir,e.name);if(e.isSymbolicLink())throw new Error(`Resource symlink is not allowed: ${full}`);if(e.isDirectory())visit(full);else if(e.isFile())out.push(full);else throw new Error(`Unsupported resource: ${full}`);}};visit(path);
 return out.sort((a,b)=>Buffer.compare(Buffer.from(relative(path,a).replaceAll("\\","/")),Buffer.from(relative(path,b).replaceAll("\\","/"))));
}
export function treeHash(path:string):string{const h=createHash("sha256");for(const file of treeFiles(path)){h.update(relative(path,file).replaceAll("\\","/"));h.update("\0");h.update(readFileSync(file));}return h.digest("hex");}
const xml=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
function copy(source:string,target:string){mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,dereference:false,errorOnExist:true,force:false});}
function machoDeps(file:string):string[]{return run(["otool","-L",file]).split("\n").slice(1).map(s=>s.trim().split(" (compatibility")[0]).filter(Boolean);}
function machoRpaths(file:string):string[]{return [...run(["otool","-l",file]).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(m=>m[1]);}
// Read every architecture's deployment target. SDK versions do not describe OS compatibility.
export function macMinimumFromLoadCommands(output:string):string{
 const versions:string[]=[];
 for(const block of output.split(/(?=Load command \d+)/)){
  if(/cmd LC_BUILD_VERSION\s/.test(block)){
   if(!/platform (?:1|MACOS)\s/.test(block))throw new Error("Bundled Mach-O is not a macOS binary");
   const version=block.match(/\bminos (\d+\.\d+(?:\.\d+)?)\b/);if(!version)throw new Error("Missing Mach-O minos");versions.push(version[1]);
  }else if(/cmd LC_VERSION_MIN_MACOSX\s/.test(block)){
   const version=block.match(/\bversion (\d+\.\d+(?:\.\d+)?)\b/);if(!version)throw new Error("Missing Mach-O minimum version");versions.push(version[1]);
  }
 }
 if(!versions.length)throw new Error("Missing macOS deployment target in bundled Mach-O");
 return maxMacVersion(versions);
}
export function maxMacVersion(versions:string[]):string{
 const parts=(s:string)=>{if(!/^\d+\.\d+(?:\.\d+)?$/.test(s))throw new Error("Invalid macOS version");return s.split(".").map(Number);};
 const sorted=versions.map(parts).sort((a,b)=>(a[0]-b[0])||(a[1]-b[1])||((a[2]??0)-(b[2]??0)));
 if(!sorted.length)throw new Error("No macOS deployment targets");const v=sorted.at(-1)!;return v[2]?v.join("."):`${v[0]}.${v[1]}`;
}
export function macMinimumSupportedOS(executable:string,frameworks:string):string{
 return maxMacVersion(["13.0",...[executable,...(existsSync(frameworks)?treeFiles(frameworks):[])].map(file=>macMinimumFromLoadCommands(run(["otool","-l",file])))]);
}
function bundleMacLibraries(original:string,executable:string,frameworks:string):string[]{
 mkdirSync(frameworks,{recursive:true});const copied=new Map<string,string>(),names=new Map<string,string>();const queue=[{source:realpathSync(original),target:executable}];
 const expand=(p:string,source:string)=>p.replace(/^@loader_path/,dirname(source)).replace(/^@executable_path/,dirname(original));
 for(let i=0;i<queue.length;i++){
  const {source,target}=queue[i];for(const dependency of machoDeps(source)){
   if(dependency.startsWith("/System/Library/")||dependency.startsWith("/usr/lib/"))continue;
   let actual=expand(dependency,source);
   if(dependency.startsWith("@rpath/")){const suffix=dependency.slice(7);const found=[...machoRpaths(source),...machoRpaths(original)].map(p=>join(expand(p,source),suffix)).find(existsSync);if(!found)throw new Error(`Unresolved dependency ${dependency} from ${source}`);actual=found;}
   if(!existsSync(actual))throw new Error(`Missing dependency ${actual}`);actual=realpathSync(actual);
   if(actual===source)continue;
   if(actual.includes(".framework/"))throw new Error(`Non-system frameworks require explicit packaging support: ${actual}`);
   const name=basename(actual),destination=join(frameworks,name);const collision=names.get(name);if(collision&&collision!==actual)throw new Error(`Library basename collision: ${name}`);
   if(!copied.has(actual)){copy(actual,destination);chmodSync(destination,0o755);copied.set(actual,destination);names.set(name,actual);queue.push({source:actual,target:destination});run(["install_name_tool","-id",`@rpath/${name}`,destination]);}
   run(["install_name_tool","-change",dependency,target===executable?`@executable_path/../Frameworks/${name}`:`@loader_path/${name}`,target]);
  }
 }
 // Fail rather than ship any surviving non-system absolute loader dependency.
 for(const {target}of queue)for(const dep of machoDeps(target))if(dep.startsWith("/")&&!dep.startsWith("/System/Library/")&&!dep.startsWith("/usr/lib/"))throw new Error(`Unbundled dependency: ${dep}`);
 return [...copied.values()];
}
function notices(resources:string,extra:string[]){
 const to=join(resources,"licenses");copy(join(root,"apps/native/packaging/licenses"),to);
 copy(join(root,"apps/native/vendor/nlohmann/LICENSE.MIT"),join(to,"nlohmann-json.txt"));
 for(const name of ["dr_libs","stb"])copy(join(root,"apps/native/vendor",name,"LICENSE"),join(to,`${name}.txt`));
 for(const name of ["JetBrainsMono-OFL.txt","LeagueGothic-OFL.txt"])copy(join(root,"tools/hermes/fonts",name),join(to,name));
 for(const name of ["LICENSE-playsrc","LICENSE.source-sdk-2013","thirdpartylegalnotices.txt","NOTICE-playsrc.md","SOURCE-SDK-NOTICES.md"])copy(join(root,"crates/vendor",name),join(to,name));
 const metadata=JSON.parse(run(["cargo","metadata","--format-version","1","--locked"]));
 const nodes=new Map(metadata.resolve.nodes.map((n:any)=>[n.id,n]));const bridge=metadata.packages.find((p:any)=>p.name==="bunnyhop-native-bridge");const seen=new Set<string>();
 const visit=(id:string)=>{if(seen.has(id))return;seen.add(id);for(const d of (nodes.get(id)as any)?.dependencies??[])visit(d);};visit(bridge.id);
 const index=[];for(const p of metadata.packages.filter((p:any)=>seen.has(p.id))){
  const dir=dirname(p.manifest_path);const files=readdirSync(dir).filter(n=>/^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(n)&&lstatSync(join(dir,n)).isFile());
  if(p.license_file){const f=resolve(dir,p.license_file);if(!f.startsWith(dir+"/")&&!f.startsWith(dir+"\\"))throw new Error("Dependency license outside package");if(!files.includes(p.license_file))files.push(p.license_file);}
  for(const name of files)copy(join(dir,name),join(to,`rust-${p.name}-${p.version}`,basename(name)));
  index.push({name:p.name,version:p.version,license:p.license,licenseFiles:files,repository:p.repository});
 }
 for(const dir of extra)for(const file of treeFiles(dir).filter(f=>/^(?:copyright|license|copying|notice)(?:[._-].*)?$/i.test(basename(f))))copy(file,join(to,"native-dependencies",basename(dir),relative(dir,file)));
 writeFileSync(join(to,"rust-dependencies.json"),JSON.stringify(index,null,2)+"\n");
}
function windowsDependencies(exe:string,destination:string,search:string[]){
 const queue=[exe],seen=new Set<string>();const system=/^(?:api-ms-|ext-ms-|kernel32|user32|gdi32|advapi32|shell32|ole32|oleaut32|comdlg32|comctl32|ws2_32|winhttp|wininet|crypt32|bcrypt|ntdll|secur32|userenv|version|shlwapi|urlmon|dwmapi|imm32|setupapi|winmm|opengl32|glu32|ucrtbase|msvcrt|rpcrt4|normaliz|dnsapi|iphlpapi|wldap32|dbghelp|hid|cfgmgr32|powrprof|dwrite|dxgi|d3d11|d3d12|dcomp|windowscodecs)\b/i;
 const redist=process.env.VCToolsRedistDir;if(redist)search.push(join(redist,"x64","Microsoft.VC143.CRT"));
 for(let i=0;i<queue.length;i++){for(const match of run(["dumpbin","/DEPENDENTS",queue[i]]).matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gmi)){const name=match[1];if(system.test(name)||seen.has(name.toLowerCase()))continue;seen.add(name.toLowerCase());const file=[dirname(exe),...search,...(process.env.PATH??"").split(";")].map(p=>join(p,name)).find(existsSync);if(!file)throw new Error(`Unresolved Windows dependency ${name}; pass --dependencies DIR / configure VCToolsRedistDir`);const to=join(destination,name);copy(file,to);queue.push(to);}}
}
export function makeManifest(executable:string,resources:string,platform:string,arch:string,wasm:Uint8Array,source:Record<string,unknown>){
 const wasmSha256=sha(wasm);
 if(wasm.length!==CANONICAL_WASM_BYTES||wasmSha256!==CANONICAL_WASM_SHA256)throw new Error("Package requires the exact pinned canonical WASM artifact");
 const canonical=`bunnyhop-web/${wasmSha256.slice(0,12)}`;
 if(source.wasm!==canonical)throw new Error("Source manifest canonical WASM identity does not match the artifact; build first");
 // The verifier pin covers exactly one physics/timer-rules pair; a stale source manifest must not relabel it.
 if(source.physics!==CANONICAL_PHYSICS||source.rules!==CANONICAL_TIMER_RULES)throw new Error(`Source manifest physics/rules do not match the pinned verifier (physics ${CANONICAL_PHYSICS}, rules ${CANONICAL_TIMER_RULES}); build first`);
 const binaryHashMode=platform==="darwin"?MACHO_MODE:"sha256",binary=readFileSync(executable),binarySha256=executableHash(binary,binaryHashMode),menuSha256=sha(readFileSync(join(resources,"menu.html"))),assetsSha256=treeHash(join(resources,"native-assets"));
 return packageIdentity(platform,arch,binarySha256,menuSha256,assetsSha256);
}
export function packageIdentity(platform:string,arch:string,binarySha256:string,menuSha256:string,assetsSha256:string){
 if(!["darwin","win32","linux"].includes(platform)||!["arm64","x64"].includes(arch))throw new Error("Unsupported package platform/architecture");
 for(const hash of [binarySha256,menuSha256,assetsSha256])if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("Invalid package identity hash");
 const wasmSha256=CANONICAL_WASM_SHA256;
 const build=`bunnyhop-native/${sha(["package-v1",platform,arch,binarySha256,menuSha256,assetsSha256,wasmSha256].join("\0")).slice(0,24)}`;
 return{schema:1,build,wasm:`bunnyhop-web/${wasmSha256.slice(0,12)}`,canonicalWasmSha256:wasmSha256,physics:CANONICAL_PHYSICS,rules:CANONICAL_TIMER_RULES,platform:`${platform}/${arch}`,renderer:"native-opengl",binaryHashMode:platform==="darwin"?MACHO_MODE:"sha256",binarySha256,menuSha256,assetsSha256};
}
export function verifyPackageIdentity(manifest:unknown,executable:string,resources:string,platform:string,arch:string){
 if(!manifest||typeof manifest!=="object"||Array.isArray(manifest))throw new Error("Invalid package identity manifest");
 const expected=packageIdentity(platform,arch,executableHash(readFileSync(executable),platform==="darwin"?MACHO_MODE:"sha256"),sha(readFileSync(join(resources,"menu.html"))),treeHash(join(resources,"native-assets")));
 for(const [field,value]of Object.entries(expected))if((manifest as Record<string,unknown>)[field]!==value)throw new Error(`Packaged identity mismatch: ${field}`);
 return expected;
}

if(import.meta.main){
 const {values}=parseArgs({args:Bun.argv.slice(2),options:{"skip-build":{type:"boolean"},out:{type:"string",default:"target/native-packages"},platform:{type:"string",default:process.platform},arch:{type:"string",default:process.arch},version:{type:"string",default:"0.1.0"},binary:{type:"string"},dependencies:{type:"string",multiple:true},"linux-dlopen-library":{type:"string",multiple:true},identity:{type:"string",default:process.env.BUNNYHOP_CODESIGN_IDENTITY??"-"},"notary-profile":{type:"string"},"windows-thumbprint":{type:"string",default:process.env.BUNNYHOP_WINDOWS_SIGNING_THUMBPRINT},licenses:{type:"string",multiple:true},release:{type:"boolean"},"require-platform-signing":{type:"boolean"}}});
 try{
 const platform=values.platform!,arch=values.arch!,version=values.version!;
 if(!["darwin","win32","linux"].includes(platform)||!['x64','arm64'].includes(arch)||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error("Invalid package platform/architecture/version");
 if(platform!==process.platform)throw new Error("Package on the target OS (Windows via packaging CI); cross-OS dependency/signing closure is not supported");
 if(arch!==process.arch)throw new Error("Package on the target architecture; cross-architecture packaging needs a separately validated closure");
 if(platform!=="linux"&&values["linux-dlopen-library"]?.length)throw new Error("--linux-dlopen-library requires Linux packaging");
 if(!values["skip-build"])console.log(run(["bun","apps/native/build.ts"]));
 const out=resolve(root,values.out!),tag=`bunnyhop-native-${version}-${platform}-${arch}`,stage=join(out,tag);if(existsSync(stage))throw new Error(`Package exists: ${stage}; choose a new output directory/version`);mkdirSync(stage,{recursive:true});
 const sourceBinary=resolve(root,values.binary??`apps/native/build/bunnyhop-native${platform==="win32"?".exe":""}`);
 const packageRoot=platform==="darwin"?join(stage,MAC_APP):stage;
 const executable=platform==="darwin"?join(packageRoot,"Contents/MacOS/bunnyhop-native"):platform==="win32"?join(packageRoot,"bunnyhop-native.exe"):join(packageRoot,"bin/bunnyhop-native");
 const resources=platform==="darwin"?join(packageRoot,"Contents/Resources"):platform==="win32"?join(packageRoot,"resources"):join(packageRoot,"share/bunnyhop-native");
 mkdirSync(resources,{recursive:true});copy(sourceBinary,executable);chmodSync(executable,0o755);
 copy(join(root,"target/native-menu/menu.html"),join(resources,"menu.html"));const assets=join(root,"target/native-assets");treeFiles(assets);copy(assets,join(resources,"native-assets"));
 packageBranding(resources,packageRoot,platform);
 verifyMusicAssets(join(resources,"native-assets"));
 if(existsSync(join(root,"target/native-menu/menu-manifest.json"))){
  const menuManifest=JSON.parse(readFileSync(join(root,"target/native-menu/menu-manifest.json"),"utf8"));
  // The builder records its local output path; packaged metadata names the bundled document.
  menuManifest.html="menu.html";
  writeFileSync(join(resources,"menu-manifest.json"),JSON.stringify(menuManifest,null,2)+"\n");
 }
 for(const name of ["LICENSE","LICENSE.md","LICENSE-MIT"]){if(existsSync(join(root,name)))copy(join(root,name),join(resources,name));}
 copy(join(root,"apps/native/packaging/NOTICE.txt"),join(resources,"NOTICE.txt"));
 notices(resources,(values.licenses??[]).map(p=>resolve(root,p)));
 let signing="unsigned",notarized=false,minimumSupportedOS:string|undefined;
 if(platform==="darwin"){
  const libs=bundleMacLibraries(sourceBinary,executable,join(packageRoot,"Contents/Frameworks"));
  minimumSupportedOS=macMinimumSupportedOS(executable,join(packageRoot,"Contents/Frameworks"));
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>${xml(APP_NAME)}</string><key>CFBundleDisplayName</key><string>${xml(APP_NAME)}</string><key>CFBundleIdentifier</key><string>${APP_ID}</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleExecutable</key><string>bunnyhop-native</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${xml(version.split('-')[0])}</string><key>CFBundleVersion</key><string>${xml(version.split('-')[0])}</string><key>LSMinimumSystemVersion</key><string>${minimumSupportedOS}</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`;
  writeFileSync(join(packageRoot,"Contents/Info.plist"),plist);run(["plutil","-lint",join(packageRoot,"Contents/Info.plist")]);
  const identity=values.identity!,sign=(file:string)=>run(["codesign","--force","--sign",identity,...(identity==="-"?[]:["--options","runtime","--timestamp"]),file]);
  if(values["require-platform-signing"]&&(identity==="-"||!values["notary-profile"]))throw new Error("macOS release requires a configured Developer ID identity and --notary-profile");
  if(identity!=="-"&&!run(["security","find-identity","-v","-p","codesigning"]).includes(identity))throw new Error("Requested signing identity is not available in this keychain");
  // Mach-O debug STABS can retain absolute archive-member paths even after
  // compiler path remapping. Remove only debug symbols before final signing.
  for(const file of [...libs,executable])run(["strip","-S",file]);
  for(const lib of libs)sign(lib);sign(executable);signing=identity==="-"?"ad-hoc":"developer-id";
 }else if(platform==="win32"){
  if(arch!=="x64")throw new Error("Windows packaging currently supports the MSVC x64 build");
  windowsDependencies(sourceBinary,packageRoot,(values.dependencies??[]).map(p=>resolve(root,p)));
  if(values["windows-thumbprint"]){if(!/^[a-f0-9]{40}$/i.test(values["windows-thumbprint"]))throw new Error("Invalid Windows certificate thumbprint");run(["signtool","sign","/sha1",values["windows-thumbprint"],"/fd","SHA256","/tr","https://timestamp.digicert.com","/td","SHA256",executable]);run(["signtool","verify","/pa","/all",executable]);signing="authenticode";}
  if(values["require-platform-signing"]&&signing!=="authenticode")throw new Error("Windows release requires a configured Authenticode certificate in the certificate store");
  for(const name of ["Install.ps1","Uninstall.ps1","Install-WebView2.ps1"])copy(join(root,"apps/native/packaging/windows",name),join(packageRoot,name));
 }else{
  // Patch and verify every bundled ELF before makeManifest hashes the executable.
  writeFileSync(join(packageRoot,"RUNTIME.txt"),bundleLinuxDependencies(executable,join(packageRoot,"lib"),(values["linux-dlopen-library"]??[]).map(p=>resolve(root,p))));
  copy(join(root,"apps/native/packaging/linux-launch.sh"),join(packageRoot,"bunnyhop-native"));chmodSync(join(packageRoot,"bunnyhop-native"),0o755);
  copy(join(root,"apps/native/packaging/linux-dependencies.txt"),join(packageRoot,"DEPENDENCIES.txt"));
 }
 const sourceManifest=JSON.parse(readFileSync(join(root,"target/native-menu/native-manifest.json"),"utf8"));
 verifyPackageBranding(resources,packageRoot,platform);
 const manifest=makeManifest(executable,resources,platform,arch,readFileSync(join(root,"apps/web/src/wasm/bunnyhop_core.wasm")),sourceManifest);
 writeFileSync(join(resources,"native-manifest.json"),JSON.stringify(manifest,null,2)+"\n");
 if(platform==="darwin"){
  const identity=values.identity!;run(["codesign","--force","--sign",identity,...(identity==="-"?[]:["--options","runtime","--timestamp"]),packageRoot]);run(["codesign","--verify","--deep","--strict",packageRoot]);
  if(executableHash(readFileSync(executable),manifest.binaryHashMode)!==manifest.binarySha256)throw new Error("Final bundle signing changed canonical binary identity");
 }
 const extension=platform==="linux"?"tar.gz":"zip",archive=join(out,`${tag}.${extension}`);if(existsSync(archive))throw new Error(`Archive exists: ${archive}`);
 if(platform==="darwin")run(["ditto","-c","-k","--sequesterRsrc","--keepParent",packageRoot,archive]);else if(platform==="win32")run(["tar","-a","-c","-f",archive,"-C",stage,"."]);else run(["tar","-czf",archive,"-C",stage,"."]);
 if(platform==="darwin"&&values["notary-profile"]){if(signing!=="developer-id")throw new Error("Notarization requires Developer ID signing");console.log(run(["xcrun","notarytool","submit",archive,"--keychain-profile",values["notary-profile"],"--wait"]));run(["xcrun","stapler","staple",packageRoot]);run(["xcrun","stapler","validate",packageRoot]);run(["ditto","-c","-k","--sequesterRsrc","--keepParent",packageRoot,archive]);notarized=true;}
 const report={schema:1,version,displayName:APP_NAME,iconSha256:ICON_HASHES,platform:`${platform}/${arch}`,archive:basename(archive),bytes:statSync(archive).size,sha256:sha(readFileSync(archive)),build:manifest.build,wasm:manifest.wasm,canonicalWasmSha256:manifest.canonicalWasmSha256,physics:manifest.physics,rules:manifest.rules,binaryHashMode:manifest.binaryHashMode,binarySha256:manifest.binarySha256,menuSha256:manifest.menuSha256,assetsSha256:manifest.assetsSha256,signing,notarized,...(minimumSupportedOS?{minimumSupportedOS}:{}),releaseEligible:true,platformSigned:platform==="darwin"?signing==="developer-id":platform==="win32"?signing==="authenticode":false};
 writeFileSync(join(out,`${tag}.json`),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({...report,stage,archive},null,2));
 }catch(error){console.error(error instanceof Error?error.message:String(error));process.exit(1);}
}
