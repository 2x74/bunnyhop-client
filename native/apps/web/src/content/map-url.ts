// Where a map's BSP is downloaded from: by content hash when the map index names it (/api/bsp/<sha>.bsp: cached for
// good, no lookups on the server), else by name (/<map>.bsp). main.ts downloadMap loads it; gauntlet/mode.ts prefetches
// the next map's with the same URL, so that load is an HTTP cache hit.

/** The index entry's sha256 when it is a valid one, else null. */
export function indexSha(entry: { sha256?: string } | null | undefined): string | null {
  return entry?.sha256 && /^[0-9a-f]{64}$/.test(entry.sha256) ? entry.sha256 : null;
}

export function bspUrl(name: string, sha: string | null): string {
  return sha ? `/api/bsp/${sha}.bsp` : `/${name}.bsp`;
}
