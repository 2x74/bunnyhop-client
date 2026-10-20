// Favorite maps: the rules shared by the client (ui/favorites.ts keeps the set in localStorage and syncs it) and the API
// (apps/api src/favorites.ts stores it: migrations/0040_map_favorites.sql, GET / POST /me/favorites). DOM-free.

/** Most maps one player can star. Far past any real list (the game has ~340 maps), so it only stops scripts. */
export const MAX_FAVORITES = 500;
/** Most names one POST /me/favorites may carry in `add` and in `remove` (a sync after a long offline spell fits). */
export const MAX_FAVORITE_CHANGES = 100;

/** A map name as the API's routes take them (/maps/:name). Whether the map exists is the server's question. */
export function favoriteNameOk(name: unknown): name is string {
  return typeof name === "string" && /^[\w.-]{1,64}$/.test(name);
}
