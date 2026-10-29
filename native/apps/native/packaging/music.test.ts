import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bundledMusic, exportMusic, OST, verifyMusicAssets } from "../src/export-music";

test("the pinned OST manifest keeps exact LF bytes in an autocrlf checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-ost-checkout-"));
  const root = resolve(import.meta.dir, "../../../..");
  const manifest = "native/apps/native/assets/music/manifest.json";
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "-c", "core.autocrlf=true", "-c", "core.eol=crlf", "-c", "core.safecrlf=false", ...args],
      { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "no-global-config") } },
    );
    if (result.exitCode) throw new Error(result.stderr.toString());
    return Buffer.from(result.stdout);
  };
  try {
    mkdirSync(dirname(join(dir, manifest)), { recursive: true });
    writeFileSync(join(dir, ".gitattributes"), readFileSync(join(root, ".gitattributes")));
    writeFileSync(join(dir, manifest), readFileSync(join(root, manifest)));
    // An adjacent text file must still undergo CRLF conversion: the rule is narrow.
    const adjacent = "native/apps/native/assets/music/checkout-control.json";
    writeFileSync(join(dir, adjacent), "{}\n");
    git("init", "--quiet");
    git("add", "--", ".gitattributes", manifest, adjacent);
    const canonical = git("show", `:${manifest}`);
    expect(canonical.includes(Buffer.from("\r\n"))).toBe(false);
    unlinkSync(join(dir, manifest));
    unlinkSync(join(dir, adjacent));
    git("checkout-index", "--all", "--force");
    expect(readFileSync(join(dir, manifest))).toEqual(canonical);
    expect(readFileSync(join(dir, adjacent), "utf8")).toBe("{}\r\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bundled OST stays complete when the web catalogue adds tracks", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-ost-"));
  const upstream = JSON.parse(
    readFileSync(new URL("../../web/src/assets/audio/manifest.json", import.meta.url), "utf8"),
  ).music;
  const catalog = bundledMusic(upstream);
  try {
    exportMusic(dir, upstream);
    writeFileSync(join(dir, "audio.json"), JSON.stringify({ music: catalog }));
    verifyMusicAssets(dir);
    expect(OST.tracks).toHaveLength(11);
    expect(OST.tracks.filter((t) => t.role === "menu")).toHaveLength(1);
    expect(OST.tracks.every((t) => t.credit.includes("ElevenLabs Music"))).toBe(true);
    const manifest = join(dir, "music", "manifest.json"),
      manifestBytes = readFileSync(manifest);
    writeFileSync(manifest, manifestBytes.toString().replace(/\n/g, "\r\n"));
    expect(() => verifyMusicAssets(dir)).toThrow("manifest or file list mismatch");
    writeFileSync(manifest, manifestBytes);
    const file = join(dir, "music", OST.tracks[0].file),
      original = readFileSync(file);
    const changed = Buffer.from(original);
    changed[100] ^= 1;
    writeFileSync(file, changed);
    expect(() => verifyMusicAssets(dir)).toThrow("Bundled OST file mismatch");
    writeFileSync(file, original);
    rmSync(file);
    expect(() => verifyMusicAssets(dir)).toThrow();
    exportMusic(dir, catalog);
    writeFileSync(join(dir, "music", "menu-drift.ogg"), "stale alternate codec");
    expect(() => verifyMusicAssets(dir)).toThrow("file list mismatch");
    exportMusic(dir, catalog);
    verifyMusicAssets(dir);
    writeFileSync(join(dir, "audio.json"), JSON.stringify({ music: catalog.slice(1) }));
    expect(() => verifyMusicAssets(dir)).toThrow("catalog is incomplete");
    expect(() =>
      exportMusic(
        dir,
        catalog.map((t: object, i: number) => (i ? t : { ...t, role: "game" })),
      ),
    ).toThrow("metadata mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
