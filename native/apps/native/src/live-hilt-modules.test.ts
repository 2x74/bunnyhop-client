// The living hilt loader must pick out the four designs however the platform spells their paths. Bun on Windows
// hands its loader backslash paths with a drive letter; the v0.9.4 candidate failed there when the filter only
// knew forward slashes.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DESIGN_FILTER, designOf } from "./live-hilt-modules";

const designs = ["clockwork", "deep", "storm", "bloom"];
const spellings = (name: string) => [
  `/home/runner/work/bunnyhop-client/native/apps/web/src/viewmodel/hilts/live/designs/${name}.ts`,
  `D:\\a\\bunnyhop-client\\bunnyhop-client\\native\\apps\\web\\src\\viewmodel\\hilts\\live\\designs\\${name}.ts`,
  `D:/a/bunnyhop-client/bunnyhop-client/native/apps/web/src/viewmodel/hilts/live/designs/${name}.ts`,
  `d:\\A\\Bunnyhop-Client\\NATIVE\\apps\\web\\src\\Viewmodel\\Hilts\\Live\\Designs\\${name.toUpperCase()}.TS`,
  `C:\\Users\\Some One\\src\\native\\apps\\web\\src\\viewmodel\\hilts/live\\designs/${name}.ts`,
];
const urls = (name: string) => [
  `file:///D:/a/bunnyhop-client/bunnyhop-client/native/apps/web/src/viewmodel/hilts/live/designs/${name}.ts`,
  `file:///C:/Users/Some%20One/src/native/apps/web/src/viewmodel/hilts/live/designs/${name}.ts`,
  `file:///home/runner/native/apps/web/src/viewmodel/hilts/live/designs/${name}.ts`,
];

test("every spelling of a design path passes the loader's filter and names the design", () => {
  for (const name of designs) {
    for (const path of spellings(name)) {
      expect(DESIGN_FILTER.test(path)).toBe(true);
      expect(designOf(path)).toBe(name);
    }
    for (const url of urls(name)) {
      expect(DESIGN_FILTER.test(url)).toBe(true);
      expect(designOf(url)).toBe(name);
    }
  }
});

test("this platform's own resolved path and file URL match", () => {
  for (const name of designs) {
    const path = resolve(import.meta.dir, `../../web/src/viewmodel/hilts/live/designs/${name}.ts`);
    expect(DESIGN_FILTER.test(path)).toBe(true);
    expect(designOf(path)).toBe(name);
    expect(designOf(pathToFileURL(path).href)).toBe(name);
  }
});

test("other modules are left alone", () => {
  for (const path of [
    "D:\\a\\native\\apps\\web\\src\\viewmodel\\hilts\\live\\designs\\watcher.ts",
    "/n/apps/web/src/viewmodel/hilts/live/designs/common.ts",
    "/n/apps/web/src/viewmodel/hilts/live/designs/clockwork.test.ts",
    "/n/apps/web/src/viewmodel/hilts/live/designs/myclockwork.ts",
    "/n/apps/web/src/viewmodel/hilts/live/kit.ts",
    "D:\\a\\native\\apps\\web\\src\\viewmodel\\hilts\\designs\\clockwork.ts",
  ]) {
    expect(DESIGN_FILTER.test(path)).toBe(false);
    expect(designOf(path)).toBeUndefined();
  }
});

test("the loader exposes the helpers when the designs load", async () => {
  const { loadLiveHilts } = await import("./live-hilt-modules");
  const hilts = await loadLiveHilts();
  expect(typeof hilts.pivots).toBe("function");
  expect(hilts.TEETH).toBeGreaterThan(0);
});
