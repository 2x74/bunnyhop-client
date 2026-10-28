// Map difficulty tiers T1–T6 plus T7+: one scale and one colour ramp shared by the map browser, HUD, loading screen,
// end card, pause menu, profiles and the API's points formula. DOM-free (the API imports it).
//
// Source data: maps/index.json `tier` (SourceJump / srcwr zones-cstrike, community-voted), stored raw in D1 maps.tier.
// Upstream scales go to T8 or T10; every map rated 7 or higher shares one top tier, shown "T7+" (2026-10-28, players
// asked for it: the hardest T6s were T7 and T8 upstream). Maps without a tier show "T?" and are unranked for points.

export const MAX_TIER = 7;
export const TIERS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Tier = (typeof TIERS)[number];

/** Clamps a raw tier to 1..7 (7 = T7+); null/0/NaN → null ("T?"). */
export function clampTier(raw: number | null | undefined): Tier | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw < 1) return null;
  return Math.min(MAX_TIER, Math.max(1, Math.round(raw))) as Tier;
}

/** The tier without its "T": "3", "7+" (the top tier), "?" (unrated). */
export function tierNum(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? `${t}${t === MAX_TIER ? "+" : ""}` : "?";
}

export function tierLabel(raw: number | null | undefined): string {
  return `T${tierNum(raw)}`;
}

/** Names shown in tooltips and group headers (bhop community wording). */
export const TIER_NAMES: Record<Tier, string> = {
  1: "Very easy",
  2: "Easy",
  3: "Medium",
  4: "Hard",
  5: "Very hard",
  6: "Extreme",
  7: "Insane",
};

export function tierName(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? TIER_NAMES[t] : "Unrated";
}

/**
 * The tier colour ramp (green → teal → yellow → orange → red → violet → indigo). CSS mirrors these as --tier-1..7 in
 * style.css; canvas / three.js users read them from here.
 */
export const TIER_COLORS: Record<Tier, string> = {
  1: "#5ee08a",
  2: "#3fd0c9",
  3: "#ffd84d",
  4: "#ff9a3c",
  5: "#ff5468",
  6: "#c477ff",
  7: "#7c83ff",
};
export const TIER_UNKNOWN_COLOR = "#8a93a6";

export function tierColor(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? TIER_COLORS[t] : TIER_UNKNOWN_COLOR;
}
