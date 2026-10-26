// The HUD elements the player can move, and where hud.hpp draws each one when
// it hasn't been moved. Positions are percent of the screen; hud.hpp keeps its
// built-in places in HUD units (1/900 of the screen height above 540 px), so
// the same formulas are repeated here to show those places as percentages.
// Keep the ids and formulas in step with NativeHud::draw and settings.hpp.

type Place = (w: number, h: number) => number;
export interface HudElement { id: string; label: string; x: Place; y: Place }

export const HUD_ELEMENTS = [
  { id: "crosshair", label: "Crosshair", x: w => w / 2, y: (_, h) => h / 2 },
  { id: "map", label: "Map and style", x: () => 26, y: () => 18 },
  { id: "fps", label: "FPS", x: w => w - 135, y: () => 20 },
  { id: "timer", label: "Timer", x: w => w / 2, y: (_, h) => h - 154 },
  { id: "speed", label: "Speed", x: w => w / 2, y: (_, h) => h - 105 },
  { id: "runStats", label: "Run stats", x: w => w / 2, y: (_, h) => h - 68 },
  { id: "status", label: "Run status", x: w => w / 2, y: (_, h) => h - 186 },
  { id: "jumpStats", label: "Jump stats", x: w => w / 2, y: (_, h) => h - 222 },
  { id: "strafeTrainer", label: "Strafe trainer", x: w => w / 2, y: (_, h) => h - 276 },
  { id: "splits", label: "Split comparison", x: w => w / 2, y: (_, h) => h - 330 },
  { id: "speedGraph", label: "Speed graph", x: w => w - 300, y: (_, h) => h - 180 },
  { id: "keys", label: "Keys", x: () => 26, y: (_, h) => h - 65 },
  { id: "health", label: "Health and ammo", x: w => w - 275, y: (_, h) => h - 62 },
  { id: "notice", label: "Notices", x: w => w / 2, y: () => 70 },
  { id: "replay", label: "Replay banner", x: w => w / 2, y: () => 22 },
] as const satisfies readonly HudElement[];

export type HudElementId = (typeof HUD_ELEMENTS)[number]["id"];
export interface HudPosition { x: number; y: number; visible?: boolean; scale?: number }
export type HudLayout = Partial<Record<HudElementId, HudPosition>>;
export const HUD_ELEMENT_IDS: readonly HudElementId[] = HUD_ELEMENTS.map(item => item.id);

const round = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/** Where |id| sits by default on a |width| × |height| window, in percent. */
export function defaultPosition(id: HudElementId, width = window.innerWidth, height = window.innerHeight): HudPosition {
  const element: HudElement = HUD_ELEMENTS.find(item => item.id === id)!;
  const scale = Math.max(.6, height / 900);
  const w = width / scale, h = height / scale;
  return { x: round(element.x(w, h) / w * 100), y: round(element.y(w, h) / h * 100) };
}

export function validHudLayout(value: unknown): value is HudLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, at]) => HUD_ELEMENT_IDS.includes(id as HudElementId) &&
    !!at && typeof at === "object" && !Array.isArray(at) && Object.keys(at).every(key => ["x","y","visible","scale"].includes(key)) &&
    (!("visible" in at) || typeof at.visible === "boolean") &&
    (!("scale" in at) || typeof at.scale === "number" && Number.isFinite(at.scale) && at.scale >= .5 && at.scale <= 3) &&
    (["x", "y"] as const).every(axis => { const n = (at as Record<string, unknown>)[axis]; return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100; }));
}
