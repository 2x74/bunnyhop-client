// Playing a set in order: the map list's "Play … in order" (ui/maps.ts) on a group or Favorites takes the set's maps in
// the list's order, from the selected map to the last, and queue-mode.ts loads the next one after each finish. DOM-free.
//
// Kept in sessionStorage (this tab): a reload, or the next map's page, carries on. Any other page (another map, the main
// menu, a room, a replay, a gauntlet) ends it: settleQueue() at page load keeps it only on the map it's waiting for.
// Every map is played, done or not; only a finish moves the queue on.

export interface MapQueue {
  /** The map list's set value ("favorites", "group:<id>"): the list's menu stops the queue it started. */
  set: string;
  /** The set's name as the player knows it ("Warmups", "Favorites"). */
  name: string;
  /** The set's maps, in the list's order when it started. */
  maps: string[];
  /** The map being played. */
  at: number;
}

/** The finish card's wait before the next map loads (Enter goes at once; a restart stays). */
export const NEXT_MAP_MS = 3000;

const KEY = "bunnyhop:map-queue";

/** sessionStorage's part we use (structural, so tests need no DOM). */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStore(): Store | null {
  try {
    return (globalThis as { sessionStorage?: Store }).sessionStorage ?? null;
  } catch {
    return null; // storage blocked: no queue
  }
}

export function readQueue(store: Store | null = sessionStore()): MapQueue | null {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? "null") as Partial<MapQueue> | null;
    if (!v || typeof v.set !== "string" || typeof v.name !== "string" || !Array.isArray(v.maps) || !v.maps.every((m) => typeof m === "string")) return null;
    if (typeof v.at !== "number" || !Number.isInteger(v.at) || v.at < 0 || v.at >= v.maps.length) return null;
    return { set: v.set, name: v.name, maps: v.maps, at: v.at };
  } catch {
    return null;
  }
}

function write(q: MapQueue | null, store: Store | null): void {
  try {
    if (q) store?.setItem(KEY, JSON.stringify(q));
    else store?.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

/** Starts playing `maps` in order from `from` (the first map when it isn't one of them). Null when there are none. */
export function startQueue(set: string, name: string, maps: readonly string[], from: string | null, store: Store | null = sessionStore()): MapQueue | null {
  if (!maps.length) return null;
  const q: MapQueue = { set, name, maps: [...maps], at: Math.max(0, from ? maps.indexOf(from) : 0) };
  write(q, store);
  return q;
}

export function stopQueue(store: Store | null = sessionStore()): void {
  write(null, store);
}

/** At page load: the queue goes on only on the map it's waiting for (`map`: the page's map, null for anything else). */
export function settleQueue(map: string | null, store: Store | null = sessionStore()): MapQueue | null {
  const q = readQueue(store);
  if (q && map !== null && q.maps[q.at] === map) return q;
  if (q) stopQueue(store);
  return null;
}

/** The map is done: the next one becomes the queue's map (its name), or the queue ends after the last one (null). */
export function advanceQueue(store: Store | null = sessionStore()): string | null {
  const q = readQueue(store);
  if (!q) return null;
  if (q.at + 1 >= q.maps.length) {
    stopQueue(store);
    return null;
  }
  write({ ...q, at: q.at + 1 }, store);
  return q.maps[q.at + 1];
}

/** "Warmups · 3 of 8". */
export function queueLine(q: MapQueue): string {
  return `${q.name} · ${q.at + 1} of ${q.maps.length}`;
}

/** The finish card's line once the map is done. */
export function doneLine(q: MapQueue): string {
  const next = q.maps[q.at + 1];
  return next ? `${queueLine(q)} done. ${next} is next.` : `${queueLine(q)} done. That was the last one.`;
}

/** What a finish on the queue's map is, as queue-mode.ts sees it. */
export interface QueueFinish {
  track: number;
  /** A practice run (practice mode, third person, a lesson, the debug hook). */
  practice: boolean;
  multiplayer: boolean;
  /** A !race duel on the board. */
  racing: boolean;
  gauntlet: boolean;
  /** The submission's status (hud.ts SubmissionView), and its code when refused. */
  status: string;
  code?: string;
}

/**
 * Whether the finish moves the queue on: "go", "wait" (still uploading: the next page would cut the upload off) or
 * "no". Only a run on the main track that counts: never in a room, a race, a gauntlet or practice. A run the server
 * refused stays (the card says why); one it can't take yet (offline, kept on this device) goes on, like an unranked map.
 */
export function finishMoves(f: QueueFinish): "go" | "wait" | "no" {
  if (f.track !== 0 || f.practice || f.multiplayer || f.racing || f.gauntlet) return "no";
  if (f.status === "submitting") return "wait";
  if (f.status === "rejected") return f.code === "unranked_map" ? "go" : "no";
  return "go";
}
