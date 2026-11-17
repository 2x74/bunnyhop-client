// Practice replays: practice attempts kept on this device (session.ts keepPracticeReplay), so a route test can be
// watched back. A practice finish keeps one by itself when its recording plays back (attempt.ts replayLoss), and
// !keepreplay or the pause menu keeps the attempt so far. They are ordinary replay files (no field the verifier would
// ever see): what makes them practice is where they live. Never uploaded, never a PB or a ghost, never on a board:
// nothing here imports the API or the upload queue (apps/web/test/practice-replays.test.ts checks).
//
// The bytes go in pb.ts's IndexedDB store under their own "practice:" keys (memory when the browser refuses IndexedDB);
// the list is in localStorage, so the pause menu draws it without waiting. Caps: PRACTICE_REPLAY_CAPS, oldest first,
// and only practice replays ever go to make room: a PB replay is never touched.

import type { Replay } from "../replay";

/**
 * `replay` (a fresh build: its own arrays) ending with a replay checkpoint of `s`, the state now, when it hasn't one
 * there yet. A replay kept mid-attempt adds its last checkpoint here rather than to the live recording, which a real run
 * may still submit (session.ts buildReplay `live`).
 */
export function withFinalCheckpoint(replay: Replay, s: { tick: number; position: readonly number[]; velocity: readonly number[] }): Replay {
  if (replay.checkpoints.at(-1)?.tick !== s.tick) replay.checkpoints.push({ tick: s.tick, position: [s.position[0], s.position[1], s.position[2]], velocity: [s.velocity[0], s.velocity[1], s.velocity[2]] });
  return replay;
}

export interface PracticeReplayMeta {
  /** Store key ("practice:<map>:<savedAt>:<n>"). */
  key: string;
  map: string;
  style: string;
  track: number;
  /** Run time in seconds when it reached the end zone; null for an attempt kept before it finished. */
  time: number | null;
  /** The run timer's time when it was kept unfinished (null: the timer wasn't running). */
  at: number | null;
  /** Checkpoint teleports on its path (the replay's segment loads). */
  teleports: number;
  savedAt: number;
  bytes: number;
}

/**
 * At most `perMap` on one map and `total` on this device, holding at most `bytes` together; one replay over
 * `maxBytes` (the server's replay size limit, apps/api/src/replay-io.ts MAX_REPLAY_BYTES) isn't kept.
 */
export const PRACTICE_REPLAY_CAPS = { perMap: 20, total: 100, bytes: 64 << 20, maxBytes: 8 << 20 };
export type PracticeReplayCaps = typeof PRACTICE_REPLAY_CAPS;

export const PRACTICE_KEY_PREFIX = "practice:";
export const isPracticeReplayKey = (key: string): boolean => key.startsWith(PRACTICE_KEY_PREFIX);

/**
 * The practice replays to drop so `list` (newest last) fits the caps: the oldest first, on the same map first when that
 * map is over its own cap. The newest (just kept) never goes.
 */
export function practiceEvictions(list: readonly PracticeReplayMeta[], caps: PracticeReplayCaps = PRACTICE_REPLAY_CAPS): string[] {
  const keep = [...list].sort((a, b) => a.savedAt - b.savedAt);
  const out: string[] = [];
  const drop = (i: number) => out.push(keep.splice(i, 1)[0].key);
  const newest = keep.at(-1);
  if (newest) {
    const same = () => keep.filter((m) => m.map === newest.map);
    while (same().length > caps.perMap) drop(keep.indexOf(same()[0]));
  }
  const bytes = () => keep.reduce((n, m) => n + m.bytes, 0);
  while (keep.length > 1 && (keep.length > caps.total || bytes() > caps.bytes)) drop(0);
  return out;
}

