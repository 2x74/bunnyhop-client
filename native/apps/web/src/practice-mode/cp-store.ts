// Kept checkpoints (0.0.44, Throw 11-26: "leaving a map also loses them"). A checkpoint lives in the core as a snapshot
// handle (checkpoints.ts) that can't leave the page, so this keeps the light part of each one on this device: where you
// were, the view and the speed, their order and which one was current, per map + style + track. On the way back to the
// map they come back as practice checkpoints (controller.ts): a teleport to one places you there and makes the attempt
// practice, like any checkpoint teleport. Doors, buttons and triggers aren't kept, nor the timer.
// Segmented styles are never kept: their checkpoints are bound to a run (segments.ts).
// localStorage, one item per map + style + track plus a small index for pruning: the least recently used go first
// when there are more than MAX_STORED_KEYS or they hold more than STORED_BUDGET_CHARS. Every access is guarded (private
// mode, quota, blocked storage) and a stored value that doesn't parse is ignored. DOM-free (test/practice-cp-store.test.ts).

import { isSegmented, isStyleId, type StyleId } from "../styles";

/** One kept checkpoint. */
export interface StoredCheckpoint {
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  /** The style the attempt ran in (styles.ts styleForTrack; the key holds the selected one). */
  style: StyleId;
}

export interface StoredCheckpoints {
  list: StoredCheckpoint[];
  /** Index of the current one in `list`. */
  at: number;
}

/** What the store writes to (localStorage, or a stand-in in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

/** The most kept per map + style + track (the newest; bhoptimer's 1000 is the in-page cap). */
export const MAX_STORED_CHECKPOINTS = 200;
/** The most map + style + track lists kept. */
export const MAX_STORED_KEYS = 40;
/** The most characters all kept lists hold (localStorage has about 5 MB per site, shared with settings and the rest). */
export const STORED_BUDGET_CHARS = 512 * 1024;

const PREFIX = "bh.cps.v1:";
const INDEX = "bh.cps.v1.index";
/** Out of the world (noclip.ts WORLD_LIMIT): nothing kept lies past it. */
const WORLD = 16384;
const SPEED = 1e5;

/** The localStorage item of a map + style + track. */
export const storedKey = (map: string, style: StyleId, track: number) => `${PREFIX}${map}|${style}|${track}`;

/** Whether checkpoints in this selected style are kept at all (never Segmented). */
export const keepsCheckpoints = (style: StyleId) => !isSegmented(style);

const num = (v: unknown, limit: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;
const vec = (v: unknown, limit: number): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, limit));
const round = (v: number, places = 1000) => Math.round(v * places) / places;

/** A stored list, or null when it isn't one (corrupt, edited, from another version). */
export function parseStored(text: string | null): StoredCheckpoints | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { list, at } = raw as { list?: unknown; at?: unknown };
  if (!Array.isArray(list) || !list.length || list.length > MAX_STORED_CHECKPOINTS) return null;
  if (!Number.isInteger(at) || (at as number) < 0 || (at as number) >= list.length) return null;
  const out: StoredCheckpoint[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") return null;
    const { p, v, a, s } = c as { p?: unknown; v?: unknown; a?: unknown; s?: unknown };
    if (!vec(p, WORLD) || !vec(v, SPEED) || !Array.isArray(a) || a.length !== 2 || !num(a[0], 360) || !num(a[1], 90) || typeof s !== "string" || !isStyleId(s)) return null;
    out.push({ position: [p[0], p[1], p[2]], velocity: [v[0], v[1], v[2]], yaw: a[0], pitch: a[1], style: s as StyleId });
  }
  return { list: out, at: at as number };
}

/** A list as stored: the newest MAX_STORED_CHECKPOINTS, short numbers. */
export function encodeStored(s: StoredCheckpoints): string | null {
  const drop = Math.max(0, s.list.length - MAX_STORED_CHECKPOINTS);
  const list = s.list.slice(drop);
  if (!list.length) return null;
  const at = Math.max(0, Math.min(list.length - 1, s.at - drop));
  const wrap = (y: number) => ((((y + 180) % 360) + 360) % 360) - 180;
  return JSON.stringify({
    at,
    list: list.map((c) => ({ p: c.position.map((x) => round(x)), v: c.velocity.map((x) => round(x)), a: [round(wrap(c.yaw)), round(Math.max(-90, Math.min(90, c.pitch)))], s: c.style })),
  });
}

type IndexEntry = { k: string; t: number; n: number };

export class CheckpointStore {
  constructor(
    private storage: () => KeyValueStore | null,
    private now: () => number = () => Date.now(),
  ) {}

