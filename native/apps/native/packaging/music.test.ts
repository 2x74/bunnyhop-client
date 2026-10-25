import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportMusic, OST, verifyMusicAssets } from "../src/export-music";

test("the complete production OST is copied, credited and verified offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunnyhop-ost-"));
  const catalog = JSON.parse(readFileSync(new URL("../../web/src/assets/audio/manifest.json", import.meta.url), "utf8")).music;
  try {
    exportMusic(dir, catalog);
    writeFileSync(join(dir, "audio.json"), JSON.stringify({ music: catalog }));
    verifyMusicAssets(dir);
    expect(OST.tracks).toHaveLength(11);
    expect(OST.tracks.filter(t => t.role === "menu")).toHaveLength(1);
    expect(OST.tracks.every(t => t.credit.includes("ElevenLabs Music"))).toBe(true);
    const file = join(dir, "music", OST.tracks[0].file), original = readFileSync(file);
    const changed = Buffer.from(original); changed[100] ^= 1; writeFileSync(file, changed);
    expect(() => verifyMusicAssets(dir)).toThrow("Bundled OST file mismatch");
    writeFileSync(file, original); rmSync(file);
    expect(() => verifyMusicAssets(dir)).toThrow();
    exportMusic(dir, catalog);
    writeFileSync(join(dir, "music", "menu-drift.ogg"), "stale alternate codec");
    expect(() => verifyMusicAssets(dir)).toThrow("file list mismatch");
    exportMusic(dir, catalog); verifyMusicAssets(dir);
    writeFileSync(join(dir, "audio.json"), JSON.stringify({ music: catalog.slice(1) }));
    expect(() => verifyMusicAssets(dir)).toThrow("catalog is incomplete");
    expect(() => exportMusic(dir, catalog.map((t: object, i: number) => i ? t : { ...t, role: "game" }))).toThrow("metadata mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
