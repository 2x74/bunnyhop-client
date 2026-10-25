// Map groups on this device: the player's own named lists of maps, in the map list's set menu after Favorites
// (ui/maps.ts). Works like ui/favorites.ts: the account's groups live on the server (apps/api src/map-groups.ts, rules
// in map-groups.ts); this keeps a copy in localStorage so they paint at once and work offline. A change applies to the
// copy right away and is sent a moment later; quick changes go out as one request, and changes the server didn't take
// (offline, API down) are sent on the next page load.
//
// The copy is { user, groups, pending }: `groups` is the server's list as last seen, `pending` the changes not yet
// taken, per group id: a name (a new group, or a rename), a delete, or maps added / removed (map -> in the group). What
// the player sees is the two together. The client makes a new group's id, so a group made offline is the same group
// once it's sent. `user` is the account the copy belongs to (null before the first answer): another account's copy,
// pending changes and all, is dropped when its server list arrives.

import { api, ApiError, type ApiMapGroup, type ApiMapGroupChange } from "../api";
import { cleanGroupName, GROUP_NAME_MAX, MAX_GROUP_CHANGES, MAX_GROUP_MAP_CHANGES, MAX_GROUP_MAPS, MAX_MAP_GROUPS, newGroupId, sameGroupName } from "../map-groups";
import { toast } from "../notify";
import { me } from "./account-state";

const KEY = "bunnyhop:map-groups";
const EVENT = "bunnyhop:map-groups";
/** Wait after a change before sending, so a run of changes goes out as one request. */
const SEND_MS = 600;

interface Change {
  name?: string;
  delete?: true;
  maps: Record<string, boolean>;
  /** An Undo of a delete: the whole group is sent (name and every map), not the difference from the server's copy,
   *  because the delete may already be on its way and the server's copy is about to lose the group. */
  restore?: true;
}

interface Copy {
  user: string | null;
  groups: ApiMapGroup[];
  pending: Record<string, Change>;
}

export interface MapGroupView {
  id: string;
  name: string;
  maps: Set<string>;
}

function read(): Copy {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Copy> | null;
    const groups = Array.isArray(v?.groups)
      ? v.groups.filter((g) => g && typeof g.id === "string" && typeof g.name === "string" && Array.isArray(g.maps)).map((g) => ({ id: g.id, name: g.name, maps: g.maps.filter((m) => typeof m === "string") }))
      : [];
    const pending: Record<string, Change> = {};
    for (const [id, c] of Object.entries(v?.pending && typeof v.pending === "object" ? v.pending : {})) {
      if (!c || typeof c !== "object") continue;
      pending[id] = {
        ...(typeof c.name === "string" ? { name: c.name } : {}),
        ...(c.delete === true ? { delete: true as const } : {}),
        ...(c.restore === true ? { restore: true as const } : {}),
        maps: Object.fromEntries(Object.entries(c.maps && typeof c.maps === "object" ? c.maps : {}).filter(([, on]) => typeof on === "boolean")),
      };
    }
    return { user: typeof v?.user === "string" ? v.user : null, groups, pending };
  } catch {
    return { user: null, groups: [], pending: {} };
  }
}

let copy = read();
let shown = view(copy);

function view(c: Copy): MapGroupView[] {
  const out = new Map<string, MapGroupView>(c.groups.map((g) => [g.id, { id: g.id, name: g.name, maps: new Set(g.maps) }]));
  for (const [id, ch] of Object.entries(c.pending)) {
    if (ch.delete) {
      out.delete(id);
      continue;
    }
    let g = out.get(id);
    if (!g && ch.name !== undefined) out.set(id, (g = { id, name: ch.name, maps: new Set() }));
    if (!g) continue;
    if (ch.name !== undefined) g.name = ch.name;
    for (const [m, on] of Object.entries(ch.maps)) on ? g.maps.add(m) : g.maps.delete(m);
  }
  return [...out.values()];
}

/** `server`: the groups themselves changed (a sync), not just a change this page made. */
function save(server: boolean): void {
  shown = view(copy);
  try {
    localStorage.setItem(KEY, JSON.stringify(copy));
  } catch {
    /* storage blocked: this page still has them */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { server } }));
}

