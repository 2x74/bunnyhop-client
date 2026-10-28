// Pinned, offline vendor sync. Reads Git objects, never the upstream working tree.
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

interface SyncManifest {
  schema: number;
  commit: string;
  output: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const manifestPath = join(root, "upstream-manifest.json");
const areas = ["crates/core", "crates/vendor", "apps/web/src"];
const hash = (b: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(b).digest("hex");
function run(args: string[], cwd: string): Uint8Array {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout;
}
async function files(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(prefix, e.name);
    if (e.isDirectory()) result.push(...(await files(join(dir, e.name), p)));
    else if (e.isFile()) result.push(p);
    else throw new Error(`Unexpected vendor symlink: ${p}`);
  }
  return result.sort();
}
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    upstream: { type: "string" },
    commit: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
if (!values.upstream || !values.commit)
  throw new Error("--upstream /repo --commit <full SHA> [--dry-run]");
if (!/^[0-9a-f]{40}$/.test(values.commit))
  throw new Error("Use an immutable full 40-character commit SHA");
const upstream = resolve(values.upstream);
const commit = new TextDecoder()
  .decode(run(["git", "rev-parse", `${values.commit}^{commit}`], upstream))
  .trim();
if (commit !== values.commit) throw new Error("Commit resolution mismatch");
const stage = await mkdtemp(join(tmpdir(), "bunnyhop-vendor-"));
try {
  const archive = run(["git", "archive", commit, ...areas], upstream);
  const tar = Bun.spawn(["tar", "-x", "-C", stage], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  tar.stdin.write(archive);
  tar.stdin.end();
  if (await tar.exited) throw new Error("Archive extraction failed");
  const sources: Record<string, string> = {};
  for (const file of await files(stage))
    sources[file] = hash(await readFile(join(stage, file)));
  // Preserve the existing native distribution's omission of optional samples.
  const excluded = Object.keys(sources).filter((p) =>
    /\/assets\/audio\/sfx\/announcer_(godlike|holyshit|perfect)-/.test(p),
  );
  for (const file of excluded) await rm(join(stage, file));
  const patches: Record<string, string> = {};
  for (const name of (await readdir(join(import.meta.dir, "upstream-patches")))
    .filter((n) => n.endsWith(".patch"))
    .sort()) {
    const path = join(import.meta.dir, "upstream-patches", name);
    patches[name] = hash(await readFile(path));
    run(["git", "apply", "--check", path], stage);
    run(["git", "apply", path], stage);
  }
  const output: Record<string, string> = {};
  for (const file of await files(stage))
    output[file] = hash(await readFile(join(stage, file)));
  const manifest = {
    schema: 1,
    repository: "https://github.com/2x74/bunnyhop",
    commit,
    areas,
    excluded,
    patches,
    sourceTreeSha256: hash(JSON.stringify(sources)),
    sources,
    output,
  };
  // Refuse to erase local tracked or untracked work. Record native edits as a patch first.
  const previous = await readFile(manifestPath, "utf8")
    .then((source) => JSON.parse(source) as SyncManifest)
    .catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
  if (previous)
    for (const [file, expected] of Object.entries(previous.output)) {
      const bytes = await readFile(join(root, file)).catch(() => null);
      if (!bytes || hash(bytes) !== expected)
        throw new Error(
          `Local vendor edit: ${file}; move it into upstream-patches first`,
        );
    }
  const old = previous
    ? Object.keys(previous.output)
    : new TextDecoder()
        .decode(run(["git", "ls-files", "-z", ...areas], root))
        .split("\0")
        .filter(Boolean)
        .map((p) => (p.startsWith("native/") ? p.slice(7) : p));
  if (previous)
    for (const file of Object.keys(output)) {
      if (
        !(file in previous.output) &&
        (await readFile(join(root, file)).catch(() => null))
      )
        throw new Error(`Unmanaged vendor collision: ${file}`);
    }
  if (!values["dry-run"]) {
    for (const file of old)
      if (!(file in output)) await rm(join(root, file), { force: true });
    for (const file of Object.keys(output)) {
      const target = join(root, file);
      const existing = await readFile(target).catch(() => null);
      if (existing && hash(existing) === output[file]) continue;
      if (previous && !(file in previous.output) && existing)
        throw new Error(`Unmanaged vendor collision: ${file}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(stage, file)));
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(
    `${values["dry-run"] ? "Dry run" : "Synced"} ${commit}: ${Object.keys(sources).length} source files, ${Object.keys(patches).length} patches, tree ${manifest.sourceTreeSha256}`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
