// Signs native releases for the in-game updater. It runs where the release key lives (a server timer), never in CI.
//
// For each published GitHub release that has all three platform archives and their package reports, it checks every
// archive against its report, writes a signed update-manifest.json and attaches it to the release. It then points the
// update channel (update-manifest.json on the native-update-channel branch) at the newest signed release, and re-signs
// the channel before it expires. The client reads the channel through raw.githubusercontent.com.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifiedManifest, type ReleaseArtifact, type ReleaseManifest, type Trust } from "./update";

export const MANIFEST_ASSET = "update-manifest.json";
export const CHANNEL_BRANCH = "native-update-channel";
export const PLATFORMS = ["darwin/arm64", "linux/x64", "win32/x64"] as const;
/** The client accepts at most 31 days between createdAt and expiresAt. */
const VALID_DAYS = 30;
/** The timer re-signs the channel when fewer days than this remain. */
const CHANNEL_REFRESH_DAYS = 10;
const DAY_MS = 86_400_000;
const MAX_NOTES_BYTES = 8 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;

export interface PackageReport {
  schema: 1;
  version: string;
  platform: string;
  archive: string;
  bytes: number;
  sha256: string;
  build: string;
  wasm: string;
  canonicalWasmSha256: string;
  binarySha256: string;
  menuSha256: string;
  assetsSha256: string;
  releaseEligible: boolean;
}

export interface Envelope {
  keyId: string;
  payload: string;
  signature: string;
}

export interface ReleaseAsset {
  name: string;
  size: number;
}

export interface Release {
  tag: string;
  draft: boolean;
  body: string;
  assets: ReleaseAsset[];
}

/** What the signer needs from GitHub. `ghCli` implements it with the gh command; tests use a fake. */
export interface GitHub {
  repo: string;
  releaseTags(): string[];
  release(tag: string): Release;
  download(tag: string, asset: string, folder: string): string;
  upload(tag: string, file: string): void;
  channel(): { text: string; sha: string } | null;
  putChannel(text: string, sha: string | null, message: string): void;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** SemVer order: -1, 0 or 1. Prerelease identifiers sort before the release they lead to. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core, pre = ""] = version.split(/-(.*)/s);
    return { core: core.split(".").map(BigInt), pre: pre ? pre.split(".") : [] };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

export function versionOfTag(tag: string): string | null {
  const version = tag.replace(/^v/, "");
  return VERSION_PATTERN.test(version) ? version : null;
}

/** package.ts packageIdentity, recomputed from the report so a hand-edited build id is caught. */
export function reportBuild(report: PackageReport): string {
  const [os, arch] = report.platform.split("/");
  const parts = [os, arch, report.binarySha256, report.menuSha256, report.assetsSha256, report.canonicalWasmSha256];
  return `bunnyhop-native/${sha256(["package-v1", ...parts].join("\0")).slice(0, 24)}`;
}

