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
export function mouseFromPrefs(p: { sensitivity: number; dpi: number; dpiConfirmed: boolean; dpiHidden?: boolean }): MouseSettings {
  // Older settings already stored user-entered DPI before dpiConfirmed existed. dpiHidden: the player keeps it private.
  return { sensitivity: p.sensitivity, dpi: !p.dpiHidden && (p.dpiConfirmed || p.dpi !== DEFAULT_MOUSE_DPI) ? p.dpi : null };
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
