// Ghost tint per source: PB = gold, WR = blue, anything else (loaded replay, leaderboard run, demo) = white.

export type GhostKind = "pb" | "wr" | "custom";

export const GHOST_COLORS: Record<GhostKind, number> = {
  pb: 0xffc23d,
  wr: 0x4fa8ff,
  custom: 0xe9f0fb,
};

export const GHOST_CSS: Record<GhostKind, string> = {
  pb: "#ffc23d",
  wr: "#4fa8ff",
  custom: "#e9f0fb",
};
