// Timer zones: axis-aligned boxes in Source coordinates, grouped into tracks (0 = main, 1+ = bonus N).
// DOM-free so the headless verifier (tools/verify) can share the exact same logic.
//
// Sources, in priority order (see loadZones):
//   1. localStorage override written by the in-game zone editor
//   2. maps/<map>.zones.json served from the vite publicDir (hand-made, or imported from srcwr/zones-cstrike
//      with tools/zones/import-srcwr.ts)
//   3. auto-detection from map entities (trigger names / KZ buttons) + BSP model bounds
//
// File format (maps/<map>.zones.json):
//   {
//     "map": "bhop_eazy",
//     "zones": [
//       { "kind": "start", "mins": [x,y,z], "maxs": [x,y,z] },                 // track omitted = 0 (main)
//       { "kind": "end",   "track": 1, "mins": [...], "maxs": [...] },         // bonus 1
//       { "kind": "stage", "index": 2, "mins": [...], "maxs": [...] },         // split: stage 2 begins here
//       { "kind": "checkpoint", "index": 1, "mins": [...], "maxs": [...] }     // split on a linear map
//     ],
//     "provenance": { "source": "srcwr", ... }                                  // informational only
//   }
// Version 1 files ({kind: start|end} only) are a subset of this and load unchanged.

export type ZoneKind = "start" | "end" | "stage" | "checkpoint";

export const ZONE_KINDS: readonly ZoneKind[] = ["start", "end", "stage", "checkpoint"];

export interface Zone {
  kind: ZoneKind;
  mins: [number, number, number];
  maxs: [number, number, number];
  /** 0 = main track, N = bonus N. Omitted means 0. */
  track?: number;
  /** Stage / checkpoint number (1-based ordering of splits within the track). */
  index?: number;
}

/** Where a zone set came from (stored in the zones file; not part of the canonical form or replays). */
export interface ZoneProvenance {
  source: string;
  [k: string]: unknown;
}

export interface ZoneSet {
  map: string;
  zones: Zone[];
  /** Where the zones came from (for display only; not part of the canonical form). */
  source?: string;
  provenance?: ZoneProvenance;
}

/** Player hull (CS:S): 32x32, 62 tall standing, 45 ducked; origin at the feet. */
export const HULL_HALF_WIDTH = 16;
export const HULL_HEIGHT = 62;
export const HULL_HEIGHT_DUCKED = 45;

export const trackOf = (z: Pick<Zone, "track">): number => z.track ?? 0;

export function trackName(track: number): string {
  return track === 0 ? "Main" : `Bonus ${track}`;
}

/** Short label for HUD / file names: "" for main, "b1", "b2", ... */
export function trackSuffix(track: number): string {
  return track === 0 ? "" : `b${track}`;
}

/** Player AABB vs zone box overlap (touching counts). Pure f64 comparisons on exact f32 inputs: deterministic. */
export function playerInZone(pos: readonly number[], crouched: boolean, z: Zone): boolean {
  const h = crouched ? HULL_HEIGHT_DUCKED : HULL_HEIGHT;
  return (
    pos[0] - HULL_HALF_WIDTH <= z.maxs[0] &&
    pos[0] + HULL_HALF_WIDTH >= z.mins[0] &&
    pos[1] - HULL_HALF_WIDTH <= z.maxs[1] &&
    pos[1] + HULL_HALF_WIDTH >= z.mins[1] &&
    pos[2] <= z.maxs[2] &&
    pos[2] + h >= z.mins[2]
  );
}

/** True if the player touches a zone of `kind` (optionally restricted to one track). */
export function inAny(pos: readonly number[], crouched: boolean, zones: readonly Zone[], kind: ZoneKind, track?: number): boolean {
  for (const z of zones) if (z.kind === kind && (track === undefined || trackOf(z) === track) && playerInZone(pos, crouched, z)) return true;
  return false;
}

/** First zone of `kind` the player touches (lowest track first, then file order), or null. */
export function touching(pos: readonly number[], crouched: boolean, zones: readonly Zone[], kind: ZoneKind, track?: number): Zone | null {
  let best: Zone | null = null;
  for (const z of zones) {
    if (z.kind !== kind || (track !== undefined && trackOf(z) !== track) || !playerInZone(pos, crouched, z)) continue;
    if (!best || trackOf(z) < trackOf(best)) best = z;
  }
  return best;
}

