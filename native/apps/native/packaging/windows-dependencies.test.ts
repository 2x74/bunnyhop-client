import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "./branding";
import {
  isWindowsComponent,
  locateWindowsLibrary,
  verifyWindowsPackage,
  versionResourceProblem,
} from "./windows-dependencies";

const here = import.meta.dir;
const utf16 = (text: string) => Buffer.from(text, "utf16le");

// The build server as packaging sees it: its own libraries, the VC redistributable, and Windows on PATH.
const files = new Set(
  [
    "D:\\build\\SDL3.dll",
    "D:\\deps\\bin\\libcurl.dll",
    "D:\\deps\\bin\\z.dll",
    "C:\\VS\\Redist\\x64\\Microsoft.VC143.CRT\\MSVCP140.dll",
    "C:\\Windows\\System32\\MSVCP140.dll",
    "C:\\Windows\\System32\\VCRUNTIME140_1.dll",
    "C:\\Windows\\System32\\AVRT.dll",
    "C:\\Windows\\System32\\bcryptprimitives.dll",
    "C:\\Windows\\System32\\mfplat.dll",
    "C:\\Tools\\ffmpeg\\avcodec-62.dll",
  ].map((file) => file.toLowerCase()),
);
const search = {
  bundled: ["D:\\build", "D:\\deps\\bin", "C:\\VS\\Redist\\x64\\Microsoft.VC143.CRT"],
  path: ["C:\\WINDOWS\\system32", "C:\\Windows", "", "C:\\Tools\\ffmpeg"],
  windows: "C:\\Windows",
  exists: (file: string) => files.has(file.toLowerCase()),
};

test("the game's own libraries and the redistributable runtime are packaged", () => {
  expect(locateWindowsLibrary("SDL3.dll", search)).toEqual({ kind: "bundle", file: "D:\\build\\SDL3.dll" });
  expect(locateWindowsLibrary("libcurl.dll", search)).toEqual({ kind: "bundle", file: "D:\\deps\\bin\\libcurl.dll" });
  expect(locateWindowsLibrary("MSVCP140.dll", search)).toEqual({
    kind: "bundle",
    file: "C:\\VS\\Redist\\x64\\Microsoft.VC143.CRT\\MSVCP140.dll",
  });
  expect(locateWindowsLibrary("avcodec-62.dll", search)).toEqual({
    kind: "bundle",
    file: "C:\\Tools\\ffmpeg\\avcodec-62.dll",
  });
});

// v0.6.2 to v0.9.7 shipped the build server's AVRT.dll and bcryptprimitives.dll beside the game.
test("Windows' own libraries are left to Windows", () => {
  for (const name of ["AVRT.dll", "bcryptprimitives.dll", "bcrypt.dll", "KERNEL32.dll", "mfplat.dll"])
    expect(locateWindowsLibrary(name, search)).toEqual({ kind: "windows" });
  expect(locateWindowsLibrary("api-ms-win-crt-runtime-l1-1-0.dll", search)).toEqual({ kind: "windows" });
  // A --dependencies folder inside the Windows directory doesn't make a system library the game's own.
  const careless = { ...search, bundled: ["C:\\Windows\\System32", ...search.bundled] };
  expect(locateWindowsLibrary("mfplat.dll", careless)).toEqual({ kind: "windows" });
});

test("a runtime found only in the Windows directory or a library found nowhere stops packaging", () => {
  expect(() => locateWindowsLibrary("VCRUNTIME140_1.dll", search)).toThrow("VCToolsRedistDir");
  expect(() => locateWindowsLibrary("missing.dll", search)).toThrow("Unresolved Windows dependency missing.dll");
});

test("a library that names Windows as its product is recognised", () => {
  const system = Buffer.concat([
    Buffer.alloc(64),
    utf16("ProductName\0Microsoft\u00ae Windows\u00ae Operating System\0"),
  ]);
  const runtime = Buffer.concat([Buffer.alloc(64), utf16("ProductName\0Microsoft\u00ae Visual Studio\u00ae\0")]);
  expect(isWindowsComponent(system)).toBe(true);
  expect(isWindowsComponent(runtime)).toBe(false);
});

