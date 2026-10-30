// Where the optional CS:S sounds (manifest `optional.sounds`, see manifest.ts) can be fetched from. Every map manifest
// carries the same group; prepareMapContent registers it here, and audio/classic.ts fetches the files when the
// "Classic CS:S sounds" option is on. Without hosted content the game keeps its own sounds.

import type { MapSoundGroup, SoundGroup } from "./manifest";

export interface SoundContent {
  group: SoundGroup;
  /** Content base URL ("" = same origin). */
  base: string;
}

let current: SoundContent | null = null;
const listeners = new Set<(c: SoundContent) => void>();

export function setSoundContent(c: SoundContent): void {
  const changed = !current || current.base !== c.base || Object.keys(current.group.files).length !== Object.keys(c.group.files).length;
  current = c;
  if (changed) for (const l of listeners) l(c);
}

export function soundContent(): SoundContent | null {
  return current;
}

/** Calls fn when sound content becomes available (now, if it already is). Returns an unsubscribe function. */
export function onSoundContent(fn: (c: SoundContent) => void): () => void {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

/** A map's `optional.mapSounds` (audio/map-sounds.ts reads it). */
export interface MapSoundContent {
  group: MapSoundGroup;
  base: string;
}

// Per core: the attract screen's background map prepares its content on its own core while the real one loads.
const mapSounds = new WeakMap<object, MapSoundContent>();

export function setMapSoundContent(core: object, c: MapSoundContent | null): void {
  if (c) mapSounds.set(core, c);
  else mapSounds.delete(core);
}

export function mapSoundContent(core: object): MapSoundContent | null {
  return mapSounds.get(core) ?? null;
}
