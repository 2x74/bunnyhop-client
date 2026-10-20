import { nativeClient } from "../client-bridge";

/** Only immutable bytes with a known digest belong in the desktop cache. */
export async function cachedContent(hash: string | undefined, download: () => Promise<Uint8Array>, signal?: AbortSignal, progress?: (got: number, total: number | null) => void): Promise<Uint8Array> {
  const native = nativeClient();
  const usable = typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) && native?.getCachedContent && native?.cacheContent;
  if (!usable) return download();
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let hit: Uint8Array | null = null;
  try { hit = await native.getCachedContent!(hash!); } catch { /* Cache failure must not block play. */ }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (hit instanceof Uint8Array) {
    progress?.(hit.length, hit.length);
    return hit;
  }
  const bytes = await download();
  if (!signal?.aborted) {
    try { await native.cacheContent!(hash!, bytes); } catch { /* Full disk or unavailable bridge: use the downloaded bytes. */ }
  }
  return bytes;
}
