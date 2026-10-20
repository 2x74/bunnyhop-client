import { api, type User } from "./api";

// Personal bests: account-scoped verified snapshots plus device-only attempts and legacy guest records.
// Replay bodies stay in IndexedDB and are recovered from the server only when requested.

export interface PersonalBest {
  map: string;
  /** Device records stay local; account id prevents another account inheriting new records. */
  owner?: string | null;
  mapSha256?: string;
  zonesHash?: string;
  rejected?: boolean;
  previous?: PersonalBest;
  style: string;
  /** 0 = main, N = bonus N (absent in PBs saved before tracks existed = 0). */
  track?: number;
  ticks: number;
  time: number;
  date: number;
  jumps: number;
  strafes: number;
  sync: number;
  /** Stage/checkpoint splits of the PB run: [index, ticks since start]. */
  splits?: [number, number][];
}

const trackKey = (track: number) => (track ? `:b${track}` : "");
const pbKey = (map: string, style: string, track = 0) => `bunnyhop:pb:${map}:${style}${trackKey(track)}`;

/** Parsed PBs by key (the HUD asks every frame); setPB and other tabs' writes (storage events) keep it current. */
const cache = new Map<string, PersonalBest | null>();
if (typeof addEventListener === "function") addEventListener("storage", (e) => cache.clear());

export interface ServerPB extends PersonalBest {
  runId: string;
  mapSha256: string;
  zonesHash: string;
}

let account: string | null = null;
let generation = 0;
let synced = false;
let inFlight: Promise<void> | null = null;
let server = new Map<string, ServerPB>();
const contexts = new Map<string, { mapSha256: string; zonesHash: string }>();
const summaryKey = (id: string) => `bunnyhop:server-pbs:${id}`;
const idOf = (pb: PersonalBest) => pbKey(pb.map, pb.style, pb.track ?? 0);
const changed = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event("bunnyhop:pbs")); };

/** Account lifecycle calls this before starting any request; old responses cannot cross identities. */
export function setPBAccount(user: User | null): void {
  const id = user?.id ?? null;
  if (account === id) return;
  account = id;
  generation++;
  synced = false;
  inFlight = null;
  server.clear();
  try {
    const saved: ServerPB[] = id ? JSON.parse(localStorage.getItem(summaryKey(id)) ?? "[]") : [];
    for (const pb of saved) if (typeof pb.runId === "string") server.set(idOf(pb), pb);
  } catch { /* offline copy unavailable */ }
  changed();
}

export function setPBContext(map: string, mapSha256: string, zonesHash: string): void {
  contexts.set(map, { mapSha256, zonesHash });
  changed();
}
function compatible(pb: PersonalBest): boolean {
  const c = contexts.get(pb.map);
  // Legacy device PBs have no compatibility metadata: keep them usable, as before.
  return !c || ((!pb.mapSha256 || pb.mapSha256 === c.mapSha256) && (!pb.zonesHash || pb.zonesHash === c.zonesHash));
}
export const pbAccount = () => account;
const deviceKey = (map: string, style: string, track: number, owner = account) => `${pbKey(map, style, track)}:owner:${owner ?? "offline"}`;
function localPB(map: string, style: string, track: number): PersonalBest | null {
  const key = deviceKey(map, style, track);
  if (cache.has(key)) return cache.get(key)!;
  try {
    const v = localStorage.getItem(key) ?? localStorage.getItem(deviceKey(map, style, track, null)) ?? localStorage.getItem(pbKey(map, style, track));
    const pb = v ? JSON.parse(v) as PersonalBest : null;
    cache.set(key, pb);
    return pb;
  } catch { return null; }
}
export function getPB(map: string, style: string, track = 0): PersonalBest | null {
  let local = localPB(map, style, track);
  while (local?.rejected) local = local.previous ?? null;
  const l = local && !local.rejected && (local.owner == null || local.owner === account) && compatible(local) ? local : null;
  const remote = server.get(pbKey(map, style, track));
  const r = remote && compatible(remote) ? remote : null;
  return l && (!r || l.ticks < r.ticks) ? l : r ?? l;
}

export function setPB(pb: PersonalBest): void {
  const owner = pb.owner === undefined ? account : pb.owner;
  const key = deviceKey(pb.map, pb.style, pb.track ?? 0, owner);
  let previous = owner === account ? localPB(pb.map, pb.style, pb.track ?? 0) : null;
  while (previous?.rejected) previous = previous.previous ?? null;
  // Bound metadata while retaining the original device fallback after a burst of pending improvements.
  const history: PersonalBest[] = [];
  for (let p = previous; p; p = p.previous ?? null) history.push(p);
  const kept = history.length > 31 ? [...history.slice(0, 30), history.at(-1)!] : history;
  let prior: PersonalBest | undefined;
  for (const entry of kept.reverse()) prior = { ...entry, previous: prior };
  const value = { ...pb, owner, ...contexts.get(pb.map), previous: prior };
  cache.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memory still works */ }
  changed();
}

/** Refusal removes only this attempt from comparisons; its stored summary/replay are retained. */
export function rejectPB(map: string, style: string, track: number, date: number, owner = account): void {
  const key = deviceKey(map, style, track, owner);
  let pb = cache.get(key);
  if (!pb) {
    try { pb = JSON.parse(localStorage.getItem(key) ?? "null") as PersonalBest | null; } catch { return; }
  }
  if (!pb) return;
  let target: PersonalBest | undefined = pb;
  while (target && target.date !== date) target = target.previous;
  if (!target) return;
  target.rejected = true;
  const value = pb;
  // Other scopes may have cached this offline record as their fallback.
  cache.clear();
  cache.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memory still works */ }
  changed();
}

