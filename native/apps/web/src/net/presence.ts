// Which room (if any) this page is playing in. Tiny and DOM-free so online.ts (run submission tags the room) and the
// menus can ask without importing the multiplayer layer. Set by net/mp.ts while connected.

export interface RoomPresence {
  id: string;
  name: string;
}

let current: RoomPresence | null = null;
const listeners = new Set<(r: RoomPresence | null) => void>();

/** Room id runs are submitted from (POST /runs?room=), or null in solo play. */
export function currentRoom(): string | null {
  return current?.id ?? null;
}

export function roomPresence(): RoomPresence | null {
  return current;
}

export function setRoomPresence(r: RoomPresence | null): void {
  current = r;
  for (const l of listeners) l(r);
}

export function onRoomPresence(l: (r: RoomPresence | null) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A finished run's board, for the race tag. */
export interface RunBoard {
  map: string;
  style: string;
  track: number;
}

let raceTag: ((run: RunBoard) => string | null) | null = null;

/** net/race.ts: the live race's id for runs on its board (POST /runs?room=&race=; the room ties them to the race). */
export function setRaceTag(f: ((run: RunBoard) => string | null) | null): void {
  raceTag = f;
}

/** The race a finished run is submitted for, or null (no race live, or another board). */
export function currentRace(run: RunBoard | null | undefined): string | null {
  return run && raceTag ? raceTag(run) : null;
}

/** What the pause menu can do in a room (registered by net/mp.ts while connected). */
export interface RoomActions {
  summary(): {
    id: string;
    name: string;
    map: string;
    tier: number | null;
    players: number;
    max: number;
    timeLeft: string;
    rtv: { count: number; needed: number };
    spectating: boolean;
    status: string;
    /** A private lobby (net/lobby.ts), and whether you're its host. */
    lobby: boolean;
    host: boolean;
  };
  spectate(): void;
  /** Private lobbies: copy the invite link (says so in chat). */
  invite(): void;
  /** Private lobbies, host: pick the next map (!map). */
  changeMap(): void;
  nominate(): void;
  /** !race: the pick menus (net/race.ts). */
  race(): void;
  rtv(): void;
  leave(): void;
  scoreboard(): void;
}

let actions: RoomActions | null = null;

export function registerRoomActions(a: RoomActions | null): void {
  actions = a;
}

export function roomActions(): RoomActions | null {
  return actions;
}

/** URL that plays `map` in room `id` (main.ts loads the map, then net/mp.ts connects). */
export function roomUrl(id: string, map: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("map", map);
  url.searchParams.set("server", id);
  return url.toString();
}
