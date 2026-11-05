// Map difficulty tiers T1–T10: one scale and one colour ramp shared by the map browser, HUD, loading screen, end card,
// pause menu, profiles and the API's points formula. DOM-free (the API imports it).
//
// Source data: maps/index.json `tier` (SourceJump / srcwr zones-cstrike, community-voted), stored raw in D1 maps.tier.
// SourceJump's scale goes to T10, and so does ours (owner, v0.0.37). From 2026-10-28 to v0.0.37 everything rated 7 or
// higher shared one top tier, shown "T7+"; D1 kept the raw tiers, so nothing had to be re-rated. Maps without a tier
// show "T?" and are unranked for points.

export const MAX_TIER = 10;
export const TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type Tier = (typeof TIERS)[number];

/** Clamps a raw tier to 1..10; null/0/NaN → null ("T?"). */
export function clampTier(raw: number | null | undefined): Tier | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw) || raw < 1) return null;
  return Math.min(MAX_TIER, Math.max(1, Math.round(raw))) as Tier;
}

/** The tier without its "T": "3", "10", "?" (unrated). */
export function tierNum(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? String(t) : "?";
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
  8: "Brutal",
  9: "Nightmare",
  10: "Impossible",
};

export function tierName(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? TIER_NAMES[t] : "Unrated";
}

/**
 * The tier colour ramp (green → teal → yellow → orange → red → violet → indigo → pink → azure → white). CSS mirrors
 * these as --tier-1..10 in style.css; canvas / three.js users read them from here.
 */
export const TIER_COLORS: Record<Tier, string> = {
  1: "#5ee08a",
  2: "#3fd0c9",
  3: "#ffd84d",
  4: "#ff9a3c",
  5: "#ff5468",
  6: "#c477ff",
  7: "#7c83ff",
  8: "#ff6ec7",
  9: "#4fb8ff",
  10: "#f2f4ff",
};
export const TIER_UNKNOWN_COLOR = "#8a93a6";

export function tierColor(raw: number | null | undefined): string {
  const t = clampTier(raw);
  return t ? TIER_COLORS[t] : TIER_UNKNOWN_COLOR;
}
