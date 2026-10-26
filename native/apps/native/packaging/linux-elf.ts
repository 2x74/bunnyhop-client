// Only inspect trusted, locally built ELFs: ldd is not a hostile-artifact scanner.
import {chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";

const executableRunpath = "$ORIGIN/../lib";
const libraryRunpath = "$ORIGIN";
const bundledRoot = /^lib(?:SDL3|curl|ssl|crypto|z\.|zstd|brotli|idn|nghttp|psl|ssh2)/;
// Keep libc/toolchain, display/GPU/audio drivers and the desktop stack on the OS.
// Other dependencies of bundled roots (e.g. curl's LDAP/GnuTLS dependencies)
// must travel with them, even when their names don't match bundledRoot.
const systemLibrary = /^(?:ld-linux[^/]*|lib(?:c|m|dl|pthread|rt|resolv|util|anl|nss_[\w-]+|BrokenLocale|stdc\+\+|gcc_s|GL[\w-]*|EGL|OpenGL|GLES[\w-]*|vulkan|gbm|drm[\w-]*|X[\w-]*|xcb[\w-]*|wayland[\w-]*|xkbcommon[\w-]*|asound|pulse[\w-]*|dbus-1|udev|systemd|decor-0|gtk-3|gdk-3|glib-2\.0|gobject-2\.0|gio-2\.0|gmodule-2\.0|pango-1\.0|pangocairo-1\.0|pangoft2-1\.0|cairo(?:-gobject)?|harfbuzz(?:-subset)?|fontconfig|freetype|fribidi|webkit2gtk-4\.1|javascriptcoregtk-4\.1))\.so(?:\.|$)/;
const systemPath = (path: string) => /^\/(?:usr\/)?lib(?:64|32)?\//.test(realpathSync(path));

export function linuxLoaderEnvironment(discovery = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, LC_ALL: "C"};
  for (const key of Object.keys(env)) if ((key.startsWith("LD_") && !(discovery && key === "LD_LIBRARY_PATH")) || key === "GLIBC_TUNABLES") delete env[key];
  return env;
}

function command(args: string[], discovery = false): string {
  const result = Bun.spawnSync(args, {env: linuxLoaderEnvironment(discovery), stdout: "pipe", stderr: "pipe"});
  if (result.exitCode !== 0) throw new Error(`Linux ELF ${args[0]} failed (${result.exitCode}): ${Buffer.from(result.stderr).toString()}`);
  return Buffer.from(result.stdout).toString();
}

function needed(file: string): string[] {
  const names = command(["patchelf", "--print-needed", file]).trim().split("\n").filter(Boolean);
  for (const name of names) if (name.includes("/") || name === "." || name === "..") throw new Error(`Non-relocatable ELF dependency in ${file}: ${name}`);
  return names;
}

function dependencies(file: string, discovery = false): {output: string; libraries: Map<string, string>} {
  const output = command(["ldd", file], discovery);
  if (/=>\s+not found\b/.test(output)) throw new Error(`Unresolved Linux ELF dependency in ${file}:\n${output}`);
  const libraries = new Map<string, string>();
  for (const match of output.matchAll(/^\s*(\S+) => (\/.*?) \(0x[\da-f]+\)\s*$/gm)) {
    const previous = libraries.get(match[1]);
    if (previous && realpathSync(previous) !== realpathSync(match[2])) throw new Error(`Ambiguous Linux ELF dependency ${match[1]} in ${file}`);
    libraries.set(match[1], match[2]);
  }
  // glibc's loader can itself be DT_NEEDED (notably on ARM64). ldd prints
  // that entry as an absolute path without the usual "name =>" prefix.
  for (const match of output.matchAll(/^\s*(\/.*?) \(0x[\da-f]+\)\s*$/gm)) libraries.set(basename(match[1]), match[1]);
  for (const name of needed(file)) if (!libraries.has(name)) throw new Error(`Unresolved Linux ELF dependency ${name} in ${file}`);
  return {output, libraries};
}

function packageFiles(executable: string, libraryDirectory: string): string[] {
  const files = [executable, ...readdirSync(libraryDirectory).sort().map(name => join(libraryDirectory, name))];
  for (const file of files) if (!lstatSync(file).isFile()) throw new Error(`Packaged ELF is not a regular file: ${file}`);
  return files;
}

