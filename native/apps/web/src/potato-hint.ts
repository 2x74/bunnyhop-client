import { toast } from "./notify";
import { applyGraphicsPreset, graphicsPreset, PRESET_ORDER, prefs, type GraphicsPreset } from "./ui/settings";

// A quiet suggestion of a lower graphics preset (Settings → Graphics → Preset) for players whose game runs slowly: after
// a while of playing at a median frame time over SLOW_FRAME_MS, the next time a menu opens, a toast with the preset to
// try. Never mid-run. Low first (Potato mode, no antialiasing or anisotropic filtering), then Lowest (half resolution)
// if it's still slow; each preset is offered once per browser.
//
// Unplayable (a median under 20 fps over the first SEVERE_PLAY_MS of play) on settings nobody has touched (the High
// preset): Low goes on at once, with an Undo, rather than waiting for a menu the player may never open.

const KEY = "bunnyhop:potato-hint";
/** Median frame time (ms) that counts as slow: under 40 fps. */
export const SLOW_FRAME_MS = 25;
/** Playing time (ms) before judging. */
export const MIN_PLAY_MS = 20_000;
/** Median frame time (ms) that is unplayable: under 20 fps. */
export const SEVERE_FRAME_MS = 50;
export const SEVERE_PLAY_MS = 10_000;
/** Frames judged: the most recent ones. */
const WINDOW = 1200;

/** Whether these frame times (ms) are slow: their median is over `limit` (SLOW_FRAME_MS). */
export function slowFrames(frames: ArrayLike<number>, limit = SLOW_FRAME_MS): boolean {
  if (!frames.length) return false;
  const s = Array.from(frames).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] > limit;
}

/** The preset to suggest for these settings, or null when they are already as low as a suggestion goes. */
export function nextPreset(g: { potato: boolean; antialias: boolean; anisotropy: number; resolutionScale: number }): GraphicsPreset | null {
  if (!g.potato || g.antialias || g.anisotropy > 1) return "low";
  if (g.resolutionScale > 0.5) return "lowest";
  return null;
}

export class PotatoHint {
  private frames = new Float32Array(WINDOW);
  private n = 0;
  private played = 0;
  private armed = false;
  private severeChecked = false;
  /** The lowest preset offered so far in this browser ("1": Potato mode, before presets). */
  private offered: string | null = null;

  constructor() {
    try {
      this.offered = localStorage.getItem(KEY);
    } catch {
      /* storage blocked: may suggest once per page */
    }
  }

  private target(): GraphicsPreset | null {
    const next = nextPreset(prefs.get().graphics);
    if (!next) return null;
    // Never the same or a higher preset again ("1": the old Potato mode hint, the same as Low).
    const was = this.offered === "1" ? "low" : (this.offered as GraphicsPreset | null);
    if (was && PRESET_ORDER.indexOf(next) >= PRESET_ORDER.indexOf(was)) return null;
    return next;
  }

  /** Every frame: its duration (ms) and whether the game is being played (pointer locked, not watching a replay). */
  frame(ms: number, playing: boolean): void {
    if (playing) {
      if (this.armed) return;
      this.frames[this.n++ % WINDOW] = ms;
      this.played += ms;
      if (!this.severeChecked && this.played >= SEVERE_PLAY_MS && this.n >= 60) {
        this.severeChecked = true;
        if (slowFrames(this.frames.subarray(0, Math.min(this.n, WINDOW)), SEVERE_FRAME_MS)) this.lower();
      }
      if (this.played >= MIN_PLAY_MS && this.n >= 300 && this.n % 60 === 0) this.armed = !!this.target() && slowFrames(this.frames.subarray(0, Math.min(this.n, WINDOW)));
      return;
    }
    if (this.armed && document.body.classList.contains("menu-open")) this.show();
  }

  /** Unplayable on untouched settings: Low now, with an Undo. */
  private lower(): void {
    const g = prefs.get().graphics;
    if (graphicsPreset(g) !== "high" || this.target() !== "low") return;
    const before = { ...g };
    this.offered = "low";
    try {
      localStorage.setItem(KEY, "low");
    } catch {
      /* once per page then */
    }
    prefs.update((p) => applyGraphicsPreset(p.graphics, "low"));
    this.n = 0;
    this.played = 0;
    toast("Graphics lowered to keep it smooth.", {
      key: "potato",
      ms: 12_000,
      action: { label: "Undo", run: () => prefs.update((p) => Object.assign(p.graphics, { potato: before.potato, antialias: before.antialias, anisotropy: before.anisotropy, resolutionScale: before.resolutionScale })) },
    });
  }

  private show(): void {
    this.armed = false;
    this.n = 0;
    this.played = 0;
    const preset = this.target();
    if (!preset) return;
    this.offered = preset;
    try {
      localStorage.setItem(KEY, preset);
    } catch {
      /* once per page then */
    }
    const name = preset === "low" ? "Low" : "Lowest";
    toast(`Running slow. Try ${name} graphics?`, {
      key: "potato",
      ms: 14_000,
      action: { label: `Use ${name}`, run: () => prefs.update((p) => applyGraphicsPreset(p.graphics, preset)) },
    });
  }
}
