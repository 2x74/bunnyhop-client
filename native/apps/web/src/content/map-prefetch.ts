// A map's BSP fetched ahead of its load, while another map is played, so the load that follows is a cache hit: the
// browser's HTTP cache (the same URL the loader asks: content/map-url.ts), or in the desktop client its own content
// cache (by the BSP's sha256). Used for a gauntlet's next map (gauntlet/mode.ts) and for a room's next map once it is
// known (net/mp.ts: the Daily room names the next day's map from 15:50 UTC; any room once a vote has picked one).
//
// Best effort: a failure costs nothing (the load downloads it as usual), and a name is fetched once per page.

import { fetchBytes } from "./fetch";
import { bspUrl, indexSha } from "./map-url";
import { nativeClient } from "../client-bridge";
import { noteStall } from "../stall-log";

/** The map index (ui/maps.ts fetchMapIndex): only the name and the hash are read. */
export type MapIndexRead = () => Promise<readonly { name: string; sha256?: string }[]>;

const started = new Set<string>();

/** Fetches `name`'s BSP into the cache, once per page. Resolves when done (or given up); never rejects. */
export async function prefetchMap(name: string, index: MapIndexRead): Promise<void> {
  if (!name || started.has(name)) return;
  started.add(name);
  noteStall("prefetch");
  try {
    const sha = indexSha((await index()).find((m) => m.name === name));
    const url = bspUrl(name, sha);
    if (nativeClient() && sha) {
      await fetchBytes(url, { cacheSha256: sha, attempts: 2, resume: true, sha256: sha });
      return;
    }
    const res = await fetch(url, { priority: "low" } as RequestInit);
    const reader = res.ok ? res.body?.getReader() : null;
    if (!reader) return;
    while (!(await reader.read()).done) {
      /* drained into the cache */
    }
  } catch {
    /* the load downloads it as usual */
  }
}

/** Tests: forget which maps were fetched. */
export const forgetPrefetched = () => started.clear();
