// Skies from the desktop app's skies folder (client-bridge.ts watchClientSkies): .hdr / PNG / JPEG / WebP panoramas and
// .bhsky.json packs a player drops in a folder. They are never installed. Each one becomes a sky pack (from-hdr.ts,
// from-image.ts) or is checked
// (validateSkyPack) only when it's picked or drawn, and the result is kept by file name, size and modified time, so a
// rescan of the folder redoes nothing. A file that leaves the folder leaves the Sky picker (sky-packs/settings.ts puts
// the map sky back if it was the selected one).
import { nativeClient, watchClientSkies, type ClientSky } from "../client-bridge";
import { validateSkyPack, type SkyPack } from "./manifest";
import { skyIdFrom } from "./sources";
import { installedSkyPacks, watchSkyPacks } from "./store";

/** One file in the picker: its sky id, its name without the extension, and why it can't be used (null if it can). */
export interface FolderSky { id: string; name: string; error: string | null }

type FolderFile = Extract<ClientSky, { bytes: ArrayBuffer }>;
interface Bridge { watch: typeof watchClientSkies; available: () => boolean }

let bridge: Bridge = { watch: watchClientSkies, available: () => !!nativeClient()?.onCustomSkies };
let started = false;
let stop: (() => void) | null = null;
/** The folder's last list: null until the app has sent one. */
let list: { raw: ClientSky[]; entries: FolderSky[]; files: Map<string, FolderFile> } | null = null;
let signature = "";
let arrived: () => void = () => {};
let firstList = new Promise<void>((resolve) => (arrived = resolve));
/** Converted (or failed) skies by file key; dropped when the file changes or leaves. */
const cache = new Map<string, Promise<SkyPack>>();
const failed = new Map<string, string>();
const listeners = new Set<(changed: ReadonlySet<string>) => void>();

const key = (f: FolderFile) => `${f.name}\n${f.size}\n${f.mtime}`;
const displayName = (name: string) => name.replace(/\.bhsky\.json$|\.(hdr|png|jpe?g|webp)$/i, "") || name;

/** 32-bit FNV-1a, so two names that read the same as ids ("My sky", "my-sky") still get their own. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
/** A folder file's sky id: folder-<name as an id>-<hash of the exact name>. Matches validateSkyPack's id rule. */
export function folderSkyId(name: string): string {
  return `folder-${skyIdFrom(name.replace(/\.bhsky\.json$/i, "")).slice(0, 47)}-${fnv(name)}`;
}
export const isFolderSkyId = (id: string | null | undefined): id is string => !!id && /^folder-[a-z0-9_-]+-[0-9a-f]{8}$/.test(id);

/** Whether the desktop app has a skies folder (an app without it, and the browser, don't). */
export const folderSkiesAvailable = () => bridge.available();

function update(skies: ClientSky[]): void {
  const files = new Map<string, FolderFile>();
  const entries: FolderSky[] = [];
  for (const s of skies) {
    const id = folderSkyId(s.name);
    if (entries.some((e) => e.id === id)) continue;
    if ("error" in s) entries.push({ id, name: s.name, error: s.error });
    else {
      files.set(id, s);
      entries.push({ id, name: displayName(s.name), error: failed.get(key(s)) ?? null });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const keep = new Set([...files.values()].map(key));
  for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
  for (const k of [...failed.keys()]) if (!keep.has(k)) failed.delete(k);
  // The skies whose file came, went or changed (a sky being drawn reloads only if it's one of them).
  const changed = new Set<string>();
  for (const id of new Set([...files.keys(), ...(list?.files.keys() ?? [])])) {
    const a = files.get(id), b = list?.files.get(id);
    if (!a || !b || key(a) !== key(b)) changed.add(id);
  }
  list = { raw: skies, entries, files };
  arrived();
  const next = JSON.stringify(entries);
  if (next === signature && !changed.size) return;
  signature = next;
  for (const fn of listeners) fn(changed);
}

/** Starts listening to the folder (once; nothing without the desktop app). The list comes from the app. */
export function startFolderSkies(): void {
  if (started || !bridge.available()) return;
  started = true;
  stop = bridge.watch(update);
}

/** The folder's skies and unreadable files for the picker, by name; empty until the app has sent the list. */
export function folderSkies(): FolderSky[] {
  return list?.entries ?? [];
}
/** Whether the folder's list has arrived. */
export const folderSkiesKnown = () => list !== null;

/** Called when the folder's list changes (a file added, changed, removed) or a sky in it fails to convert, with the ids
 *  of the files that came, went or changed. */
export function watchFolderSkies(fn: (changed: ReadonlySet<string>) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The pack for folder sky `id`, made the first time it's asked for and kept while the file stays as it is. */
export async function folderSkyPack(id: string): Promise<SkyPack> {
  startFolderSkies();
  if (!list && started) await Promise.race([firstList, new Promise((r) => setTimeout(r, 5000))]);
  const entry = list?.entries.find((e) => e.id === id);
  const file = list?.files.get(id);
  if (!file) throw Error(entry?.error ?? "That sky isn't in your skies folder any more.");
  const k = key(file);
  let pack = cache.get(k);
  if (!pack) {
    pack = convert(id, file);
    cache.set(k, pack);
    pack.catch((e) => {
      if (cache.get(k) !== pack) return;
      failed.set(k, String((e as Error).message ?? e));
      // Shown in the picker as one of the folder's unusable files.
      if (list) update(list.raw);
    });
  }
  return pack;
}

async function convert(id: string, file: FolderFile): Promise<SkyPack> {
  const bytes = new Uint8Array(file.bytes);
  if (file.kind === "hdr") {
    const { skyPackFromHdr } = await import("./from-hdr");
    return skyPackFromHdr(bytes, { id, name: displayName(file.name), clouds: "photographic", sourceURL: `skies-folder/${file.name}` });
  }
  if (file.kind === "image") {
    const { skyPackFromImage } = await import("./from-image");
    return skyPackFromImage(bytes, { id, name: displayName(file.name), clouds: "photographic", sourceURL: `skies-folder/${file.name}` });
  }
  let pack: SkyPack;
  try {
    pack = JSON.parse(new TextDecoder().decode(bytes)) as SkyPack;
  } catch {
    throw Error("That isn't a sky pack (it isn't JSON).");
  }
  if (!pack || typeof pack !== "object") throw Error("That isn't a sky pack.");
  return validateSkyPack({ ...pack, id });
}

/** A sky by id for the sky runtime: a folder sky (converted on demand) or an installed pack; null if there's none. */
export async function findSkyPack(id: string): Promise<SkyPack | null> {
  if (isFolderSkyId(id) && bridge.available()) return folderSkyPack(id);
  return (await installedSkyPacks()).find((r) => r.pack.id === id)?.pack ?? null;
}

/** Installed packs and the folder both: `fn` runs when either changes (from the folder: with the ids that changed). */
export function watchSkies(fn: (changed?: ReadonlySet<string>) => void): () => void {
  const a = watchSkyPacks(() => fn()), b = watchFolderSkies(fn);
  return () => {
    a();
    b();
  };
}

/** Tests: a fake bridge, and the folder forgotten (listeners stay). */
export function resetFolderSkiesForTest(fake?: Bridge): void {
  stop?.();
  stop = null;
  started = false;
  list = null;
  signature = "";
  cache.clear();
  failed.clear();
  firstList = new Promise<void>((resolve) => (arrived = resolve));
  bridge = fake ?? { watch: watchClientSkies, available: () => !!nativeClient()?.onCustomSkies };
}
