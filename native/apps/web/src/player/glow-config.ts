export const GLOW_COLORS = [
  { id: "violet", name: "Violet", hex: "#bd54ff" },
  { id: "pink", name: "Pink", hex: "#ff65c9" },
  { id: "cyan", name: "Cyan", hex: "#54dfff" },
  { id: "gold", name: "Gold", hex: "#ffc654" },
  { id: "green", name: "Green", hex: "#65ff9b" },
  { id: "white", name: "White", hex: "#eef1ff" },
] as const;
export type GlowColorId = (typeof GLOW_COLORS)[number]["id"];
export type HexGlowColor = `#${string}`;
export type GlowColor = GlowColorId | HexGlowColor;
export const isHexGlowColor = (value: unknown): value is HexGlowColor =>
  typeof value === "string" &&
  value.length === 7 &&
  /^#[0-9a-f]{6}$/i.test(value);

/** Six-digit hex colors are canonical lowercase; legacy preset IDs remain valid. */
export function normalizeGlowColor(value: unknown): GlowColor | null {
  if (GLOW_COLORS.some((color) => color.id === value))
    return value as GlowColorId;
  return isHexGlowColor(value) ? (value.toLowerCase() as HexGlowColor) : null;
}

/** The same validated color mapping is used by preview controls and renderer materials. */
export function glowColorHex(value: unknown): HexGlowColor {
  const color = normalizeGlowColor(value);
  if (isHexGlowColor(color)) return color;
  return (
    GLOW_COLORS.find((preset) => preset.id === color)?.hex ?? GLOW_COLORS[0].hex
  );
}

export interface PlayerGlow {
  enabled: boolean;
  /** Animated outer aura; older preferences default on. */
  aura: boolean;
  color: GlowColor;
  intensity: number;
}
export const DEFAULT_PLAYER_GLOW: PlayerGlow = {
  enabled: true,
  aura: true,
  color: "violet",
  intensity: 0.7,
};
export const isGlowColor = (v: unknown): v is GlowColor =>
  normalizeGlowColor(v) !== null;
/** This cleans an entitled config; null never grants an effect. */
export function normalizePlayerGlow(v: unknown): PlayerGlow | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<PlayerGlow>;
  return {
    enabled: p.enabled === true,
    aura: p.aura === undefined ? true : p.aura === true,
    color: normalizeGlowColor(p.color) ?? "violet",
    intensity:
      typeof p.intensity === "number" && Number.isFinite(p.intensity)
        ? Math.max(0.25, Math.min(1, p.intensity))
        : 0.7,
  };
}
