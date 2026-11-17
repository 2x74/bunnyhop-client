// How this page's room connection has held up: how often it dropped and came back, and how the last one closed.
// DOM-free so the feedback form and a run's diagnostics can read it without the multiplayer layer (net/room.ts
// writes it). A page is one map in a room (a map change loads the next page), so the counts are per map.

export interface RoomClose {
  /** WebSocket close code (1006: the connection died without a close frame). */
  code: number;
  reason?: string;
  /** Date.now() of the close. */
  at: number;
  /** How long that socket had been open (s). */
  ageS: number;
}

export interface RoomHealth {
  /** Times the connection dropped and the client connected again (not counting map changes or leaving). */
  reconnects: number;
  /** The last close the client reconnected after, or null. */
  lastClose: RoomClose | null;
}

const health: RoomHealth = { reconnects: 0, lastClose: null };

export function roomHealth(): Readonly<RoomHealth> {
  return health;
}

/** net/room.ts: a socket closed and the client will connect again. */
export function noteDrop(code: number, reason: string, ageMs: number, at = Date.now()): void {
  health.lastClose = { code, ...(reason ? { reason: reason.slice(0, 60) } : {}), at, ageS: Math.round(ageMs / 1000) };
}

/** net/room.ts: a socket opened again after a drop. */
export function noteReconnect(): void {
  health.reconnects++;
}

/** A run's room connection (apps/api diagnostics.ts `room`): reconnects while it ran, and how the last drop closed. */
export interface RunRoomNet {
  reconnects: number;
  lastClose?: number;
}

/** For a run played in a room (`inRoom`): the reconnects since `reconnectsAt` (the count when it started); else null. */
export function runRoomNet(reconnectsAt: number, inRoom: boolean): RunRoomNet | null {
  if (!inRoom) return null;
  const reconnects = Math.max(0, health.reconnects - reconnectsAt);
  const last = health.lastClose;
  return { reconnects, ...(reconnects && last ? { lastClose: last.code } : {}) };
}
