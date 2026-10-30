import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  artifactUrl,
  buildManifest,
  CHANNEL_BRANCH,
  compareVersions,
  loadKey,
  MANIFEST_ASSET,
  PLATFORMS,
  reportBuild,
  signManifest,
  signPending,
  type GitHub,
  type PackageReport,
  type Release,
} from "./sign-release";
import { verifiedManifest, type Trust } from "./update";
import { packageIdentity } from "../package";
import { CANONICAL_WASM_SHA256 } from "../ensure-wasm";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = "test-only";
const repo = "2x74/bunnyhop-client";
const origins = [
  "https://raw.githubusercontent.com",
  "https://github.com",
  "https://release-assets.githubusercontent.com",
];
const trust: Trust = {
  schema: 1,
  keys: [{ id: keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  downloadOrigins: origins,
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function report(version: string, platform: string, archiveBytes: string): PackageReport {
  const extension = platform.startsWith("linux/") ? "tar.gz" : "zip";
  const wasm = "3".repeat(64);
  const partial = {
    schema: 1 as const,
    version,
    platform,
    archive: `bunnyhop-native-${version}-${platform.replace("/", "-")}.${extension}`,
    bytes: archiveBytes.length,
    sha256: sha256(archiveBytes),
    build: "",
    wasm: `bunnyhop-web/${wasm.slice(0, 12)}`,
    canonicalWasmSha256: wasm,
    binarySha256: sha256(`binary ${version} ${platform}`),
    menuSha256: sha256(`menu ${version}`),
    assetsSha256: sha256(`assets ${version}`),
    releaseEligible: true,
  };
  return { ...partial, build: reportBuild(partial) };
}

/** An in-memory GitHub with releases, their assets and the channel branch. */
class FakeGitHub implements GitHub {
  repo = repo;
  releases = new Map<string, { draft: boolean; body: string; assets: Map<string, string> }>();
  channelFile: { text: string; sha: string } | null = null;
  uploads: string[] = [];

  add(version: string, platforms: readonly string[], options: { draft?: boolean; tamper?: boolean } = {}): void {
    const assets = new Map<string, string>();
    for (const platform of platforms) {
      const bytes = `archive ${version} ${platform}`;
      const entry = report(version, platform, bytes);
      assets.set(entry.archive, options.tamper ? bytes.toUpperCase() : bytes);
      assets.set(`package-report-${platform.split("/")[0]}.json`, JSON.stringify(entry));
    }
    assets.set("SHA256SUMS", "sums");
    this.releases.set(`v${version}`, { draft: options.draft ?? false, body: `Notes for ${version}`, assets });
  }
  releaseTags(): string[] {
    return [...this.releases.keys()];
  }
  release(tag: string): Release {
    const release = this.releases.get(tag)!;
    const assets = [...release.assets].map(([name, bytes]) => ({ name, size: Buffer.byteLength(bytes) }));
    return { tag, draft: release.draft, body: release.body, assets };
  }
  download(tag: string, asset: string, folder: string): string {
    writeFileSync(join(folder, asset), this.releases.get(tag)!.assets.get(asset)!);
    return join(folder, asset);
  }
  upload(tag: string, file: string): void {
    const assets = this.releases.get(tag)!.assets;
    const name = file.split(/[\\/]/).pop()!;
    if (assets.has(name)) throw new Error("asset exists");
    assets.set(name, readFileSync(file, "utf8"));
    this.uploads.push(`${tag}/${name}`);
  }
  channel(): { text: string; sha: string } | null {
    return this.channelFile;
  }
  putChannel(text: string, sha: string | null): void {
    expect(sha).toBe(this.channelFile?.sha ?? null);
    this.channelFile = { text, sha: sha256(text) };
  }
}

const options = (github: GitHub, upload = true, now = Date.now()) => ({
  github,
  key: privateKey,
  keyId,
  origins,
  upload,
  since: "0.6.2",
  log: () => {},
  now,
});

const channelManifest = (github: FakeGitHub, now = Date.now()) =>
  verifiedManifest(Buffer.from(github.channelFile!.text), trust, now);

test("report build ids match package.ts", () => {
  const hashes = ["a", "b", "c"].map((c) => c.repeat(64));
  const identity = packageIdentity("win32", "x64", hashes[0], hashes[1], hashes[2]);
  const entry = { ...report("0.6.2", "win32/x64", "x"), binarySha256: hashes[0], menuSha256: hashes[1] };
  Object.assign(entry, { assetsSha256: hashes[2], canonicalWasmSha256: CANONICAL_WASM_SHA256 });
  expect(reportBuild(entry)).toBe(identity.build);
});

test("versions order like the client's", () => {
  expect(compareVersions("0.6.10", "0.6.9")).toBe(1);
  expect(compareVersions("0.6.2", "0.6.2-rc.1")).toBe(1);
  expect(compareVersions("0.6.2-rc.10", "0.6.2-rc.2")).toBe(1);
  expect(compareVersions("0.6.2", "0.6.2")).toBe(0);
});

test("a signed manifest verifies like the client; tampering and foreign hosts don't", () => {
  const artifacts = PLATFORMS.map((platform) => {
    const entry = report("0.6.2", platform, "bytes");
    const url = artifactUrl(repo, "v0.6.2", entry.archive);
    return { platform, filename: entry.archive, url, bytes: 5, sha256: entry.sha256, build: entry.build };
  });
  const manifest = buildManifest("0.6.2", "x".repeat(20_000), artifacts);
  expect(Buffer.byteLength(manifest.notes)).toBeLessThanOrEqual(8 * 1024);
  const envelope = signManifest(manifest, privateKey, keyId);
  expect(verifiedManifest(Buffer.from(JSON.stringify(envelope)), trust).version).toBe("0.6.2");
  const tampered = {
    ...envelope,
    payload: Buffer.from(JSON.stringify({ ...manifest, version: "9.9.9" })).toString("base64"),
  };
  expect(() => verifiedManifest(Buffer.from(JSON.stringify(tampered)), trust)).toThrow("signature");
  const elsewhere = structuredClone(manifest);
  elsewhere.artifacts[0].url = "https://objects.example.com/a.zip";
  const foreign = signManifest(elsewhere, privateKey, keyId);
  expect(() => verifiedManifest(Buffer.from(JSON.stringify(foreign)), trust)).toThrow("pinned");
});

test("signs complete releases once, skips ones still uploading, and points the channel at the newest", async () => {
  const github = new FakeGitHub();
  github.add("0.6.1", PLATFORMS);
  github.add("0.6.2", PLATFORMS);
  github.add("0.6.3", ["darwin/arm64", "linux/x64"]);
  github.add("0.6.4", PLATFORMS, { draft: true });
  expect(await signPending(options(github))).toBe(2);
  expect(github.uploads).toEqual([`v0.6.2/${MANIFEST_ASSET}`]);
  const live = channelManifest(github);
  expect(live.version).toBe("0.6.2");
  expect(live.notes).toBe("Notes for 0.6.2");
  const mac = live.artifacts.find((artifact) => artifact.platform === "darwin/arm64")!;
  expect(mac.url).toBe(`https://github.com/${repo}/releases/download/v0.6.2/bunnyhop-native-0.6.2-darwin-arm64.zip`);
  expect(mac.wasm).toBe("bunnyhop-web/333333333333");

  const sha = github.channelFile!.sha;
  expect(await signPending(options(github))).toBe(0);
  expect(github.channelFile!.sha).toBe(sha);

  github.add("0.6.3", PLATFORMS);
  expect(await signPending(options(github))).toBe(2);
  expect(channelManifest(github).version).toBe("0.6.3");
});

test("the channel is re-signed before it expires", async () => {
  const github = new FakeGitHub();
  github.add("0.6.2", PLATFORMS);
  const start = Date.now();
  await signPending(options(github, true, start));
  const later = start + 25 * 86_400_000;
  expect(await signPending(options(github, true, later))).toBe(1);
  expect(Date.parse(channelManifest(github, later).expiresAt)).toBeGreaterThan(later + 29 * 86_400_000);
});

test("a dry run changes nothing; a tampered archive fails the run", async () => {
  const github = new FakeGitHub();
  github.add("0.6.2", PLATFORMS);
  const lines: string[] = [];
  expect(await signPending({ ...options(github, false), log: (line) => lines.push(line) })).toBe(2);
  expect(github.uploads).toEqual([]);
  expect(github.channelFile).toBeNull();
  expect(lines).toEqual([
    `would sign v0.6.2 and attach ${MANIFEST_ASSET}`,
    "would point the channel at v0.6.2 (no channel yet)",
  ]);
  const tampered = new FakeGitHub();
  tampered.add("0.6.2", PLATFORMS, { tamper: true });
  await expect(signPending(options(tampered))).rejects.toThrow("SHA-256 differs");
  expect(tampered.uploads).toEqual([]);
});

test("one run at a time; a dead run's lock is taken over", () => {
  const folder = mkdtempSync(join(tmpdir(), "bunnyhop-lock-"));
  try {
    const lock = join(folder, "sign.lock");
    const release = acquireLock(lock)!;
    expect(release).toBeFunction();
    expect(acquireLock(lock)).toBeNull();
    release();
    writeFileSync(lock, "999999999");
    expect(acquireLock(lock)).toBeFunction();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the key must be private to its owner and pinned under its id", () => {
  const folder = mkdtempSync(join(tmpdir(), "bunnyhop-key-"));
  try {
    const file = join(folder, "release.pem");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
    chmodSync(file, 0o600);
    expect(loadKey(file, keyId, trust).asymmetricKeyType).toBe("ed25519");
    expect(() => loadKey(file, "other", trust)).toThrow("isn't pinned");
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => loadKey(file, keyId, { ...trust, keys: [{ id: keyId, publicKey: other }] })).toThrow("doesn't match");
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => loadKey(file, keyId, trust)).toThrow("chmod 600");
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the shipped trust pins the k8plus key, the channel and GitHub's download hosts", async () => {
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, "release-keys.json"), "utf8")) as Trust;
  expect(shipped.keys.map((key) => key.id)).toEqual(["native-k8plus-2026-10"]);
  expect(shipped.manifestUrl).toBe(`https://raw.githubusercontent.com/${repo}/${CHANNEL_BRANCH}/${MANIFEST_ASSET}`);
  expect(shipped.downloadOrigins).toEqual(origins);
});
