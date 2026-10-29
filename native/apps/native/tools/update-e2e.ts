// End-to-end update on macOS, headless. Installs an old package built with BUNNYHOP_UPDATE_TEST_HOOKS into a temporary
// folder, serves a newer package and a manifest signed with a throwaway key from a loopback server, and runs the old
// game's `--update-smoke`: check, download, unpack, verify, swap, relaunch. The relaunched new version runs the home
// menu smoke with `--hidden` and a private data folder. Nothing touches the real data folder or release key.
//
//   bun apps/native/tools/update-e2e.ts --old OLD.zip --new NEW.zip --new-report NEW.json
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { buildManifest, signManifest, type PackageReport } from "../packaging/sign-release";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    old: { type: "string" },
    new: { type: "string" },
    "new-report": { type: "string" },
    keep: { type: "boolean" },
  },
});
if (!values.old || !values.new || !values["new-report"])
  throw new Error("Usage: bun update-e2e.ts --old OLD.zip --new NEW.zip --new-report NEW.json [--keep]");
if (process.platform !== "darwin") throw new Error("This end-to-end test drives a macOS package");

const report = JSON.parse(readFileSync(values["new-report"], "utf8")) as PackageReport;
const archive = readFileSync(values.new);
const work = mkdtempSync(join(tmpdir(), "bunnyhop-update-e2e-"));
const applications = join(work, "Applications");
const data = join(work, "data");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function run(command: string[], env: Record<string, string> = {}): { code: number; output: string } {
  const result = Bun.spawnSync(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const output = Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString();
  return { code: result.exitCode ?? 1, output };
}

// The loopback server runs on this process's event loop, so the game must be started without blocking it.
async function runAsync(command: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

async function waitFor(condition: () => boolean, seconds: number): Promise<boolean> {
  for (let elapsed = 0; elapsed < seconds * 10; elapsed++) {
    if (condition()) return true;
    await Bun.sleep(100);
  }
  return condition();
}

const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/manifest") return new Response(manifestText);
    if (path === `/download/${basename(values.new!)}`)
      return new Response(null, { status: 302, headers: { location: `/files/${basename(values.new!)}` } });
    if (path === `/files/${basename(values.new!)}`) return new Response(archive);
    return new Response("not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const manifest = buildManifest(report.version, "**Fixes**\n- End-to-end update test.", [
  {
    platform: report.platform,
    filename: basename(values.new),
    url: `${origin}/download/${basename(values.new)}`,
    bytes: archive.length,
    sha256: report.sha256,
    build: report.build,
    wasm: report.wasm,
  },
]);
const manifestText = JSON.stringify(signManifest(manifest, privateKey, "e2e-test-only"));
const trustFile = join(work, "trust.json");
writeFileSync(
  trustFile,
  JSON.stringify({
    schema: 1,
    keys: [{ id: "e2e-test-only", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
    downloadOrigins: [origin],
    manifestUrl: `${origin}/manifest`,
  }),
);

try {
  mkdirSync(applications, { recursive: true });
  check(run(["ditto", "-x", "-k", values.old, applications]).code === 0, "old package unpacked into Applications");
  const app = join(
    applications,
    readdirSync(applications).find((name) => name.endsWith(".app"))!,
  );
  const manifestPath = join(app, "Contents", "Resources", "native-manifest.json");
  const installed = () => JSON.parse(readFileSync(manifestPath, "utf8"));
  const oldVersion = installed().version;
  check(oldVersion !== report.version, `old install is ${oldVersion}, update is ${report.version}`);

  const settings = join(data, "settings.json");
  const replay = join(data, "replays", "run.bhr");
  mkdirSync(join(data, "replays"), { recursive: true });
  writeFileSync(settings, '{"sensitivity":2}');
  writeFileSync(replay, "replay bytes");

  const smoke = await runAsync([join(app, "Contents", "MacOS", "bunnyhop-native"), "--update-smoke", data], {
    BUNNYHOP_UPDATE_TEST_TRUST: trustFile,
  });
  console.log(smoke.output.trim());
  check(smoke.code === 0, "old version checked, downloaded, staged and started the update helper");

  const result = join(data, "updates", "last-update.json");
  const staging = join(applications, ".bunnyhop-update");
  const finished = () => existsSync(result) && !existsSync(`${app}.update-old`) && !existsSync(staging);
  check(await waitFor(finished, 90), "helper swapped the app and cleaned up its backup and staging folder");
  const outcome = JSON.parse(readFileSync(result, "utf8"));
  check(outcome.status === "installed", `helper reported ${outcome.status} ${outcome.message ?? ""}`);
  check(installed().version === report.version && installed().build === report.build, "new build is installed");
  check(run(["codesign", "--verify", "--deep", "--strict", app]).code === 0, "installed app's signature is valid");
  check(run(["xattr", "-p", "com.apple.quarantine", app]).code !== 0, "installed app carries no quarantine flag");
  const relaunched = join(data, "relaunched");
  check(await waitFor(() => existsSync(join(relaunched, "data")), 60), "new version started with --hidden");
  check(readFileSync(settings, "utf8") === '{"sensitivity":2}', "settings untouched");
  check(readFileSync(replay, "utf8") === "replay bytes", "replays untouched");
  check(requests.includes(`/download/${basename(values.new)}`), "download followed a redirect on the pinned origin");
  console.log("update end-to-end passed");
} finally {
  server.stop(true);
  if (!values.keep) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
