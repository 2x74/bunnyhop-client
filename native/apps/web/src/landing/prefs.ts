// Landing spot prefs (Prefs.landing; Settings → HUD → Advanced → Landing spot, !landing). A leaf module: no import cycle
// through ui/settings.ts.

/** Where the landing spot shows: never (the default), only in practice attempts, or in every attempt. */
export type LandingMode = "off" | "practice" | "always";

export interface LandingPrefs {
  mode: LandingMode;
  /** The path to the spot as a faint dotted arc. */
  arc: boolean;
  /** The spot's colour (a path into a teleport shows in the palette's loss colour). */
  color: string;
}

export const LANDING_MODES: [LandingMode, string][] = [
  ["off", "Off"],
  ["practice", "Practice"],
  ["always", "Always"],
];

export const DEFAULT_LANDING_COLOR = "#4de1ff";
export const DEFAULT_LANDING_PREFS: LandingPrefs = { mode: "off", arc: false, color: DEFAULT_LANDING_COLOR };

/** Saved or imported values that can't be used are dropped (the default takes their place). */
export function normalizeLandingPrefs(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const l = raw as Record<string, unknown>;
  if (!LANDING_MODES.some(([m]) => m === l.mode)) delete l.mode;
  if (typeof l.color === "string" && /^#[0-9a-f]{6}$/i.test(l.color)) l.color = l.color.toLowerCase();
  else delete l.color;
}

/**
 * Whether the spot shows for the run on screen. `practicing`: this attempt is practice (practice mode or a practice
 * tool); `replay`: the replay viewer (no practice there: any mode but Off shows it).
 */
export function landingEnabled(mode: LandingMode, practicing: boolean, replay = false): boolean {
  return mode === "always" || (mode === "practice" && (practicing || replay));
}
