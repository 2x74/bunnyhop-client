import { PACK_LIMITS, validatePack, type TexturePack } from "./manifest";
const listeners=new Set<()=>void>();
export function watchTexturePacks(fn:()=>void):()=>void {listeners.add(fn);return()=>listeners.delete(fn);}
const notify=()=>{for(const fn of listeners)fn();};
export interface InstalledPack { pack: TexturePack; enabled: boolean; installedAt: number }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bunnyhop:texture-packs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("packs", { keyPath: "pack.id" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function storage<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try { return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction("packs", mode); const request = action(tx.objectStore("packs"));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function installedPacks(): Promise<InstalledPack[]> {
  const records = await storage("readonly", (store) => store.getAll());
  return records.sort((a, b) => a.installedAt - b.installedAt);
}
export async function installPack(input: unknown, signal?: AbortSignal): Promise<void> {
  const pack = await validatePack(input, signal);
  signal?.throwIfAborted();
  const record: InstalledPack = { pack, enabled: false, installedAt: Date.now() };
  await storage("readwrite", (store) => store.put(record));notify();
}
export async function enablePack(id: string, enabled: boolean): Promise<void> {
  const record = (await installedPacks()).find((p) => p.pack.id === id); if (!record) return;
  await storage("readwrite", (store) => store.put({ ...record, enabled }));notify();
}
export async function removePack(id: string): Promise<void> { await storage("readwrite", (store) => store.delete(id));notify(); }
export async function downloadPack(url: string, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void> {
  const parsed = new URL(url, location.href);
  if (parsed.protocol !== "https:" && parsed.origin !== location.origin) throw new Error("Pack downloads require HTTPS");
  const response = await fetch(parsed, { signal }); if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get("content-length") ?? 0); if (total > PACK_LIMITS.file) throw new Error("Pack file exceeds budget");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let received = 0;
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break;
    received += value.byteLength; if (received > PACK_LIMITS.file) throw new Error("Pack file exceeds budget");
    chunks.push(value); progress(received, total);
  } } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  const bytes = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await installPack(JSON.parse(new TextDecoder().decode(bytes)), signal);
}
