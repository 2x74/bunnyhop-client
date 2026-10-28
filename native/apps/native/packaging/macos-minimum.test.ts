import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macMinimumFromLoadCommands, macMinimumSupportedOS, maxMacVersion, run } from "../package";
const modern = (version: string, platform = "1") =>
  `Load command 1\n cmd LC_BUILD_VERSION\n cmdsize 32\n platform ${platform}\n minos ${version}\n sdk 27.0\n`;
test("macOS minimum uses deployment targets across all slices, with numeric max and legacy support", () => {
  expect(macMinimumFromLoadCommands(modern("15.0"))).toBe("15.0");
  expect(macMinimumFromLoadCommands(modern("13.0") + modern("27.0"))).toBe("27.0");
  expect(
    macMinimumFromLoadCommands(
      "Load command 1\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 10.15.7\n sdk 27.0\n",
    ),
  ).toBe("10.15.7");
  expect(maxMacVersion(["13.0", "9.9", "15.2.1", "15.10"])).toBe("15.10");
  for (const bad of ["", modern("15.0", "2"), "Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n sdk 27.0"]) {
    expect(() => macMinimumFromLoadCommands(bad)).toThrow();
  }
});
test.skipIf(process.platform !== "darwin")(
  "macOS package minimum includes a higher transitive bundled library, independent of host SDK",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "bunnyhop-macos-minimum-"));
    try {
      const frameworks = join(dir, "Frameworks");
      mkdirSync(frameworks);
      const source = join(dir, "fixture.c"),
        exe = join(dir, "exe"),
        leaf = join(frameworks, "leaf.dylib");
      writeFileSync(source, "int main(void){return 0;}");
      run(["cc", "-mmacosx-version-min=13.0", source, "-o", exe]);
      run(["cc", "-dynamiclib", "-mmacosx-version-min=15.0", source, "-o", leaf]);
      expect(macMinimumSupportedOS(exe, frameworks)).toBe("15.0");
      run(["cc", "-dynamiclib", "-mmacosx-version-min=13.0", source, "-o", leaf]);
      expect(macMinimumSupportedOS(exe, frameworks)).toBe("13.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
