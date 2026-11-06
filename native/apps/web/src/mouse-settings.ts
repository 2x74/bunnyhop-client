import { cssEquivalent, M_YAW, roundSens } from "./sens-convert";

export const DEFAULT_MOUSE_DPI = 800;

/** DPI is self-reported; sensitivity is the game's CS:S value. Unknown stays null. */
export interface MouseSettings { sensitivity: number; dpi: number | null }
export function parseMouseSettings(value: unknown): MouseSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { sensitivity, dpi } = value as MouseSettings;
  if (typeof sensitivity !== "number" || !Number.isFinite(sensitivity) || sensitivity < 0.01 || sensitivity > 100) return null;
  if (dpi !== null && (typeof dpi !== "number" || !Number.isInteger(dpi) || dpi < 50 || dpi > 32000)) return null;
  return { sensitivity, dpi };
}
export function mouseFromPrefs(p: { sensitivity: number; mYaw?: number; dpi: number; dpiConfirmed: boolean; dpiHidden?: boolean }): MouseSettings {
  // Older settings already stored user-entered DPI before dpiConfirmed existed. dpiHidden: the player keeps it private.
  // A custom m_yaw: the CS:S sensitivity that turns the same (cm/360 and eDPI stay true on the profile and the runs).
  const yaw = p.mYaw ?? M_YAW;
  const sensitivity = yaw === M_YAW ? p.sensitivity : roundSens(cssEquivalent(p.sensitivity, yaw));
  return { sensitivity, dpi: !p.dpiHidden && (p.dpiConfirmed || p.dpi !== DEFAULT_MOUSE_DPI) ? p.dpi : null };
}
/** Only constant settings belong in per-run comparisons. A mid-run change invalidates that snapshot. */
export class RunMouseSettings {
  private initial: MouseSettings | null = null;
  private changed = false;
  feed(value: MouseSettings, running: boolean): void {
    if (!running || !this.initial) { this.initial = { ...value }; this.changed = false; }
    else if (value.sensitivity !== this.initial.sensitivity || value.dpi !== this.initial.dpi) this.changed = true;
  }
  snapshot(): MouseSettings | null { return this.changed || !this.initial ? null : { ...this.initial }; }
}

/** RunPlay's vertical look: vsens always, invertY only when on. */
export function pitchPlay(s: { sensitivity: number; m_pitch: number; verticalSensitivityEnabled?: boolean; verticalSensitivity?: number }): { vsens?: number; invertY?: true } {
  // In CS:S units at m_pitch 0.022, like the run's sensitivity (mouseFromPrefs above): a custom m_pitch
  // reports the CS:S value that turns the same.
  const raw = s.verticalSensitivityEnabled ? (s.verticalSensitivity ?? s.sensitivity) : s.sensitivity;
  const size = Math.abs(s.m_pitch);
  const v = size === M_YAW || !(size > 0) ? raw : roundSens(cssEquivalent(raw, size));
  return { ...(Number.isFinite(v) && v > 0 ? { vsens: v } : {}), ...(s.m_pitch < 0 ? { invertY: true as const } : {}) };
}
