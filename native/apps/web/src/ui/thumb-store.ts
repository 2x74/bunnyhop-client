// The Loadout's rendered thumbnails kept across page loads (IndexedDB), so only the first visit draws them: every knife
// in every finish, gloves, hats, colourways each cost a model build, sometimes a shader compile and a GPU readback,
// and the grid used to draw them all again on every page load (slow on first open, worst on Windows / older PCs).
//
// A thumbnail is stored under its key (what it shows, loadout-stage.ts ThumbJob.key plus what else it depends on) in a
// store tagged with `version`: the stage passes its own hashed chunk URL, which changes whenever its code or any model
// code it imports changes, and a store of another version is cleared on open. Anything failing (no IndexedDB, private
// mode, quota) just means drawing them again, as before.

const DB = "bunnyhop-thumbs";
const STORE = "thumbs";
const VERSION_KEY = "\u0000version";

let open: Promise<IDBDatabase | null> | null = null;

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function db(version: string): Promise<IDBDatabase | null> {
  open ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
      r.onsuccess = () => {
        const d = r.result;
        // Another version's thumbnails can never be shown again: drop them.
        const tx = d.transaction(STORE, "readwrite");
        const s = tx.objectStore(STORE);
        const v = s.get(VERSION_KEY);
        v.onsuccess = () => {
          if (v.result === version) return;
          s.clear();
          s.put(version, VERSION_KEY);
        };
        tx.oncomplete = () => resolve(d);
        tx.onerror = tx.onabort = () => resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
  return open;
}

/** A stored thumbnail as a canvas (a software one, like the stage's own), or null. */
export async function loadThumb(version: string, key: string): Promise<HTMLCanvasElement | null> {
  try {
    const d = await db(version);
    if (!d) return null;
    const blob = (await req(d.transaction(STORE).objectStore(STORE).get(key))) as Blob | undefined;
    if (!(blob instanceof Blob)) return null;
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d", { willReadFrequently: true })?.drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  } catch {
    return null;
  }
}

/** Stores a thumbnail (encoded off the main thread by toBlob), fire and forget. */
export function saveThumb(version: string, key: string, c: HTMLCanvasElement): void {
  try {
    c.toBlob(
      (blob) => {
        if (!blob) return;
        void db(version)
          .then((d) => d && req(d.transaction(STORE, "readwrite").objectStore(STORE).put(blob, key)))
          .catch(() => {});
      },
      "image/webp",
      0.92,
    );
  } catch {
    /* not stored: drawn again next time */
  }
}
