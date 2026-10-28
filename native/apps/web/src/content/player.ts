// Where the optional CS:S player content (manifest `optional.player`, see manifest.ts) can be fetched from. Every map
// manifest carries the same group; prepareMapContent registers it here when a map loads, and the player model loader
// (player/studio/loader.ts) fetches files from it on demand. Without hosted content the game keeps the runner model.

import type { ContentGroup } from "./manifest";

export interface PlayerContent {
  group: ContentGroup;
  /** Content base URL ("" = same origin). */
  base: string;
}

let current: PlayerContent | null = null;
const listeners = new Set<(c: PlayerContent) => void>();

export function setPlayerContent(c: PlayerContent): void {
  const changed = !current || current.base !== c.base || Object.keys(current.group.files).length !== Object.keys(c.group.files).length;
  current = c;
  if (changed) for (const l of listeners) l(c);
}

export function playerContent(): PlayerContent | null {
  return current;
}

/** Calls fn when player content becomes available (now, if it already is). Returns an unsubscribe function. */
export function onPlayerContent(fn: (c: PlayerContent) => void): () => void {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}
