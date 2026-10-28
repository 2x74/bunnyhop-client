import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { treeHash, treeFiles } from "../package";
test("global UTF-8 path order and asset byte changes are deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-assets-"));
  try {
    mkdirSync(join(dir, "a"));
    for (const [n, s] of [
      ["a/x", "x"],
      ["a.json", "json"],
      ["Z", "Z"],
      ["é", "unicode"],
    ])
      writeFileSync(join(dir, n), s);
    expect(treeFiles(dir).map((p) => p.slice(dir.length + 1).replaceAll("\\", "/"))).toEqual([
      "Z",
      "a.json",
      "a/x",
      "é",
    ]);
    const hash = treeHash(dir);
    writeFileSync(join(dir, "a/x"), "changed");
    expect(treeHash(dir)).not.toBe(hash);
    let linked = false;
    try {
      symlinkSync(join(dir, "Z"), join(dir, "link"));
      linked = true;
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    if (linked) expect(() => treeHash(dir)).toThrow("symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test.skipIf(process.platform === "win32")("C++ asset identity matches TypeScript tree hashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-assets-cpp-"));
  try {
    const assets = join(dir, "assets");
    mkdirSync(join(assets, "a"), { recursive: true });
    for (const [name, bytes] of [
      ["a/x", "x"],
      ["a.json", "json"],
      ["Z", "Z"],
      ["é", "unicode"],
    ])
      writeFileSync(join(assets, name), bytes);
    const source = join(dir, "main.cpp"),
      exe = join(dir, "oracle");
    // An OpenSSL/Security-free SHA implementation is already available via the tested native bridge.
    writeFileSync(
      source,
      `#include ${JSON.stringify(resolve(import.meta.dir, "assets_identity.hpp"))}\n#include <iostream>\nint main(int argc,char**argv){std::cout<<native::assets_identity_hash(argv[1]);}`,
    );
    const rust = resolve(import.meta.dir, "../../../target/release/libbunnyhop_native_bridge.a");
    const args = [
      "c++",
      "-std=c++20",
      "-I",
      resolve(import.meta.dir, "../include"),
      source,
      rust,
      ...(process.platform === "darwin"
        ? ["-framework", "Security", "-framework", "CoreFoundation", "-liconv", "-lresolv"]
        : ["-ldl", "-lm", "-lpthread"]),
      "-o",
      exe,
    ];
    const compile = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(compile.exitCode, Buffer.from(compile.stderr).toString()).toBe(0);
    const result = Bun.spawnSync([exe, assets], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe(treeHash(assets));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
