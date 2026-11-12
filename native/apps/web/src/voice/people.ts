// Per-player voice choices you made (mute, volume), by account id, remembered in this browser. Client side only: the
// room never knows who you muted. DOM-free apart from localStorage (guarded), so tests can run it.

const KEY = "bunnyhop:voice-people";
const MAX = 500;

interface Entry {
  /** Muted. */
  m?: 1;
  /** Volume 0..2 (1 = as sent). */
  v?: number;
  /** Last changed (ms), to drop the oldest past MAX. */
  t: number;
}

type Store = Record<string, Entry>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

let store: Store | null = null;
const listeners = new Set<() => void>();
const get = () => (store ??= read());

function write(): void {
  const s = get();
  const ids = Object.keys(s);
  if (ids.length > MAX) for (const id of ids.sort((a, b) => s[a].t - s[b].t).slice(0, ids.length - MAX)) delete s[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: this session only */
  }
  for (const l of listeners) l();
}

export const voicePeople = {
  muted(id: string | undefined | null): boolean {
    return !!id && get()[id]?.m === 1;
  },
  volume(id: string | undefined | null): number {
    const v = id ? get()[id]?.v : undefined;
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
  },
  setMuted(id: string, on: boolean): void {
    const e = (get()[id] ??= { t: 0 });
    if (on) e.m = 1;
    else delete e.m;
    e.t = Date.now();
    if (!e.m && e.v === undefined) delete get()[id];
    write();
  },
  setVolume(id: string, v: number): void {
    const e = (get()[id] ??= { t: 0 });
    v = Math.max(0, Math.min(2, v));
    if (Math.abs(v - 1) < 0.001) delete e.v;
    else e.v = v;
    e.t = Date.now();
    if (!e.m && e.v === undefined) delete get()[id];
    write();
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Tests: forget the cached copy. */
  reload(): void {
    store = null;
  },
};
