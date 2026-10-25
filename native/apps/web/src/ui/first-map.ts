// The map new players start on: the intro's Hop in, the home screen's featured Play and the menu background on a first
// visit, the map list's default pick, an empty own profile, and the tutorial's "play a map" at the end. It rotates
// daily over a few very easy, popular, ranked tier 1 maps that look friendly and load fast, the same for everyone on a
// given UTC day (days since the epoch, mod the list).
//
// Picked from prod (2026-10-21, Normal boards): median finish time on the board vs the WR, players, BSP size, looks.
//   bhop_ambience  3.2k players, median 33 s (WR 19 s), pink trees and grass; 17.5 MB, the biggest here
//   bh_aztec       2.1k players, median 23 s (WR 9 s), sandstone and water under a sky; 1.6 MB
//   bhop_easyhop   150 players, median 22 s (WR 13 s), bright orange and blue rooms; 2.3 MB
//   bhop_2_easy    475 players, median 12 s (WR 8 s), one short stone lane over water; 1.2 MB
//   bhop_alley     190 players, median 23 s (WR 13 s), brick alleys on grass under a blue sky; 2.0 MB
// Not: bhop_eazy / bhop_1 / bhop_1n5an3 / bhop_2easy (newcomers' times are 3-4x the WR), bhop_3_easy and
// bhop_at_night (dark), bhop_bfur (one strafe corridor).

export const FIRST_MAPS = ["bhop_ambience", "bh_aztec", "bhop_easyhop", "bhop_2_easy", "bhop_alley"] as const;

const DAY_MS = 86_400_000;

/** Today's first map (UTC days since the epoch, mod the list). */
export function firstMapOfTheDay(now = Date.now()): string {
  const day = Math.floor(now / DAY_MS);
  return FIRST_MAPS[((day % FIRST_MAPS.length) + FIRST_MAPS.length) % FIRST_MAPS.length];
}
