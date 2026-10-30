// Custom start point (bhoptimer's !setstart): a spot and view inside a track's start zone that R / B / M restart you
// at instead of the zone centre. Saved per map and track in localStorage. DOM-free apart from the default store
// (apps/api/test/start-point.test.ts runs it); session.ts wires it in, research/TIMER-RULES.md has the rules.
//
// A restart to a start point is an ordinary restart (core.setPosition: zero velocity, standing, settled onto the
// floor, the timer reset); only the position and view differ. The replay records the point like any restart point
// and the verifier checks it like any other (restart.ts restartPointProblem, verifier.ts restartPointAllowed).
//
// Practice spawns: where practice works (solo) the same command saves a spot anywhere you stand still, and so does a
// spot in the start zone after a noclip or checkpoint teleport. Restarts from one are practice attempts (session.ts
// resetCore): never submitted, and the verifier would refuse such a replay anyway. The timer works as ever, from the
// start zone.

import { applyRestartPoint, restartPoint, type Core, type PlayerState, type RestartPoint, type Settings } from "./core";
import { restartPointProblem, withRestartNames } from "./restart";
import { restartPointAllowed } from "./verifier";
import { HULL_HALF_WIDTH, HULL_HEIGHT, trackName, trackOf, type Zone } from "./zones";

export interface StartPoint {
  /** Feet position, exactly as the core reported it while standing there (f32 values). */
  position: [number, number, number];
  /** View when it was saved: yaw goes to the core with the position, pitch only to the camera. */
  yaw: number;
  pitch: number;
  /** A practice spawn: restarts from it are practice attempts (it isn't a valid start for a ranked run). */
  practice?: true;
}

/** Why a saved spawn is practice: it's outside the start zone, or noclip / a checkpoint teleport got you to it. */
export type PracticeSpawn = "outside" | "tool";

/** Speed (u/s) under which the player counts as standing still. Friction stops a walking player at exactly 0. */
export const STILL_SPEED = 1;

/**
 * The standing player at `pos` lies inside start zone `z`: the 32x32 footprint entirely inside it horizontally, and
 * the standing hull overlapping it vertically like the timer's test (zones.ts playerInZone). Vertically it's only an
 * overlap because zones are often drawn from 1 unit above the floor (bhoptimer) or float above it (bhop_monster_jam).
 */
export function startZoneHolds(z: Zone, pos: readonly number[]): boolean {
  return (
    z.kind === "start" &&
    pos[0] - HULL_HALF_WIDTH >= z.mins[0] &&
    pos[0] + HULL_HALF_WIDTH <= z.maxs[0] &&
    pos[1] - HULL_HALF_WIDTH >= z.mins[1] &&
    pos[1] + HULL_HALF_WIDTH <= z.maxs[1] &&
    pos[2] <= z.maxs[2] &&
    pos[2] + HULL_HEIGHT >= z.mins[2]
  );
}

/** Start zone (lowest track first) that holds the standing player at `pos`, or null. */
export function holdingStartZone(pos: readonly number[], zones: readonly Zone[], track?: number): Zone | null {
  let best: Zone | null = null;
  for (const z of zones) {
    if (track !== undefined && trackOf(z) !== track) continue;
    if (startZoneHolds(z, pos) && (!best || trackOf(z) < trackOf(best))) best = z;
  }
  return best;
}

const touchesStart = (pos: readonly number[], zones: readonly Zone[]) =>
  zones.some(
    (z) =>
      z.kind === "start" &&
      pos[0] + HULL_HALF_WIDTH >= z.mins[0] && pos[0] - HULL_HALF_WIDTH <= z.maxs[0] &&
      pos[1] + HULL_HALF_WIDTH >= z.mins[1] && pos[1] - HULL_HALF_WIDTH <= z.maxs[1] &&
      pos[2] <= z.maxs[2] && pos[2] + HULL_HEIGHT >= z.mins[2],
  );

export type StartPointCheck = { ok: true; track: number; point: StartPoint; practice: PracticeSpawn | null } | { ok: false; reason: string };

/**
 * Whether the player can save a start point where they stand (and for which track), else the reason. Rules:
 * - the whole standing footprint inside a start zone, so the restart never begins straddling the zone's edge. Where
 *   practice works (`o.offZone`) any other spot is a practice spawn instead, on the current track `o.track`;
 * - a spot reached with noclip or a checkpoint teleport (`o.tool`: this attempt used one) is a practice spawn too: those
 *   reach places a run can't walk to (the restart is checked again when it's used: resolveStartPoint);
 * - on the ground: no height or fall to start from, and the spot is somewhere you can walk to;
 * - standing, not crouched: restarts always stand you up, and a spot only the ducked hull fits isn't one the
 *   restart can put you at (the core would lift you onto whatever is above);
 * - standing still: no speed to carry anyway (restarts zero it), but a still player is really resting there, not
 *   sliding down a slope or riding something that moves.
 */
export function checkStartPoint(
  s: Pick<PlayerState, "position" | "velocity" | "grounded" | "crouched" | "onLadder">,
  view: { yaw: number; pitch: number },
  zones: readonly Zone[],
  o: { track: number; offZone: boolean; tool: boolean },
): StartPointCheck {
  const zone = holdingStartZone(s.position, zones);
  if (!zone && !o.offZone) return { ok: false, reason: touchesStart(s.position, zones) ? "Move further into the start zone" : "Stand inside the start zone" };
  if (!s.grounded || s.onLadder) return { ok: false, reason: "Stand on the ground" };
  if (s.crouched) return { ok: false, reason: "Stand up" };
  if (Math.hypot(s.velocity[0], s.velocity[1], s.velocity[2]) > STILL_SPEED) return { ok: false, reason: "Stand still" };
  const practice: PracticeSpawn | null = !zone ? "outside" : o.tool ? "tool" : null;
  const point: StartPoint = { position: [s.position[0], s.position[1], s.position[2]], yaw: normalizeYaw(view.yaw), pitch: clampPitch(view.pitch), ...(practice ? { practice: true as const } : {}) };
  return { ok: true, track: zone ? trackOf(zone) : o.track, point, practice };
}