/** Sorted list of tracks that have both a start and an end zone. */
export function tracksOf(zones: readonly Zone[]): number[] {
  const starts = new Set(zones.filter((z) => z.kind === "start").map(trackOf));
  const ends = new Set(zones.filter((z) => z.kind === "end").map(trackOf));
  return [...starts].filter((t) => ends.has(t)).sort((a, b) => a - b);
}

/** Number of split zones (distinct stage/checkpoint indices) on a track. */
export function splitCount(zones: readonly Zone[], track: number): number {
  return new Set(zones.filter((z) => (z.kind === "stage" || z.kind === "checkpoint") && trackOf(z) === track).map((z) => z.index ?? 0)).size;
}

/** Normalises a box so mins <= maxs and coordinates are f32 (they are stored as f32 in replays). */
export function normalizeZone(kind: ZoneKind, a: readonly number[], b: readonly number[], track = 0, index?: number): Zone {
  const mins = [0, 1, 2].map((i) => Math.fround(Math.min(a[i], b[i]))) as [number, number, number];
  const maxs = [0, 1, 2].map((i) => Math.fround(Math.max(a[i], b[i]))) as [number, number, number];
  const z: Zone = { kind, mins, maxs };
  if (track) z.track = track;
  if ((kind === "stage" || kind === "checkpoint") && index !== undefined) z.index = index;
  return z;
}

export function parseZoneSet(json: unknown, map: string, source: string): ZoneSet | null {
  if (!json || typeof json !== "object") return null;
  const list = (json as { zones?: unknown }).zones;
  if (!Array.isArray(list)) return null;
  const zones: Zone[] = [];
  for (const z of list) {
    if (!z || !ZONE_KINDS.includes(z.kind)) continue;
    if (!Array.isArray(z.mins) || !Array.isArray(z.maxs) || z.mins.length !== 3 || z.maxs.length !== 3) continue;
    const track = Number.isInteger(z.track) && z.track > 0 && z.track < 256 ? z.track : 0;
    const index = Number.isInteger(z.index) && z.index >= 0 && z.index < 256 ? z.index : z.kind === "stage" || z.kind === "checkpoint" ? 0 : undefined;
    zones.push(normalizeZone(z.kind, z.mins.map(Number), z.maxs.map(Number), track, index));
  }
  if (!tracksOf(zones).length) return null;
  const prov = (json as { provenance?: unknown }).provenance;
  const set: ZoneSet = { map, zones, source };
  if (prov && typeof prov === "object" && typeof (prov as ZoneProvenance).source === "string") set.provenance = prov as ZoneProvenance;
  return set;
}

function zoneJson(z: Zone): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: z.kind };
  if (trackOf(z)) o.track = trackOf(z);
  if (z.index !== undefined) o.index = z.index;
  o.mins = z.mins;
  o.maxs = z.maxs;
  return o;
}

/**
 * Canonical JSON (what the editor saves and what zone hashes are computed over). Main-track start/end-only
 * sets serialise exactly as version 1 did. Provenance, when present, is appended after the zones.
 */
export function zoneSetToJson(set: ZoneSet, withProvenance = false): string {
  const body: Record<string, unknown> = { map: set.map, zones: set.zones.map(zoneJson) };
  if (withProvenance && set.provenance) body.provenance = set.provenance;
  return JSON.stringify(body, null, 2) + "\n";
}

export function zonesEqual(a: readonly Zone[], b: readonly Zone[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (z, i) =>
      z.kind === b[i].kind &&
      trackOf(z) === trackOf(b[i]) &&
      (z.index ?? 0) === (b[i].index ?? 0) &&
      z.mins.every((v, j) => v === b[i].mins[j]) &&
      z.maxs.every((v, j) => v === b[i].maxs[j]),
  );
}

// ---------------------------------------------------------------------------
// BSP model bounds (read straight from the BSP header so no wasm changes are needed)

const LUMP_MODELS = 14;

/** dmodel_t bounds per brush model index, or null if the lump is unreadable (e.g. LZMA-compressed). */
export function bspModelBounds(bsp: Uint8Array): { mins: number[]; maxs: number[] }[] | null {
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  if (bsp.byteLength < 1036 || dv.getUint32(0, true) !== 0x50534256 /* "VBSP" */) return null;
  const lump = 8 + LUMP_MODELS * 16;
  const ofs = dv.getInt32(lump, true);
  const len = dv.getInt32(lump + 4, true);
  const uncompressed = dv.getInt32(lump + 12, true);
  if (uncompressed !== 0 || ofs <= 0 || len <= 0 || ofs + len > bsp.byteLength) return null;
  const out: { mins: number[]; maxs: number[] }[] = [];
  for (let p = ofs; p + 48 <= ofs + len; p += 48) {
    const f = (i: number) => dv.getFloat32(p + i * 4, true);
    out.push({ mins: [f(0), f(1), f(2)], maxs: [f(3), f(4), f(5)] });
  }
  return out;
}

