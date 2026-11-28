// Which DLLs a Windows package carries beside the game.
//
// Windows' own libraries are never copied. They aren't ours to redistribute, and a copy beside the game makes it
// load the build server's version of that library in place of the player's own.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";

/** Names Windows resolves itself (API sets have no file of their own to look for). */
const WINDOWS_NAMES =
  /^(?:(?:api|ext)-ms-|(?:kernel32|user32|gdi32|advapi32|shell32|ole32|oleaut32|comdlg32|comctl32|ws2_32|winhttp|wininet|crypt32|bcrypt|bcryptprimitives|ntdll|secur32|userenv|version|shlwapi|urlmon|dwmapi|avrt|imm32|setupapi|winmm|opengl32|glu32|ucrtbase|msvcrt|rpcrt4|normaliz|dnsapi|iphlpapi|wldap32|dbghelp|hid|cfgmgr32|powrprof|dwrite|d2d1|dxgi|d3d11|d3d12|dcomp|windowscodecs)\.dll$)/i;
/** The MSVC runtime. Windows may hold a copy, but the package carries the redistributable one. */
const MSVC_RUNTIME = /^(?:msvcp|vcruntime|concrt|vccorlib|vcomp)\d/i;

export type WindowsLibrary = { kind: "windows" } | { kind: "bundle"; file: string };
export type WindowsSearch = {
  /** Folders whose libraries belong in the package: the build folder, --dependencies, the VC redistributable. */
  bundled: string[];
  /** The rest of PATH, used only for folders outside the Windows directory. */
  path: string[];
  /** %SystemRoot%, for example C:\Windows. */
  windows: string;
  exists?: (file: string) => boolean;
};

const inside = (folder: string, parent: string) => {
  const rel = win32.relative(win32.resolve(parent).toLowerCase(), win32.resolve(folder).toLowerCase());
  return !rel.startsWith("..") && !win32.isAbsolute(rel);
};

export function locateWindowsLibrary(name: string, search: WindowsSearch): WindowsLibrary {
  const exists = search.exists ?? existsSync;
  if (WINDOWS_NAMES.test(name)) return { kind: "windows" };
  const find = (folders: string[]) => folders.map((folder) => win32.join(folder, name)).find(exists);
  const own = find(search.bundled.filter((folder) => !inside(folder, search.windows)));
  if (own) return { kind: "bundle", file: own };
  if (exists(win32.join(search.windows, "System32", name))) {
    if (MSVC_RUNTIME.test(name))
      throw new Error(
        `${name} was found only in the Windows directory; configure VCToolsRedistDir so the package carries the redistributable MSVC runtime`,
      );
    return { kind: "windows" };
  }
  const other = find(search.path.filter((folder) => folder && !inside(folder, search.windows)));
  if (other) return { kind: "bundle", file: other };
  throw new Error(`Unresolved Windows dependency ${name}; pass --dependencies DIR / configure VCToolsRedistDir`);
}

const utf16 = (text: string) => Buffer.from(text, "utf16le");
const WINDOWS_PRODUCT = utf16("Microsoft\u00ae Windows\u00ae Operating System");

/** True for a file whose version resource names Windows itself as its product. */
export function isWindowsComponent(file: Uint8Array): boolean {
  return Buffer.from(file.buffer, file.byteOffset, file.byteLength).includes(WINDOWS_PRODUCT);
}

/** What is wrong with the game's version resource, or nothing. Windows shows these fields in Properties > Details. */
export function versionResourceProblem(exe: Uint8Array, version: string, product: string): string | undefined {
  const bytes = Buffer.from(exe.buffer, exe.byteOffset, exe.byteLength);
  if (!bytes.includes(utf16("VS_VERSION_INFO"))) return "the executable has no version resource";
  // A version string is its key, a terminator, padding to four bytes, then its value.
  const holds = (key: string, text: string) => {
    const name = utf16(`${key}\0`);
    const at = bytes.indexOf(name);
    if (at < 0) return false;
    const value = at + name.length;
    return bytes.subarray(value, value + 2 + utf16(`${text}\0`).length).includes(utf16(`${text}\0`));
  };
  const expected = [
    ["FileVersion", version],
    ["ProductVersion", version],
    ["ProductName", product],
    ["FileDescription", product],
  ];
  for (const [key, text] of expected) if (!holds(key, text)) return `the executable's ${key} is not "${text}"`;
  return undefined;
}

/** Checks a staged Windows package: nothing of Windows' own beside the game, and the game's version resource. */
export function verifyWindowsPackage(app: string, version: string, product: string): void {
  for (const name of readdirSync(app).filter((file) => /\.dll$/i.test(file)))
    if (isWindowsComponent(readFileSync(join(app, name))))
      throw new Error(`${name} is a Windows system library and must not be packaged`);
  const problem = versionResourceProblem(readFileSync(join(app, "bunnyhop-native.exe")), version, product);
  if (problem)
    throw new Error(
      `Windows package ${version}: ${problem}; configure the build with -DBUNNYHOP_PACKAGE_VERSION=${version}`,
    );
}
