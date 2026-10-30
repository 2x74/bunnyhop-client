import { effectMaterialNames } from "../map-effects/smoke";
// Hosted stock content (CS:S/HL2 materials and skyboxes the map references but doesn't pack).
//
// On map load: fetch content-manifests/<bsp sha256>.json, fetch each listed file from
// content/<sha256> (immutable, content-addressed: the browser HTTP cache keeps them), verify the
// hash and hand the bytes to core, which mounts them behind the pakfile. Core then resolves with
// Source's precedence: pakfile → hosted stock content → grey checker fallback (render.ts).
//
// Base URL: VITE_CONTENT_URL, else the API (VITE_API_URL), else same-origin, which the Vite dev
// server serves from the local content-cache/ (tools/content/extract.ts output).
// Taken-down files (apps/api denylist) are absent from the manifest or 404, and simply fall back.

import type { Core } from "../core";
import { MaterialKind, registerPhysicsContent } from "../core";
import { API_URL } from "../api";
import { type ContentManifest, contentKey, isManifest, manifestKey } from "./manifest";
import { skyMaterials } from "./resolve";
import { setPlayerContent } from "./player";
import { setMapSoundContent, setSoundContent } from "./sounds";
import { fetchBytes } from "./fetch";
import { CLIENT_DRAWN_SHADERS } from "../vmt";

export { skyMaterials, SKY_SUFFIXES } from "./resolve";
export type { ContentManifest } from "./manifest";

