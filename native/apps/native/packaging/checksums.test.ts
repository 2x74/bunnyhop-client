import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageChecksums } from "./checksums";
test("release checksums verify report bytes and reject archive mutation or paths", () => {
 const directory=mkdtempSync(join(tmpdir(),"native-checksums-"));
 try {
  const name="bunnyhop-native-0.0.1-linux-x64.tar.gz", bytes=Buffer.from("archive fixture");
  const report={schema:1,archive:name,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const save=()=>writeFileSync(join(directory,"package.json"),JSON.stringify(report));
  writeFileSync(join(directory,name),bytes);save();
  const result=packageChecksums(directory);expect(result).toContain(`${report.sha256}  ${name}\n`);expect(result).toContain("  package.json\n");
  writeFileSync(join(directory,name),"tampered");expect(()=>packageChecksums(directory)).toThrow("does not match");
  report.archive="../escape.zip";save();expect(()=>packageChecksums(directory)).toThrow("Invalid archive name");
 } finally {rmSync(directory,{recursive:true,force:true});}
});