const onServer = (id: string) => copy.groups.find((g) => g.id === id);
/** Changes sent and not answered yet. A new change to the same name or map is kept pending as it is, even when it
 *  matches the server's last list or what's on its way: the view is that list plus pending, and the answer clears
 *  what it took (an Undo's restore on its way, then a map unticked, must still send the untick). */
let inflight: Record<string, Change> = {};
/** A send that wasn't taken and will be retried: put back what it carried, unless the player changed it since. */
function unsent(sent: Record<string, Change>): void {
  for (const [id, s] of Object.entries(sent)) {
    const c = (copy.pending[id] ??= { maps: {} });
    if (c.delete) continue;
    if (s.delete) {
      if (c.name === undefined && !Object.keys(c.maps).length) copy.pending[id] = { delete: true, maps: {} };
      continue;
    }
    if (s.name !== undefined && c.name === undefined) c.name = s.name;
    if (s.restore) c.restore = true;
    for (const [m, on] of Object.entries(s.maps)) if (!(m in c.maps)) c.maps[m] = on;
    tidy(id);
  }
}
const change = (id: string): Change => (copy.pending[id] ??= { maps: {} });
/** Drops a group's pending change when nothing is left in it. */
function tidy(id: string): void {
  const c = copy.pending[id];
  if (c && c.name === undefined && !c.delete && !Object.keys(c.maps).length) delete copy.pending[id];
}
function changed(): void {
  save(false);
  schedule();
}

/** The player's groups, oldest first. */
export function mapGroups(): readonly MapGroupView[] {
  return shown;
}

export function mapGroup(id: string): MapGroupView | null {
  return shown.find((g) => g.id === id) ?? null;
}

/** What's wrong with `raw` as a name for a new group (or for group `id`, renamed), or null when it's fine. */
export function groupNameProblem(raw: string, id: string | null = null): string | null {
  const name = cleanGroupName(raw);
  if (!name) return raw.trim() ? `Names are up to ${GROUP_NAME_MAX} characters of plain text.` : "Type a name.";
  if (shown.some((g) => g.id !== id && sameGroupName(g.name, name))) return "You already have a group with that name.";
  return null;
}

/** Makes a group holding `maps`; its id, or null when the player has the most groups (they're told). */
export function createGroup(rawName: string, maps: string[] = []): string | null {
  const name = cleanGroupName(rawName);
  if (!name) return null;
  if (shown.length >= MAX_MAP_GROUPS) {
    toast(`You can have up to ${MAX_MAP_GROUPS} groups.`);
    return null;
  }
  const id = newGroupId();
  copy.pending[id] = { name, maps: Object.fromEntries(maps.map((m) => [m, true])) };
  changed();
  return id;
}

export function renameGroup(id: string, rawName: string): void {
  const name = cleanGroupName(rawName);
  if (!name || !mapGroup(id)) return;
  const c = change(id);
  // Back to the server's name: nothing to send (a group made on this page, or put back by Undo, keeps its name: that's
  // its creation).
  if (inflight[id]?.name === undefined && onServer(id)?.name === name && !c.restore) delete c.name;
  else c.name = name;
  tidy(id);
  changed();
}

/** Adds a map to a group or takes it out. False when the group is full (nothing changes; the player is told). */
export function setInGroup(id: string, map: string, on: boolean): boolean {
  const g = mapGroup(id);
  if (!g) return false;
  if (on === g.maps.has(map)) return true;
  if (on && g.maps.size >= MAX_GROUP_MAPS) {
    toast(`A group holds up to ${MAX_GROUP_MAPS} maps.`);
    return false;
  }
  const c = change(id);
  // Back to what the server has: nothing left to send for this map. Not while a change to it is on its way (kept until
  // the answer clears it), and a group put back by Undo sends all of its maps.
  if (!(map in (inflight[id]?.maps ?? {})) && on === (onServer(id)?.maps.includes(map) ?? false) && !(c.restore && on)) delete c.maps[map];
  else c.maps[map] = on;
  tidy(id);
  changed();
  return true;
}

/** Deletes a group; what it was, for restoreGroup (Undo). */
export function deleteGroup(id: string): ApiMapGroup | null {
  const g = mapGroup(id);
  if (!g) return null;
  // Sent even for a group this page made: its creation may be on its way (the server ignores an unknown id).
  copy.pending[id] = { delete: true, maps: {} };
  changed();
  return { id, name: g.name, maps: [...g.maps] };
}

