// Copy start (v0.0.39): another run's starting point as your start point, the leaderboard row's "Copy start" and
// !copystart. A start point (start-point.ts, bhoptimer's !setstart) is a spot standing still in a start zone and the
// view you had there, so a run's starting point is the last tick it stood still in its start zone before the timer
// started: where the player lined up before the prestrafe. For a run from a saved start point that's the restart point
// itself (tick 0); for one that walked to a corner first, that corner. The tick the timer starts can't be the point
// itself: by then the player is moving, usually in the air, on the zone's edge, and !setstart refuses all three.
//
// The replay is re-simulated on the live core up to a little past its start (session.ts wraps it in withRestoredState,
// like the !setstart probe, so play carries on untouched). The point found is then checked exactly like a spot you
// stood on and saved (start-point.ts resolveStartPoint: inside one of the track's start zones now, a restart there
// settles where it should, and the verifier would accept it) and saved the same way. DOM-free
// (apps/api/test/copy-start.test.ts).

import type { Core } from "./core";
import type { Replay } from "./replay";
import { SimRun } from "./sim";
import { clampPitch, holdingStartZone, normalizeYaw, STILL_SPEED, type StartPoint } from "./start-point";
import { trackName, type Zone } from "./zones";

export type RunStart = { ok: true; track: number; point: StartPoint; tick: number } | { ok: false; reason: string };

/**
 * Where `replay`'s run started: the last tick at or before the timer's start tick that the player stood still (on the
 * ground, standing up, under STILL_SPEED) with the whole footprint in one of the run's track's start zones `zones`
 * (the loaded map's), with the view of that moment. Leaves the core mid-replay: wrap it in core.ts withRestoredState.
 */
export function runStartPoint(core: Core, replay: Replay, zones: readonly Zone[], map: string): RunStart {
  const h = replay.header;
  if (h.map !== map) return { ok: false, reason: "That run is on another map." };
  if (!(h.startTick > 0)) return { ok: false, reason: "That run never left the start zone." };
  const track = h.track;
  const still = (s: { position: readonly number[]; velocity: readonly number[]; grounded: boolean; crouched: boolean; onLadder: boolean }) =>
    s.grounded && !s.crouched && !s.onLadder && Math.hypot(s.velocity[0], s.velocity[1], s.velocity[2]) <= STILL_SPEED && holdingStartZone(s.position, zones, track) !== null;
  let found: { tick: number; position: [number, number, number]; yaw: number; pitch: number } | null = null;
  const at = (tick: number, s: { position: readonly number[] }, yaw: number, pitch: number) => (found = { tick, position: [s.position[0], s.position[1], s.position[2]], yaw, pitch });
  // A checkpoint after the start too (every checkpointInterval ticks), so a replay that doesn't play back the same in
  // this version is caught before its start is trusted.
  const until = Math.min(h.totalTicks, h.startTick + Math.max(1, h.checkpointInterval || 100));
  const run = new SimRun(core, replay, h.zones.length ? h.zones : zones, {
    untilTick: until,
    // The state after `tick` commands; the view is that tick's command (what the player looked at, standing there).
    onTick: (tick, s) => {
      if (tick <= h.startTick && still(s)) at(tick, s, replay.yaw[tick - 1], replay.pitch[tick - 1]);
    },
  });
  // Tick 0: where the restart put them, facing the restart's way (their own start point, when they had one). A restart
  // always stands you still on the floor, but the core only flags the ground on the first step: a run that moves on
  // its first tick still started from here.
  const s0 = core.state();
  if (!s0.crouched && Math.hypot(s0.velocity[0], s0.velocity[1], s0.velocity[2]) <= STILL_SPEED && holdingStartZone(s0.position, zones, track)) at(0, s0, h.spawn?.yaw ?? s0.teleportAngles[1], replay.pitch.length ? replay.pitch[0] : 0);
  run.step();
  if (run.desynced) return { ok: false, reason: "That run doesn't play back exactly in this version, so its start can't be copied." };
  const f = found as { tick: number; position: [number, number, number]; yaw: number; pitch: number } | null;
  if (!f) return { ok: false, reason: "That run never stood still in the start zone, so it has no start point to copy." };
  return { ok: true, track, tick: f.tick, point: { position: f.position, yaw: normalizeYaw(f.yaw), pitch: clampPitch(f.pitch) } };
}

/** The chat / toast line: "Copied hopper's start point" (+ " for Bonus 1"), and how to use it when you're mid-run. */
export function copiedMessage(who: string, track: number, restarted: boolean): string {
  const where = track > 0 ? ` for ${trackName(track)}` : "";
  return `Copied ${who}'s start point${where}${restarted ? "" : ". Restart to use it"}`;
}

/** !copystart's argument: nothing (the world record, or the room's player menu), "#3" / "3" (a rank), else a name. */
export type CopyStartTarget = { kind: "wr" } | { kind: "rank"; rank: number } | { kind: "name"; name: string };

export function parseCopyStart(arg: string): CopyStartTarget {
  const a = arg.trim();
  if (!a) return { kind: "wr" };
  const m = /^#?(\d{1,6})$/.exec(a);
  if (m && Number(m[1]) >= 1) return Number(m[1]) === 1 ? { kind: "wr" } : { kind: "rank", rank: Number(m[1]) };
  return { kind: "name", name: a };
}
