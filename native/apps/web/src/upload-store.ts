// Failed uploads on this device (uploads.ts): their own IndexedDB database, "bunnyhop-uploads", so adding it needed no
// upgrade of pb.ts's "bunnyhop" database (tabs of older builds keep that one open, which would block an upgrade).

import type { StoredUpload, UploadFailure } from "./uploads";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bunnyhop-uploads", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("uploads", { keyPath: "sha" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = d.transaction("uploads", mode);
      const req = fn(t.objectStore("uploads"));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    d.close();
  }
}

/** Where runs go when the browser refuses IndexedDB (blocked site data): kept for as long as this page is open. */
const memory = new Map<string, StoredUpload>();

export const uploadStore = {
  async put(u: StoredUpload): Promise<void> {
    try {
      await tx("readwrite", (s) => s.put(u));
      memory.delete(u.sha);
    } catch {
      memory.set(u.sha, u);
    }
  },
  async get(sha: string): Promise<StoredUpload | undefined> {
    return memory.get(sha) ?? (await tx<StoredUpload | undefined>("readonly", (s) => s.get(sha) as IDBRequest<StoredUpload | undefined>).catch(() => undefined));
  },
  async remove(sha: string): Promise<void> {
    memory.delete(sha);
    await tx("readwrite", (s) => s.delete(sha)).catch(() => undefined);
  },
  async all(): Promise<StoredUpload[]> {
    const stored = await tx<StoredUpload[]>("readonly", (s) => s.getAll() as IDBRequest<StoredUpload[]>).catch(() => []);
    return [...stored.filter((u) => !memory.has(u.sha)), ...memory.values()];
  },
  /**
   * Marks a stored run failed (no-op when it isn't stored). Refused for having no session (guest_limit), it belongs to
   * nobody yet, whatever this browser remembered of its last account (uploads.ts).
   */
  async fail(sha: string, failure: UploadFailure): Promise<void> {
    const u = await uploadStore.get(sha);
    if (u) await uploadStore.put({ ...u, state: "failed", failure, at: Date.now(), account: failure === "guest_limit" ? null : u.account });
  },
};
