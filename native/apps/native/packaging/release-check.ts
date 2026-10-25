// Read-only local artifact checks. This does not register an active build or upload a score/release.
import{readFileSync,existsSync}from"node:fs";import{resolve,join}from"node:path";import{parseArgs}from"node:util";import{run,verifyPackageIdentity,macMinimumSupportedOS}from"../package";
import{verifyLinuxPackage}from"./linux-elf";
import{APP_NAME,APP_ID,MAC_APP,verifyPackageBranding}from"./branding";
import{verifyMusicAssets}from"../src/export-music";
if(import.meta.main){try{const{values}=parseArgs({args:Bun.argv.slice(2),options:{package:{type:"string"},"require-release":{type:"boolean"}}});if(!values.package)throw new Error("Usage: bun release-check.ts --package STAGE_DIRECTORY [--require-release]");const stage=resolve(values.package);const mac=existsSync(join(stage,MAC_APP));const platform=mac?"darwin":existsSync(join(stage,"bunnyhop-native.exe"))?"win32":"linux",app=mac?join(stage,MAC_APP):stage,resources=mac?join(app,"Contents/Resources"):platform==="win32"?join(app,"resources"):join(app,"share/bunnyhop-native"),exe=mac?join(app,"Contents/MacOS/bunnyhop-native"):platform==="win32"?join(app,"bunnyhop-native.exe"):join(app,"bin/bunnyhop-native");const manifest=JSON.parse(readFileSync(join(resources,"native-manifest.json"),"utf8"));
 for(const p of ["menu.html","native-assets/viewmodels.json","native-assets/viewmodels.bin.z","native-assets/audio.json","native-assets/tutorial.json","native-assets/hud.rgba","licenses/SDL3.txt","licenses/dr_libs.txt","licenses/stb.txt","licenses/LDNOOBW-CC-BY-4.0.txt","licenses/JetBrainsMono-OFL.txt","licenses/LeagueGothic-OFL.txt","licenses/LICENSE-playsrc","licenses/LICENSE.source-sdk-2013","licenses/thirdpartylegalnotices.txt","licenses/NOTICE-playsrc.md","licenses/SOURCE-SDK-NOTICES.md","licenses/rust-dependencies.json"]){if(!existsSync(join(resources,p)))throw new Error(`Required package resource missing: ${p}`);}
 const identity=verifyPackageIdentity(manifest,exe,resources,platform,process.arch);
 verifyPackageBranding(resources,app,platform);
 verifyMusicAssets(join(resources,"native-assets"));
 let minimumSupportedOS:string|undefined;
 if(mac){
  for(const [key,value]of Object.entries({CFBundleName:APP_NAME,CFBundleDisplayName:APP_NAME,CFBundleIdentifier:APP_ID,CFBundleExecutable:"bunnyhop-native",CFBundleIconFile:"icon.icns"})){
   if(run(["/usr/libexec/PlistBuddy","-c",`Print :${key}`,join(app,"Contents/Info.plist")]).trim()!==value)throw new Error(`macOS app identity mismatch: ${key}`);
  }
  minimumSupportedOS=macMinimumSupportedOS(exe,join(app,"Contents/Frameworks"));
  const declared=run(["/usr/libexec/PlistBuddy","-c","Print :LSMinimumSystemVersion",join(app,"Contents/Info.plist")]).trim();
  if(declared!==minimumSupportedOS)throw new Error(`macOS minimum supported OS mismatch: plist ${declared}, bundled Mach-O ${minimumSupportedOS}`);
 }
 if(mac){run(["codesign","--verify","--deep","--strict",app]);if(values["require-release"]){run(["spctl","--assess","--type","execute","--verbose=2",app]);run(["xcrun","stapler","validate",app]);}}
 else if(platform==="win32"&&values["require-release"])run(["signtool","verify","/pa","/all",exe]);
 else if(platform==="linux")verifyLinuxPackage(exe,join(app,"lib"));
 console.log(JSON.stringify({valid:true,platform,build:identity.build,...(minimumSupportedOS?{minimumSupportedOS}:{}),resources:true,releaseAdmissionChecked:false}));
 }catch(e){console.error(e instanceof Error?e.message:String(e));process.exit(1);}}
