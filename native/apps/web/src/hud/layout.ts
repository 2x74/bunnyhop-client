// HUD layout model: which elements are shown, where and how big. Resolution independent:
// each element has a 9-grid anchor (the same point on the screen and on the element), an offset
// from that screen point as a fraction of the viewport, and a scale. Stored in prefs.hud.layout.
// Also: presets and a compact share string ("bhl1.<base64url>") for export/import.

export const HUD_ELEMENTS = [
  { id: "speed", label: "Speed" },
  { id: "timer", label: "Timer" },
  { id: "split", label: "Split vs PB" },
  { id: "track", label: "Bonus / track" },
  { id: "stage", label: "Stage / CP" },
  { id: "stats", label: "Jumps · strafes · sync" },
  { id: "sync", label: "Sync bar" },
  { id: "keys", label: "Keys overlay" },
  { id: "ghostKeys", label: "Ghost keys" },
  { id: "graph", label: "Speed graph" },
  { id: "jumpStats", label: "Jump stats" },
  { id: "map", label: "Map / style line" },
  { id: "pb", label: "Personal best" },
  { id: "fps", label: "FPS counter" },
  // Chat (rooms, and commands in solo play). Appended last: share strings keep the order above.
  { id: "chat", label: "Chat" },
  // Rounds in the clip while a gun is out (hidden with the knife). Appended after chat for the same reason.
  { id: "ammo", label: "Ammo" },
  { id: "strafeTrainer", label: "Strafe trainer" },
  { id: "startPre", label: "Start Pre" },
  { id: "strafeOffsets", label: "Strafe offsets" },
  { id: "firstJump", label: "First jump tick" },
  { id: "longJump", label: "Longjump stats" },
  // Who is watching you in a room (net/spectators.ts), left middle like a CS:S server's spectator list.
  { id: "spectators", label: "Spectator list" },
] as const;

export type HudElId = (typeof HUD_ELEMENTS)[number]["id"];

/** 0 1 2 / 3 4 5 / 6 7 8 = top-left .. bottom-right. */
export type Anchor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface HudPlace {
  on: boolean;
  /** 9-grid anchor (screen point == element point). */
  a: number;
  /** Offset from the anchor point, as a fraction of viewport width / height. */
  x: number;
  y: number;
  /** Element scale (multiplied by the global HUD scale). */
  s: number;
}

export type HudLayout = Record<HudElId, HudPlace>;

export const anchorX = (a: number) => (a % 3) / 2;
export const anchorY = (a: number) => Math.floor(a / 3) / 2;

const P = (on: boolean, a: Anchor, x: number, y: number, s = 1): HudPlace => ({ on, a, x, y, s });

/** "Classic centred": the original HUD (speed / timer / stats under the crosshair, keys below it). */
export const CLASSIC: HudLayout = {
  speed: P(true, 7, 0, -0.262),
  timer: P(true, 7, 0, -0.22),
  split: P(true, 7, 0.072, -0.222, 0.9),
  track: P(true, 7, 0, -0.31, 0.85),
  stage: P(true, 7, 0, -0.165),
  stats: P(true, 7, 0, -0.19),
  sync: P(false, 7, 0, -0.135),
  keys: P(true, 4, 0, 0.115),
  ghostKeys: P(false, 4, 0.085, 0.115, 0.8),
  graph: P(false, 6, 0.015, -0.03),
  // The jump block, top to bottom between the in-game toasts (22vh) and the crosshair: last jump, offsets, first
  // jump tick, jump stats. Start Pre sits left of the speed (the gain tick flashes on its right).
  jumpStats: P(false, 4, 0, -0.06),
  startPre: P(false, 7, -0.075, -0.262),
  strafeOffsets: P(false, 4, 0, -0.13, 0.85),
  firstJump: P(false, 4, 0, -0.104, 0.85),
  longJump: P(false, 4, 0, -0.185),
  map: P(true, 0, 0.012, 0.016),
  pb: P(true, 2, -0.012, 0.016),
  fps: P(false, 0, 0.012, 0.045),
  chat: P(true, 6, 0.012, -0.2),
  strafeTrainer: P(false, 1, 0, 0.22, 1.15),
  ammo: P(true, 8, -0.014, -0.022),
  spectators: P(true, 3, 0.012, -0.06),
};