const env = (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {};
/** Where content/ and content-manifests/ are served from ("" = same origin). */
export const CONTENT_BASE: string = String(env.VITE_CONTENT_URL || API_URL || "").replace(/\/+$/, "");

export interface MapContentStatus {
  materials: number;
  /** Materials still missing (grey checker). */
  missing: number;
  /** Missing with the pakfile alone. */
  missingWithoutContent: number;
  sky: string | null;
  /** The skybox textures resolved, or its faces are WindowImposters (rendered as a real sky, else the gradient). */
  skyResolved: boolean;
  /** Where the manifest came from ("" = same origin), or null if none was found. */
  source: string | null;
  /** Hosted manifest found for this exact BSP. */
  manifest: boolean;
  /** Files listed / loaded / unavailable (404, taken down, hash mismatch, timed out after retries). */
  files: number;
  loaded: number;
  failed: number;
  /** Not downloaded because the player chose to play without textures. */
  skipped: number;
  bytes: number;
  /** Static props rendered (instances), models built, models whose files were unavailable. */
  props: { instances: number; models: number; missingModels: number };
  ms: number;
}

let status: MapContentStatus | null = null;

/** Content state of the current map (null until a map has been prepared). */
export function mapContentStatus(): MapContentStatus | null {
  return status && { ...status };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchManifest(mapSha: string, signal?: AbortSignal): Promise<ContentManifest | null> {
  const bases = [CONTENT_BASE];
  // Dev with an API configured but not seeded with content: fall back to the local content-cache.
  if (env.DEV && CONTENT_BASE) bases.push("");
  for (const base of bases) {
    try {
      const b = await fetchBytes(`${base}/${manifestKey(mapSha)}`, {
        attempts: 3,
        headerTimeoutMs: 15_000,
        idleTimeoutMs: 15_000,
        signal,
        accept: (r) => ((r.headers.get("content-type") ?? "").includes("json") ? null : "not a manifest"),
      });
      const m: unknown = JSON.parse(new TextDecoder().decode(b));
      if (isManifest(m) && m.mapSha256 === mapSha) return Object.assign(m, { base });
    } catch (e) {
      /* offline / no content server / timed out after retries */
      if ((e as Error)?.message !== "HTTP 404" && (e as Error)?.message !== "not a manifest") console.warn(`content: manifest unavailable (${(e as Error)?.message ?? e})`);
    }
  }
  return null;
}

/** Hosted content download progress (main.ts shows it on the loading screen). */
export interface ContentProgress {
  /** Files to download, finished (loaded or failed), failed. */
  files: number;
  done: number;
  failed: number;
  /** Bytes received / expected (manifest sizes). */
  bytes: number;
  totalBytes: number;
}

export interface PrepareContentOptions {
  bsp?: Uint8Array;
  mapSha256?: string;
  /** Play without textures: download only the collision models (the simulation needs them), no materials or props. */
  skip?: boolean;
  /** Aborting it stops the texture download where it is (collision models still finish): the map loads with what arrived. */
  signal?: AbortSignal;
  onProgress?: (p: ContentProgress) => void;
}

/** Registers the player content group of a map's manifest without loading the map (dev preview pages). */
export async function discoverPlayerContent(mapSha: string): Promise<boolean> {
  const m = await fetchManifest(mapSha);
  if (!m?.optional?.player) return false;
  setPlayerContent({ group: m.optional.player, base: (m as ContentManifest & { base?: string }).base ?? CONTENT_BASE });
  return true;
}

async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Loads hosted stock content for the loaded map and resolves its materials (+ skybox faces).
 * Also builds the static prop mesh (core.propsMesh()). Returns the extra material names core
 * appended after the mesh materials: sky faces (SKY_SUFFIXES order), then the prop materials
 * (indexed by prop group `material`). Never throws: without a manifest the map renders with its
 * pakfile alone.
 */
export async function prepareMapContent(
  core: Core,
  opts: PrepareContentOptions = {},
): Promise<{ sky: string | null; extra: string[]; propMaterials: string[] }> {
  if (!core.hasContentApi()) return { sky: null, extra: [], propMaterials: [] };
  const t0 = performance.now();
  const world = core.entities().find((e) => e.classname === "worldspawn");
  const sky = world?.skyname?.trim() || null;
  const extra = [...(sky ? skyMaterials(sky) : []), ...effectMaterialNames(core.entities())];
  const meshCount = core.mesh().materials.length;
  // WindowImposter / Aftershock materials are drawn by the renderer (imposter.ts): not missing.
  const countMissing = () => core.materials().slice(0, meshCount).filter((d) => d.kind === MaterialKind.Missing && !CLIENT_DRAWN_SHADERS.has(d.shader)).length;

  core.contentMaterialOverrides({}); // the previous map's
  core.contentResolve(extra);
  const missingWithoutContent = countMissing();

  const mapSha = opts.mapSha256 ?? (opts.bsp ? await sha256Hex(opts.bsp) : null);
  const manifest = mapSha ? await fetchManifest(mapSha, opts.signal) : null;
  // Map-specific material overrides (maps/<map>.json `materialOverrides`): they win over the pakfile, and apply even
  // when textures are skipped (the replacement is then missing: the plain fallback, never the covered art).
  if (manifest?.materialOverrides) core.contentMaterialOverrides(manifest.materialOverrides);
  if (manifest?.optional?.player) setPlayerContent({ group: manifest.optional.player, base: (manifest as ContentManifest & { base?: string }).base ?? CONTENT_BASE });
  setMapSoundContent(core, manifest?.optional?.mapSounds ? { group: manifest.optional.mapSounds, base: (manifest as ContentManifest & { base?: string }).base ?? CONTENT_BASE } : null);
  if (manifest?.optional?.sounds) setSoundContent({ group: manifest.optional.sounds, base: (manifest as ContentManifest & { base?: string }).base ?? CONTENT_BASE });
  let loaded = 0;
  let failed = 0;
  let skipped = 0;
  let bytes = 0;
  if (manifest) {
    const base = (manifest as ContentManifest & { base?: string }).base ?? CONTENT_BASE;
    const got: [string, Uint8Array][] = [];
    // Collision models first (the simulation needs them; a few small files), then everything the renderer uses.
    const physicsPaths = manifest.physics?.files ?? {};
    const all = Object.entries(manifest.files).sort(([a], [b]) => Number(b in physicsPaths) - Number(a in physicsPaths));
    const queue = opts.skip ? all.filter(([path]) => path in physicsPaths) : all;
    skipped = all.length - queue.length;
    const progress: ContentProgress = { files: queue.length, done: 0, failed: 0, bytes: 0, totalBytes: queue.reduce((n, [, f]) => n + (f.size || 0), 0) };
    opts.onProgress?.({ ...progress });
    await pool(queue, 12, async ([path, f]) => {
      const isPhysics = path in physicsPaths;
      // Skipping textures: what hasn't started isn't fetched (collision models always are).
      if (opts.signal?.aborted && !isPhysics) {
        skipped++;
        return;
      }
      let seen = 0;
      try {
        const b = await fetchBytes(`${base}/${contentKey(f.sha256)}`, {
          cacheSha256: f.sha256,
          attempts: 3,
          headerTimeoutMs: 15_000,
          idleTimeoutMs: 15_000,
          signal: isPhysics ? undefined : opts.signal,
          // Decoded bytes against the manifest size: the edge compresses content downloads (no usable Content-Length).
          expectedSize: f.size,
          onProgress: (n) => {
            progress.bytes += n - seen;
            seen = n;
            opts.onProgress?.({ ...progress });
          },
          onRetry: (attempt, e) => console.warn(`content: ${path}: ${e.message}, retrying (${attempt}/3)`),
        });
        if ((await sha256Hex(b)) !== f.sha256) throw new Error("hash mismatch");
        got.push([path, b]);
      } catch (e) {
        progress.bytes -= seen;
        if (opts.signal?.aborted && !isPhysics) skipped++;
        else {
          failed++;
          progress.failed++;
          console.warn(`content: ${path} unavailable (${(e as Error).message})`);
        }
      }
      progress.done++;
      opts.onProgress?.({ ...progress });
    });
    for (const [path, b] of got) {
      core.contentAddFile(path, b);
      bytes += b.length;
      loaded++;
    }
    core.contentResolve(extra);
    // Prop collision models: shared with every simulation instance, then rebuild this one's props.
    const physics = manifest.physics?.files ?? {};
    registerPhysicsContent(got.filter(([path]) => path in physics));
    core.physicsReload();
    const stillMissing = core.physicsMissing();
    if (stillMissing.length) console.warn(`content: no collision model for ${stillMissing.length} prop model(s): ${stillMissing.slice(0, 5).join(", ")}`);
  }

  // Static props: models come from the pakfile or hosted content; their materials resolve after the sky.
  let propMaterials: string[] = [];
  let props = { instances: 0, models: 0, missingModels: 0 };
  if (opts.bsp && core.propsLoad(opts.bsp).length) {
    propMaterials = core.propsBuild();
    core.contentResolve([...extra, ...propMaterials]);
    const pm = core.propsMesh();
    props = { instances: pm.instances, models: pm.models, missingModels: pm.missingModels };
  }

  const descs = core.materials();
  status = {
    materials: meshCount,
    missing: countMissing(),
    missingWithoutContent,
    sky,
    // WindowImposter sky faces: drawn from their cube map (imposter.ts).
    skyResolved: extra.length > 0 && descs.slice(meshCount, meshCount + 4).every((d) => d.texture >= 0 || d.shader === "windowimposter"),
    source: manifest ? ((manifest as ContentManifest & { base?: string }).base ?? CONTENT_BASE) : null,
    manifest: !!manifest,
    files: manifest ? Object.keys(manifest.files).length : 0,
    loaded,
    failed,
    skipped,
    bytes,
    props,
    ms: Math.round(performance.now() - t0),
  };
  console.info(
    `content: ${status.missing}/${meshCount} materials missing (${missingWithoutContent} with the pakfile alone); ` +
      (manifest ? `${loaded}/${status.files} hosted files (${(bytes / 1e6).toFixed(2)} MB${skipped ? `, ${skipped} skipped: playing without textures` : ""})` : "no hosted manifest") +
      `; sky ${sky ?? "-"}${status.skyResolved ? "" : " (gradient)"}; props ${props.instances} (${props.models} models` +
      `${props.missingModels ? `, ${props.missingModels} unavailable` : ""}); ${status.ms} ms`,
  );
  return { sky, extra, propMaterials };
}

if (env.DEV && typeof window !== "undefined") Object.assign(window, { __bunnyhopContent: { mapContentStatus, CONTENT_BASE } });
