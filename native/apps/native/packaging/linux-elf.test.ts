import {expect, test} from "bun:test";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import {bundleLinuxDependencies, linuxLoaderEnvironment, verifyLinuxPackage} from "./linux-elf";
import {makeManifest} from "../package";
import {CANONICAL_PHYSICS, CANONICAL_TIMER_RULES} from "../ensure-wasm";
import {packageBranding} from "./branding";
import {exportMusic, OST} from "../src/export-music";

const linuxTest = test.skipIf(process.platform !== "linux");
function run(args: string[], env = linuxLoaderEnvironment()) {
  const result = Bun.spawnSync(args, {env, cwd: tmpdir(), stdout: "pipe", stderr: "pipe"});
  expect(result.exitCode, `${args.join(" ")}\n${Buffer.from(result.stderr)}`).toBe(0);
  return Buffer.from(result.stdout).toString();
}
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bunnyhop-elf-"));
  try {
    const build = join(root, "builder home", "SDL-build"), stage = join(root, "stage"), exe = join(stage, "bin/bunnyhop-native"), libs = join(stage, "lib");
    mkdirSync(build, {recursive: true}); mkdirSync(join(stage, "bin"), {recursive: true}); mkdirSync(libs);
    const shared = (name: string, source: string, link: string[] = [], legacy = false) => {
      const c = join(build, `${name}.c`); writeFileSync(c, source);
      run(["cc", "-fPIC", "-shared", c, "-o", join(build, name), `-Wl,-soname,${name}`, `-Wl,-rpath,${build}`, ...(legacy ? ["-Wl,--disable-new-dtags"] : []), `-L${build}`, ...link]);
    };
    shared("libfixture-leaf.so.1", "int leaf(void){return 17;}");
    shared("libfixture-core.so.1", "extern int leaf(void); int core(void){return leaf();}", ["-l:libfixture-leaf.so.1"], true);
    shared("libfixture-plugin-leaf.so.1", "int plugin_leaf(void){return 25;}");
    shared("libfixture-plugin.so.1", "extern int plugin_leaf(void); int plugin(void){return plugin_leaf();}", ["-l:libfixture-plugin-leaf.so.1"]);
    shared("libSDL3-fixture.so.0", `#include <dlfcn.h>
      extern int core(void);
      int fixture(void){void *p=dlopen("libfixture-plugin.so.1",RTLD_NOW); if(!p)return -1;
        int (*f)(void)=(int(*)(void))dlsym(p,"plugin"); int n=f?f()+core():-2; dlclose(p);return n;}`,
      ["-l:libfixture-core.so.1", "-ldl"], true);
    const source = join(build, "main.c");
    writeFileSync(source, '#include <stdio.h>\nextern int fixture(void); int main(void){int n=fixture(); printf("fixture=%d\\n",n);return n!=42;}');
    run(["cc", source, "-o", exe, `-L${build}`, "-l:libSDL3-fixture.so.0", `-Wl,-rpath,${build}`, `-Wl,-rpath-link,${build}`]);
    // Real ARM64 SDL builds can explicitly need the loader; ldd prints this
    // dependency without "name =>". Keep that form covered on every Linux CPU.
    const interpreter = run(["patchelf", "--print-interpreter", exe]).trim();
    run(["patchelf", "--add-needed", basename(interpreter), join(build, "libSDL3-fixture.so.0")]);
    return {root, build, stage, exe, libs, plugin: join(build, "libfixture-plugin.so.1")};
  } catch (error) {rmSync(root, {recursive: true, force: true}); throw error;}
}

function releaseResources(stage: string, exe: string) {
  const resources = join(stage, "share/bunnyhop-native");
  for (const name of ["menu.html", "native-assets/viewmodels.json", "native-assets/viewmodels.bin.z", "native-assets/actor-animations.json", "native-assets/actor-animations.bin", "native-assets/tp-inspects.json", "native-assets/runner.json", "native-assets/runner.bin", "native-assets/audio.json", "native-assets/tutorial.json", "native-assets/hud.rgba", "licenses/SDL3.txt", "licenses/dr_libs.txt", "licenses/stb.txt", "licenses/LDNOOBW-CC-BY-4.0.txt", "licenses/Announcer-CC-BY-4.0.txt","licenses/Unicode.txt", "licenses/JetBrainsMono-OFL.txt", "licenses/LeagueGothic-OFL.txt", "licenses/LICENSE-playsrc", "licenses/LICENSE.source-sdk-2013", "licenses/thirdpartylegalnotices.txt", "licenses/NOTICE-playsrc.md", "licenses/SOURCE-SDK-NOTICES.md", "licenses/rust-dependencies.json"]) {
    const path = join(resources, name); mkdirSync(resolve(path, ".."), {recursive: true}); writeFileSync(path, "local fixture");
  }
  packageBranding(resources, stage, "linux");
  exportMusic(join(resources,"native-assets"),OST.tracks);
  writeFileSync(join(resources,"native-assets/audio.json"),JSON.stringify({music:OST.tracks}));
  const wasm = readFileSync(resolve(import.meta.dir, "../../web/src/wasm/bunnyhop_core.wasm")), wasmHash = createHash("sha256").update(wasm).digest("hex");
  const manifest = makeManifest(exe, resources, "linux", process.arch, wasm, {wasm: `bunnyhop-web/${wasmHash.slice(0, 12)}`, physics: CANONICAL_PHYSICS, rules: CANONICAL_TIMER_RULES});
  writeFileSync(join(resources, "native-manifest.json"), JSON.stringify(manifest));
  return manifest;
}