export const MINIMAL: HudLayout = {
  speed: P(true, 4, 0, 0.07, 0.85),
  timer: P(true, 4, 0, 0.105, 0.8),
  split: P(true, 4, 0, 0.13, 0.8),
  track: P(true, 4, 0, 0.045, 0.7),
  stage: P(true, 4, 0, 0.155, 0.75),
  stats: P(false, 7, 0, -0.165),
  sync: P(false, 7, 0, -0.14),
  keys: P(false, 4, 0, 0.115),
  ghostKeys: P(false, 4, 0.085, 0.115, 0.8),
  graph: P(false, 7, 0, -0.33),
  jumpStats: P(false, 4, 0, -0.06, 0.85),
  startPre: P(false, 4, -0.06, 0.07, 0.85),
  strafeOffsets: P(false, 4, 0, -0.13, 0.85),
  firstJump: P(false, 4, 0, -0.104, 0.85),
  longJump: P(false, 4, 0, -0.185),
  map: P(false, 0, 0.012, 0.016),
  pb: P(false, 2, -0.012, 0.016),
  fps: P(false, 0, 0.012, 0.045),
  chat: P(true, 6, 0.012, -0.03, 0.9),
  strafeTrainer: P(false, 1, 0, 0.22, 1.15),
  ammo: P(true, 8, -0.014, -0.022, 0.85),
  spectators: P(true, 3, 0.012, -0.06, 0.9),
};

export const STREAMER: HudLayout = {
  speed: P(true, 7, 0, -0.2, 1.25),
  timer: P(true, 7, 0, -0.148, 1.2),
  split: P(true, 7, 0.085, -0.15, 1.05),
  track: P(true, 7, 0, -0.29, 1.1),
  stage: P(true, 2, -0.012, 0.09, 1.1),
  stats: P(true, 7, 0, -0.105),
  sync: P(true, 7, 0, -0.055, 1.1),
  keys: P(true, 6, 0.02, -0.04, 1.45),
  ghostKeys: P(true, 6, 0.15, -0.04, 1.0),
  graph: P(true, 8, -0.02, -0.04, 1.2),
  jumpStats: P(true, 5, -0.02, 0, 1.1),
  startPre: P(false, 7, -0.09, -0.2, 1.25),
  strafeOffsets: P(false, 4, 0, -0.13, 0.85),
  firstJump: P(false, 4, 0, -0.104, 0.85),
  longJump: P(false, 4, 0, -0.185, 1.1),
  map: P(true, 0, 0.012, 0.016, 1.1),
  pb: P(true, 2, -0.012, 0.016, 1.2),
  fps: P(true, 2, -0.012, 0.055),
  chat: P(true, 3, 0.015, 0.12),
  strafeTrainer: P(false, 1, 0, 0.22, 1.15),
  ammo: P(true, 8, -0.02, -0.125, 1.1),
  // Above the chat, which sits at left middle here.
  spectators: P(true, 3, 0.015, -0.14),
};

/**
 * Placements the movement elements and the jump stats had before v0.0.25 grouped them (the same in every preset, except
 * Minimal's jump stats). A saved layout still holding one of these exactly was never moved there: settings.ts moves it
 * to its preset's current placement (the preset whose speed placement the layout has; else Classic), keeping on / off.
 * Anything the player placed themselves stays where it is.
 */