export function checkReport(value: unknown, version: string): PackageReport {
  const report = value as PackageReport;
  const hash = /^[a-f0-9]{64}$/;
  if (!report || typeof report !== "object" || report.schema !== 1) throw new Error("Not a package report");
  if (report.version !== version) throw new Error(`Report ${report.archive} is for ${report.version}, not ${version}`);
  if (!report.releaseEligible) throw new Error(`${report.archive} isn't release-eligible`);
  if (!PLATFORMS.includes(report.platform as (typeof PLATFORMS)[number]))
    throw new Error(`Unknown platform ${report.platform}`);
  const extension = report.platform.startsWith("linux/") ? "tar.gz" : "zip";
  if (report.archive !== `bunnyhop-native-${version}-${report.platform.replace("/", "-")}.${extension}`)
    throw new Error(`Unexpected archive name ${report.archive}`);
  const hashes = [report.sha256, report.canonicalWasmSha256, report.binarySha256, report.menuSha256];
  if (!hashes.concat(report.assetsSha256).every((value) => hash.test(value)))
    throw new Error(`${report.archive}: malformed hashes`);
  if (!Number.isSafeInteger(report.bytes) || report.bytes <= 0) throw new Error(`${report.archive}: bad size`);
  if (report.wasm !== `bunnyhop-web/${report.canonicalWasmSha256.slice(0, 12)}`)
    throw new Error(`${report.archive}: verifier identity doesn't match its hash`);
  if (reportBuild(report) !== report.build) throw new Error(`${report.archive}: build identity doesn't add up`);
  return report;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function checkArchive(path: string, report: PackageReport): Promise<void> {
  if (statSync(path).size !== report.bytes) throw new Error(`${report.archive}: size differs from its report`);
  if ((await fileSha256(path)) !== report.sha256) throw new Error(`${report.archive}: SHA-256 differs from its report`);
}

export function artifactUrl(repo: string, tag: string, archive: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(archive)}`;
}

/** Release notes as the player reads them in Settings → Updates: plain text, bounded. */
export function releaseNotes(body: string): string {
  const text = body.replaceAll("\r\n", "\n").trim();
  if (Buffer.byteLength(text) <= MAX_NOTES_BYTES) return text;
  let cut = text.slice(0, MAX_NOTES_BYTES - 4);
  while (Buffer.byteLength(cut) > MAX_NOTES_BYTES - 4) cut = cut.slice(0, -1);
  return cut + "\n…";
}

export function buildManifest(
  version: string,
  notes: string,
  artifacts: ReleaseArtifact[],
  now = Date.now(),
): ReleaseManifest & { notes: string } {
  return {
    schema: 1,
    version,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VALID_DAYS * DAY_MS).toISOString(),
    notes: releaseNotes(notes),
    artifacts,
  };
}

export function signManifest(manifest: ReleaseManifest, key: KeyObject, keyId: string): Envelope {
  const payload = Buffer.from(JSON.stringify(manifest));
  return { keyId, payload: payload.toString("base64"), signature: sign(null, payload, key).toString("base64") };
}

/** Reads an envelope this key signed. Expiry is not checked: the channel re-signs old releases with fresh dates. */
export function openEnvelope(text: string, key: KeyObject, keyId: string): ReleaseManifest & { notes?: string } {
  const envelope = JSON.parse(text) as Envelope;
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  if (envelope.keyId !== keyId || !verify(null, payload, createPublicKey(key), signature))
    throw new Error("Manifest isn't signed by this key");
  return JSON.parse(payload.toString("utf8"));
}

export function refreshed<T extends ReleaseManifest>(manifest: T, now = Date.now()): T {
  return {
    ...manifest,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VALID_DAYS * DAY_MS).toISOString(),
  };
}

/** The private key, refused unless only its owner can read it and release-keys.json pins its public half. */
export function loadKey(path: string, keyId: string, trust: Trust): KeyObject {
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
    throw new Error(`${path} must be readable by its owner only (chmod 600)`);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The release key must be Ed25519");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const pinned = trust.keys.find((entry) => entry.id === keyId);
  if (!pinned) throw new Error(`Key id ${keyId} isn't pinned in release-keys.json`);
  if (pinned.publicKey.replace(/\s+/g, "") !== publicKey.replace(/\s+/g, ""))
    throw new Error(`The key doesn't match the public key pinned as ${keyId}`);
  return key;
}

/** Checks the signed envelope the way the client will, before anything is published. */
function checkLikeClient(envelope: Envelope, key: KeyObject, keyId: string, origins: string[], now = Date.now()): void {
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const trust: Trust = { schema: 1, keys: [{ id: keyId, publicKey }], downloadOrigins: origins };
  verifiedManifest(Buffer.from(JSON.stringify(envelope)), trust, now);
}

export interface SignerOptions {
  github: GitHub;
  key: KeyObject;
  keyId: string;
  origins: string[];
  upload: boolean;
  since: string;
  log: (line: string) => void;
  now?: number;
}

interface PendingRelease {
  tag: string;
  version: string;
  release: Release;
  reports: Map<string, PackageReport>;
}

function downloadJson(github: GitHub, tag: string, asset: ReleaseAsset, folder: string): unknown {
  if (asset.size > MAX_REPORT_BYTES) return null;
  try {
    return JSON.parse(readFileSync(github.download(tag, asset.name, folder), "utf8"));
  } catch {
    return null;
  }
}

