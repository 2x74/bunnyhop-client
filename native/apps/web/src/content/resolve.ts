// The resolution loop between core (which knows what it needs) and a host that can read the game's
// VPKs. Used by the content extractor (tools/content/extract.ts) with Bun.file().slice(); the core side
// is generic, so a browser host could drive it the same way with File.slice().
//
//   core.contentResolve()  ->  [{ path, mount, archive, offset, length }]   (what's missing, one level deep)
//   step()                     optional: more reads (models, props) that add pending requests
//   host reads the byte ranges, core.contentProvide(path, bytes)            (CRC-checked against the VPK tree)
//   repeat until nothing is pending: pakfile VMT -> include VMT -> VTF takes ~3 rounds.

import { type Core, type ContentRequest, CONTENT_ARCHIVE_LISTING } from "../core";

/** Stock VPKs in CS:S search order, relative to the install root (`.../common/Counter-Strike Source`). */
export const GAME_VPKS = [
  "cstrike/cstrike_pak_dir.vpk",
  "hl2/hl2_textures_dir.vpk",
  "hl2/hl2_misc_dir.vpk",
  "platform/platform_misc_dir.vpk",
] as const;

/**
 * Stock CS:GO VPKs, relative to a CS:GO install root (the folder containing `csgo/`: the game, or the dedicated server,
 * SteamCMD app 740). Searched before the CS:S VPKs for CS:GO (BSP v21) maps, which were compiled against them.
 */
export const CSGO_VPKS = ["csgo/pak01_dir.vpk"] as const;

/** Skybox faces in the order core returns them (+X, -X, +Y, -Y, +Z, -Z in Source axes). */
export const SKY_SUFFIXES = ["rt", "lf", "bk", "ft", "up", "dn"] as const;

export function skyMaterials(skyname: string): string[] {
  const n = skyname.trim().toLowerCase();
  return n ? SKY_SUFFIXES.map((s) => `skybox/${n}${s}`) : [];
}

/** Companion files of a studio model. */
export function modelFiles(mdl: string): string[] {
  const base = mdl.toLowerCase().replace(/\\/g, "/").replace(/\.mdl$/, "");
  return [`${base}.mdl`, `${base}.vvd`, `${base}.dx90.vtx`];
}

/** `cstrike/cstrike_pak_dir.vpk`, 3 -> `cstrike/cstrike_pak_003.vpk`. */
export function archiveName(dirName: string, archive: number): string {
  return `${dirName.replace(/_dir\.vpk$/, "")}_${String(archive).padStart(3, "0")}.vpk`;
}

/** Reads the bytes a request needs. */
export interface ContentReader {
  /** Byte range of a file relative to the install root (`cstrike/cstrike_pak_000.vpk`). */
  readRange(file: string, offset: number, length: number): Promise<Uint8Array>;
  /** Whole file from a listing, by game path. */
  fetchListed?(path: string): Promise<Uint8Array | null>;
}

export interface ResolveResult {
  rounds: number;
  /** Files fetched from mounted content (path -> assembled bytes). */
  fetched: Map<string, Uint8Array>;
  /** Bytes read from VPK archives / listings. */
  bytesRead: number;
  failed: string[];
  /** Mount (VPK dir name or listing) each fetched file came from (path -> mount). */
  origin?: Map<string, string>;
}

async function readRequest(r: ContentRequest, reader: ContentReader): Promise<Uint8Array | null> {
  if (r.archive === CONTENT_ARCHIVE_LISTING) return reader.fetchListed ? reader.fetchListed(r.path) : null;
  if (r.length === 0) return new Uint8Array(0);
  return reader.readRange(archiveName(r.mount, r.archive), r.offset, r.length);
}

async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Resolves the loaded map's materials (+ `extra` names) against mounted content, fetching until
 * nothing is pending. `step` runs after each resolve and may read more files (models) through the
 * same VFS; its requests are fetched in the same round.
 */
export async function resolveContent(
  core: Core,
  reader: ContentReader | null,
  extra: string[] | (() => string[]) = [],
  step?: () => void,
  into?: ResolveResult,
): Promise<ResolveResult> {
  const result: ResolveResult = into ?? { rounds: 0, fetched: new Map(), bytesRead: 0, failed: [] };
  const failed = new Set<string>(result.failed);
  for (let round = 0; ; round++) {
    core.contentResolve(typeof extra === "function" ? extra() : extra);
    step?.();
    const pending = core.contentPending().filter((r) => !failed.has(r.path));
    if (!pending.length || !reader || round >= 16) break;
    result.rounds++;
    const got: [ContentRequest, Uint8Array | null][] = [];
    await pool(pending, 16, async (r) => {
      try {
        got.push([r, await readRequest(r, reader)]);
      } catch (e) {
        console.warn(`content: reading ${r.path} failed`, e);
        got.push([r, null]);
      }
    });
    // Provide after all reads: contentProvide matches against the current VFS's pending requests.
    for (const [r, bytes] of got) {
      if (bytes && core.contentProvide(r.path, bytes)) {
        result.bytesRead += bytes.length;
        result.fetched.set(r.path, core.contentFile(r.path) ?? new Uint8Array(0));
        result.origin?.set(r.path, r.mount);
      } else {
        if (bytes) console.warn(`content: ${core.lastError()}`);
        failed.add(r.path);
      }
    }
  }
  result.failed = [...failed];
  return result;
}
