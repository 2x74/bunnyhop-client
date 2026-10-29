// Ephemeral offline signing fixtures. No key here is ever trusted by a release.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const now = 1793016000;
const trust = {
  schema: 1,
  keys: [{ id: "test-only", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  downloadOrigins: ["https://download.example.test"],
};
const artifact = {
  platform: "darwin/arm64",
  filename: "bunnyhop-0.4.0.tar.gz",
  url: "https://download.example.test/bunnyhop-0.4.0.tar.gz",
  bytes: 100,
  sha256: "a".repeat(64),
  build: "bunnyhop-native/" + "b".repeat(24),
};
const base = {
  schema: 1,
  version: "0.4.0",
  createdAt: new Date((now - 60) * 1000).toISOString(),
  expiresAt: new Date((now + 86400) * 1000).toISOString(),
  artifacts: [artifact],
};
function envelope(m: unknown) {
  const bytes = Buffer.from(JSON.stringify(m));
  return {
    keyId: "test-only",
    payload: bytes.toString("base64"),
    signature: sign(null, bytes, privateKey).toString("base64"),
  };
}
const cases: { name: string; envelope: unknown; valid: boolean }[] = [
  { name: "valid", envelope: envelope(base), valid: true },
];
const bad = (name: string, mutate: (m: typeof base) => void) => {
  const m = structuredClone(base);
  mutate(m);
  cases.push({ name, envelope: envelope(m), valid: false });
};
bad("expired", (m) => (m.expiresAt = new Date((now - 1) * 1000).toISOString()));
bad("future", (m) => (m.createdAt = new Date((now + 301) * 1000).toISOString()));
bad("long validity", (m) => (m.expiresAt = new Date((now + 32 * 86400) * 1000).toISOString()));
bad("bad day", (m) => (m.createdAt = "2026-02-30T00:00:00Z"));
bad("duplicate platform", (m) => m.artifacts.push({ ...artifact }));
bad("unsafe filename", (m) => (m.artifacts[0].filename = "../escape.zip"));
bad("wrong origin", (m) => (m.artifacts[0].url = "https://download.example.test.evil.test/a.zip"));
bad("url credentials", (m) => (m.artifacts[0].url = "https://evil@download.example.test/a.zip"));
bad("too large", (m) => (m.artifacts[0].bytes = 512 * 1024 * 1024 + 1));
bad("fraction", (m) => (m.artifacts[0].bytes = 1.5));
bad("hash", (m) => (m.artifacts[0].sha256 = "a".repeat(63)));
bad("build", (m) => (m.artifacts[0].build = "local"));
bad("wasm", (m) => Object.assign(m.artifacts[0], { wasm: "bunnyhop-web/xyz" }));
bad("notes type", (m) => Object.assign(m, { notes: 12 }));
bad("long notes", (m) => Object.assign(m, { notes: "x".repeat(8 * 1024 + 1) }));
const described = structuredClone(base);
Object.assign(described, { notes: "**Fixes**\n- Frame rate is back up." });
Object.assign(described.artifacts[0], { wasm: "bunnyhop-web/" + "c".repeat(12) });
cases.push({ name: "notes and wasm", envelope: envelope(described), valid: true });
const tampered = envelope(base);
tampered.payload = Buffer.from(JSON.stringify({ ...base, version: "9.0.0" })).toString("base64");
cases.push({ name: "tampered", envelope: tampered, valid: false });
const unknown = envelope(base);
unknown.keyId = "other";
cases.push({ name: "untrusted key", envelope: unknown, valid: false });
// Releases served by native_update_tests.cpp's loopback server (test-hook builds only), signed for today.
const servicePort = 47613;
const serviceOrigin = `http://127.0.0.1:${servicePort}`;
const packageBody = "native package bytes";
const packageSha256 = createHash("sha256").update(packageBody).digest("hex");
function release(version: string, platforms: string[], sha256 = packageSha256) {
  const created = Date.now() - 60_000;
  return envelope({
    schema: 1,
    version,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 7 * 86400_000).toISOString(),
    notes: `Notes for ${version}`,
    artifacts: platforms.map((platform) => ({
      platform,
      filename: `bunnyhop-native-${version}-${platform.replace("/", "-")}.zip`,
      url: `${serviceOrigin}/redirect/${platform.replace("/", "-")}`,
      bytes: packageBody.length,
      sha256,
      build: "bunnyhop-native/" + "e".repeat(24),
      wasm: "bunnyhop-web/" + "f".repeat(12),
    })),
  });
}
const everywhere = ["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"];
const service = {
  port: servicePort,
  body: packageBody,
  trust: { ...trust, downloadOrigins: [serviceOrigin], manifestUrl: `${serviceOrigin}/manifest` },
  releases: {
    newer: release("9.0.0", everywhere),
    older: release("0.0.1", everywhere),
    otherPlatform: release("9.0.0", ["linux/arm64"]),
    tampered: release("9.0.0", everywhere, "0".repeat(64)),
  },
};
await Bun.write(Bun.argv[2], JSON.stringify({ now, trust, cases, service }));
