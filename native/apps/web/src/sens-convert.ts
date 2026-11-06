// Mouse sensitivity maths: Source's m_yaw, cm / in per 360°, and other games' sensitivities in ours. DOM-free
// (Settings → Mouse & view, onboarding, the console and their tests use it).
//
// Every game here turns the view by a fixed angle per mouse count: degrees = counts × sensitivity × yaw, where `yaw` is
// the game's own constant (Source's m_yaw). Two settings feel the same when sensitivity × yaw is the same, so a
// sensitivity moves between games as  ours = theirs × theirYaw / ourYaw.  DPI doesn't change that (same mouse); it
// only turns degrees per count into a distance per turn.

/** Source's default m_yaw (and m_pitch): degrees per count at sensitivity 1 (in_mouse.cpp, ConVar m_yaw "0.022"). */
export const M_YAW = 0.022;
/**
 * Allowed m_yaw / m_pitch. Wide enough to type any game's yaw here and keep that game's sensitivity number (Overwatch
 * 0.0066, Fortnite's 0.005555 per %), and nothing that isn't a real setting.
 */
export const M_YAW_RANGE: readonly [number, number] = [0.001, 1];
/** Allowed sensitivity (the Sensitivity box; the server's range for the profile's sensitivity, mouse-settings.ts). */
export const SENS_RANGE: readonly [number, number] = [0.01, 100];
/**
 * Allowed degrees per count (sensitivity × m_yaw): what CS:S sensitivities 0.01 to 100 give at m_yaw 0.022, so the
 * CS:S-equivalent sensitivity the profile and runs report always fits the server's range.
 */
export const DEG_PER_COUNT_RANGE: readonly [number, number] = [SENS_RANGE[0] * M_YAW, SENS_RANGE[1] * M_YAW];

const CM_PER_IN = 2.54;

/** Degrees the view turns per mouse count. */
export const degPerCount = (sensitivity: number, yaw: number): number => sensitivity * yaw;

/** Inches of mouse travel for a 360° turn (Infinity for a still view or no DPI). */
export function inPer360(sensitivity: number, yaw: number, dpi: number): number {
  const d = degPerCount(sensitivity, yaw);
  return d > 0 && dpi > 0 ? 360 / d / dpi : Infinity;
}

/** Centimetres of mouse travel for a 360° turn. */
export const cmPer360 = (sensitivity: number, yaw: number, dpi: number): number => inPer360(sensitivity, yaw, dpi) * CM_PER_IN;

/** A sensitivity at `fromYaw` as one at `toYaw` that turns the same per count. */
export const convertSens = (sens: number, fromYaw: number, toYaw: number): number => (sens * fromYaw) / toYaw;

/** The CS:S sensitivity (m_yaw 0.022) that turns as `sensitivity` does at `mYaw`: what the profile and runs report. */
export const cssEquivalent = (sensitivity: number, mYaw: number): number => convertSens(sensitivity, mYaw, M_YAW);

/**
 * A sensitivity to four decimals, as people type them: within 0.005% of the exact conversion (0.002 cm on a 40 cm
 * turn).
 */
export const roundSens = (v: number): number => Math.round(v * 1e4) / 1e4;

const within = (v: number, [lo, hi]: readonly [number, number]) => Number.isFinite(v) && v >= lo && v <= hi;

/** Why a sensitivity / m_yaw pair can't be used, or null when it can (Settings, the console, a pasted config). */
export function sensProblem(sensitivity: number, mYaw: number): string | null {
  if (!within(mYaw, M_YAW_RANGE)) return `m_yaw goes from ${M_YAW_RANGE[0]} to ${M_YAW_RANGE[1]}.`;
  if (!within(sensitivity, SENS_RANGE)) return `Sensitivity goes from ${SENS_RANGE[0]} to ${SENS_RANGE[1]}.`;
  const css = cssEquivalent(sensitivity, mYaw);
  // (A rounding hair over the edge still fits: the check is on the CS:S value the server sees.)
  if (!(css >= SENS_RANGE[0] - 1e-9 && css <= SENS_RANGE[1] + 1e-9)) return `That turns like CS:S sensitivity ${roundSens(css)}, outside ${SENS_RANGE[0]} to ${SENS_RANGE[1]}.`;
  return null;
}

