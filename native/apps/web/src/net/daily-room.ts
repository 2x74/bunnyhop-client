// The Daily room on the client (apps/api src/rooms, a room with mode "daily"): a public room that always plays the
// day's Daily Challenge map, with no votes, nominations or extends, and changes map a little after 16:00 UTC when the
// day does. DOM-free (tests import it): what the room's lines say, where Join goes, and which listed room is the one to
// offer from the Daily card (ui/daily-room-line.ts).
//
//   - Join (the server list, the Daily card, the room's own map change) goes to the room's map with ?daily=<day>, so
//     main.ts plays the page in the day's style from the start, as the Daily entry does. The player may switch style
//     after; the Daily line then says those runs don't count (daily/state.ts hudLine).
//   - Runs count for the day wherever the day's map is played (the server marks them), so the room adds no rule.

import { api, type ServerListing } from "../api";
import { styleNote } from "../daily/state";
import { roomUrl } from "./presence";
import type { RoomDaily } from "./protocol";

/** The hour (UTC) a Daily Challenge day starts and ends (apps/api src/daily-rotation.ts DAILY_HOUR_UTC). */
export const DAILY_HOUR_UTC = 16;
/** The day (the UTC date it starts on) that server time `ms` falls in. */
export const dayAt = (ms: number): string => new Date(ms - DAILY_HOUR_UTC * 3_600_000).toISOString().slice(0, 10);

/** Where Join on a listed room goes: the map it plays (or is changing to), with the day for a Daily room. */
export const listingUrl = (s: Pick<ServerListing, "id" | "map" | "changing" | "daily">): string => roomUrl(s.id, s.changing ?? s.map ?? "", { daily: s.daily?.day });

/** m:ss, and h:mm:ss from an hour (the Daily room's day is up to 24 hours long). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const ss = String(s % 60).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}:${ss}`;
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${ss}`;
}

/** "5h 12m" from an hour, else m:ss. */
const span = (ms: number): string => {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : clock(ms);
};

/**
 * The room's time left as the scoreboard and the pause menu show it (both drop a trailing " left" where it doesn't fit).
 * `now`, `endsAt` and `daily.endsAt` on the same clock. A Daily room counts down to the end of the day ("5h 12m left"),
 * then to its map change ("next map in 1:42").
 */
export function roomTimeLeft(now: number, endsAt: number, daily?: Pick<RoomDaily, "endsAt"> | null): string {
  if (daily && now < daily.endsAt) return `${span(daily.endsAt - now)} left`;
  const ms = endsAt - now;
  if (ms <= 0) return "last round";
  return daily ? `next map in ${clock(ms)}` : `${clock(ms)} left`;
}

/** The chat line on arriving in a room. `chat`: the chat key's label. */
export function connectedLine(o: { room: string; players: number; max: number; map: string; chat: string; daily?: Pick<RoomDaily, "style"> | null }): string {
  const head = `Connected to ${o.room} (${o.players}/${o.max})`;
  const keys = `${o.chat} chat · Tab scores · N spectate`;
  if (o.daily) return `${head}. Today's Daily Challenge: ${o.map}${styleNote(o.daily.style)}. ${keys} · type timeleft`;
  return `${head} · ${o.map}. ${keys} · type rtv / nominate / timeleft`;
}

/**
 * The Daily room to offer from the Daily card: one that is up, plays a map and has a free slot; your nearer region's
 * when there are several (ui/servers-who.ts nearRegion), then the one with people in it. null: none.
 */
export function pickDailyRoom<T extends Pick<ServerListing, "id" | "region" | "online" | "map" | "players" | "maxPlayers" | "daily">>(rows: readonly T[], near: string | null = null): T | null {
  const open = rows.filter((s) => s.daily && s.online && s.map && s.players < s.maxPlayers);
  return open.sort((a, b) => Number(b.region === near) - Number(a.region === near) || b.players - a.players)[0] ?? null;
}

/** "3 playing", nothing for an empty room (the home screen's Play online says it the same way). */
export const playingNote = (players: number): string => (players > 0 ? `${players.toLocaleString("en-US")} playing` : "");

// --- GET /servers, shared by the home screen's Play online count and the Daily card's line (one request, not two)

const TTL_MS = 15_000;
let cached: { at: number; list: Promise<ServerListing[]> } | null = null;

/** GET /servers, shared for `maxAge` (a failed answer isn't kept). */
export function serversNow(maxAge = TTL_MS): Promise<ServerListing[]> {
  const now = Date.now();
  if (cached && now - cached.at < maxAge) return cached.list;
  const list = api.servers();
  const entry = { at: now, list };
  cached = entry;
  list.catch(() => cached === entry && (cached = null));
  return list;
}
/** Tests: ask again next time. */
export const forgetServers = () => void (cached = null);
