// Device-local indicators, scoped by account. Celebration notices use a separate store.
const SEEN = (uid: string) => `bunnyhop:unlocks-seen:${uid}`;
export const FRESH = "bunnyhop:unlocks-fresh";

interface IndicatorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const storage = (): IndicatorStorage | undefined => (globalThis as typeof globalThis & { localStorage?: IndicatorStorage }).localStorage;

export function readSet(key: string): Set<string> | null {
  try {
    const raw = storage()?.getItem(key) ?? null;
    return raw === null ? null : new Set(JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}
export function writeSet(key: string, s: Iterable<string>): void {
  try {
    storage()?.setItem(key, JSON.stringify([...s]));
  } catch {
    /* private mode */
  }
}

/** Owned ids the player hasn't been shown yet. The first call for an account marks what it already owns as seen. */
export function unseen(uid: string, owned: readonly string[]): Set<string> {
  const fresh = readSet(FRESH) ?? new Set<string>();
  let seen = readSet(SEEN(uid));
  if (!seen) {
    seen = new Set(owned.filter((id) => !fresh.has(id)));
    writeSet(SEEN(uid), seen);
  }
  if (fresh.size) {
    try {
      storage()?.removeItem(FRESH);
    } catch {
      /* ignore */
    }
  }
  return new Set(owned.filter((id) => !seen!.has(id)));
}

export function markSeen(uid: string, ids: Iterable<string>): void {
  const seen = readSet(SEEN(uid)) ?? new Set<string>();
  let changed = false;
  for (const id of ids)
    if (!seen.has(id)) {
      seen.add(id);
      changed = true;
    }
  if (changed) writeSet(SEEN(uid), seen);
}
