// The packaged OST is an offline copy of the production music, decoded by SDL's
// native music worker. No web audio elements or network downloads are required.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MUSIC_SOURCE = resolve(import.meta.dir, "../assets/music");
const manifestBytes = readFileSync(join(MUSIC_SOURCE, "manifest.json"));
export const OST = JSON.parse(manifestBytes.toString()) as {
  schema: number;
  tracks: {
    id: string;
    title: string;
    role: string;
    duration: number;
    bpm: number;
    loopStart: number;
    loopEnd: number;
    credit: string;
    file: string;
    bytes: number;
    sha256: string;
  }[];
};
const metadataKeys = ["id", "title", "role", "duration", "bpm", "loopStart", "loopEnd", "credit"] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function verifyCatalog(music: unknown): void {
  if (OST.schema !== 1 || OST.tracks.length !== 11 || !Array.isArray(music) || music.length !== OST.tracks.length)
    throw new Error("Bundled OST catalog is incomplete");
  const ids = new Set<string>();
  for (let i = 0; i < OST.tracks.length; i++) {
    const track = OST.tracks[i];
    if (
      !/^[a-z0-9-]+$/.test(track.id) ||
      ids.has(track.id) ||
      track.file !== `${track.id}.mp3` ||
      !Number.isSafeInteger(track.bytes) ||
      track.bytes <= 0 ||
      track.bytes > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(track.sha256)
    )
      throw new Error("Invalid bundled OST identity");
    ids.add(track.id);
    for (const key of metadataKeys)
      if (music[i]?.[key] !== track[key]) throw new Error(`Bundled OST metadata mismatch: ${track.id}.${key}`);
  }
}

function verifyTrack(directory: string, track: (typeof OST.tracks)[number]): void {
  const file = join(directory, track.file),
    st = lstatSync(file);
  if (!st.isFile() || st.size !== track.bytes || sha(readFileSync(file)) !== track.sha256)
    throw new Error(`Bundled OST file mismatch: ${track.file}`);
}

export function exportMusic(assets: string, music: unknown): void {
  verifyCatalog(music);
  for (const track of OST.tracks) verifyTrack(MUSIC_SOURCE, track);
  const directory = join(assets, "music");
  mkdirSync(directory, { recursive: true });
  // This is generated output. Remove old codecs/tracks so runtime extension
  // discovery cannot prefer an obsolete copy over the pinned soundtrack.
  for (const name of readdirSync(directory)) rmSync(join(directory, name), { recursive: true });
  for (const track of OST.tracks) copyFileSync(join(MUSIC_SOURCE, track.file), join(directory, track.file));
  writeFileSync(join(directory, "manifest.json"), manifestBytes);
}

export function verifyMusicAssets(assets: string): void {
  verifyCatalog(JSON.parse(readFileSync(join(assets, "audio.json"), "utf8")).music);
  const directory = join(assets, "music");
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Bundled OST directory must not be a symlink");
  const expected = ["manifest.json", ...OST.tracks.map((track) => track.file)].sort();
  if (
    JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected) ||
    !readFileSync(join(directory, "manifest.json")).equals(manifestBytes)
  )
    throw new Error("Bundled OST manifest or file list mismatch");
  for (const track of OST.tracks) verifyTrack(directory, track);
}