/**
 * `sensitivity` brought into what the Sensitivity box allows at `mYaw`: SENS_RANGE, and a CS:S equivalent in
 * SENS_RANGE (at m_yaw 0.022 that is the same range).
 */
export function clampSens(sensitivity: number, mYaw: number): number {
  const lo = Math.max(SENS_RANGE[0], DEG_PER_COUNT_RANGE[0] / mYaw);
  const hi = Math.min(SENS_RANGE[1], DEG_PER_COUNT_RANGE[1] / mYaw);
  return Math.min(hi, Math.max(lo, sensitivity));
}

/** A game the converter knows: its yaw (degrees per count at sensitivity 1, in the units its menu shows). */
export interface GameYaw {
  id: string;
  label: string;
  yaw: number;
  /** What the game's sensitivity number looks like, when it isn't a plain number (Fortnite's percent). */
  unit?: string;
  /** Short note for the converter (raw input, OS pointer speed). */
  note?: string;
}

/**
 * Yaw constants, checked 2026-11-05. Only games with a yaw we could confirm; nobody asked for more.
 *  - Source engine (CS:S, CS:GO, CS2, TF2, Momentum Mod): 0.022. Primary: Source SDK 2013 src/game/client/in_mouse.cpp,
 *    `static ConVar m_yaw( "m_yaw","0.022", ...)`, applied as m_yaw * mouse_x:
 *    https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/in_mouse.cpp
 *  - Quake Live (Quake III base): 0.022. Primary: Quake-III-Arena code/client/cl_main.c, Cvar_Get("m_yaw", "0.022").
 *    Quake Champions uses the same scale (converter tables, e.g. csdb.gg).
 *  - Apex Legends: 0.022 (Source-derived): https://www.mouse-sensitivity.com/n/apex-legends/
 *  - Valorant: 0.07 (community measurement; Riot publishes none): https://www.mouse-sensitivity.com/n/valorant/
 *  - Overwatch 2: 0.0066 (community; CS sens × 10/3): https://csdb.gg/sensitivity-converter/overwatch-2-to-cs2/
 *  - Fortnite: 0.005555 per percent of the X-axis slider (it shows e.g. 7.0%): https://www.mouse-sensitivity.com/n/fortnite/
 * Left out on purpose: Roblox. Its default camera turns 0.5° per input delta at sensitivity 1 (PlayerModule
 * CameraInput.lua ROTATION_SPEED_MOUSE), but that delta is in screen pixels after the OS pointer speed and display
 * scaling, not mouse counts, so no single number converts it.
 */
export const GAMES: readonly GameYaw[] = [
  { id: "cs", label: "CS2 / CS:GO / CS:S", yaw: 0.022 },
  { id: "source", label: "TF2 / Momentum / other Source", yaw: 0.022 },
  { id: "apex", label: "Apex Legends", yaw: 0.022 },
  { id: "quake", label: "Quake Champions / Quake Live", yaw: 0.022 },
  { id: "valorant", label: "Valorant", yaw: 0.07 },
  { id: "overwatch", label: "Overwatch 2", yaw: 0.0066 },
  { id: "fortnite", label: "Fortnite", yaw: 0.005555, unit: "%", note: "Use the X-axis percentage." },
];

export const gameById = (id: string): GameYaw | undefined => GAMES.find((g) => g.id === id);

/** A distance per turn for people: "34.6 cm" / "13.6 in" (one decimal; "—" when it can't turn). */
export const fmtTurn = (v: number, unit: "cm" | "in"): string => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : "—");
