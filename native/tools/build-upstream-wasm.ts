// Build the unpublished verifier from immutable, unpatched upstream Git objects.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import pin from "../upstream-wasm.json";
const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { upstream: { type: "string" } },
});
if (!values.upstream) throw new Error("--upstream /path/to/upstream-repo required");
const archive = Bun.spawnSync(
  ["git", "archive", pin.commit, "Cargo.toml", "Cargo.lock", "crates", "tools/scripts/build-wasm.sh"],
  { cwd: resolve(values.upstream) },
);
if (archive.exitCode) throw new Error(archive.stderr.toString());
await mkdir(join(root, "target"), { recursive: true });
const stage = await mkdtemp(join(root, "target/upstream-wasm-build-"));
try {
  const tar = Bun.spawn(["tar", "-x", "-C", stage], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  tar.stdin.write(archive.stdout);
  tar.stdin.end();
  if (await tar.exited) throw new Error("Archive extraction failed");
  await mkdir(join(root, "target/upstream-wasm-cargo"), { recursive: true });
  await symlink(join(root, "target/upstream-wasm-cargo"), join(stage, "target"), "dir");
  const originalLock = await readFile(join(stage, "Cargo.lock"));
  const build = Bun.spawn(["bash", "tools/scripts/build-wasm.sh"], {
    cwd: stage,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      RUSTUP_TOOLCHAIN: pin.toolchain,
      CARGO_TARGET_DIR: join(root, "target/upstream-wasm-cargo"),
      RUSTFLAGS: `--remap-path-prefix=${stage}=/bunnyhop-upstream`,
      CARGO_INCREMENTAL: "0",
    },
  });
  if (await build.exited)
    throw new Error("Upstream WASM build failed (install the pinned toolchain's wasm32-unknown-unknown target)");
  const resultingLock = await readFile(join(stage, "Cargo.lock"));
  if (!originalLock.equals(resultingLock)) {
    throw new Error("Upstream build changed its pinned Cargo.lock");
  }
  // Upstream's script assumes the default target directory for its final copy.
  const bytes = await readFile(join(root, "target/upstream-wasm-cargo/wasm32-unknown-unknown/wasm/bunnyhop_core.wasm"));
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (bytes.length !== pin.bytes || sha256 !== pin.sha256)
    throw new Error(
      `WASM pin differs: ${bytes.length} bytes, SHA-256 ${sha256}. Review and update upstream-wasm.json, then rerun parity.`,
    );
  await mkdir(join(root, "target/upstream-wasm"), { recursive: true });
  const path = join(root, `target/upstream-wasm/${sha256}.wasm`);
  await writeFile(path, bytes);
  console.log(`Verified unpublished upstream WASM: ${path}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