linuxTest("unsafe ELF build paths become relocatable, including transitive and dlopen dependencies; release-check rechecks every ELF", () => {
  const f = fixture();
  try {
    expect(run(["readelf", "-d", f.exe])).toContain(f.build);
    expect(() => verifyLinuxPackage(f.exe, f.libs)).toThrow("Unsafe ELF RPATH/RUNPATH");
    const before = hash(f.exe), sourceLibraryHash = hash(join(f.build, "libSDL3-fixture.so.0"));
    bundleLinuxDependencies(f.exe, f.libs, [f.plugin]);
    expect(hash(f.exe)).not.toBe(before);
    expect(hash(join(f.build, "libSDL3-fixture.so.0"))).toBe(sourceLibraryHash);
    expect(readdirSync(f.libs).sort()).toEqual(["libSDL3-fixture.so.0", "libfixture-core.so.1", "libfixture-leaf.so.1", "libfixture-plugin-leaf.so.1", "libfixture-plugin.so.1"]);
    const manifest = releaseResources(f.stage, f.exe);
    expect(manifest.binarySha256).toBe(hash(f.exe));
    const relocated = join(f.root, "relocated package with spaces"); renameSync(f.stage, relocated);
    rmSync(f.build, {recursive: true});
    const exe = join(relocated, "bin/bunnyhop-native"), libs = join(relocated, "lib");
    expect(run([exe])).toBe("fixture=42\n"); // Direct launch, cwd outside package, no LD_LIBRARY_PATH.
    expect(verifyLinuxPackage(exe, libs)).toContain(join(libs, "libfixture-core.so.1"));
    const check = [process.execPath, resolve(import.meta.dir, "release-check.ts"), "--package", relocated, "--skip-sdl-pin"];
    expect(JSON.parse(run(check)).valid).toBe(true);
    // The executable hash stays valid, but a tampered bundled library must fail.
    run(["patchelf", "--set-rpath", "/tmp/unsafe-builder-search", join(libs, "libfixture-plugin.so.1")]);
    expect(() => verifyLinuxPackage(exe, libs)).toThrow("Unsafe ELF RPATH/RUNPATH");
    const rejected = Bun.spawnSync(check, {env: linuxLoaderEnvironment(), stdout: "pipe", stderr: "pipe"});
    expect(rejected.exitCode).toBe(1);
    expect(Buffer.from(rejected.stderr).toString()).toContain("Unsafe ELF RPATH/RUNPATH");
    run(["patchelf", "--set-rpath", "$ORIGIN", join(libs, "libfixture-plugin.so.1")]);
    rmSync(join(libs, "libfixture-plugin-leaf.so.1"));
    expect(() => verifyLinuxPackage(exe, libs)).toThrow("Unresolved Linux ELF dependency");
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

linuxTest("ELF packaging rejects missing dependencies and path-qualified DT_NEEDED", () => {
  const f = fixture();
  try {
    run(["patchelf", "--replace-needed", "libSDL3-fixture.so.0", join(f.build, "libSDL3-fixture.so.0"), f.exe]);
    expect(() => bundleLinuxDependencies(f.exe, f.libs)).toThrow("Non-relocatable ELF dependency");
    run(["patchelf", "--replace-needed", join(f.build, "libSDL3-fixture.so.0"), "libSDL3-fixture.so.0", f.exe]);
    rmSync(join(f.build, "libfixture-leaf.so.1"));
    expect(() => bundleLinuxDependencies(f.exe, f.libs)).toThrow("Unresolved Linux ELF dependency");
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

linuxTest("patch failures and successful no-op patchers fail closed", () => {
  const f = fixture();
  try {
    const tools = join(f.root, "tools"); mkdirSync(tools);
    const actual = Bun.which("patchelf")!, shim = join(tools, "patchelf");
    const code = `import {bundleLinuxDependencies} from ${JSON.stringify(resolve(import.meta.dir, "linux-elf.ts"))}; bundleLinuxDependencies(...JSON.parse(process.argv[1]));`;
    const env = {...linuxLoaderEnvironment(), PATH: `${tools}:${process.env.PATH}`};
    for (const mode of ["failure", "no-op"]) {
      writeFileSync(shim, `#!/bin/sh\ncase "$1" in --remove-rpath|--set-rpath) ${mode === "failure" ? "echo patch-denied >&2; exit 73" : "exit 0"};; esac\nexec ${JSON.stringify(actual)} "$@"\n`); chmodSync(shim, 0o755);
      const result = Bun.spawnSync([process.execPath, "-e", code, JSON.stringify([f.exe, f.libs, [f.plugin]])], {env, stdout: "pipe", stderr: "pipe"});
      expect(result.exitCode).not.toBe(0);
      expect(Buffer.from(result.stderr).toString()).toContain(mode === "failure" ? "patch-denied" : "Unsafe ELF RPATH/RUNPATH");
      rmSync(f.libs, {recursive: true}); mkdirSync(f.libs);
    }
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test("verification environment drops loader overrides", () => {
  const original = {...process.env};
  try {
    process.env.LD_LIBRARY_PATH = "/tmp/build"; process.env.LD_PRELOAD = "/tmp/preload"; process.env.LD_AUDIT = "/tmp/audit"; process.env.GLIBC_TUNABLES = "example";
    const env = linuxLoaderEnvironment();
    for (const key of ["LD_LIBRARY_PATH", "LD_PRELOAD", "LD_AUDIT", "GLIBC_TUNABLES"]) expect(env[key]).toBeUndefined();
    expect(linuxLoaderEnvironment(true).LD_LIBRARY_PATH).toBe("/tmp/build");
  } finally {
    for (const key of ["LD_LIBRARY_PATH", "LD_PRELOAD", "LD_AUDIT", "GLIBC_TUNABLES"]) {if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];}
  }
});
