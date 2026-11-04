// Which room (if any) this page is playing in. Tiny and DOM-free so online.ts (run submission tags the room) and the
// menus can ask without importing the multiplayer layer. Set by net/mp.ts while connected.

import { appHref } from "../platform/navigation";

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

// The room's announcement of a run goes first, then the WR / PB voice. The room plays the voice with its chat line
// (net/mp.ts announce), and the submission poller (online.ts trackVerdict) could see the verdict first: for a run sent
// from a room it waits for the room's line, up to ROOM_LINE_WAIT_MS (a room that doesn't announce it, or is slow).

/** How long a room run's verdict voice waits for the room's line. */
export const ROOM_LINE_WAIT_MS = 3000;
const ROOM_LINES_KEPT = 64;
const roomLines: string[] = [];
const lineWaiters = new Map<string, Set<() => void>>();

/** net/mp.ts: the room's chat line for run `runId` is on screen. */
export function roomLineShown(runId: string): void {
  if (!roomLines.includes(runId)) {
    roomLines.push(runId);
    if (roomLines.length > ROOM_LINES_KEPT) roomLines.shift();
  }
  const w = lineWaiters.get(runId);
  lineWaiters.delete(runId);
  for (const f of w ?? []) f();
}

/**
 * Plays a verified run's voice (`play`) once the room has shown its line, or after `waitMs` without one. At once for a
 * run sent outside a room (`room` null), or when this page has left the room since.
 */
export function voiceAfterRoomLine(runId: string, room: string | null, play: () => void, waitMs = ROOM_LINE_WAIT_MS): void {
  if (!room || currentRoom() !== room || roomLines.includes(runId)) return play();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    lineWaiters.get(runId)?.delete(go);
    if (!lineWaiters.get(runId)?.size) lineWaiters.delete(runId);
    play();
  };
  const timer = setTimeout(go, waitMs);
  const set = lineWaiters.get(runId) ?? new Set();
  set.add(go);
  lineWaiters.set(runId, set);
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
  /** The friends list's Spectate (social/spectate.ts): whether player `id` is in this room (not you), and watching them. */
  canWatch(id: string): boolean;
  watch(id: string): void;
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

/**
 * URL that plays `map` in room `id` (main.ts loads the map, then net/mp.ts connects). `spectate`: a player id to watch
 * on arrival instead of spawning (social/spectate.ts).
 */
export function roomUrl(id: string, map: string, o: { spectate?: string | null } = {}): string {
  const url = new URL(appHref());
  url.search = "";
  url.searchParams.set("map", map);
  url.searchParams.set("server", id);
  if (o.spectate) url.searchParams.set("spectate", o.spectate);
  return url.toString();
}
