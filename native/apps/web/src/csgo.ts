// The "CS:GO" map label (maps/index.json `game: "csgo"`, research/CSGO-MAPS.md, "The CS:GO tag"): a CS:GO build of a
// map. Only a label: every map plays in CS:S movement (a few have a scoped fix, crates/core MAP_FIXES). DOM-free (the
// API's map pages import it).

/** The label's hover line (map rows, the map panel, the set menu, the map page). */
export const CSGO_NOTE = "A CS:GO map: built for CS:GO movement, so some jumps can play differently here.";

export const isCsgo = (m: { game?: string | null } | null | undefined): boolean => m?.game === "csgo";
