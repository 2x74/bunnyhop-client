// Map backgrounds for world record holders (v0.0.43, lane wrcard; design: bh-archive/v0043/reports/wrcard.md).
//
// Hold the world record on a map and that map's in-engine render can be your card background (profile card, mini
// profile, Discord and link previews). The choice is a map name stored next to `background` (profiles.cosmetics
// .mapBg); every read checks the record again (apps/api src/map-bg.ts), so losing it shows `background` again with
// nothing written, and taking it back brings the map back.
//
// The rules below are the designer's picks; the owner has not ruled on them. Each is one value here, read by the API,
// the client and the tests alike.

/**
 * Styles whose world records count: the eight that earn progression (styles.ts earnsProgression), in the order the
 * card names them when one map is held in several (Normal first). The owner's other idea: ["autohop", "legit"]
 * (Normal and EZ Scroll only).
 */
export const MAP_BG_STYLES: readonly string[] = ["autohop", "legit", "scroll", "wonly", "sideways", "hsw", "backwards", "adonly"];

/** Finishers the board needs, the holder included, counted over the rows the viewer may see. */
export const MAP_BG_MIN_FINISHERS = 3;

/** Tracks whose records count: the main course only (0). Bonus tracks would be [0, 1, 2, ...]. */
export const MAP_BG_TRACKS: readonly number[] = [0];

/**
 * A tie: false = the earlier run holds it (the boards, the run announcer, recent WRs and snipes all say so); true = every
 * tied player may use the map.
 */
export const MAP_BG_TIES_SHARED = false;

/** The small "WR <map> <time>" line on the card (profile, mini profile, embed). */
export const MAP_BG_LINE = true;

/** Guests may use it like every other card item; false = signed-in accounts only. */
export const MAP_BG_GUESTS = true;

/**
 * How much of the per-map dim (maps/index.json cardDim, 0.10 to 0.50 from the render's brightness: tools/thumbs/card-dim.py)
 * is applied: 1 = as measured, 0 = no extra dim (bright snow maps then read weaker). MAP_BG_DIM_DEFAULT is used for a map
 * without a measured value.
 */
export const MAP_BG_DIM_SCALE = 1;
export const MAP_BG_DIM_DEFAULT = 0.3;

/** A map name as stored (the same shape as map file names). */
export const MAP_NAME_RE = /^[\w.-]{1,64}$/;

/** The dim drawn for a map's measured value (null: not measured), 0 to 0.6. */
export function mapBgDim(cardDim: number | null | undefined): number {
  const d = typeof cardDim === "number" && Number.isFinite(cardDim) ? cardDim : MAP_BG_DIM_DEFAULT;
  return Math.round(Math.max(0, Math.min(0.6, d * MAP_BG_DIM_SCALE)) * 100) / 100;
}

/** Sort key of a style for "the first in style order". */
export function mapBgStyleOrder(style: string): number {
  const i = MAP_BG_STYLES.indexOf(style);
  return i < 0 ? MAP_BG_STYLES.length : i;
}

/**
 * A map background as the card draws it (GET /players/:id and /card `mapBg`, GET /me/map-backgrounds rows): the map,
 * the record that holds it (style, time in seconds, run), and its pictures from the catalogue (`hero` 1280x720 for the
 * profile card, `card` 480x270 for the mini profile and the picker; null when the map has no in-engine render) with the
 * dim to draw over them.
 */
export interface MapBgView {
  map: string;
  style: string;
  time: number;
  runId: string;
  hero: string | null;
  card: string | null;
  dim: number;
}
