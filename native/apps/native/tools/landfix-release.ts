// The release's offline landfix fixtures and pristine upstream source are retained with its GitHub assets.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const archive = join(root, "target/qualification-inputs.tar.gz");
const inputs = join(root, "target/qualification-inputs");
const commit = "23059ce90500ffdde7cd5884208e26749fe3d108";
const expectedArchive = "a318c27341a24de3133ef3ab36c7d0bd4a9d0d39d7938195b5284e5f72ee2b20";
const expectedFiles: Record<string, string> = {
  "baseline.wasm": "08de4923bdfc4f01678420c1f4e62ca5567c4e2501e4c36bfdef45ebb1871d58",
  "bhop_eazy.bsp": "4abc652f775d1639451a20c3a91d5903b41307981ea48395ba0b561e869cd1fe",
  "on.bhr": "4b6f0c0ee93454d94852d7994d20f670ecf26ecfce6b3055db831dabfac0f2dc",
  "off.bhr": "da181bb2dfc38758911a461361cd6fe12aa60b1a9c6e22776d79b976eb04c511",
  "toggle.bhr": "4cf5ed1ed7b224172ebb9ec3f4b197e98600556871591d9879d2b9f502e77e49",
};
function run(args: string[]): void {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) throw new Error(`${args.join(" ")} failed (${result.exitCode})`);
}
function verify(file: string, expected: string): void {
  const actual = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) throw new Error(`Qualification input hash mismatch: ${file}`);
}
if (Bun.argv.includes("--stage")) {
  verify(archive, expectedArchive);
  run(["tar", "-xzf", archive, "-C", "target"]);
  for (const [name, sha] of Object.entries(expectedFiles)) verify(join(inputs, name), sha);
  mkdirSync(join(root, "maps"), { recursive: true });
  const map = join(root, "maps/bhop_eazy.bsp");
  if (!existsSync(map)) copyFileSync(join(inputs, "bhop_eazy.bsp"), map);
  verify(map, expectedFiles["bhop_eazy.bsp"]!);
  console.log("Release landfix inputs staged and hash-checked");
} else if (Bun.argv.includes("--proof")) {
  for (const [name, sha] of Object.entries(expectedFiles)) verify(join(inputs, name), sha);
  verify(join(root, "maps/bhop_eazy.bsp"), expectedFiles["bhop_eazy.bsp"]!);
  const output = "target/native-landfix";
  run([
    "bun",
    "apps/native/tools/landfix-proof.ts",
    "--baseline",
    join(inputs, "baseline.wasm"),
    "--output",
    `${output}/identity`,
  ]);
  run(["cargo", "test", "-p", "bunnyhop-core", "--features", "native-wasm-math", "--test", "landfix_v27", "--locked"]);
  for (const name of ["on", "off", "toggle"])
    run([
      "bun",
      "crates/native-bridge/tools/record-proof.ts",
      "--map",
      "maps/bhop_eazy.bsp",
      "--replay",
      join(inputs, `${name}.bhr`),
      "--output",
      `${output}/record-${name}`,
    ]);
  run([
    "bun",
    "tools/segmented-proof.ts",
    "--wasm",
    "apps/web/src/wasm/bunnyhop_core.wasm",
    "--website",
    join(inputs, "website"),
    "--commit",
    commit,
    "--maps",
    "maps",
    "--output",
    `${output}/segmented`,
    "--only",
    "bhop_eazy",
  ]);
} else throw new Error("Use --stage or --proof");