/** All three platforms present with matching reports, or null while the release is still being assembled. */
function completeRelease(github: GitHub, tag: string, version: string, folder: string): PendingRelease | null {
  const release = github.release(tag);
  if (release.draft || release.assets.some((asset) => asset.name === MANIFEST_ASSET)) return null;
  const reports = new Map<string, PackageReport>();
  for (const asset of release.assets.filter((entry) => entry.name.endsWith(".json"))) {
    const report = downloadJson(github, tag, asset, folder) as PackageReport | null;
    if (report?.schema === 1 && typeof report.platform === "string") reports.set(report.platform, report);
  }
  for (const platform of PLATFORMS) {
    const report = reports.get(platform);
    if (!report || !release.assets.some((asset) => asset.name === report.archive)) return null;
  }
  return { tag, version, release, reports };
}

async function signRelease(options: SignerOptions, pending: PendingRelease, folder: string): Promise<string> {
  const { github, key, keyId } = options;
  const artifacts: ReleaseArtifact[] = [];
  for (const platform of PLATFORMS) {
    const report = checkReport(pending.reports.get(platform), pending.version);
    const asset = pending.release.assets.find((entry) => entry.name === report.archive)!;
    if (asset.size !== report.bytes) throw new Error(`${report.archive}: uploaded size differs from its report`);
    await checkArchive(github.download(pending.tag, report.archive, folder), report);
    artifacts.push({
      platform,
      filename: report.archive,
      url: artifactUrl(github.repo, pending.tag, report.archive),
      bytes: report.bytes,
      sha256: report.sha256,
      build: report.build,
      wasm: report.wasm,
    });
  }
  const manifest = buildManifest(pending.version, pending.release.body, artifacts, options.now);
  const envelope = signManifest(manifest, key, keyId);
  checkLikeClient(envelope, key, keyId, options.origins, options.now);
  return JSON.stringify(envelope, null, 2) + "\n";
}

