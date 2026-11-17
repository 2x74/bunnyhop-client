// Other players' looks in a room: the game draws each from the website's own packed loadout (loadout.ts packLoadout),
// worked out here from their roster entry, so every field the website adds (hop effect, back item, cape and robe
// options, head options) reaches it byte for byte. The game keeps its own packing for menus older than this.
import { cleanLoadout, packLoadout } from "../../web/src/loadout";
import type { ServerMsg } from "../../web/src/net/protocol";

/** The roster loadout's pack, or null when there is nothing the website would draw. */
export function rosterPack(loadout: unknown): string | null {
  const clean = cleanLoadout(loadout);
  return clean ? packLoadout(clean) : null;
}

function withPack<T extends { loadout?: unknown }>(entry: T): T & { pack?: string } {
  if (!entry || typeof entry !== "object" || !("loadout" in entry)) return entry;
  const pack = rosterPack(entry.loadout);
  return pack === null ? entry : { ...entry, pack };
}

/** The message with `pack` beside each roster loadout it carries (welcome players, a join, a player's patch). */
export function withLoadoutPacks(message: ServerMsg): ServerMsg {
  if (message.t === "welcome") return { ...message, players: message.players.map(withPack) };
  if (message.t === "join") return { ...message, player: withPack(message.player) };
  if (message.t === "player") return { ...message, patch: withPack(message.patch) };
  return message;
}
