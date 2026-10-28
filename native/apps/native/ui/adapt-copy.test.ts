import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { COPY_FIXES, adaptCopySource } from "./adapt-copy";

test("copy fixes apply to the vendored web text and are no-ops once it is current", async () => {
  for (const fix of COPY_FIXES) {
    const source = await readFile(new URL(`../../web/src/${fix.file}`, import.meta.url), "utf8");
    const adapted = adaptCopySource(fix.file, source);
    expect(adapted).toContain(fix.to);
    expect(adaptCopySource(fix.file, adapted)).toBe(adapted);
  }
  expect(adaptCopySource("ui/other.ts", COPY_FIXES[0].from)).toBe(COPY_FIXES[0].from);
});