/**
 * How far the core may move a saved spot when it settles it onto the floor. Normally it doesn't move at all; on a few
 * maps the settle trace and the movement disagree about the floor by a unit or two (bhop_eject: 1.9, bhop_cynical:
 * 1.2). Further than this and the restart wouldn't be where you stood.
 */
export const SETTLE_TOLERANCE = 4;

/**
 * The restart point a saved start point gives on the loaded map, or null if it isn't a valid one (any more): the
 * core settles the spot (it must stay within SETTLE_TOLERANCE), and the settled point must pass what the verifier
 * checks (restart.ts restartPointProblem, verifier.ts restartPointAllowed) and still have the whole footprint in one
 * of the track's start zones. A practice spawn only has to be a spot the core settles and stands on: its attempts are
 * never submitted. Probes the core: reset it afterwards (or wrap the call in core.ts withRestoredState).
 */
export function resolveStartPoint(core: Core, settings: Settings, map: string, track: number, sp: StartPoint, zones: readonly Zone[]): RestartPoint | null {
  core.setSettings(settings);
  core.reset();
  const at: RestartPoint = { position: [...sp.position], yaw: sp.yaw };
  applyRestartPoint(core, sp.practice ? at : withRestartNames(at, map, track));
  const p = restartPoint(core);
  if (!p) return null;
  const [x, y, z] = sp.position;
  const f = Math.fround;
  if (!Object.is(p.position[0], f(x)) || !Object.is(p.position[1], f(y)) || Math.abs(p.position[2] - z) > SETTLE_TOLERANCE) return null;
  if (!sp.practice && (!holdingStartZone(p.position, zones, track) || !restartPointAllowed(p.position, zones))) return null;
  return restartPointProblem(core, settings, p) ? null : p;
}

/** What a successful save says. A practice spawn says why restarts from it are practice, and how to undo it. */
export function savedMessage(track: number, practice: PracticeSpawn | null = null): string {
  const where = track > 0 ? ` for ${trackName(track)}` : "";
  if (practice === "outside") return `Spawn saved${where}. It's outside the start zone, so restarts from it are practice. !clearstart undoes it.`;
  if (practice === "tool") return `Spawn saved${where}. This run used noclip, a checkpoint or a practice spawn, so restarts from it are practice. !clearstart undoes it.`;
  return `Start point saved${where}`;
}

export const normalizeYaw = (yaw: number) => {
  const y = ((yaw % 360) + 360) % 360;
  return y === 360 ? 0 : y;
};
export const clampPitch = (pitch: number) => Math.max(-89, Math.min(89, pitch));

// ---------------------------------------------------------------------------------------------
// Storage: one localStorage key per map, { "<track>": { p: [x, y, z], yaw, pitch, pr?: 1 } } (pr: a practice spawn).

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (map: string) => `bunnyhop:start:${map}`;
const defaultStore = (): KeyValueStore | null => {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
};

function readAll(map: string, store: KeyValueStore | null): Record<string, unknown> {
  try {
    const v = JSON.parse(store?.getItem(keyFor(map)) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeAll(map: string, all: Record<string, unknown>, store: KeyValueStore | null): void {
  try {
    if (Object.keys(all).length) store?.setItem(keyFor(map), JSON.stringify(all));
    else store?.removeItem(keyFor(map));
  } catch {
    // Storage full or blocked: the point just isn't kept.
  }
}

/** The saved start point for `map` / `track`, or null (none, or not a well-formed one). */
export function loadStartPoint(map: string, track: number, store = defaultStore()): StartPoint | null {
  const v = readAll(map, store)[String(track)] as { p?: unknown; yaw?: unknown; pitch?: unknown; pr?: unknown } | undefined;
  const p = v?.p;
  if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (typeof v!.yaw !== "number" || !Number.isFinite(v!.yaw) || typeof v!.pitch !== "number" || !Number.isFinite(v!.pitch)) return null;
  return { position: [p[0], p[1], p[2]], yaw: normalizeYaw(v!.yaw), pitch: clampPitch(v!.pitch), ...(v!.pr ? { practice: true as const } : {}) };
}

export function saveStartPoint(map: string, track: number, sp: StartPoint, store = defaultStore()): void {
  const all = readAll(map, store);
  all[String(track)] = { p: sp.position, yaw: sp.yaw, pitch: sp.pitch, ...(sp.practice ? { pr: 1 } : {}) };
  writeAll(map, all, store);
}

/** Removes the saved start point for `map` / `track`; true if there was one. */
export function clearStartPoint(map: string, track: number, store = defaultStore()): boolean {
  const all = readAll(map, store);
  if (!(String(track) in all)) return false;
  delete all[String(track)];
  writeAll(map, all, store);
  return true;
}

/** Leaving practice removes this map's practice spawns, preserving valid ranked start points. */
export function clearPracticeSpawns(map: string, store = defaultStore()): boolean {
  const all = readAll(map, store);
  let cleared = false;
  for (const [track, point] of Object.entries(all)) {
    if (point && typeof point === "object" && "pr" in point && point.pr) {
      delete all[track];
      cleared = true;
    }
  }
  if (cleared) writeAll(map, all, store);
  return cleared;
}
