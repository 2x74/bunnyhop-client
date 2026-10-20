// Favorite maps on this device: the stars in the map list (ui/maps.ts). The account's list lives on the server
// (apps/api src/favorites.ts, rules in favorites.ts); this keeps a copy in localStorage so the stars paint at once and
// work offline. A star changes the copy right away and is sent a moment later; quick toggles go out as one request,
// and changes the server didn't take (offline, API down) are sent on the next page load.
//
// The copy is { user, maps, pending }: `maps` is the server's list as last seen, `pending` the changes not yet taken
// (map -> starred). What the player sees is the two together. `user` is the account the copy belongs to (null before
// the first answer): another account's copy, pending changes and all, is dropped when its server list arrives.

import { api, ApiError } from "../api";
import { MAX_FAVORITES } from "../favorites";
import { toast } from "../notify";
import { me } from "./account-state";

const KEY = "bunnyhop:favorites";
const EVENT = "bunnyhop:favorites";
/** Wait after a star before sending, so a run of toggles goes out as one request. */
const SEND_MS = 600;

interface Copy {
  user: string | null;
  maps: string[];
  pending: Record<string, boolean>;
}

function read(): Copy {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Copy> | null;
    return {
      user: typeof v?.user === "string" ? v.user : null,
      maps: Array.isArray(v?.maps) ? v.maps.filter((m) => typeof m === "string") : [],
      pending: Object.fromEntries(Object.entries(v?.pending && typeof v.pending === "object" ? v.pending : {}).filter(([, on]) => typeof on === "boolean")),
    };
  } catch {
    return { user: null, maps: [], pending: {} };
  }
}

let copy = read();
let shown = view(copy);

function view(c: Copy): Set<string> {
  const s = new Set(c.maps);
  for (const [m, on] of Object.entries(c.pending)) on ? s.add(m) : s.delete(m);
  return s;
}

/** `server`: the list itself changed (a sync), not just a star this page made. */
function save(server: boolean): void {
  shown = view(copy);
  try {
    localStorage.setItem(KEY, JSON.stringify(copy));
  } catch {
    /* storage blocked: this page still has them */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { server } }));
}

export function isFavorite(map: string): boolean {
  return shown.has(map);
}

/** Stars or unstars a map. False when the list is full (nothing changes; the player is told). */
export function setFavorite(map: string, on: boolean): boolean {
  if (on === shown.has(map)) return true;
  if (on && shown.size >= MAX_FAVORITES) {
    toast(`You can star up to ${MAX_FAVORITES} maps.`);
    return false;
  }
  // Back to what the server has: nothing left to send for this map.
  if (on === copy.maps.includes(map)) delete copy.pending[map];
  else copy.pending[map] = on;
  save(false);
  schedule();
  return true;
}

/** Runs fn after each change while `owner` is in the document; `server` as in save(). */
export function onFavoritesChange(owner: Element, fn: (server: boolean) => void): void {
  const handler = (e: Event) => {
    if (!owner.isConnected) return void window.removeEventListener(EVENT, handler);
    fn(!!(e as CustomEvent<{ server: boolean }>).detail?.server);
  };
  window.addEventListener(EVENT, handler);
}

// ---- the server

let timer = 0;
let busy: Promise<void> = Promise.resolve();
let synced = false;

function schedule(): void {
  if (!api.available()) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void (busy = busy.then(send)), SEND_MS);
}

/** Once per page (the map list calls it when it opens): the account's list, with this device's changes sent first. */
export function syncFavorites(): void {
  if (synced || !api.available()) return;
  synced = true;
  busy = busy.then(send);
}

async function send(): Promise<void> {
  const u = await me();
  if (!u || api.meStale()) return;
  if (copy.user !== u.id) {
    // Never synced (changes made before the first answer are this player's) or another account's copy (dropped).
    if (copy.user) copy = { user: u.id, maps: [], pending: {} };
    copy.user = u.id;
  }
  const sent = { ...copy.pending };
  const add = Object.keys(sent).filter((m) => sent[m]);
  const remove = Object.keys(sent).filter((m) => !sent[m]);
  try {
    copy.maps = add.length || remove.length ? await api.saveFavorites(u.id, add, remove) : await api.favorites();
    // Taken (a map the server doesn't know is simply not in its list). A map toggled again meanwhile stays pending.
    for (const [m, on] of Object.entries(sent)) if (copy.pending[m] === on) delete copy.pending[m];
  } catch (e) {
    if (!(e instanceof ApiError) || e.status === 401 || e.status === 429) return; // kept, sent with the next change or page
    // Refused for good (full, a bad name): what the server has wins. (wrong_account: the session changed under this
    // page; the next page load reads the new account's list.)
    if (e.code === "favorites_full") toast(`You can star up to ${MAX_FAVORITES} maps.`);
    copy.pending = {};
    if (e.code !== "wrong_account") copy.maps = await api.favorites().catch(() => copy.maps);
  }
  save(true);
  if (Object.keys(copy.pending).length) schedule();
}
