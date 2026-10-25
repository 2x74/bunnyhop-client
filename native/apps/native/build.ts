import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { treeHash } from "./package";
import { CANONICAL_PHYSICS, CANONICAL_TIMER_RULES, ensureCanonicalWasm } from "./ensure-wasm";
const root = resolve(import.meta.dir, "../..");
await ensureCanonicalWasm();
const {values}=parseArgs({args:Bun.argv.slice(2),options:{"prebuilt-resources":{type:"boolean"}}});
function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) process.exit(result.exitCode);
}
if(values["prebuilt-resources"]){
  for(const file of ["target/native-menu/menu.html","target/native-menu/menu-manifest.json",
    "target/native-assets/viewmodels.json","target/native-assets/viewmodels.bin.z",
    "target/native-assets/audio.json","target/native-assets/hud.rgba","target/native-assets/tutorial.json"]){
    if(!existsSync(join(root,file)))throw new Error(`Prebuilt resource missing: ${file}`);
  }
}else{
  run(["bun", "apps/native/build-menu.ts"]);
  run(["bun", "apps/native/src/export-viewmodels.ts"]);
  run(["bun", "apps/native/src/export-presentation.ts"]);
}
run(["cmake", "-S", "apps/native", "-B", "apps/native/build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"]);
run(["cmake", "--build", "apps/native/build", "--parallel"]);
const hash = new Bun.CryptoHasher("sha256");
const fileHashes: string[] = [];
for (const file of ["apps/native/build/bunnyhop-native" + (process.platform === "win32" ? ".exe" : ""), "target/native-menu/menu.html"]) {
  const bytes=readFileSync(join(root,file));
  hash.update(file); hash.update(bytes);
  fileHashes.push(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
}
const wasm = readFileSync(join(root, "apps/web/src/wasm/bunnyhop_core.wasm"));
hash.update(wasm);
const assetsSha256=treeHash(join(root,"target/native-assets"));
hash.update(assetsSha256);
const manifest = {
  build: `bunnyhop-native/${hash.digest("hex").slice(0, 24)}`,
  wasm: `bunnyhop-web/${new Bun.CryptoHasher("sha256").update(wasm).digest("hex").slice(0, 12)}`,
  physics: CANONICAL_PHYSICS,
  rules: CANONICAL_TIMER_RULES,
  platform: `${process.platform}/${process.arch}`,
  renderer: "native-opengl",
  binarySha256: fileHashes[0],
  menuSha256: fileHashes[1],
  assetsSha256,
};
writeFileSync(join(root, "target/native-menu/native-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(manifest);
