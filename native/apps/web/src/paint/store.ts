// Paint kept on this device, per map (localStorage). One key per map, { sha, marks }: a rebuilt BSP (another sha)
// starts clean instead of leaving marks in the air. An index keeps the PAINT_MAPS most recently painted maps; older
// ones are removed. Marks never expire otherwise: they stay until !clearpaint or the map's BSP changes.
import { PAINT_COLORS, PAINT_SIZES } from "./prefs";

/** m: the brush model the mark sits on, with p / n in that mesh's local space; -1: any other mesh, p / n in world space.
 * c / s: indexes into PAINT_COLORS / PAINT_SIZES. */
export interface SavedMark {
  m: number;
  p: [number, number, number];
  n: [number, number, number];
  c: number;
  s: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PAINT_MAPS = 40;
export const PAINT_SAVE_MARKS = 256;
const INDEX = "bunnyhop:paint";
const keyFor = (map: string) => `bunnyhop:paint:${map}`;
const SIZES = Object.keys(PAINT_SIZES).length;

function defaultStore(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
}

const vec = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

function validMark(v: unknown): v is SavedMark {
  const o = v as SavedMark | null;
  return !!o && typeof o === "object" && Number.isInteger(o.m) && o.m >= -1 && vec(o.p) && vec(o.n) &&
    Number.isInteger(o.c) && o.c >= 0 && o.c < PAINT_COLORS.length && Number.isInteger(o.s) && o.s >= 0 && o.s < SIZES;
}

const round = (v: readonly number[], k: number): [number, number, number] =>
  [Math.round(v[0] * k) / k, Math.round(v[1] * k) / k, Math.round(v[2] * k) / k];

export class PaintStore {
  constructor(private readonly store: KeyValueStore | null = defaultStore()) {}

  private index(): string[] {
    try {
      const v = JSON.parse(this.store?.getItem(INDEX) ?? "null") as unknown;
      return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
    } catch {
      return [];
    }
  }

  private setIndex(maps: string[]): void {
    try {
      if (maps.length) this.store?.setItem(INDEX, JSON.stringify(maps));
      else this.store?.removeItem(INDEX);
    } catch { /* full or blocked */ }
  }

  private drop(map: string): void {
    try { this.store?.removeItem(keyFor(map)); } catch { /* blocked */ }
  }

  /** The marks saved for this build of `map`, oldest first. Anything malformed is skipped; another build's are removed. */
  load(map: string, sha: string): SavedMark[] {
    let v: { sha?: unknown; marks?: unknown } | null = null;
    try {
      v = JSON.parse(this.store?.getItem(keyFor(map)) ?? "null");
    } catch { /* corrupt: treated as none */ }
    if (!v || typeof v !== "object") return [];
    if (v.sha !== sha) {
      this.clear(map);
      return [];
    }
    return Array.isArray(v.marks) ? v.marks.filter(validMark).slice(-PAINT_SAVE_MARKS) : [];
  }

  /** Replaces `map`'s saved marks; none clears them. When storage is full, the least recently painted maps make room. */
  save(map: string, sha: string, marks: readonly SavedMark[]): void {
    if (!this.store) return;
    if (!marks.length) return this.clear(map);
    const body = JSON.stringify({ sha, marks: marks.slice(-PAINT_SAVE_MARKS).map((m) => ({ ...m, p: round(m.p, 100), n: round(m.n, 1e4) })) });
    const maps = [map, ...this.index().filter((m) => m !== map)];
    while (maps.length > PAINT_MAPS) this.drop(maps.pop()!);
    for (;;) {
      try {
        this.store.setItem(keyFor(map), body);
        break;
      } catch {
        if (maps.length <= 1) break; // still full: the copy saved before stays
        this.drop(maps.pop()!);
      }
    }
    this.setIndex(maps);
  }

  clear(map: string): void {
    this.drop(map);
    const maps = this.index();
    if (maps.includes(map)) this.setIndex(maps.filter((m) => m !== map));
  }
}
