// Run the website's Segmented tests (apps/web/test/segmented.test.ts at --commit, default the v0.0.30 release)
// against this checkout's vendored shared code and the given verifier WASM.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    website: { type: "string" },
    maps: { type: "string" },
    wasm: { type: "string" },
    commit: { type: "string", default: "56bc58e0ee77da327961253835fbaf864cf95e49" },
  },
});
if (!values.website || !values.maps || !values.wasm) {
  throw new Error("--website WEBSITE_REPO [--commit SHA] --maps DIR --wasm VERIFIER.wasm");
}
const root = resolve(import.meta.dir, "..");
const target = join(root, "target");
mkdirSync(target, { recursive: true });
const source = (path: string) => {
  const result = Bun.spawnSync(["git", "-C", resolve(values.website!), "show", `${values.commit}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
const replacements = (text: string) =>
  text
    .replaceAll("../../apps/web/src/", "../apps/web/src/")
    .replaceAll('from "../src/', 'from "../apps/web/src/')
    .replaceAll('from "../../../tools/verify/bot"', 'from "./segmented-web-bot"')
    .replaceAll('from "../../../tools/verify/record"', 'from "./segmented-web-record"')
    .replaceAll('from "../../../tools/content/physics-cache"', 'from "./segmented-web-physics"')
    .replaceAll('from "./bot"', 'from "./segmented-web-bot"')
    .replaceAll('from "../content/physics-cache"', 'from "./segmented-web-physics"');
for (const [path, name] of [
  ["tools/verify/bot.ts", "segmented-web-bot.ts"],
  ["tools/verify/record.ts", "segmented-web-record.ts"],
  ["tools/content/physics-cache.ts", "segmented-web-physics.ts"],
])
  writeFileSync(join(target, name), replacements(source(path)));
let test = replacements(source("apps/web/test/segmented.test.ts"));
test = test
  .replace(
    'new URL("../src/wasm/bunnyhop_core.wasm", import.meta.url)',
    `new URL(${JSON.stringify("file://" + resolve(values.wasm))})`,
  )
  .replace(
    'new URL("../../../maps/bhop_eazy.bsp", import.meta.url)',
    `new URL(${JSON.stringify("file://" + join(resolve(values.maps), "bhop_eazy.bsp"))})`,
  );
writeFileSync(join(target, "segmented-web.test.ts"), test);
const wasmSha = new Bun.CryptoHasher("sha256").update(readFileSync(values.wasm)).digest("hex");
console.log(JSON.stringify({ wasm: resolve(values.wasm), wasmSha, websiteCommit: values.commit }));
const child = Bun.spawn([process.execPath, "test", "./target/segmented-web.test.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
