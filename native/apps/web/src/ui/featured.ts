// Featured map and the menu background pick (attract.ts; the home screen's map plate names it).
//
//  - Featured: daily rotation over a short list of good-looking, quick-to-load maps, skipping the
//    map you last played (that one already has "Continue").
//  - Background: your most recent PB that has a replay (the PB ghost runs it), else the featured map
//    as a cinematic tour. Huge maps are never downloaded just for the background.
//  - First visit (nothing played yet): today's first map (first-map.ts), so the featured Play, the menu
//    background and onboarding all point new players at the same short, friendly tier 1 map.
//  - Winter (December 1 to January 7, Snow Day's window) with Snow and rain on: the background comes from the
//    Winter maps that snow (WINTER_BACKGROUNDS): your latest PB on one of them, else a tour of one, a new one each day.
//    Not on a first visit.
//
// `?attract=<map>` forces both (testing).

import { appLocation } from "../platform/navigation";
import { getPB, loadPBReplay } from "../pb";
import { fetchMapIndex, type MapEntry } from "./maps";
import { firstMapOfTheDay } from "./first-map";
import { WINTER_MAPS, winterSeasonOf } from "../progression";
import { prefs } from "./settings";

/** Hand-picked: they look good from the menu camera and download fast. */
const CURATED = ["bhop_choice", "bhop_danmark", "bhop_metal_v2", "bhop_eazy", "bhop_bless"];
/** Larger maps are never picked as a menu background. */
const MAX_BACKGROUND_BYTES = 32 << 20;

const forced = () => appLocation().searchParams.get("attract");

/**
 * The Winter maps the menu background picks from in the winter window: ones with falling snow (func_precipitation)
 * whose snow column map takes under 100 ms to trace (research/PRECIPITATION.md) and that are under
 * MAX_BACKGROUND_BYTES. (bhop_ambience_xmas: near the client's memory limit; bhop_jago, bhop_kaunisnimi,
 * bhop_stref_siberia, bhop_monster_jam_xmas: too big; the rest of the collection has no snowfall.)
 */
export const WINTER_BACKGROUNDS: readonly (typeof WINTER_MAPS)[number][] = ["bhop_boxes_snowy", "bhop_frost_bite_v1", "bhop_strafe_winter", "bhop_strafing_in_siberia", "bhop_christmas"];

/** In the winter window (UTC, as Snow Day) with snow on: the maps the background picks from, else null (as always). */
export function winterBackgrounds(maps: readonly MapEntry[], now: number, snowOn: boolean): MapEntry[] | null {
  if (!snowOn || winterSeasonOf(now) === null) return null;
  const pool = WINTER_BACKGROUNDS.map((n) => maps.find((m) => m.name === n)).filter((m): m is MapEntry => !!m && (m.size ?? Infinity) <= MAX_BACKGROUND_BYTES);
  return pool.length ? pool : null;
}

/** The pool's map for today (by UTC day), skipping `last` (it already has "Continue") when there is another. */
export function dailyPick(pool: readonly MapEntry[], last: string | null, now: number): MapEntry | null {
  const left = pool.length > 1 ? pool.filter((m) => m.name !== last) : pool;
  return left.length ? left[Math.floor(now / 86_400_000) % left.length] : null;
}

let featuredCache: Promise<MapEntry | null> | null = null;

export function featuredMap(): Promise<MapEntry | null> {
  featuredCache ??= (async () => {
    const maps = await fetchMapIndex();
    if (!maps.length) return null;
    const f = forced();
    if (f) return maps.find((m) => m.name === f) ?? null;
    let pool = CURATED.map((n) => maps.find((m) => m.name === n)).filter((m): m is MapEntry => !!m);
    if (!pool.length) pool = maps.filter((m) => (m.size ?? 0) <= MAX_BACKGROUND_BYTES).sort((a, b) => (a.size ?? 0) - (b.size ?? 0)).slice(0, 3);
    if (!pool.length) return null;
    const last = localStorage.getItem("bunnyhop:last-map");
    const first = firstMapOfTheDay();
    const start = maps.find((m) => m.name === first);
    if (!last && start) return start;
    return dailyPick(pool, last, Date.now());
  })();
  return featuredCache;
}

// The menu background (attract.ts) waits for the home screen's first paint (or a short timeout) before its multi-megabyte
// map download competes for the network and the main thread. (The name says "art": the home used to show a picture.)
let artReady: () => void = () => {};
const artReadyP = new Promise<void>((r) => (artReady = r));
export const markFeaturedArtReady = () => artReady();
export const featuredArtReady = (timeoutMs: number) => Promise.race([artReadyP, new Promise<void>((r) => setTimeout(r, timeoutMs))]);

export interface BackgroundPick {
  map: MapEntry;
  /** PB replay bytes to run as a ghost, or null for a map tour. */
  pbReplay: Uint8Array | null;
}

const picks = new Map<string, Promise<BackgroundPick | null>>();

/** One answer per page load (the home's map plate and attract.ts ask the same question). */
export function backgroundPick(style = "autohop"): Promise<BackgroundPick | null> {
  let p = picks.get(style);
  if (!p) picks.set(style, (p = pickBackground(style)));
  return p;
}

async function pickBackground(style: string): Promise<BackgroundPick | null> {
  const maps = await fetchMapIndex();
  const f = forced();
  // (Not on a first visit: the background, Play and onboarding stay on today's first map, firstMapOfTheDay.)
  const last = localStorage.getItem("bunnyhop:last-map");
  const winter = f || !last ? null : winterBackgrounds(maps, Date.now(), prefs.get().graphics.precipitation !== "off");
  if (!f) {
    const withPB = (winter ?? maps)
      .filter((m) => (m.size ?? Infinity) <= MAX_BACKGROUND_BYTES)
      .map((m) => ({ m, pb: getPB(m.name, style) }))
      .filter((x) => x.pb)
      .sort((a, b) => (b.pb!.date ?? 0) - (a.pb!.date ?? 0))
      .slice(0, 3);
    for (const { m } of withPB) {
      const bytes = await loadPBReplay(m.name, style);
      if (bytes) return { map: m, pbReplay: bytes };
    }
  }
  if (winter) {
    const m = dailyPick(winter, last, Date.now());
    if (m) return { map: m, pbReplay: null };
  }
  const m = await featuredMap();
  return m ? { map: m, pbReplay: f ? await loadPBReplay(m.name, style) : null } : null;
}
