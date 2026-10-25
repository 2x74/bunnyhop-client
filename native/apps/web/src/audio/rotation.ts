// The music rotation (music.ts): every track once in a shuffled order, then a fresh order, never the same track twice
// in a row (also across reshuffles and reloads). The order and the place in it are kept in localStorage, so a reload
// moves on to the next track instead of starting the same song every time. DOM-free (unit tests: test/music.test.ts).

export interface RotationStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Saved {
  order: string[];
  i: number;
  shuffle?: boolean;
}

export const ROTATION_KEY = "bunnyhop:music";

export class Rotation {
  private order: string[] = [];
  /** Index of the track playing (or last played) in `order`; -1 before the first. */
  private i = -1;
  private shuffle = true;

  constructor(
    private ids: string[],
    private store: RotationStore | null = null,
    private random: () => number = Math.random,
    /** Played first on a device with no saved rotation (the menu track). */
    private first: string | null = null,
  ) {
    this.restore();
  }

  /** The track playing, or last played (also across reloads), if any. */
  get current(): string | null {
    return this.order[this.i] ?? null;
  }

  setShuffle(on: boolean): void {
    if (on === this.shuffle) return;
    this.shuffle = on;
    // A new round from here: shuffled (not starting with the track playing) or in order after it.
    this.order = this.fresh(this.current);
    this.i = -1;
    this.save();
  }

  /** Moves to the next track that `accept` allows (all by default) and returns it; null if none is allowed. */
  next(accept: (id: string) => boolean = () => true): string | null {
    if (!this.ids.some(accept)) return null;
    // The track that played last (tracks skipped by `accept` below don't count): a new round never starts with it.
    const last = this.current;
    for (let guard = 0; guard < this.ids.length * 2 + 2; guard++) {
      if (this.i + 1 >= this.order.length) {
        this.order = this.fresh(last, accept);
        this.i = -1;
      }
      const id = this.order[++this.i];
      if (id && accept(id)) {
        this.save();
        return id;
      }
    }
    return null;
  }

  /** Moves back to the track before the current one (in this round) that `accept` allows; null at the start. */
  prev(accept: (id: string) => boolean = () => true): string | null {
    for (let j = this.i - 1; j >= 0; j--) {
      if (!accept(this.order[j])) continue;
      this.i = j;
      this.save();
      return this.order[j];
    }
    return null;
  }

  /** A new round: every track once; it never starts (counting only tracks `accept` allows) with `last`. */
  private fresh(last: string | null, accept: (id: string) => boolean = () => true): string[] {
    const o = [...this.ids];
    if (this.shuffle) {
      for (let k = o.length - 1; k > 0; k--) {
        const j = Math.floor(this.random() * (k + 1));
        [o[k], o[j]] = [o[j], o[k]];
      }
    } else if (last) {
      // In order, the round continues after `last`.
      const at = o.indexOf(last);
      if (at >= 0) o.push(...o.splice(0, at + 1));
    }
    const a = o.findIndex(accept);
    const b = a < 0 ? -1 : o.findIndex((id, k) => k > a && accept(id));
    if (b > 0 && o[a] === last) [o[a], o[b]] = [o[b], o[a]];
    return o;
  }

  private restore(): void {
    let s: Saved | null = null;
    try {
      const raw = this.store?.getItem(ROTATION_KEY);
      s = raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      s = null;
    }
    const valid = !!s && Array.isArray(s.order) && typeof s.i === "number" && s.order.length === this.ids.length && this.ids.every((id) => s!.order.includes(id));
    if (s && typeof s.shuffle === "boolean") this.shuffle = s.shuffle;
    if (valid) {
      this.order = s!.order;
      this.i = Math.max(-1, Math.min(this.order.length - 1, Math.floor(s!.i)));
      return;
    }
    // Tracks were added or removed (or nothing saved yet): a new round, still never repeating the last one played.
    const last = s && Array.isArray(s.order) && typeof s.i === "number" ? (s.order[s.i] ?? null) : null;
    this.order = this.fresh(last && this.ids.includes(last) ? last : null);
    if (!s && this.first && this.ids.includes(this.first)) {
      this.order.splice(this.order.indexOf(this.first), 1);
      this.order.unshift(this.first);
    }
    this.i = -1;
  }

  private save(): void {
    try {
      this.store?.setItem(ROTATION_KEY, JSON.stringify({ order: this.order, i: this.i, shuffle: this.shuffle } satisfies Saved));
    } catch {
      /* private mode / quota */
    }
  }
}