/** A durable upload retry can reject after the original session has gone; match only that account's device attempt. */
export function rejectPBForRun(map: string, style: string, track: number, time: number, owner: string | null): void {
  if (owner !== account) return;
  let pb = localPB(map, style, track);
  while (pb) {
    if (pb.owner === owner && pb.time === time) {
      rejectPB(map, style, track, pb.date, owner);
      return;
    }
    pb = pb.previous ?? null;
  }
}

/** Atomic snapshot: a failed page never replaces a complete offline copy. No uploads happen here. */
export function syncPBs(force = false): Promise<void> {
  if (inFlight) return force ? inFlight.then(() => syncPBs(true)) : inFlight;
  const p = readServerPBs(force);
  inFlight = p;
  void p.finally(() => { if (inFlight === p) inFlight = null; });
  return p;
}
async function readServerPBs(force: boolean): Promise<void> {
  if (!account || !api.available() || (synced && !force)) return;
  const id = account, epoch = generation;
  const found = new Map<string, ServerPB>();
  try {
    let after: string | null = null;
    do {
      const page = await api.personalBests(after);
      if (epoch !== generation || account !== id || page.user !== id) return;
      for (const pb of page.pbs) found.set(idOf(pb), pb);
      if (page.next !== null && (!/^\d+$/.test(page.next) || Number(page.next) <= Number(after ?? 0))) return;
      after = page.next;
    } while (after !== null);
    server = found;
    synced = true;
    try { localStorage.setItem(summaryKey(id), JSON.stringify([...found.values()])); } catch { /* memory still works */ }
    changed();
  } catch { /* keep local and last complete server snapshot offline */ }

}

/** Split times are recovered by the requested ghost's verified simulation, never a bulk replay download. */
export function rememberPBSplits(pb: PersonalBest, splits: [number, number][]): void {
  if (getPB(pb.map, pb.style, pb.track ?? 0) !== pb) return;
  pb.splits = splits;
  if (account && "runId" in pb) {
    try { localStorage.setItem(summaryKey(account), JSON.stringify([...server.values()])); } catch { /* memory still works */ }
  }
}

/** Repaint lists after account hydration without introducing network work into getPB/the frame loop. */
export function onPBChange(owner: Element, fn: () => void): void {
  const handler = () => {
    if (!owner.isConnected) return void window.removeEventListener("bunnyhop:pbs", handler);
    fn();
  };
  window.addEventListener("bunnyhop:pbs", handler);
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bunnyhop", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("replays");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const transaction = d.transaction("replays", mode);
    const req = fn(transaction.objectStore("replays"));
    transaction.oncomplete = () => { d.close(); resolve(req.result); };
    transaction.onerror = () => { d.close(); reject(transaction.error); };
    transaction.onabort = () => { d.close(); reject(transaction.error); };
  });
}

export const replayKey = (map: string, style: string, track = 0) => `pb:${map}:${style}${trackKey(track)}`;

export async function savePBReplay(map: string, style: string, bytes: Uint8Array, track = 0, owner = account, date = localPB(map, style, track)?.date ?? 0): Promise<void> {
  await tx("readwrite", (s) => s.put(bytes, `${replayKey(map, style, track)}:owner:${owner ?? "offline"}:${date}`));
}

export async function loadPBReplay(map: string, style: string, track = 0): Promise<Uint8Array | null> {
  const selected = getPB(map, style, track);
  if (!selected) return null;
  const epoch = generation;
  const remote = "runId" in selected ? selected as ServerPB : null;
  const key = remote ? `server-pb:${remote.runId}` : selected.owner === undefined ? replayKey(map, style, track) : `${replayKey(map, style, track)}:owner:${selected.owner ?? "offline"}:${selected.date}`;
  const stillSelected = () => epoch === generation && getPB(map, style, track) === selected;
  try {
    const v = await tx<unknown>("readonly", (s) => s.get(key));
    const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    if (!stillSelected()) return null;
    if (bytes) return bytes;
  } catch { /* IndexedDB blocked: server replay can still be watched */ }
  if (!remote || !stillSelected()) return null;
  try {
    const bytes = await api.replay(remote.runId);
    if (!stillSelected()) return null;
    await tx("readwrite", (s) => s.put(bytes, key)).catch(() => {});
    return stillSelected() ? bytes : null;
  } catch { return null; }
}

/**
 * Stored PB replays larger than `minBytes`, with their keys (uploads.ts: the legacy retry of pre-v0.0.10 runs over the
 * old upload cap). Walks the store with a cursor, keeping only the large ones.
 */
export async function largePBReplays(minBytes: number): Promise<{ key: string; bytes: Uint8Array }[]> {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const out: { key: string; bytes: Uint8Array }[] = [];
      const req = d.transaction("replays", "readonly").objectStore("replays").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        const v = c.value as unknown;
        const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
        if (bytes && bytes.byteLength > minBytes && typeof c.key === "string" && c.key.startsWith("pb:")) out.push({ key: c.key, bytes });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

export function download(bytes: Uint8Array, name: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

if (typeof window !== "undefined") window.addEventListener("online", () => void syncPBs(true));
