import {expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createHash} from "node:crypto";
import {makeManifest, packageIdentity, verifyPackageIdentity} from "../package";
import {CANONICAL_PHYSICS, CANONICAL_TIMER_RULES, CANONICAL_WASM_SHA256} from "../ensure-wasm";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function mutations(valid:ReturnType<typeof packageIdentity>){
 const cases:Record<string,unknown>[]=[];
 for(const key of Object.keys(valid)){const missing={...valid} as Record<string,unknown>;delete missing[key];cases.push(missing);cases.push({...valid,[key]:typeof valid[key as keyof typeof valid]==="number"?999:"wrong"});}
 cases.push({...valid,physics:16},{...valid,canonicalWasmSha256:"f".repeat(64),wasm:`bunnyhop-web/${"f".repeat(12)}`},{...valid,build:"bunnyhop-native/local"});
 return cases;
}
test("package identity requires all metadata, the exact verifier pin, and a recomputed build ID",()=>{
 const dir=mkdtempSync(join(tmpdir(),"bunnyhop-release-identity-"));
 try{
  const exe=join(dir,"exe"),resources=join(dir,"resources");mkdirSync(join(resources,"native-assets"),{recursive:true});writeFileSync(exe,"binary");writeFileSync(join(resources,"menu.html"),"menu");writeFileSync(join(resources,"native-assets/data"),"assets");
  const wasm=readFileSync(resolve(import.meta.dir,"../../web/src/wasm/bunnyhop_core.wasm"));
  const source={wasm:`bunnyhop-web/${CANONICAL_WASM_SHA256.slice(0,12)}`,physics:CANONICAL_PHYSICS,rules:CANONICAL_TIMER_RULES};
  const valid=makeManifest(exe,resources,"linux",process.arch,wasm,source);
  expect(verifyPackageIdentity(valid,exe,resources,"linux",process.arch)).toEqual(valid);
  for(const bad of mutations(valid))expect(()=>verifyPackageIdentity(bad,exe,resources,"linux",process.arch)).toThrow("identity mismatch");
  for(const bad of [null,[],"manifest"])expect(()=>verifyPackageIdentity(bad,exe,resources,"linux",process.arch)).toThrow();
  expect(()=>makeManifest(exe,resources,"linux",process.arch,Buffer.from("false verifier"),source)).toThrow("exact pinned");
  for(const bad of [{...source,physics:16},{...source,rules:999},{...source,wasm:"false"}])expect(()=>makeManifest(exe,resources,"linux",process.arch,wasm,bad)).toThrow();
  writeFileSync(exe,"tampered binary");expect(()=>verifyPackageIdentity(valid,exe,resources,"linux",process.arch)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test.skipIf(process.platform==="win32")("compiled client validator matches TS and the linked native core's physics/rules; incomplete/dev identities remain unqualified",()=>{
 const dir=mkdtempSync(join(tmpdir(),"bunnyhop-release-cpp-"));
 try{
  const cpp=join(dir,"main.cpp"),exe=join(dir,"oracle");
  writeFileSync(cpp,`#include ${JSON.stringify(resolve(import.meta.dir,"release_identity.hpp"))}
#include <iostream>
int main(){BhSettings s{};BhRunOptions o{};bh_default_settings(&s);bh_default_run_options(&o);std::cout<<nlohmann::json({{"physics",s.physics},{"rules",o.rules},{"wasm",std::string(native::release_wasm_sha256)},{"platform",native::release_platform()}}).dump()<<'\\n';std::string line;while(std::getline(std::cin,line)){try{auto m=nlohmann::json::parse(line);native::verify_release_identity(m,${JSON.stringify(hash("binary"))},${JSON.stringify(hash("menu"))},${JSON.stringify(hash("assets"))});std::cout<<"qualified\\n";}catch(const std::exception&){std::cout<<"local\\n";}}}`);
  const rust=resolve(import.meta.dir,"../../../target/release/libbunnyhop_native_bridge.a");
  const compile=Bun.spawnSync(["c++","-std=c++20","-I",resolve(import.meta.dir,"../include"),cpp,rust,...(process.platform==="darwin"?["-framework","Security","-framework","CoreFoundation","-liconv","-lresolv"]:["-ldl","-lm","-lpthread"]),"-o",exe],{stdout:"pipe",stderr:"pipe"});
  expect(compile.exitCode,Buffer.from(compile.stderr).toString()).toBe(0);
  const valid=packageIdentity(process.platform,process.arch,hash("binary"),hash("menu"),hash("assets"));
  const cases=[valid,...mutations(valid),null,[],{build:"bunnyhop-native/local",wasm:""}];
  const result=Bun.spawnSync([exe],{stdin:Buffer.from(cases.map(m=>JSON.stringify(m)).join("\n")+"\n"),stdout:"pipe",stderr:"pipe"});
  expect(result.exitCode,Buffer.from(result.stderr).toString()).toBe(0);
  const [pin,...statuses]=Buffer.from(result.stdout).toString().trim().split("\n");
  expect(JSON.parse(pin)).toEqual({physics:CANONICAL_PHYSICS,rules:CANONICAL_TIMER_RULES,wasm:CANONICAL_WASM_SHA256,platform:`${process.platform}/${process.arch}`});
  expect(statuses).toEqual(["qualified",...cases.slice(1).map(()=>"local")]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
