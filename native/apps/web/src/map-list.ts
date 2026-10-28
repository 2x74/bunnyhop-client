// The map list's rules (ui/maps.ts draws the list): which maps a search, tier and set leave on it, the die's random
// pick from them, and the set menu's "done" counts per tier. DOM-free.

export interface ListFilter {
  /** The search, lower case and trimmed ("" = none). */
  q: string;
  /** A tier key ("1" – "7", "x" = unrated) or "all". */
  tier: string;
  /** The map is in the set on show (all maps, Favorites, a group or a collection). */
  inSet: (name: string) => boolean;
  tierKey: (name: string) => string;
}

export interface ListMap {
  name: string;
  title?: string;
  author?: string | null;
}

/** The map stays on the list under the search, the tier and the set. */
export function listed(m: ListMap, f: ListFilter): boolean {
  if (f.q && !`${m.name} ${m.title ?? ""} ${m.author ?? ""}`.toLowerCase().includes(f.q)) return false;
  if (f.tier !== "all" && f.tierKey(m.name) !== f.tier) return false;
  return f.inSet(m.name);
}

/**
 * The die: one of the maps on the list, never the one already selected (unless it's the only one). Null when the list
 * is empty.
 */
export function randomMap(names: readonly string[], selected: string | null, rand: () => number = Math.random): string | null {
  const pool = names.length > 1 ? names.filter((n) => n !== selected) : names;
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] : null;
}

/** A tier key's place in the set menu: T1 to T6, then unrated. */
const TIER_ORDER = ["1", "2", "3", "4", "5", "6", "x"];

/**
 * The set's maps done per tier, for the set menu's "T2 · 34 of 120" lines: tiers with maps in the set only, easiest
 * first, unrated last. `done` is the menu's own "N of M done" rule (a PB in the page's style).
 */
export function doneByTier(names: readonly string[], tierKey: (name: string) => string, done: (name: string) => boolean): { tier: string; done: number; total: number }[] {
  const by = new Map<string, { tier: string; done: number; total: number }>();
  for (const n of names) {
    const tier = tierKey(n);
    const t = by.get(tier) ?? { tier, done: 0, total: 0 };
    t.total++;
    if (done(n)) t.done++;
    by.set(tier, t);
  }
  return [...by.values()].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}