function newestFirst(tags: string[], since: string): { tag: string; version: string }[] {
  return tags
    .map((tag) => ({ tag, version: versionOfTag(tag) }))
    .filter((entry): entry is { tag: string; version: string } => entry.version !== null)
    .filter((entry) => compareVersions(entry.version, since) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Signs what is ready and refreshes the channel. Returns the number of changes made (or planned, without upload). */
export async function signPending(options: SignerOptions): Promise<number> {
  const { github, upload, log } = options;
  const folder = mkdtempSync(join(tmpdir(), "bunnyhop-sign-"));
  let changes = 0;
  try {
    let newest: { tag: string; text: string } | null = null;
    for (const { tag, version } of newestFirst(github.releaseTags(), options.since)) {
      const release = completeRelease(github, tag, version, folder);
      if (release) {
        const text = await signRelease(options, release, folder);
        const file = join(folder, `${version}-${MANIFEST_ASSET}`);
        writeFileSync(file, text);
        changes++;
        if (upload) uploadAs(github, tag, text, folder);
        log(upload ? `signed ${tag}: attached ${MANIFEST_ASSET}` : `would sign ${tag} and attach ${MANIFEST_ASSET}`);
        newest ??= { tag, text };
      }
      newest ??= signedManifest(github, tag, folder);
    }
    if (newest && updateChannel(options, newest)) changes++;
    return changes;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function uploadAs(github: GitHub, tag: string, text: string, folder: string): void {
  const exact = join(mkdtempSync(join(folder, "upload-")), MANIFEST_ASSET);
  writeFileSync(exact, text);
  github.upload(tag, exact);
}

function signedManifest(github: GitHub, tag: string, folder: string): { tag: string; text: string } | null {
  const release = github.release(tag);
  if (release.draft || !release.assets.some((asset) => asset.name === MANIFEST_ASSET)) return null;
  const file = github.download(tag, MANIFEST_ASSET, mkdtempSync(join(folder, "signed-")));
  return { tag, text: readFileSync(file, "utf8") };
}

function updateChannel(options: SignerOptions, newest: { tag: string; text: string }): boolean {
  const { github, key, keyId, log, upload } = options;
  const now = options.now ?? Date.now();
  const target = openEnvelope(newest.text, key, keyId);
  const current = github.channel();
  let reason = "";
  try {
    const live = current ? openEnvelope(current.text, key, keyId) : null;
    if (!live) reason = "no channel yet";
    else if (live.version !== target.version) reason = `was ${live.version}`;
    else if (Date.parse(live.expiresAt) - now < CHANNEL_REFRESH_DAYS * DAY_MS) reason = "expiring soon";
  } catch {
    reason = "channel file unreadable";
  }
  if (!reason) return false;
  const envelope = signManifest(refreshed(target, now), key, keyId);
  checkLikeClient(envelope, key, keyId, options.origins, now);
  const expires = refreshed(target, now).expiresAt.slice(0, 10);
  if (!upload) {
    log(`would point the channel at ${newest.tag} (${reason})`);
    return true;
  }
  github.putChannel(JSON.stringify(envelope, null, 2) + "\n", current?.sha ?? null, `Channel: ${newest.tag}`);
  log(`channel now ${newest.tag}, expires ${expires} (${reason})`);
  return true;
}

/** Signs reports and archives already on disk (`--local`), for a release made by hand. Never uploads. */
export async function signLocal(
  folder: string,
  repo: string,
  tag: string,
  notes: string,
  key: KeyObject,
  keyId: string,
  origins: string[],
): Promise<string> {
  const version = versionOfTag(tag);
  if (!version) throw new Error(`${tag} isn't a version tag`);
  const artifacts: ReleaseArtifact[] = [];
  const reports = new Map<string, PackageReport>();
  for (const name of new Bun.Glob("*.json").scanSync(folder)) {
    const report = JSON.parse(readFileSync(join(folder, name), "utf8"));
    if (report?.schema === 1 && report.platform && report.archive) reports.set(report.platform, report);
  }
  for (const platform of PLATFORMS) {
    const report = checkReport(reports.get(platform), version);
    await checkArchive(join(folder, report.archive), report);
    artifacts.push({
      platform,
      filename: report.archive,
      url: artifactUrl(repo, tag, report.archive),
      bytes: report.bytes,
      sha256: report.sha256,
      build: report.build,
      wasm: report.wasm,
    });
  }
  const envelope = signManifest(buildManifest(version, notes, artifacts), key, keyId);
  checkLikeClient(envelope, key, keyId, origins);
  return JSON.stringify(envelope, null, 2) + "\n";
}

// --- gh ---------------------------------------------------------------------------------------------------------

function gh(args: string[], input?: string): string {
  const result = Bun.spawnSync(["gh", ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  });
  if (result.exitCode !== 0) {
    const message = Buffer.from(result.stderr).toString().trim().split("\n")[0];
    throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${message}`);
  }
  return Buffer.from(result.stdout).toString();
}

function ghMissing(error: unknown): boolean {
  return error instanceof Error && /HTTP 404|Not Found/i.test(error.message);
}

export function ghCli(repo: string): GitHub {
  const contents = `repos/${repo}/contents/${MANIFEST_ASSET}`;
  return {
    repo,
    releaseTags: () => {
      const list = JSON.parse(gh(["release", "list", "-R", repo, "--limit", "40", "--json", "tagName,isDraft"]));
      return list
        .filter((entry: { isDraft: boolean }) => !entry.isDraft)
        .map((entry: { tagName: string }) => entry.tagName);
    },
    release: (tag) => {
      const view = JSON.parse(gh(["release", "view", tag, "-R", repo, "--json", "tagName,isDraft,body,assets"]));
      const assets = view.assets.map((asset: ReleaseAsset) => ({ name: asset.name, size: asset.size }));
      return { tag: view.tagName, draft: view.isDraft, body: view.body ?? "", assets };
    },
    download: (tag, asset, folder) => {
      gh(["release", "download", tag, "-R", repo, "--pattern", asset, "--dir", folder, "--clobber"]);
      return join(folder, asset);
    },
    upload: (tag, file) => void gh(["release", "upload", tag, file, "-R", repo]),
    channel: () => {
      try {
        const file = JSON.parse(gh(["api", `${contents}?ref=${CHANNEL_BRANCH}`]));
        return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
      } catch (error) {
        if (ghMissing(error)) return null;
        throw error;
      }
    },
    putChannel: (text, sha, message) => {
      if (!sha) ensureChannelBranch(repo);
      const body = {
        message,
        branch: CHANNEL_BRANCH,
        content: Buffer.from(text).toString("base64"),
        sha: sha ?? undefined,
      };
      gh(["api", "-X", "PUT", contents, "--input", "-"], JSON.stringify(body));
    },
  };
}

/** The channel branch holds only the manifest and a README, with no history shared with the code. */
function ensureChannelBranch(repo: string): void {
  try {
    gh(["api", `repos/${repo}/git/ref/heads/${CHANNEL_BRANCH}`]);
    return;
  } catch (error) {
    if (!ghMissing(error)) throw error;
  }
  const readme =
    "Signed update manifest for the native client. Written by apps/native/packaging/sign-release.ts; don't edit.\n";
  const tree = JSON.parse(
    gh(
      ["api", "-X", "POST", `repos/${repo}/git/trees`, "--input", "-"],
      JSON.stringify({ tree: [{ path: "README.md", mode: "100644", type: "blob", content: readme }] }),
    ),
  );
  const commit = JSON.parse(
    gh(
      ["api", "-X", "POST", `repos/${repo}/git/commits`, "--input", "-"],
      JSON.stringify({ message: "Start the native update channel", tree: tree.sha, parents: [] }),
    ),
  );
  gh(
    ["api", "-X", "POST", `repos/${repo}/git/refs`, "--input", "-"],
    JSON.stringify({ ref: `refs/heads/${CHANNEL_BRANCH}`, sha: commit.sha }),
  );
}

// --- Command line -------------------------------------------------------------------------------------------------

/** One run at a time. A lock left by a run that died is taken over. */
export function acquireLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const usage = `Usage:
  bun sign-release.ts --pending [--upload] --repo OWNER/REPO --key PEM --key-id ID [--since 0.6.2]
  bun sign-release.ts --local FOLDER --tag vX.Y.Z --repo OWNER/REPO --key PEM --key-id ID [--out FILE]
The key may also come from BH_NATIVE_RELEASE_KEY (a file path).`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pending: { type: "boolean" },
      upload: { type: "boolean" },
      local: { type: "string" },
      tag: { type: "string" },
      notes: { type: "string" },
      out: { type: "string", default: MANIFEST_ASSET },
      repo: { type: "string" },
      key: { type: "string", default: process.env.BH_NATIVE_RELEASE_KEY },
      "key-id": { type: "string" },
      keys: { type: "string", default: resolve(import.meta.dir, "release-keys.json") },
      since: { type: "string", default: "0.6.2" },
      lock: { type: "string", default: join(tmpdir(), "bunnyhop-native-sign-release.lock") },
    },
  });
  if (!values.repo || !values.key || !values["key-id"] || (!values.pending && !values.local)) throw new Error(usage);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)) throw new Error("--repo must be OWNER/REPO");
  const trust = JSON.parse(readFileSync(values.keys!, "utf8")) as Trust;
  const key = loadKey(values.key, values["key-id"], trust);
  if (values.local) {
    if (!values.tag) throw new Error("--local needs --tag");
    const notes = values.notes ? readFileSync(values.notes, "utf8") : "";
    const text = await signLocal(
      values.local,
      values.repo,
      values.tag,
      notes,
      key,
      values["key-id"],
      trust.downloadOrigins,
    );
    writeFileSync(values.out!, text, { flag: "wx" });
    console.log(`wrote ${values.out}`);
    console.log(`attach it with: gh release upload ${values.tag} ${values.out} -R ${values.repo}`);
    return;
  }
  const release = acquireLock(values.lock!);
  if (!release) return console.log("another signing run is active");
  try {
    await signPending({
      github: ghCli(values.repo),
      key,
      keyId: values["key-id"],
      origins: trust.downloadOrigins,
      upload: Boolean(values.upload),
      since: values.since!,
      log: (line) => console.log(line),
    });
  } finally {
    release();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("Usage:") ? message : message.split("\n")[0]);
    process.exit(1);
  }
}
