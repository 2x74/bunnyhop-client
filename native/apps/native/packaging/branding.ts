import {copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname, join, resolve} from "node:path";

export const APP_NAME="bunnyhop.lol - Native", APP_ID="lol.bunnyhop.native", MAC_APP=`${APP_NAME}.app`;
export const ICON_HASHES={
 "icon-512.png":"b556536d4834d01e67941ef94b535aba627fcabf0576394e1416d7fcc7df28ad",
 "icon.ico":"ba98c24713ffdc554e119b336a171833efa8f59df665c360b43075fef4b90a1a",
 "icon.icns":"fcd60a26e5a3025bd9c189aea8ee90a8950244b77422f5729f5a0cbe516d51ee",
} as const;
export const ICON_SOURCE=resolve(import.meta.dir,"../assets");
export function verifyIcon(file:string,name:keyof typeof ICON_HASHES){
 if(!lstatSync(file).isFile()||createHash("sha256").update(readFileSync(file)).digest("hex")!==ICON_HASHES[name])throw new Error(`Official app icon mismatch: ${name}`);
}
export const LINUX_DESKTOP=`[Desktop Entry]\nType=Application\nName=${APP_NAME}\nComment=Native bunnyhop.lol client\nExec=bunnyhop-native\nTryExec=bunnyhop-native\nIcon=${APP_ID}\nStartupWMClass=${APP_ID}\nTerminal=false\nCategories=Game;\n`;
const linuxIcon=(app:string)=>join(app,`share/icons/hicolor/512x512/apps/${APP_ID}.png`);
const linuxDesktop=(app:string)=>join(app,`share/applications/${APP_ID}.desktop`);
// Store all original OS formats inside the hashed native-assets tree. The OS
// integration copies below must also match the exact official bytes.
export function packageBranding(resources:string,app:string,platform:string){
 const branding=join(resources,"native-assets/branding");mkdirSync(branding,{recursive:true});
 for(const name of Object.keys(ICON_HASHES) as (keyof typeof ICON_HASHES)[]){
  verifyIcon(join(ICON_SOURCE,name),name);copyFileSync(join(ICON_SOURCE,name),join(branding,name));
 }
 if(platform==="darwin")copyFileSync(join(branding,"icon.icns"),join(resources,"icon.icns"));
 if(platform==="linux"){
  mkdirSync(dirname(linuxIcon(app)),{recursive:true});copyFileSync(join(branding,"icon-512.png"),linuxIcon(app));
  mkdirSync(dirname(linuxDesktop(app)),{recursive:true});writeFileSync(linuxDesktop(app),LINUX_DESKTOP);
 }
}
export function verifyPackageBranding(resources:string,app:string,platform:string){
 for(const name of Object.keys(ICON_HASHES) as (keyof typeof ICON_HASHES)[])verifyIcon(join(resources,"native-assets/branding",name),name);
 if(platform==="darwin")verifyIcon(join(resources,"icon.icns"),"icon.icns");
 if(platform==="linux"){
  verifyIcon(linuxIcon(app),"icon-512.png");
  if(readFileSync(linuxDesktop(app),"utf8")!==LINUX_DESKTOP)throw new Error("Linux desktop app identity mismatch");
 }
}
