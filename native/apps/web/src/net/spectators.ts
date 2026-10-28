// Spectator list (HUD element "spectators", hud.ts setSpectators), like a CS:S bhop server's: who is watching you, or,
// while you spectate someone, who else is watching them. Computed from the room roster's spec targets (protocol.ts
// RosterPlayer.spec, kept by the welcome, join and { t: "player" } patches); no server change. Everyone on the roster
// counts, shadowed players included, as on the Tab scoreboard (the client can't tell them apart); there is no hidden
// staff spectating. DOM-free for the tests.

/** The roster fields the list reads (protocol.ts RosterPlayer). */
export interface SpecEntry {
  slot: number;
  name: string;
  spec: number | null;
}

/** Names shown before the list folds the rest into "+N more". */
export const SPEC_LIST_MAX = 8;

/**
 * Names (slot order, like a server's client index) of the players watching `watching` (your target while you
 * spectate) or else you; never you. Empty when nobody is.
 */
export function spectatorsOf(players: readonly SpecEntry[], you: number, watching: number | null): string[] {
  const subject = watching ?? you;
  if (subject < 0) return [];
  return players
    .filter((p) => p.spec === subject && p.slot !== you && p.slot !== subject)
    .sort((a, b) => a.slot - b.slot)
    .map((p) => p.name);
}

/** The element's lines: "Spectators (n)", then up to SPEC_LIST_MAX names, then "+N more". Empty: nothing to show. */
export function spectatorLines(names: readonly string[]): string[] {
  if (!names.length) return [];
  const shown = names.slice(0, SPEC_LIST_MAX);
  const more = names.length - shown.length;
  return [`Spectators (${names.length})`, ...shown, ...(more > 0 ? [`+${more} more`] : [])];
}