function versionStrings(strings: Record<string, string>) {
  const parts = [Buffer.alloc(6), utf16("VS_VERSION_INFO\0"), Buffer.alloc(2)];
  for (const [key, text] of Object.entries(strings)) {
    const name = utf16(`${key}\0`);
    // Header of three 16-bit fields, then the key, padded so the value starts on a four-byte boundary.
    parts.push(Buffer.alloc(6), name, Buffer.alloc((6 + name.length) % 4 ? 2 : 0), utf16(`${text}\0`));
  }
  return Buffer.concat(parts);
}

test("the packaged game must carry this release's version resource", () => {
  const strings = {
    FileDescription: APP_NAME,
    FileVersion: "0.9.8",
    ProductName: APP_NAME,
    ProductVersion: "0.9.8",
  };
  expect(versionResourceProblem(versionStrings(strings), "0.9.8", APP_NAME)).toBeUndefined();
  expect(versionResourceProblem(Buffer.alloc(256), "0.9.8", APP_NAME)).toBe("the executable has no version resource");
  // Built without -DBUNNYHOP_PACKAGE_VERSION, or packaged under another version.
  expect(versionResourceProblem(versionStrings({ ...strings, FileVersion: "0.0.0" }), "0.9.8", APP_NAME)).toContain(
    "FileVersion",
  );
  expect(versionResourceProblem(versionStrings(strings), "0.9.80", APP_NAME)).toContain("FileVersion");
  expect(versionResourceProblem(versionStrings({ ...strings, ProductName: "Game" }), "0.9.8", APP_NAME)).toContain(
    "ProductName",
  );
});

test("a staged package with a Windows library beside the game is rejected", () => {
  const stage = mkdtempSync(join(tmpdir(), "bunnyhop-windows-package-"));
  try {
    const strings = { FileDescription: APP_NAME, FileVersion: "0.9.8", ProductName: APP_NAME, ProductVersion: "0.9.8" };
    writeFileSync(join(stage, "bunnyhop-native.exe"), versionStrings(strings));
    writeFileSync(join(stage, "SDL3.dll"), utf16("ProductName\0SDL\0"));
    verifyWindowsPackage(stage, "0.9.8", APP_NAME);
    expect(() => verifyWindowsPackage(stage, "0.9.9", APP_NAME)).toThrow("-DBUNNYHOP_PACKAGE_VERSION=0.9.9");
    writeFileSync(join(stage, "AVRT.dll"), utf16("ProductName\0Microsoft\u00ae Windows\u00ae Operating System\0"));
    expect(() => verifyWindowsPackage(stage, "0.9.8", APP_NAME)).toThrow("AVRT.dll is a Windows system library");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("the resource script and the build supply those fields", () => {
  const resource = readFileSync(join(here, "windows/app.rc.in"), "utf8");
  expect(resource).toContain("VERSIONINFO");
  expect(resource).toContain("FILEVERSION @BUNNYHOP_RC_VERSION@");
  for (const key of ["FileDescription", "ProductName"]) expect(resource).toContain(`VALUE "${key}", "${APP_NAME}"`);
  for (const key of ["FileVersion", "ProductVersion"])
    expect(resource).toContain(`VALUE "${key}", "@BUNNYHOP_PACKAGE_VERSION@"`);
  const cmake = readFileSync(join(here, "../CMakeLists.txt"), "utf8");
  expect(cmake).toContain("BUNNYHOP_PACKAGE_VERSION");
  expect(cmake).toContain("BUNNYHOP_RC_VERSION");
  const build = readFileSync(join(here, "windows/build.ps1"), "utf8");
  expect(build).toContain('"-DBUNNYHOP_PACKAGE_VERSION=$Version"');
});
