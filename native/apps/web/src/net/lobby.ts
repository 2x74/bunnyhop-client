// Private lobbies (apps/api/src/rooms/config.ts): a room a signed-in player opens for friends, joined by invite link
// (bunnyhop.lol/?lobby=<code>; the room id is "p-<code>"). Not in the server list; the creator is the host.

import { api } from "../api";
import { roomUrl } from "./presence";
import { WAVEDASH } from "../platform/env";
import { wavedashLink } from "../platform/wavedash";

const LOBBY_RE = /^p-[a-z2-7]{10}$/;

export const isLobbyRoom = (id: string | null | undefined): boolean => !!id && LOBBY_RE.test(id);

/** The room id an invite's ?lobby= value names (the code, or the whole id), or null. */
export function lobbyIdFromParam(v: string | null): string | null {
  const id = v ? (v.startsWith("p-") ? v : `p-${v}`).toLowerCase() : null;
  return id && LOBBY_RE.test(id) ? id : null;
}

/** The link friends open: the site's, or in the Wavedash build the Wavedash game page (they join there, signed in). */
export function lobbyInviteUrl(id: string): string {
  if (WAVEDASH) return wavedashLink({ lobby: id.replace(/^p-/, "") });
  const u = new URL("/", location.origin);
  u.searchParams.set("lobby", id.replace(/^p-/, ""));
  return u.toString();
}

/** Copies the invite link; false if the browser refused (the caller shows the link instead). */
export async function copyLobbyInvite(id: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(lobbyInviteUrl(id));
    return true;
  } catch {
    return false;
  }
}

/** Opens the lobby on the map it is playing (or changing to). Throws the API's error (404 lobby_closed). */
export async function goToLobby(id: string): Promise<void> {
  const l = await api.lobby(id);
  const map = l.changing ?? l.map;
  if (!map) throw new Error("This lobby has no map to play.");
  location.href = roomUrl(l.id, map);
}
