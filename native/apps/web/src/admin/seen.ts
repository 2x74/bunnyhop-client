// Unread, as a watermark (research/ADMIN-UPLIFT.md, after T3 Code's thread visits): per staff member and per thread, the
// last time they looked at it. A thread is unread when its newest activity from the other side (the player writing,
// a new flag) is newer than that. Opening a thread, or replying and commenting on it, moves the mark; nothing is
// written per message. Kept in this browser (localStorage, one key per staff member); a staff member's first visit
// sets a baseline so the history before it reads as seen.

import { me } from "./core";

type Kind = "ac" | "report";
interface Store {
  /** Everything before this reads as seen. */
  since: number;
  marks: Record<string, number>;
}

const MAX = 1500;
const keyOf = () => `bh_admin_seen_${me?.token ? "token" : (me?.id ?? "anon")}`;
let cache: { key: string; store: Store } | null = null;

function load(): Store {
  const key = keyOf();
  if (cache?.key === key) return cache.store;
  let store: Store | null = null;
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as Store | null;
    if (v && typeof v.since === "number" && v.marks && typeof v.marks === "object") store = v;
  } catch {
    /* private mode, or someone else's shape */
  }
  store ??= { since: Date.now(), marks: {} };
  cache = { key, store };
  if (!localStorage.getItem(key)) save(store);
  return store;
}

function save(s: Store): void {
  const ids = Object.keys(s.marks);
  // The oldest marks go first; a thread older than every kept mark reads as seen through `since`.
  if (ids.length > MAX) {
    const sorted = ids.sort((a, b) => s.marks[a] - s.marks[b]);
    const drop = sorted.slice(0, ids.length - MAX);
    s.since = Math.max(s.since, s.marks[drop[drop.length - 1]]);
    for (const id of drop) delete s.marks[id];
  }
  try {
    localStorage.setItem(keyOf(), JSON.stringify(s));
  } catch {
    /* full or private: the marks last as long as the tab */
  }
}

const id = (kind: Kind, subject: string) => `${kind === "ac" ? "a" : "r"}:${subject}`;

/** When this staff member last looked at the thread (or the baseline). */
export function seenAt(kind: Kind, subject: string): number {
  const s = load();
  return s.marks[id(kind, subject)] ?? s.since;
}

/** Whether activity at `at` (the player's newest message, the newest flag) is newer than their last look. */
export function unread(kind: Kind, subject: string, at: number | null | undefined): boolean {
  return !!at && at > seenAt(kind, subject);
}

/** They looked (or acted) now. */
export function markSeen(kind: Kind, subject: string, at = Date.now()): void {
  const s = load();
  const k = id(kind, subject);
  if ((s.marks[k] ?? s.since) >= at) return;
  s.marks[k] = at;
  save(s);
}

/** Back to unread: the mark goes to just before the activity (T3's "mark unread"). */
export function markUnread(kind: Kind, subject: string, at: number): void {
  const s = load();
  s.marks[id(kind, subject)] = at - 1;
  save(s);
}