const RETIRED_PLACES: Partial<Record<HudElId, Omit<HudPlace, "on">[]>> = {
  jumpStats: [{ a: 4, x: 0, y: -0.1, s: 1 }, { a: 4, x: 0, y: -0.08, s: 0.85 }],
  startPre: [{ a: 4, x: 0, y: -0.065, s: 0.85 }],
  strafeOffsets: [{ a: 4, x: 0, y: -0.2, s: 0.85 }],
  firstJump: [{ a: 4, x: 0, y: -0.16, s: 0.85 }],
  longJump: [{ a: 4, x: 0, y: -0.27, s: 0.9 }],
};

const samePlace = (p: Partial<HudPlace> | undefined, q: Omit<HudPlace, "on">) => !!p && p.a === q.a && p.x === q.x && p.y === q.y && p.s === q.s;

/** Moves never-moved elements off their retired placements (RETIRED_PLACES). Mutates `layout`. */
export function moveRetiredPlaces(layout: Record<string, Partial<HudPlace> | undefined>): void {
  const preset = [MINIMAL, STREAMER].find((l) => samePlace(layout.speed, l.speed)) ?? CLASSIC;
  for (const [id, olds] of Object.entries(RETIRED_PLACES) as [HudElId, Omit<HudPlace, "on">[]][]) {
    const p = layout[id];
    if (!p || typeof p !== "object" || !olds.some((o) => samePlace(p, o))) continue;
    const n = preset[id];
    // Streamer's jump stats never moved (right side): leave it.
    if (!olds.some((o) => samePlace(n, o))) Object.assign(p, { a: n.a, x: n.x, y: n.y, s: n.s });
  }
}

export const PRESETS: { id: string; label: string; layout: HudLayout }[] = [
  { id: "classic", label: "Classic centred", layout: CLASSIC },
  { id: "minimal", label: "Minimal", layout: MINIMAL },
  { id: "streamer", label: "Streamer", layout: STREAMER },
];

export const cloneLayout = (l: HudLayout): HudLayout => JSON.parse(JSON.stringify(l));

export function sameLayout(a: HudLayout, b: HudLayout): boolean {
  return HUD_ELEMENTS.every(({ id }) => {
    const p = a[id];
    const q = b[id];
    return p.on === q.on && p.a === q.a && Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.y - q.y) < 1e-4 && Math.abs(p.s - q.s) < 1e-3;
  });
}

