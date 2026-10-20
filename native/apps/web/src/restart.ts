// Where R / B / map load put the player, shared by the session (session.ts), the verifier (verifier.ts) and the map
// audit (tools/audit/check-map.ts). DOM-free.

import { applyRestartPoint, EVENT_TELEPORTED, restartPoint, type Core, type RestartPoint, type Settings } from "./core";
import { playerInZone, trackOf, type Zone } from "./zones";

/** Player names a restart gives (bhoptimer `ResetClientTargetNameAndClassName`). "" = default ("" / "player"). */
export interface RestartNames {
  targetname: string;
  classname: string;
}

/**
 * bhoptimer's per-map restart fixes (shavitush/bhoptimer addons/sourcemod/gamedata/shavit-mapfixes.cfg, applied by
 * shavit-misc as convars): its restart teleports to the start zone and sets the player's targetname to
 * `shavit_zones_resettargetname_{main,bonus}` and classname to `shavit_zones_resetclassname_{main,bonus}` ("" /
 * "player" by default, which is what core.reset() gives us). Maps whose start zone sits in a filtered teleport
 * need the name the map's spawn flow would have given. Only maps we host are listed.
 * - bhop_japan: the start area is inside trigger_teleport *133 (-> "begin", the spawn room) filtered by bfilter
 *   (filter_activator_class, negated, "beginner"); the spawn room's trigger_multiple *132 does
 *   `!activator AddOutput classname beginner`. Without the fix every restart is sent back through the spawn room.
 * (bhop_crash_egypt `resettargetname_main player` and bhop_drop `forcetargetnamereset` aren't modelled.)
 */
const MAP_FIXES: Record<string, { main?: Partial<RestartNames>; bonus?: Partial<RestartNames> }> = {
  bhop_japan: { main: { classname: "beginner" } },
};

/** Names a restart onto `track` gives on `map`, or null for the defaults. */
export function restartNames(map: string, track: number): RestartNames | null {
  const f = MAP_FIXES[map]?.[track === 0 ? "main" : "bonus"];
  return f ? { targetname: f.targetname ?? "", classname: f.classname ?? "" } : null;
}

/** Whether a replay's recorded restart names are what a restart on `map` gives (on any track); none is always fine. */
export function restartNamesAllowed(map: string, p: Pick<RestartPoint, "targetname" | "classname">): boolean {
  const t = p.targetname ?? "";
  const c = p.classname ?? "";
  if (!t && !c) return true;
  return [0, 1].some((track) => {
    const n = restartNames(map, track);
    return !!n && n.targetname === t && n.classname === c;
  });
}

/**
 * Where R / B put the player for `track`: null (plain reset: the map's own spawn and angle) when the map spawn
 * already lies in that track's start zone (and the map has no restart names for it), else the centre of the start
 * zone at mins z + 1 like bhoptimer's restart (the core settles it onto the floor), facing the map spawn's angle on
 * the main track, or the track's first split / end zone on bonus tracks, with the map's restart names.
 */
export function restartTarget(map: string, zones: readonly Zone[], spawn: RestartPoint | null, track: number): RestartPoint | null {
  const starts = zones.filter((z) => z.kind === "start" && trackOf(z) === track);
  if (!starts.length) return null;
  const names = restartNames(map, track);
  if (!names && spawn && starts.some((z) => playerInZone(spawn.position, false, z))) return null;
  const z = starts[0];
  const centre = (a: Zone) => [(a.mins[0] + a.maxs[0]) / 2, (a.mins[1] + a.maxs[1]) / 2] as const;
  const [cx, cy] = centre(z);
  let yaw = spawn?.yaw ?? 0;
  if (track > 0) {
    const next =
      zones.filter((n) => (n.kind === "stage" || n.kind === "checkpoint") && trackOf(n) === track).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0] ??
      zones.find((n) => n.kind === "end" && trackOf(n) === track);
    if (next) {
      const [nx, ny] = centre(next);
      if (nx !== cx || ny !== cy) yaw = Math.round((Math.atan2(ny - cy, nx - cx) * 180) / Math.PI);
    }
  }
  return withRestartNames({ position: [cx, cy, z.mins[2] + 1], yaw: ((yaw % 360) + 360) % 360 }, map, track);
}

/** `p` with the map's restart names for `track` (if any). */
export function withRestartNames(p: RestartPoint, map: string, track: number): RestartPoint {
  const n = restartNames(map, track);
  if (!n) return p;
  const out: RestartPoint = { ...p };
  if (n.targetname) out.targetname = n.targetname;
  if (n.classname) out.classname = n.classname;
  return out;
}

/**
 * Whether `p` is a valid restart point on the loaded map (null) or why not. The verifier checks the replay header's
 * `spawn` with it; the session checks a player's start point with it (start-point.ts) before restarting there.
 * A restart point must be:
 * - settled: applying it gives back the same point bit for bit, so the header says where the run really begins
 *   (the core settles every restart point onto the floor, and settling is idempotent: setPosition);
 * - on the ground: after one tick standing still there the player is on the ground (not on a ladder), so a run can't
 *   begin in the air (above a drop the settle trace doesn't reach). A tick of the sim, not another settle trace: on a
 *   few maps the trace and the movement disagree by a unit or two about the floor (bhop_eject's start), and the
 *   movement is what counts. A map teleport in that tick also passes: the point touches a trigger_teleport, which
 *   sends you where it sends anyone (bhop_space's zone centre).
 * The start-zone test is separate (verifier.ts restartPointAllowed). Every default restart passes both (all maps and
 * all prod replays: research/TIMER-RULES.md "Start points").
 *
 * Resets the core with `settings` and leaves it a tick into the probe: reset it again before using it (SimRun and
 * session.resetCore do).
 */
export function restartPointProblem(core: Core, settings: Settings, p: RestartPoint): string | null {
  const at = (v: readonly number[]) => v.map((c) => c.toFixed(1)).join(", ");
  if (!p.position.every(Number.isFinite) || !Number.isFinite(p.yaw)) return `restart point (${at(p.position)}) is not a finite position`;
  core.setSettings(settings);
  core.reset();
  applyRestartPoint(core, p);
  const settled = restartPoint(core);
  if (!settled) return null; // a wasm build without restart_point (older than any replay with a restart point)
  const f = Math.fround;
  if (![0, 1, 2].every((i) => Object.is(f(settled.position[i]), f(p.position[i])))) {
    return `restart point (${at(p.position)}) is not settled (the core puts it at ${at(settled.position)})`;
  }
  const events = core.step(0, 0, p.yaw, 0, 0);
  const s = core.state();
  if (s.grounded && !s.onLadder) return null;
  // A trigger teleport took the player: the map sends everyone who stands there the same way (bhop_space's zone centre).
  if (events >>> 0 !== 0xffffffff && events & EVENT_TELEPORTED) return null;
  return `restart point (${at(p.position)}) is not on the ground`;
}
