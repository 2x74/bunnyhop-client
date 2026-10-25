// Map groups: a player's own named lists of maps (private: only the player sees them). The rules shared by the client
// (ui/map-groups.ts keeps them in localStorage and syncs them) and the API (apps/api src/map-groups.ts stores them:
// migrations/0071_map_groups.sql, GET / POST /me/map-groups). DOM-free.

export { favoriteNameOk as groupMapOk } from "./favorites";

/** Most groups one player can have. */
export const MAX_MAP_GROUPS = 30;
/** Most maps in one group (the game has ~600). */
export const MAX_GROUP_MAPS = 300;
/** Longest group name, in characters. */
export const GROUP_NAME_MAX = 32;
/** Most groups one POST /me/map-groups may change (a sync after a long offline spell fits). */
export const MAX_GROUP_CHANGES = 2 * MAX_MAP_GROUPS;
/** Most map names one group change may carry in `add` and in `remove`. */
export const MAX_GROUP_MAP_CHANGES = 100;

/** A group's id: made by the client when the group is created (so it works offline), unique per player. */
export function groupIdOk(id: unknown): id is string {
  return typeof id === "string" && /^g[a-z0-9]{6,23}$/.test(id);
}

/** A new group id ("g" + 12 random base-36 characters). */
export function newGroupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `g${Array.from(bytes, (b) => (b % 36).toString(36)).join("")}`;
}

/**
 * A group name as stored: plain text, trimmed, runs of spaces made one, at most GROUP_NAME_MAX characters. Null when
 * nothing is left or it has control characters.
 */
export function cleanGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control and format characters (newlines, bidi overrides, invisible spaces) are never part of a name; the joiner
  // inside an emoji sequence is.
  if (/[\p{Cc}\u2028\u2029]|(?!\u200d)\p{Cf}/u.test(raw)) return null;
  const name = raw.trim().replace(/\s+/gu, " ");
  const len = [...name].length;
  return len >= 1 && len <= GROUP_NAME_MAX ? name : null;
}

/** Names compare without case: a player's groups can't share one. */
export const sameGroupName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();
