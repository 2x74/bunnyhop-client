// The Play online list as data (no DOM, so tests import it; ui/servers.ts draws it): the order of the rooms, and who a
// row lists.
//
// Order (roomOrder), decided once when the list first arrives and kept while the screen is up, so a row never moves
// under the pointer:
//   1. rooms with someone in them and a free slot, then full rooms, then empty ones. Your run is timed on your own
//      machine, so a far room with people in it is a better place to be than a near one with nobody; and with a few
//      rooms and few players, sending everyone to their nearest room would leave every room looking empty;
//   2. among those, your nearer region first (nearRegion);
//   3. then the fuller room, then the server's own order.
//
// Who a row lists: the players come from GET /servers
// `who`: everyone in the room, each as its scoreboard shows them to the others (apps/api/src/rooms/who.ts).
//   - In the room's order (first to join first), so a refresh never shuffles the list.
//   - A wide window lists everyone in a public room; a phone lists the first WHO_NARROW and "+N more", which opens the
//     rest in place.
//   - In the room you're in, your own entry is the one your client has of you (the room's roster), since the room may
//     show you more of yourself than it shows the others.

import type { ListingPerson, ServerListing } from "../api";
import type { RosterPlayer } from "../net/protocol";

/** Players listed before "+N more": on a wide window (a full public room and its supporter slot), and on a phone. */
export const WHO_WIDE = 24;
export const WHO_NARROW = 6;

export interface WhoView {
  shown: ListingPerson[];
  /** Players the row doesn't show: past the cap, or past what the server listed. */
  more: number;
  /** "+N more" opens the rest (false: the server didn't list them). */
  canOpen: boolean;
}

/**
 * What the row lists; null when there's no list to show (offline, nobody there, or an API from before the list, whose
 * rows still have their count).
 */
export function whoView(s: Pick<ServerListing, "players" | "who">, o: { cap: number; open?: boolean; self?: RosterPlayer | null }): WhoView | null {
  if (!s.who?.length) return null;
  const all = s.who.map((p) => (o.self && p.id === o.self.id ? ownEntry(p, o.self) : p));
  // Never "+1 more": the line would take the room of the player it hides.
  const shown = o.open || all.length <= o.cap + 1 ? all : all.slice(0, Math.max(1, o.cap));
  return { shown, more: Math.max(0, Math.max(s.players, all.length) - shown.length), canOpen: shown.length < all.length };
}

/** Your own entry in the room you're in: the listed one (it has your picture) with your client's view of your marks. */
export function ownEntry(listed: ListingPerson, me: RosterPlayer): ListingPerson {
  const { id, name, avatarUrl } = listed;
  return {
    id,
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
    staff: me.staff,
    verified: me.verified,
    creator: me.creator,
    booster: me.booster,
    supporter: me.supporter,
    special: me.special,
    nameBadges: me.nameBadges,
    giftsSent: me.giftsSent,
    gifterColors: me.gifterColors,
    gifterAnimated: me.gifterAnimated,
    nameColor: me.nameColor,
    nameEffect: me.nameEffect,
    nameColor2: me.nameColor2,
    nameFont: me.nameFont,
    nameStyle: me.nameStyle,
    avatarDeco: me.avatarDeco,
  };
}

/** A stable key for a listed player as drawn: the same key means the same element can stay on screen. */
export const whoKey = (p: ListingPerson): string => JSON.stringify(p);

/** "+14 more" */
export const moreLabel = (n: number): string => `+${n} more`;

// ---------------------------------------------------------------------------------------------
// Order

/**
 * Roughly where a region's rooms are, as hours from UTC (the names are the API's: apps/api/src/rooms/config.ts
 * REGION). Only for a first guess at the nearer region from the player's own clock; a region that isn't here is never
 * guessed nearer.
 */
const REGION_UTC: Record<string, number> = { "US West": -8, "US East": -5, "South America": -3, "EU West": 1, "EU East": 2, Africa: 2, "Middle East": 3, Asia: 8, Oceania: 10 };

/** Hours between two clocks, the short way round. */
const clockGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

/**
 * The region nearest the player, without asking them anything: the one whose rooms answered fastest the last time the
 * list measured (`measured`, remembered by the screen), else the one whose clock is closest to theirs (`utcHours`:
 * their offset from UTC). null: one region, or nothing to go on.
 */
export function nearRegion(regions: readonly string[], o: { utcHours: number; measured?: string | null }): string | null {
  const all = [...new Set(regions)];
  if (all.length < 2) return null;
  if (o.measured && all.includes(o.measured)) return o.measured;
  const known = all.filter((r) => r in REGION_UTC);
  if (!known.length || !Number.isFinite(o.utcHours)) return null;
  return known.reduce((best, r) => (clockGap(REGION_UTC[r], o.utcHours) < clockGap(REGION_UTC[best], o.utcHours) ? r : best));
}

/** The region whose rooms answered fastest (the lowest ping of any of its rooms); null until one has. */
export function fastestRegion(rows: readonly Pick<ServerListing, "id" | "region">[], pings: ReadonlyMap<string, number | null>): string | null {
  let best: { region: string; ms: number } | null = null;
  for (const s of rows) {
    const ms = pings.get(s.id);
    if (typeof ms === "number" && (!best || ms < best.ms)) best = { region: s.region, ms };
  }
  return best?.region ?? null;
}

/** The rooms' ids in the order the list shows them (see the header). */
export function roomOrder(rows: readonly Pick<ServerListing, "id" | "region" | "online" | "players" | "maxPlayers">[], near: string | null): string[] {
  const group = (s: (typeof rows)[number]) => (!s.online ? 3 : !s.players ? 2 : s.players >= s.maxPlayers ? 1 : 0);
  return rows
    .map((s, i) => ({ s, i }))
    .sort((a, b) => group(a.s) - group(b.s) || Number(b.s.region === near) - Number(a.s.region === near) || b.s.players - a.s.players || a.i - b.i)
    .map((x) => x.s.id);
}

/**
 * Under the list while every room is empty: why being first is worth it (Home's Play online button counts everyone in
 * a public room, as "1 playing", for everybody).
 */
export const ALL_EMPTY = "No one is in a public room right now. Join one and everyone's menu shows 1 playing.";