export const clampScale = (s: number) => Math.round(Math.max(0.4, Math.min(3, s)) * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Re-anchors an element from its on-screen rect (CSS px): picks the 9-grid cell containing the
 * rect's centre and expresses the matching rect point as an offset from that screen point.
 */
export function placeFromRect(r: { left: number; top: number; width: number; height: number }, vw: number, vh: number, prev: HudPlace): HudPlace {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const col = cx < vw / 3 ? 0 : cx < (2 * vw) / 3 ? 1 : 2;
  const row = cy < vh / 3 ? 0 : cy < (2 * vh) / 3 ? 1 : 2;
  const a = row * 3 + col;
  const px = r.left + (col / 2) * r.width;
  const py = r.top + (row / 2) * r.height;
  return { on: prev.on, a, x: round4((px - (col / 2) * vw) / vw), y: round4((py - (row / 2) * vh) / vh), s: prev.s };
}

/** CSS for an element's position (applied once per layout change, never per frame). */
export function placeStyle(p: HudPlace): { left: string; top: string; translate: string } {
  const ax = anchorX(p.a);
  const ay = anchorY(p.a);
  return {
    left: `${((ax + p.x) * 100).toFixed(3)}%`,
    top: `${((ay + p.y) * 100).toFixed(3)}%`,
    translate: `${-ax * 100}% ${-ay * 100}%`,
  };
}

// ---------------------------------------------------------------------------------------------
// Share string. Binary, then base64url: version byte, then per element (fixed order):
// [on<<7 | anchor] [x int16 (1e-4 units)] [y int16] [scale uint8 (/50)], then the keys block:
// [style] [opacity *100] [rows bitmask] [pressed rgb] [idle rgb].

export type KeysStyle = "classic" | "keycaps" | "minimal";
export const KEY_STYLES: KeysStyle[] = ["classic", "keycaps", "minimal"];

export interface KeysPrefs {
  style: KeysStyle;
  opacity: number;
  pressed: string;
  idle: string;
  rows: { wasd: boolean; actions: boolean; mouse: boolean };
}

export const DEFAULT_KEYS: KeysPrefs = {
  style: "keycaps",
  opacity: 1,
  pressed: "#ffffff",
  idle: "#9aa3b2",
  rows: { wasd: true, actions: true, mouse: true },
};

// Version byte: 1 = first 14, 2 = first 15, 3 = first 16, 4 = first 17 (through strafe trainer), 5 = first 18,
// 6 = first 21 (through longjump stats), 7 = all.
// Elements an older code doesn't carry keep the Classic placement. The "bhl1." prefix names the format.
const VERSION = 7;
const ELEMENTS_IN: Record<number, number> = { 1: 14, 2: 15, 3: 16, 4: 17, 5: 18, 6: 21, [VERSION]: HUD_ELEMENTS.length };
const PREFIX = "bhl1.";

function rgb(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

export function encodeLayout(layout: HudLayout, keys: KeysPrefs): string {
  const bytes: number[] = [VERSION];
  for (const { id } of HUD_ELEMENTS) {
    const p = layout[id];
    bytes.push(((p.on ? 1 : 0) << 7) | (p.a & 15));
    for (const v of [p.x, p.y]) {
      const i = Math.max(-32768, Math.min(32767, Math.round(v * 10000))) & 0xffff;
      bytes.push(i >> 8, i & 255);
    }
    bytes.push(Math.max(1, Math.min(255, Math.round(p.s * 50))));
  }
  const rows = (keys.rows.wasd ? 1 : 0) | (keys.rows.actions ? 2 : 0) | (keys.rows.mouse ? 4 : 0);
  bytes.push(Math.max(0, KEY_STYLES.indexOf(keys.style)), Math.round(keys.opacity * 100), rows, ...rgb(keys.pressed), ...rgb(keys.idle));
  const b64 = btoa(String.fromCharCode(...bytes));
  return PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parses a share string; null if it isn't one. */
export function decodeLayout(s: string): { layout: HudLayout; keys: KeysPrefs } | null {
  s = s.trim();
  if (!s.startsWith(PREFIX)) return null;
  let bytes: Uint8Array;
  try {
    const b64 = s.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const n = ELEMENTS_IN[bytes[0]] ?? 0;
  if (!n || bytes.length < 1 + n * 6) return null;
  const layout = cloneLayout(CLASSIC);
  let o = 1;
  const i16 = (hi: number, lo: number) => (((hi << 8) | lo) << 16) >> 16;
  for (const { id } of HUD_ELEMENTS.slice(0, n)) {
    const head = bytes[o];
    const a = head & 15;
    if (a > 8) return null;
    layout[id] = {
      on: !!(head & 128),
      a,
      x: Math.max(-1, Math.min(1, i16(bytes[o + 1], bytes[o + 2]) / 10000)),
      y: Math.max(-1, Math.min(1, i16(bytes[o + 3], bytes[o + 4]) / 10000)),
      s: clampScale(bytes[o + 5] / 50),
    };
    o += 6;
  }
  const keys: KeysPrefs = JSON.parse(JSON.stringify(DEFAULT_KEYS));
  if (bytes.length >= o + 9) {
    keys.style = KEY_STYLES[bytes[o]] ?? DEFAULT_KEYS.style;
    keys.opacity = Math.max(0.1, Math.min(1, bytes[o + 1] / 100));
    keys.rows = { wasd: !!(bytes[o + 2] & 1), actions: !!(bytes[o + 2] & 2), mouse: !!(bytes[o + 2] & 4) };
    keys.pressed = hex(bytes[o + 3], bytes[o + 4], bytes[o + 5]);
    keys.idle = hex(bytes[o + 6], bytes[o + 7], bytes[o + 8]);
  }
  return { layout, keys };
}
