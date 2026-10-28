// Builds the pinned SDL3 (packaging/sdl.json) into target/native-deps/sdl/install.
// Every platform's release build uses this one commit, built the same way.
//
//   bun apps/native/packaging/sdl.ts                    build (skipped when already built for the pin)
//   bun apps/native/packaging/sdl.ts --print install    print a directory: install, config or licenses
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "../../..");

export type SdlPin = {
  repository: string;
  branch: string;
  commit: string;
  version: string;
  macosDeploymentTarget: string;
};

export function readSdlPin(): SdlPin {
  const pin = JSON.parse(readFileSync(join(import.meta.dir, "sdl.json"), "utf8")) as SdlPin;
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new Error("sdl.json: commit must be a full 40-character SHA");
  }
  return pin;
}

export const sdlRoot = join(root, "target/native-deps/sdl");
export const sdlInstallDir = join(sdlRoot, "install");
const stampFile = join(sdlInstallDir, "sdl-pin.txt");

/**
 * The revision string SDL embeds (SDL_GetRevision). Set explicitly so it always holds the full
 * pinned SHA; SDL's own `git describe` drops the SHA at an exact release tag.
 */
export function sdlRevision(pin: SdlPin = readSdlPin()): string {
  return `SDL-${pin.version}-${pin.commit}`;
}

/** The install directory when it holds a build of the current pin, otherwise null. */
export function pinnedSdlInstall(): string | null {
  if (!existsSync(stampFile)) return null;
  return readFileSync(stampFile, "utf8").trim() === sdlRevision() ? sdlInstallDir : null;
}

/** Where the install keeps SDL3Config.cmake: <prefix>/cmake with MSVC, <prefix>/lib/cmake/SDL3 elsewhere. */
export function sdlConfigDir(install = sdlInstallDir): string {
  for (const dir of [join(install, "cmake"), join(install, "lib/cmake/SDL3")]) {
    if (existsSync(join(dir, "SDL3Config.cmake"))) return dir;
  }
  throw new Error(`No SDL3Config.cmake under ${install}`);
}

/** SDL's license directory: <prefix>/licenses with MSVC, <prefix>/share/licenses elsewhere. */
export function sdlLicenseDir(install = sdlInstallDir): string {
  for (const dir of [join(install, "licenses"), join(install, "share/licenses")]) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`No SDL license directory under ${install}`);
}

function run(cmd: string[], cwd = root): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode})`);
  }
  return result.stdout.toString();
}

function runVisible(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode})`);
  }
}

function checkout(pin: SdlPin, source: string): void {
  if (!existsSync(join(source, ".git"))) {
    run(["git", "clone", "--filter=blob:none", "--no-checkout", pin.repository, source]);
  }
  const have = Bun.spawnSync(["git", "-C", source, "cat-file", "-e", `${pin.commit}^{commit}`]).exitCode === 0;
  if (!have) {
    run(["git", "-C", source, "fetch", "--filter=blob:none", "--tags", "origin", pin.commit]);
  }
  run(["git", "-C", source, "checkout", "--detach", "--force", pin.commit]);
  const head = run(["git", "-C", source, "rev-parse", "HEAD"]).trim();
  if (head !== pin.commit) {
    throw new Error(`SDL checkout is at ${head}, expected ${pin.commit}`);
  }
}

export function buildPinnedSdl(): string {
  const pin = readSdlPin();
  if (pinnedSdlInstall()) return sdlInstallDir;

  const source = join(sdlRoot, "src");
  const build = join(sdlRoot, "build");
  // A fresh build and install, so nothing from an older pin or option set survives.
  rmSync(build, { recursive: true, force: true });
  rmSync(sdlInstallDir, { recursive: true, force: true });
  mkdirSync(sdlRoot, { recursive: true });
  checkout(pin, source);

  const configure = [
    "cmake",
    "-S",
    source,
    "-B",
    build,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_INSTALL_PREFIX=${sdlInstallDir}`,
    "-DSDL_SHARED=ON",
    "-DSDL_STATIC=OFF",
    "-DSDL_TEST_LIBRARY=OFF",
    "-DSDL_TESTS=OFF",
    "-DSDL_EXAMPLES=OFF",
    `-DSDL_REVISION=${sdlRevision(pin)}`,
  ];
  if (process.platform === "darwin") {
    configure.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${pin.macosDeploymentTarget}`);
  }
  runVisible(configure);
  runVisible(["cmake", "--build", build, "--parallel"]);
  runVisible(["cmake", "--install", build]);
  writeFileSync(stampFile, sdlRevision(pin) + "\n");
  return sdlInstallDir;
}

/** The SDL shared library inside a staged package, by platform layout. */
function bundledSdlLibrary(packageDir: string, platform: string): string {
  const dir =
    platform === "darwin"
      ? join(packageDir, "Contents/Frameworks")
      : platform === "linux"
        ? join(packageDir, "lib")
        : packageDir;
  const pattern =
    platform === "darwin"
      ? /^libSDL3(\.\d+)*\.dylib$/
      : platform === "linux"
        ? /^libSDL3\.so(\.\d+)*$/
        : /^SDL3\.dll$/i;
  const name = existsSync(dir) ? readdirSync(dir).find((file) => pattern.test(file)) : undefined;
  if (!name) throw new Error(`No bundled SDL3 library in ${dir}`);
  return join(dir, name);
}

/** Checks that a staged package bundles SDL built from the pinned commit, by its embedded revision. */
export function verifyBundledSdl(packageDir: string, platform: string): string {
  const expected = sdlRevision();
  const library = bundledSdlLibrary(packageDir, platform);
  const text = readFileSync(library).toString("latin1");
  if (!text.includes(expected)) {
    const found = text.match(/SDL-3\.\d+\.\d+[\w.+-]*/)?.[0] ?? "an unknown revision";
    throw new Error(`Bundled SDL (${library}) is ${found}, expected ${expected}`);
  }
  return expected;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { print: { type: "string" } } });
  if (values.print === "install") console.log(sdlInstallDir);
  else if (values.print === "config") console.log(sdlConfigDir());
  else if (values.print === "licenses") console.log(sdlLicenseDir());
  else if (values.print !== undefined) throw new Error("--print takes install, config or licenses");
  else console.log(buildPinnedSdl());
}