  /** The kept list of a map + style + track, or null (none, not kept for that style, unreadable). Marks it used. */
  load(map: string, style: StyleId, track: number): StoredCheckpoints | null {
    if (!keepsCheckpoints(style)) return null;
    const st = this.storage();
    if (!st) return null;
    const k = storedKey(map, style, track);
    try {
      const text = st.getItem(k);
      const s = parseStored(text);
      if (!s) {
        if (text !== null) this.drop(st, k); // (corrupt: ignored, and gone so it doesn't come up again)
        return null;
      }
      this.touch(st, k, text!.length);
      return s;
    } catch {
      return null;
    }
  }

  /** Keeps `s` for a map + style + track (an empty list deletes it). The least recently used others go when over the caps. */
  save(map: string, style: StyleId, track: number, s: StoredCheckpoints): boolean {
    if (!keepsCheckpoints(style)) return false;
    const st = this.storage();
    if (!st) return false;
    const k = storedKey(map, style, track);
    const text = encodeStored(s);
    try {
      if (text === null) {
        this.drop(st, k);
        return true;
      }
      if (text.length > STORED_BUDGET_CHARS) return false;
      const index = this.index(st).filter((e) => e.k !== k);
      index.push({ k, t: this.now(), n: text.length });
      this.prune(st, index, k);
      for (;;) {
        try {
          st.setItem(k, text);
          break;
        } catch {
          // Quota: the oldest other list goes, then try again.
          const old = this.oldest(index, k);
          if (!old) return false;
          this.remove(st, index, old);
        }
      }
      this.writeIndex(st, index);
      return true;
    } catch {
      return false;
    }
  }

  /** Deletes the kept list of a map + style + track (Clear all). */
  clear(map: string, style: StyleId, track: number): void {
    const st = this.storage();
    if (!st) return;
    try {
      this.drop(st, storedKey(map, style, track));
    } catch {
      /* blocked storage: nothing kept anyway */
    }
  }

  private drop(st: KeyValueStore, k: string): void {
    st.removeItem(k);
    const index = this.index(st);
    const kept = index.filter((e) => e.k !== k);
    if (kept.length !== index.length) this.writeIndex(st, kept);
  }

  private touch(st: KeyValueStore, k: string, n: number): void {
    const index = this.index(st).filter((e) => e.k !== k);
    index.push({ k, t: this.now(), n });
    this.writeIndex(st, index);
  }

  /** The index, oldest first. Unreadable: rebuilt from the items there are (as old as can be, so they go first). */
  private index(st: KeyValueStore): IndexEntry[] {
    let raw: unknown = null;
    try {
      raw = JSON.parse(st.getItem(INDEX) ?? "null");
    } catch {
      raw = null;
    }
    if (Array.isArray(raw) && raw.every((e) => e && typeof e.k === "string" && e.k.startsWith(PREFIX) && Number.isFinite(e.t) && Number.isFinite(e.n))) {
      return (raw as IndexEntry[]).map((e) => ({ k: e.k, t: e.t, n: e.n })).sort((a, b) => a.t - b.t);
    }
    const out: IndexEntry[] = [];
    if (typeof st.length === "number" && st.key) {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && k.startsWith(PREFIX)) out.push({ k, t: 0, n: st.getItem(k)?.length ?? 0 });
      }
    }
    return out;
  }

  private writeIndex(st: KeyValueStore, index: IndexEntry[]): void {
    if (index.length) st.setItem(INDEX, JSON.stringify(index));
    else st.removeItem(INDEX);
  }

  private oldest(index: IndexEntry[], keep: string): IndexEntry | null {
    let o: IndexEntry | null = null;
    for (const e of index) if (e.k !== keep && (!o || e.t < o.t)) o = e;
    return o;
  }

  private remove(st: KeyValueStore, index: IndexEntry[], e: IndexEntry): void {
    st.removeItem(e.k);
    index.splice(index.indexOf(e), 1);
  }

  /** Least recently used first, never `keep`, until within MAX_STORED_KEYS and STORED_BUDGET_CHARS. */
  private prune(st: KeyValueStore, index: IndexEntry[], keep: string): void {
    const total = () => index.reduce((n, e) => n + e.n, 0);
    while (index.length > MAX_STORED_KEYS || total() > STORED_BUDGET_CHARS) {
      const old = this.oldest(index, keep);
      if (!old) break;
      this.remove(st, index, old);
    }
  }
}

/** This page's localStorage, or null where it can't be used. */
export function pageStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
