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

export const uploadStore = {
  put: (u: StoredUpload) => tx("readwrite", (s) => s.put(u)).then(() => undefined),
  get: (sha: string) => tx<StoredUpload | undefined>("readonly", (s) => s.get(sha) as IDBRequest<StoredUpload | undefined>),
  remove: (sha: string) => tx("readwrite", (s) => s.delete(sha)).then(() => undefined),
  all: () => tx<StoredUpload[]>("readonly", (s) => s.getAll() as IDBRequest<StoredUpload[]>),
  /** Marks a stored run failed (no-op when it isn't stored). */
  async fail(sha: string, failure: UploadFailure): Promise<void> {
    const u = await uploadStore.get(sha);
    if (u) await uploadStore.put({ ...u, state: "failed", failure, at: Date.now() });
  },
};
