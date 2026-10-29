import { test, expect } from "bun:test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { verifiedManifest, readBounded, type Trust } from "./update";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trust: Trust = {
  schema: 1,
  keys: [{ id: "test", publicKey: publicKey.export({ format: "pem", type: "spki" }).toString() }],
  downloadOrigins: ["https://downloads.bunnyhop.lol"],
};
const body = () => ({
  schema: 1,
  version: "0.1.0",
  createdAt: "2026-10-20T12:00:00Z",
  expiresAt: "2026-10-21T12:00:00Z",
  artifacts: [
    {
      platform: "darwin/arm64",
      filename: "bunnyhop-native.zip",
      url: "https://downloads.bunnyhop.lol/native.zip",
      bytes: 123,
      sha256: "a".repeat(64),
      build: "bunnyhop-native/" + "b".repeat(24),
    },
  ],
});
const now = Date.parse("2026-10-20T15:00:00Z");
const envelope = (m = body()) => {
  const bytes = Buffer.from(JSON.stringify(m));
  return Buffer.from(
    JSON.stringify({
      keyId: "test",
      payload: bytes.toString("base64"),
      signature: sign(null, bytes, privateKey).toString("base64"),
    }),
  );
};
test("signed release accepted; unknown keys/tampered signature fail closed", () => {
  expect(verifiedManifest(envelope(), trust, now).version).toBe("0.1.0");
  expect(() => verifiedManifest(envelope(), { ...trust, keys: [] }, now)).toThrow();
  const e = JSON.parse(envelope().toString());
  e.payload = Buffer.from(JSON.stringify({ ...body(), version: "9.9.9" })).toString("base64");
  expect(() => verifiedManifest(Buffer.from(JSON.stringify(e)), trust, now)).toThrow("signature");
});
test("expired/future releases, unsafe URLs/filenames, duplicate platforms are rejected", () => {
  for (const mutate of [
    (b: any) => (b.expiresAt = "2026-10-20T13:00:00Z"),
    (b: any) => (b.createdAt = "2026-10-22T12:00:00Z"),
    (b: any) => (b.artifacts[0].url = "https://evil.example/package.zip"),
    (b: any) => (b.artifacts[0].url = "http://downloads.bunnyhop.lol/package.zip"),
    (b: any) => (b.artifacts[0].filename = "../payload.zip"),
    (b: any) => b.artifacts.push(b.artifacts[0]),
    (b: any) => (b.artifacts[0].bytes = 1024 ** 3),
    (b: any) => (b.artifacts[0].wasm = "bunnyhop-web/not-a-hash"),
    (b: any) => (b.notes = 42),
    (b: any) => (b.notes = "x".repeat(8 * 1024 + 1)),
  ]) {
    const b = body();
    mutate(b);
    expect(() => verifiedManifest(envelope(b), trust, now)).toThrow();
  }
});
test("release notes and the verifier identity ride along", () => {
  const b: any = body();
  b.notes = "**Fixes**\n- Frame rate is back up.";
  b.artifacts[0].wasm = "bunnyhop-web/3cd68ab1a59f";
  const manifest = verifiedManifest(envelope(b), trust, now);
  expect(manifest.notes).toBe(b.notes);
  expect(manifest.artifacts[0].wasm).toBe("bunnyhop-web/3cd68ab1a59f");
});
test("bounded stream rejects response growth", async () => {
  expect(Buffer.from(await readBounded(new Response("abc"), 3)).toString()).toBe("abc");
  await expect(readBounded(new Response("abcdef"), 3)).rejects.toThrow();
});
test("artifact download accepts signed bytes; corrupt bytes/redirects cannot leave an installable package", async () => {
  const { downloadArtifact, fetchBounded } = await import("./update");
  const { mkdtempSync, existsSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-update-")),
    fetch = globalThis.fetch,
    bytes = Buffer.from("signed native package bytes"),
    artifact = {
      ...body().artifacts[0],
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  try {
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    const target = await downloadArtifact(artifact, join(dir, "ok"), trust.downloadOrigins);
    expect(existsSync(target)).toBe(true);
    globalThis.fetch = (async () => new Response(Buffer.from("corrupt native package bytes"))) as typeof fetch;
    await expect(downloadArtifact(artifact, join(dir, "bad"), trust.downloadOrigins)).rejects.toThrow();
    expect(readdirSync(join(dir, "bad"))).toEqual([]);
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/payload.zip" },
      })) as typeof fetch;
    await expect(fetchBounded(artifact.url, artifact.bytes, trust.downloadOrigins)).rejects.toThrow("pinned");
  } finally {
    globalThis.fetch = fetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
