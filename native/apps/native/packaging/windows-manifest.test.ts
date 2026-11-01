import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const manifest = readFileSync(join(here, "windows/bunnyhop-native.manifest"), "utf8");

function unbalancedTags(xml: string): string[] {
  const open: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const [tag, closing, name, selfClosed] of body.matchAll(/<(\/?)([\w:.-]+)[^<>]*?(\/?)>/g)) {
    if (selfClosed) continue;
    if (!closing) open.push(name);
    else if (open.pop() !== name) return [tag];
  }
  return open;
}

// A malformed manifest stops the program from starting at all, with only a side-by-side error to show for it.
test("the Windows manifest is well-formed and asks for current controls and Windows 10", () => {
  expect(unbalancedTags(manifest)).toEqual([]);
  expect(manifest).toContain('name="Microsoft.Windows.Common-Controls"');
  expect(manifest).toContain('version="6.0.0.0"');
  expect(manifest).toContain('publicKeyToken="6595b64144ccf1df"');
  expect(manifest).toContain('<supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>');
  expect(manifest).toContain('level="asInvoker"');
});

test("the game target embeds it", () => {
  const cmake = readFileSync(join(here, "../CMakeLists.txt"), "utf8");
  expect(cmake).toContain("packaging/windows/bunnyhop-native.manifest");
});
