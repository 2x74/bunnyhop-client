// Spectate a friend from the friends list (social/dock.ts). Only a room has anything to watch: a solo map streams to
// nobody, and a private lobby comes without its id (social.ts publicWhere), so nobody outside it can walk in. A friend
// on a public server: load that room with ?spectate=<their id> (net/presence.ts roomUrl) and net/mp.ts starts watching
// them as soon as the welcome lists them, before your first sample, so you never spawn. A friend in your own room
// (a public server or the same lobby): watch them right there. Leaving is the usual spectate exit: R (or the pause
// menu's Spectate / respawn) respawns you in that room as a player. DOM-free for the tests.

import type { FriendWhere } from "../api";

/** How to watch a friend: in your room, by loading theirs, or not at all. */
export type SpectateHow = { k: "here" } | { k: "go"; id: string; map: string } | null;

/** `inMyRoom`: they're on your room's roster (net/mp.ts canWatch), which also covers the same private lobby. */
export function spectateHow(w: FriendWhere | null, inMyRoom: boolean): SpectateHow {
  if (!w) return null; // offline, or appearing offline
  if (inMyRoom) return { k: "here" };
  if (w.k === "server" && w.map) return { k: "go", id: w.id, map: w.map };
  return null;
}

/** The roster fields the pick below reads (protocol.ts RosterEntry). */
export interface SpecRoster {
  slot: number;
  id: string;
  spec: number | null;
}

/**
 * Whom to watch for `friendId` in a room: their slot; whoever they're watching when they're spectating themselves (a
 * spectator has no body to look at); null when they aren't there (they left, or it's you).
 */
export function spectateSlot(players: readonly SpecRoster[], friendId: string, you: number): number | null {
  const f = players.find((p) => p.id === friendId && p.slot !== you);
  if (!f) return null;
  if (f.spec === null) return f.slot;
  const t = players.find((p) => p.slot === f.spec && p.slot !== you && p.spec === null);
  return t ? t.slot : f.slot;
}