// Independent readelf validation catches surviving DT_RPATH as well as RUNPATH,
// including a patch tool that exits successfully without making the change.
function verifyRunpath(file: string, expected: string) {
  const dynamic = command(["readelf", "--dynamic", "--wide", file]);
  const paths = [...dynamic.matchAll(/\((RPATH|RUNPATH)\).*?\[([^\]]*)\]/g)];
  if (paths.length !== 1 || paths[0][1] !== "RUNPATH" || paths[0][2] !== expected) throw new Error(`Unsafe ELF RPATH/RUNPATH in ${file}; expected only ${expected}`);
  needed(file);
}

export function verifyLinuxPackage(executable: string, libraryDirectory: string): string {
  executable = resolve(executable); libraryDirectory = resolve(libraryDirectory);
  if (libraryDirectory !== resolve(dirname(executable), "../lib")) throw new Error("Linux package must use bin/ and lib/ sibling directories");
  const files = packageFiles(executable, libraryDirectory);
  const bundled = new Map(files.slice(1).map(file => [basename(file), realpathSync(file)]));
  const interpreter = command(["patchelf", "--print-interpreter", executable]).trim();
  if (!systemPath(interpreter)) throw new Error(`Non-system Linux ELF interpreter: ${interpreter}`);
  for (const file of files) verifyRunpath(file, file === executable ? executableRunpath : libraryRunpath);
  const reports: string[] = [];
  for (const file of files) {
    const {output, libraries} = dependencies(file);
    for (const [name, actual] of libraries) {
      const packaged = bundled.get(name);
      if (realpathSync(actual) !== packaged && !systemPath(actual)) throw new Error(`Linux ELF dependency escaped package/system libraries: ${name} => ${actual} (${file})`);
    }
    // A missing bundled transitive library must not silently fall back to a
    // same-named host copy. Check each object's direct edges: system libraries
    // can independently use host copies of those SONAMEs deeper in their graph.
    for (const name of needed(file)) {
      const packaged = bundled.get(name);
      if (packaged && realpathSync(libraries.get(name)!) !== packaged) throw new Error(`Linux ELF direct dependency escaped package: ${name} (${file})`);
      if (!packaged && (bundledRoot.test(name) || (file !== executable && !systemLibrary.test(name)))) throw new Error(`Unbundled Linux ELF dependency: ${name} (${file})`);
    }
    reports.push(`${file === executable ? "bin/" + basename(file) : "lib/" + basename(file)}\n${output}`);
  }
  return reports.join("\n");
}

export function bundleLinuxDependencies(executable: string, libraryDirectory: string, dlopenLibraries: string[] = []): string {
  executable = resolve(executable); libraryDirectory = resolve(libraryDirectory);
  mkdirSync(libraryDirectory, {recursive: true});
  if (readdirSync(libraryDirectory).length) throw new Error("Linux library staging directory must be empty");
  const queue: {source: string; target: string}[] = [];
  const sources = new Map<string, string>();
  const add = (name: string, source: string) => {
    if (basename(name) !== name || name === "." || name === "..") throw new Error(`Unsafe Linux library name: ${name}`);
    source = realpathSync(source);
    const previous = sources.get(name);
    if (previous) {if (previous !== source) throw new Error(`Linux library basename collision: ${name}`); return;}
    const target = join(libraryDirectory, name);
    copyFileSync(source, target); chmodSync(target, 0o755);
    sources.set(name, source); queue.push({source, target});
  };
  const initial = dependencies(executable, true).libraries;
  for (const name of needed(executable)) if (bundledRoot.test(name)) add(name, initial.get(name)!);
  // ldd cannot discover dlopen-only modules. Explicit inputs get the same closure
  // and relocation treatment; SDL's OS driver modules remain system dependencies.
  for (const file of dlopenLibraries) add(basename(file), file);
  for (let i = 0; i < queue.length; i++) {
    const resolved = dependencies(queue[i].source, true).libraries;
    for (const name of needed(queue[i].source)) {
      const source = resolved.get(name)!;
      if (!systemLibrary.test(name) || !systemPath(source)) add(name, source);
    }
  }
  for (const file of packageFiles(executable, libraryDirectory)) {
    command(["patchelf", "--remove-rpath", file]);
    command(["patchelf", "--set-rpath", file === executable ? executableRunpath : libraryRunpath, file]);
  }
  return verifyLinuxPackage(executable, libraryDirectory);
}