/** Where the bytes live: pb.ts's IndexedDB store, or a test's map. Keys are only ever "practice:" ones. */
export interface PracticeBytes {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** Where the list lives (localStorage, or a test's string). */
export interface PracticeIndex {
  read(): string | null;
  write(v: string): void;
}

const INDEX_KEY = "bunnyhop:practice-replays";

export class PracticeReplays {
  private list: PracticeReplayMeta[] | null = null;
  private n = 0;
  private listeners = new Set<() => void>();

  constructor(
    private store: PracticeBytes,
    private index: PracticeIndex,
    private caps: PracticeReplayCaps = PRACTICE_REPLAY_CAPS,
    private now: () => number = Date.now,
  ) {}

  private all(): PracticeReplayMeta[] {
    if (this.list) return this.list;
    let v: unknown = null;
    try {
      v = JSON.parse(this.index.read() ?? "[]");
    } catch { /* a broken list starts over */ }
    this.list = Array.isArray(v) ? v.filter((m): m is PracticeReplayMeta => !!m && typeof m.key === "string" && isPracticeReplayKey(m.key) && typeof m.map === "string") : [];
    return this.list;
  }

  private changed(): void {
    try {
      this.index.write(JSON.stringify(this.all()));
    } catch { /* memory still has it */ }
    for (const l of this.listeners) l();
  }

  /** Called after every change (the pause menu redraws). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The practice replays kept for `map`, newest first. */
  forMap(map: string): PracticeReplayMeta[] {
    return this.all().filter((m) => m.map === map).sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Keeps `bytes` (an encoded replay) with what the list shows, dropping the oldest practice replays past the caps.
   * Null when it's over the size limit or couldn't be stored.
   */
  async keep(bytes: Uint8Array, o: Omit<PracticeReplayMeta, "key" | "savedAt" | "bytes">): Promise<PracticeReplayMeta | null> {
    if (bytes.byteLength > this.caps.maxBytes) return null;
    const savedAt = this.now();
    const meta: PracticeReplayMeta = { ...o, key: `${PRACTICE_KEY_PREFIX}${o.map}:${savedAt}:${this.n++}`, savedAt, bytes: bytes.byteLength };
    try {
      await this.store.put(meta.key, bytes);
    } catch {
      return null;
    }
    const list = this.all();
    list.push(meta);
    const gone = new Set(practiceEvictions(list, this.caps));
    this.list = list.filter((m) => !gone.has(m.key));
    this.changed();
    await Promise.all([...gone].map((k) => this.store.delete(k).catch(() => {})));
    return meta;
  }

  /** The replay's bytes, or null (gone: then it leaves the list too). */
  async load(key: string): Promise<Uint8Array | null> {
    if (!isPracticeReplayKey(key)) return null;
    const bytes = await this.store.get(key).catch(() => null);
    if (!bytes) this.forget([key]);
    return bytes;
  }

  /** Removes every practice replay of `map`. */
  async clear(map: string): Promise<void> {
    const keys = this.forMap(map).map((m) => m.key);
    this.forget(keys);
    await Promise.all(keys.map((k) => this.store.delete(k).catch(() => {})));
  }

  private forget(keys: string[]): void {
    const gone = new Set(keys);
    this.list = this.all().filter((m) => !gone.has(m.key));
    this.changed();
  }
}

/** One request on pb.ts's IndexedDB "replays" store (same database and version: no upgrade). */
async function replayStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("bunnyhop", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("replays");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = d.transaction("replays", mode);
      const req = fn(t.objectStore("replays"));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    d.close();
  }
}

/** The bytes in pb.ts's IndexedDB "replays" store; in memory for this page when the browser refuses IndexedDB. */
function deviceBytes(): PracticeBytes {
  const memory = new Map<string, Uint8Array>();
  const own = (key: string) => {
    if (!isPracticeReplayKey(key)) throw new Error(`not a practice replay key: ${key}`);
  };
  return {
    async put(key, bytes) {
      own(key);
      try {
        await replayStore("readwrite", (s) => s.put(bytes, key));
        memory.delete(key);
      } catch {
        memory.set(key, bytes);
      }
    },
    async get(key) {
      own(key);
      const m = memory.get(key);
      if (m) return m;
      const v = await replayStore<unknown>("readonly", (s) => s.get(key)).catch(() => null);
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    },
    async delete(key) {
      own(key);
      memory.delete(key);
      await replayStore("readwrite", (s) => s.delete(key)).catch(() => {});
    },
  };
}

const deviceIndex: PracticeIndex = {
  read: () => localStorage.getItem(INDEX_KEY),
  write: (v) => localStorage.setItem(INDEX_KEY, v),
};

/** This device's practice replays. */
export const practiceReplays = new PracticeReplays(deviceBytes(), deviceIndex);