const START_NAMES = /^(timer_start(zone)?|mod_zone_start|zone_start|start_?zone|climb_startzone)$/i;
const END_NAMES = /^(timer_end(zone)?|timer_stop(zone)?|mod_zone_end|zone_end|end_?zone|climb_endzone)$/i;
const BONUS_START = /^(timer_bonus_?start(zone)?|mod_zone_bonus_start|zone_bonus_start|bonus_?start_?zone)$/i;
const BONUS_END = /^(timer_bonus_?end(zone)?|mod_zone_bonus_end|zone_bonus_end|bonus_?end_?zone)$/i;
const START_BUTTONS = /^climb_start(button)?$/i;
const END_BUTTONS = /^climb_end(button)?$/i;

function vec(s: string | undefined): number[] {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? v : [0, 0, 0];
}

/**
 * Auto-detects timer zones from entity keyvalues.
 * - trigger_multiple named like timer_startzone / mod_zone_start / ... -> exact brush bounds
 *   (mod_zone_bonus_start / ..._end -> bonus 1)
 * - KZ func_button named climb_startbutton / climb_endbutton -> button bounds padded by 48u
 *   (the button press is approximated by touching an area around it).
 */
export function detectZones(entities: Record<string, string>[], bounds: { mins: number[]; maxs: number[] }[] | null, map: string): ZoneSet | null {
  if (!bounds) return null;
  const zones: Zone[] = [];
  for (const e of entities) {
    const name = e.targetname ?? "";
    const cls = e.classname ?? "";
    const model = e.model?.startsWith("*") ? Number(e.model.slice(1)) : NaN;
    const b = bounds[model];
    if (!b) continue;
    const o = vec(e.origin);
    let kind: ZoneKind | null = null;
    let track = 0;
    let pad = 0;
    if (cls.startsWith("trigger_") && START_NAMES.test(name)) kind = "start";
    else if (cls.startsWith("trigger_") && END_NAMES.test(name)) kind = "end";
    else if (cls.startsWith("trigger_") && BONUS_START.test(name)) (kind = "start"), (track = 1);
    else if (cls.startsWith("trigger_") && BONUS_END.test(name)) (kind = "end"), (track = 1);
    else if (cls === "func_button" && START_BUTTONS.test(name)) (kind = "start"), (pad = 48);
    else if (cls === "func_button" && END_BUTTONS.test(name)) (kind = "end"), (pad = 48);
    if (!kind) continue;
    zones.push(
      normalizeZone(
        kind,
        b.mins.map((v, i) => v + o[i] - pad),
        b.maxs.map((v, i) => v + o[i] + pad),
        track,
      ),
    );
  }
  if (!tracksOf(zones).length) return null;
  return { map, zones, source: "entities" };
}

export const zoneStorageKey = (map: string) => `bunnyhop:zones:${map}`;

/**
 * Browser loader: editor override -> server-pinned zones (when the API is up and pinned them for this exact BSP; the
 * caller fetches them) -> maps/<map>.zones.json -> entity detection. Null = no zones anywhere.
 * Pinned zones outrank the local file so the zones a run is timed with match what the server verifies against.
 */
export async function loadZones(map: string, entities: Record<string, string>[], bsp: Uint8Array, pinned?: unknown): Promise<ZoneSet | null> {
  try {
    const local = globalThis.localStorage?.getItem(zoneStorageKey(map));
    if (local) {
      const set = parseZoneSet(JSON.parse(local), map, "editor (localStorage)");
      if (set) return set;
    }
  } catch {
    /* ignore */
  }
  if (pinned) {
    const set = parseZoneSet(pinned, map, "server (pinned)");
    if (set) return set;
  }
  try {
    const res = await fetch(`/${map}.zones.json`);
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const set = parseZoneSet(await res.json(), map, `${map}.zones.json`);
      if (set) {
        if (set.provenance?.source === "srcwr") set.source = `${map}.zones.json (srcwr/zones-cstrike)`;
        return set;
      }
    }
  } catch {
    /* ignore */
  }
  return detectZones(entities, bspModelBounds(bsp), map);
}
