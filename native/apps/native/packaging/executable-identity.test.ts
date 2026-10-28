import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executableBytes, executableHash, MACHO_MODE } from "./executable-identity";
test("macho identity rejects malformed inputs", () => {
  expect(() => executableBytes(Buffer.alloc(32), MACHO_MODE)).toThrow();
  expect(() => executableBytes(Buffer.alloc(0), "unknown")).toThrow();
});
test.skipIf(process.platform !== "darwin")(
  "C++/TS identity stable unsigned/ad-hoc signed; code mutation changes identity",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "bunnyhop-identity-"));
    const run = (args: string[]) => {
      const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode, String(r.stderr)).toBe(0);
      return Buffer.from(r.stdout);
    };
    try {
      const exe = join(dir, "sample"),
        source = join(dir, "main.cpp");
      writeFileSync(source, "int main(){return 17;}");
      run(["clang++", source, "-o", exe]);
      run(["codesign", "--remove-signature", exe]);
      const unsigned = readFileSync(exe),
        hash = executableHash(unsigned, MACHO_MODE);
      run(["codesign", "--force", "--sign", "-", exe]);
      const signed = readFileSync(exe);
      expect(executableHash(signed, MACHO_MODE)).toBe(hash);
      run(["codesign", "--force", "--sign", "-", "--identifier", "different.id", exe]);
      expect(executableHash(readFileSync(exe), MACHO_MODE)).toBe(hash);
      // First code section offset is encoded in LC_SEGMENT_64; changing its data must affect identity.
      const mutated = Buffer.from(signed);
      let at = 32,
        offset = 0;
      for (let i = 0; i < signed.readUInt32LE(16); i++) {
        if (signed.readUInt32LE(at) === 0x19 && signed.readUInt32LE(at + 64) > 0) {
          offset = signed.readUInt32LE(at + 72 + 48);
          if (offset) break;
        }
        at += signed.readUInt32LE(at + 4);
      }
      expect(offset).toBeGreaterThan(0);
      mutated[offset] ^= 1;
      expect(executableHash(mutated, MACHO_MODE)).not.toBe(hash);
      const cpp = join(dir, "oracle.cpp");
      writeFileSync(
        cpp,
        `#include ${JSON.stringify(resolve(import.meta.dir, "executable_identity.hpp"))}\n#include <fstream>\n#include <iostream>\nint main(int argc,char**argv){std::ifstream f(argv[1],std::ios::binary);std::vector<uint8_t>b(std::istreambuf_iterator<char>(f),{});auto out=native::executable_identity_bytes(b,"macho-code-v1");std::cout.write(reinterpret_cast<const char*>(out.data()),out.size());}`,
      );
      run(["clang++", "-std=c++20", cpp, "-o", join(dir, "oracle")]);
      writeFileSync(join(dir, "unsigned"), unsigned);
      for (const file of [exe, join(dir, "unsigned")])
        expect(run([join(dir, "oracle"), file])).toEqual(Buffer.from(executableBytes(readFileSync(file), MACHO_MODE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
