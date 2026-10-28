// Signed-download preparation only. Never extracts, executes or silently replaces an installed client.
import { createPublicKey, createHash, verify } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  linkSync,
  fsyncSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
export interface ReleaseArtifact {
  platform: string;
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  build: string;
}
export interface ReleaseManifest {
  schema: 1;
  version: string;
  createdAt: string;
  expiresAt: string;
  artifacts: ReleaseArtifact[];
}
export interface Trust {
  schema: 1;
  keys: { id: string; publicKey: string }[];
  downloadOrigins: string[];
}
export function verifiedManifest(envelope: Uint8Array, trust: Trust, now = Date.now()): ReleaseManifest {
  if (envelope.length > 128 * 1024) throw new Error("Release envelope exceeds128KiB");
  const e = JSON.parse(Buffer.from(envelope).toString("utf8"));
  if (!e || typeof e.keyId !== "string" || typeof e.payload !== "string" || typeof e.signature !== "string")
    throw new Error("Invalid release envelope");
  if (trust.schema !== 1 || !Array.isArray(trust.keys) || !Array.isArray(trust.downloadOrigins))
    throw new Error("Invalid trusted release configuration");
  const key = trust.keys.find((k) => k.id === e.keyId);
  if (!key) throw new Error("Release key is not pinned; update disabled");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(e.payload) || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.signature))
    throw new Error("Invalid release signature encoding");
  const bytes = Buffer.from(e.payload, "base64"),
    signature = Buffer.from(e.signature, "base64"),
    publicKey = createPublicKey(key.publicKey);
  if (
    bytes.length > 64 * 1024 ||
    signature.length !== 64 ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, publicKey, signature)
  )
    throw new Error("Release signature is invalid");
  const m = JSON.parse(bytes.toString("utf8"));
  const created = Date.parse(m.createdAt),
    expires = Date.parse(m.expiresAt);
  if (
    m.schema !== 1 ||
    typeof m.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(m.version) ||
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    created > now + 300000 ||
    expires <= now ||
    expires <= created ||
    expires - created > 31 * 86400000
  )
    throw new Error("Release manifest invalid or expired");
  if (!Array.isArray(m.artifacts) || !m.artifacts.length || m.artifacts.length > 12)
    throw new Error("Invalid release artifact count");
  const platforms = new Set<string>();
  for (const a of m.artifacts) {
    if (!a || !/^(darwin|win32|linux)\/(x64|arm64)$/.test(a.platform) || platforms.has(a.platform))
      throw new Error("Invalid/duplicate artifact platform");
    platforms.add(a.platform);
    if (
      typeof a.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(zip|tar\.gz)$/.test(a.filename) ||
      basename(a.filename) !== a.filename
    )
      throw new Error("Unsafe artifact filename");
    let url: URL;
    try {
      url = new URL(a.url);
    } catch {
      throw new Error("Invalid artifact URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !trust.downloadOrigins.includes(url.origin)
    )
      throw new Error("Artifact URL is outside pinned HTTPS download origins");
    if (
      !Number.isSafeInteger(a.bytes) ||
      a.bytes <= 0 ||
      a.bytes > 512 * 1024 * 1024 ||
      typeof a.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      typeof a.build !== "string" ||
      !/^bunnyhop-native\/[a-f0-9]{24}$/.test(a.build)
    )
      throw new Error("Invalid artifact metadata");
  }
  return m;
}
export async function fetchBounded(url: string, max: number, origins: string[]): Promise<Response> {
  let next = new URL(url);
  for (let i = 0; i < 6; i++) {
    if (next.protocol !== "https:" || next.username || next.password || !origins.includes(next.origin))
      throw new Error("Download/redirect outside pinned HTTPS origins");
    const r = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location");
      if (!location) throw new Error("Redirect lacks destination");
      await r.body?.cancel();
      next = new URL(location, next);
      continue;
    }
    if (!r.ok || !r.body) throw new Error(`Download failed: HTTP${r.status}`);
    const length = Number(r.headers.get("content-length"));
    if (length > max) throw new Error("Download exceeds declared limit");
    return r;
  }
  throw new Error("Too many download redirects");
}
export async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body!) {
    total += chunk.length;
    if (total > max) throw new Error("Response exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function downloadArtifact(
  artifact: ReleaseArtifact,
  directory: string,
  origins: string[],
): Promise<string> {
  if (
    basename(artifact.filename) !== artifact.filename ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > 512 * 1024 * 1024
  )
    throw new Error("Invalid artifact destination/size");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, artifact.filename);
  if (existsSync(target)) throw new Error("Download destination already exists");
  const part = target + ".partial",
    fd = openSync(part, "wx", 0o600);
  let succeeded = false;
  try {
    const r = await fetchBounded(artifact.url, artifact.bytes, origins),
      hash = createHash("sha256");
    let total = 0;
    for await (const chunk of r.body!) {
      total += chunk.length;
      if (total > artifact.bytes) throw new Error("Artifact exceeds signed byte count");
      hash.update(chunk);
      let at = 0;
      while (at < chunk.length) at += writeSync(fd, chunk, at, chunk.length - at);
    }
    if (total !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
      throw new Error("Artifact size/hash differs from signed release");
    fsyncSync(fd);
    closeSync(fd);
    // Same-directory hard link atomically refuses an existing destination without allocating another512MiB.
    linkSync(part, target);
    unlinkSync(part);
    succeeded = true;
    return target;
  } finally {
    if (!succeeded) {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(part);
      } catch {}
    }
  }
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        manifest: { type: "string" },
        keys: { type: "string", default: resolve(import.meta.dir, "release-keys.json") },
        platform: { type: "string", default: `${process.platform}/${process.arch}` },
        current: { type: "string" },
        download: { type: "string" },
        confirm: { type: "boolean" },
      },
    });
    if (!values.manifest)
      throw new Error("Usage: bun update.ts --manifest HTTPS_URL [--current BUILD] [--download DIRECTORY --confirm]");
    const trust = JSON.parse(readFileSync(values.keys!, "utf8")) as Trust;
    if (!trust.keys?.length) throw new Error("No release signing keys are pinned; updates disabled");
    const manifestUrl = new URL(values.manifest);
    const response = await fetchBounded(manifestUrl.href, 128 * 1024, trust.downloadOrigins),
      manifest = verifiedManifest(await readBounded(response, 128 * 1024), trust);
    const artifact = manifest.artifacts.find((a) => a.platform === values.platform);
    if (!artifact) throw new Error("No release artifact for this platform");
    if (artifact.build === values.current) {
      console.log(JSON.stringify({ current: true, version: manifest.version, build: artifact.build }));
      process.exit(0);
    }
    if (!values.download) {
      console.log(
        JSON.stringify({ available: true, version: manifest.version, artifact, requiresUserConfirmation: true }),
      );
      process.exit(0);
    }
    if (!values.confirm)
      throw new Error("Update download requires explicit user confirmation (--confirm); no installation is automatic");
    const path = await downloadArtifact(artifact, resolve(values.download), trust.downloadOrigins);
    console.log(
      JSON.stringify({
        downloaded: path,
        version: manifest.version,
        sha256: artifact.sha256,
        verified: true,
        installation: "Open the verified package and confirm installation yourself. Close the game first.",
      }),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