/**
 * Puts a deleted group back as it was (same id: made again if the delete went through). The whole group is sent, not
 * the difference from the server's copy: the delete may already be on its way, and comparing with the copy from before
 * it would send nothing and lose the group when the delete's answer arrives. Sending what the server already has
 * writes nothing there.
 */
export function restoreGroup(g: ApiMapGroup): void {
  if (mapGroup(g.id)) return;
  const server = onServer(g.id);
  const c: Change = { name: g.name, restore: true, maps: {} };
  for (const m of g.maps) c.maps[m] = true;
  for (const m of server?.maps ?? []) if (!g.maps.includes(m)) c.maps[m] = false;
  copy.pending[g.id] = c;
  changed();
}

/** Runs fn after each change while `owner` is in the document; `server` as in save(). */
export function onMapGroupsChange(owner: Element, fn: (server: boolean) => void): void {
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

/** Once per page (the map list calls it when it opens): the account's groups, with this device's changes sent first. */
export function syncMapGroups(): void {
  if (synced || !api.available()) return;
  synced = true;
  busy = busy.then(send);
}

/** What goes out next: at most what one request may carry (the rest waits for the next one). */
function outgoing(): Record<string, Change> {
  const out: Record<string, Change> = {};
  for (const [id, c] of Object.entries(copy.pending).slice(0, MAX_GROUP_CHANGES)) {
    const on = Object.entries(c.maps).filter(([, v]) => v).slice(0, MAX_GROUP_MAP_CHANGES);
    const off = Object.entries(c.maps).filter(([, v]) => !v).slice(0, MAX_GROUP_MAP_CHANGES);
    out[id] = { ...c, maps: Object.fromEntries([...on, ...off]) };
  }
  return out;
}

function body(sent: Record<string, Change>): ApiMapGroupChange[] {
  return Object.entries(sent).map(([id, c]): ApiMapGroupChange => {
    if (c.delete) return { id, delete: true };
    const maps = Object.entries(c.maps);
    return {
      id,
      ...(c.name !== undefined ? { name: c.name } : {}),
      add: maps.filter(([, on]) => on).map(([m]) => m),
      remove: maps.filter(([, on]) => !on).map(([m]) => m),
    };
  });
}

async function send(): Promise<void> {
  const u = await me();
  if (!u || api.meStale()) return;
  if (copy.user !== u.id) {
    // Never synced (changes made before the first answer are this player's) or another account's copy (dropped).
    if (copy.user) copy = { user: u.id, groups: [], pending: {} };
    copy.user = u.id;
  }
  const sent = outgoing();
  inflight = sent;
  try {
    copy.groups = Object.keys(sent).length ? await api.saveMapGroups(u.id, body(sent)) : await api.mapGroups();
    inflight = {};
    // Taken. What changed again meanwhile stays pending.
    for (const [id, s] of Object.entries(sent)) {
      const c = copy.pending[id];
      if (!c) continue;
      if (s.delete) {
        if (c.delete) delete copy.pending[id];
        continue;
      }
      if (s.name !== undefined && c.name === s.name) delete c.name;
      for (const [m, on] of Object.entries(s.maps)) if (c.maps[m] === on) delete c.maps[m];
      if (c.name === undefined) delete c.restore;
      tidy(id);
    }
  } catch (e) {
    inflight = {};
    if (!(e instanceof ApiError) || e.status === 401 || e.status === 429) {
      // Kept, sent with the next change or page.
      unsent(sent);
      save(false);
      return;
    }
    // Refused for good (full, a bad name): what the server has wins. (wrong_account: the session changed under this
    // page; the next page load reads the new account's groups.)
    if (e.code === "groups_full") toast(`You can have up to ${MAX_MAP_GROUPS} groups.`);
    if (e.code === "group_full") toast(`A group holds up to ${MAX_GROUP_MAPS} maps.`);
    copy.pending = {};
    if (e.code !== "wrong_account") copy.groups = await api.mapGroups().catch(() => copy.groups);
  }
  save(true);
  if (Object.keys(copy.pending).length) schedule();
}
