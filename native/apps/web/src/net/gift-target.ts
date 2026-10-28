/** Exact roster matching for !gift. Prefix matches are suggestions only, never a selected recipient. */
export function resolveGiftTarget(arg: string, players: readonly { id: string; name: string }[]): { kind: "room" } | { kind: "player"; id: string; name: string } | { kind: "error"; message: string } {
  const name = arg.trim();
  if (!name) return { kind: "room" };
  const q = name.toLowerCase();
  const exact = players.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: "player", ...exact[0] };
  if (exact.length > 1) return { kind: "error", message: `More than one player is named "${name}": ${exact.map((p) => p.name).join(", ")}. Open the player's profile to choose the right account.` };
  const suggestions = players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5);
  return { kind: "error", message: suggestions.length ? `Use the player's full name: ${suggestions.map((p) => p.name).join(", ")}.` : `No player named "${name}" in this room. Use !gift without a name for room gifts.` };
}
