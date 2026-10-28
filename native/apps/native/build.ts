import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageIdentity, treeHash } from "./package";
import { executableHash, MACHO_MODE } from "./packaging/executable-identity";
import { ensureCanonicalWasm } from "./ensure-wasm";
import { pinnedSdlInstall, sdlConfigDir } from "./packaging/sdl";
const root = resolve(import.meta.dir, "../..");
await ensureCanonicalWasm();
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { "prebuilt-resources": { type: "boolean" } } });
function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) process.exit(result.exitCode);
}
if (values["prebuilt-resources"]) {
  for (const file of [
    "target/native-menu/menu.html",
    "target/native-menu/menu-manifest.json",
    "target/native-assets/viewmodels.json",
    "target/native-assets/viewmodels.bin.z",
    "target/native-assets/actor-animations.json",
    "target/native-assets/actor-animations.bin",
    "target/native-assets/tp-inspects.json",
    "target/native-assets/runner.json",
    "target/native-assets/runner.bin",
    "target/native-assets/audio.json",
    "target/native-assets/hud.rgba",
    "target/native-assets/tutorial.json",
  ]) {
    if (!existsSync(join(root, file))) throw new Error(`Prebuilt resource missing: ${file}`);
  }
} else {
  run(["bun", "apps/native/build-menu.ts"]);
  run(["bun", "apps/native/src/export-viewmodels.ts"]);
  run(["bun", "apps/native/src/export-presentation.ts"]);
}
// Use the pinned SDL when packaging/sdl.ts has built it; otherwise CMake finds a system SDL3 >= 3.4.
const sdl = pinnedSdlInstall();
const configure = [
  "cmake",
  "-S",
  "apps/native",
  "-B",
  "apps/native/build",
  "-G",
  "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
];
// SDL3_DIR is explicit so a cached or vcpkg SDL from an earlier configure can't win.
if (sdl) configure.push(`-DCMAKE_PREFIX_PATH=${sdl}`, `-DSDL3_DIR=${sdlConfigDir(sdl)}`);
run(configure);
run(["cmake", "--build", "apps/native/build", "--parallel"]);
// Local and packaged binaries must use the same identity schema and executable
// hash convention; otherwise the runtime rejects every development manifest.
const executable = join(root, "apps/native/build/bunnyhop-native" + (process.platform === "win32" ? ".exe" : ""));
const binarySha256 = executableHash(readFileSync(executable), process.platform === "darwin" ? MACHO_MODE : "sha256");
const menuSha256 = new Bun.CryptoHasher("sha256")
  .update(readFileSync(join(root, "target/native-menu/menu.html")))
  .digest("hex");
const manifest = packageIdentity(
  process.platform,
  process.arch,
  binarySha256,
  menuSha256,
  treeHash(join(root, "target/native-assets")),
);
writeFileSync(join(root, "target/native-menu/native-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(manifest);
