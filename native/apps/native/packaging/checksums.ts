// Verify package reports before writing a portable checksum file for release review.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function packageChecksums(directory: string): string {
  const reports = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!reports.length) throw new Error("No package reports found");
  const files = new Set<string>();
  for (const name of reports) {
    const report = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (
      report.schema !== 1 ||
      typeof report.archive !== "string" ||
      basename(report.archive) !== report.archive ||
      !/^bunnyhop-native-[A-Za-z0-9.-]+\.(?:zip|tar\.gz)$/.test(report.archive)
    )
      throw new Error("Invalid archive name in package report");
    const file = join(directory, report.archive);
    if (!statSync(file).isFile() || statSync(file).size !== report.bytes || sha(readFileSync(file)) !== report.sha256)
      throw new Error("Archive does not match package report");
    files.add(name);
    files.add(report.archive);
  }
  return [...files]
    .sort()
    .map((name) => `${sha(readFileSync(join(directory, name)))}  ${name}\n`)
    .join("");
}
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "package-dir": { type: "string", default: "target/native-packages" } },
  });
  const directory = resolve(values["package-dir"]!);
  writeFileSync(join(directory, "SHA256SUMS"), packageChecksums(directory), { flag: "wx" });
  console.log(`Verified package reports and wrote ${join(directory, "SHA256SUMS")}`);
}
