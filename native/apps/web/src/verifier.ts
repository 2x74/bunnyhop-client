// Authoritative replay verification, shared by the CLI verifier (tools/verify/verify.ts) and the API's queue
// consumer (apps/api). DOM-free. The map must already be loaded into `core` (loadMap or loadMapPhysics).
// Never trusts the time stored in the replay: re-simulates the commands against authoritative zones.

import { isPhysicsVersion, type Core, type PlayerState, type Settings } from "./core";
import { replayPhysics, replayStyle, replayTimerRules, styleReplayProblem, type Replay } from "./replay";
import { restartNamesAllowed, restartPointProblem } from "./restart";
import { SimRun, type SimOptions, type SimResult } from "./sim";
import { BONUS_STYLE, isSegmented, STYLE_DEFS, styleDef, stylePrespeedCap, styleSettings } from "./styles";
import { isTimerRules } from "./timer";
import type { RunTiming } from "./run-timing";
import { HULL_HEIGHT, zonesEqual, type Zone } from "./zones";
import { disallowedCommand, RANKED_COMMAND_WEAPONS } from "./weapon-rules";

/** Ranked styles (styles.ts) and their canonical physics settings. */
export const STYLES: Record<string, Settings> = Object.fromEntries(STYLE_DEFS.map((d) => [d.id, styleSettings(d.id)]));

/**
 * Bit-exact (f32) comparison of the physics settings (movement constants + autohop). The physics version is not part
 * of it: every known version is a valid re-simulation (`isPhysicsVersion`, checked by verifyReplay), and which versions
 * a submission may use is the API's policy (apps/api/src/runs.ts `physicsAllowed`: the current client build records
 * PHYSICS_VERSION, older listed builds v1).
 */
export function settingsEqual(a: Settings, b: Settings): boolean {
  const keys = ["tickInterval", "airAccelerate", "accelerate", "friction", "stopSpeed", "gravity", "maxSpeed"] as const;
  return !!a.stamina === !!b.stamina && a.autohop === b.autohop && keys.every((k) => Object.is(Math.fround(a[k]), Math.fround(b[k])));
}

/**
 * A recorded restart point must be a start-zone restart: the settled feet position lies inside some
 * track's start zone (the core may lift it out of solid by up to 64 units, so allow that above the zone).
 * Below, the standing hull only has to reach the zone, like the timer's `playerInZone`: restarts go to the zone
 * centre and settle onto the floor, which can be under zones that float above it (bhop_monster_jam: 15.5u).
 * Players' start points (start-point.ts) are any spot in the zone, so this is the envelope every restart point
 * satisfies; restart.ts restartPointProblem adds that the point is settled and on the ground.
 */
export function restartPointAllowed(p: readonly number[], zones: readonly Zone[]): boolean {
  return zones.some(
    (z) =>
      z.kind === "start" &&
      p[0] >= z.mins[0] - 1 && p[0] <= z.maxs[0] + 1 &&
      p[1] >= z.mins[1] - 1 && p[1] <= z.maxs[1] + 1 &&
      p[2] + HULL_HEIGHT >= z.mins[2] && p[2] <= z.maxs[2] + 64,
  );
}

export interface VerifyOptions {
  /** sha256 of the BSP the verifier loaded (compared against the replay header); null skips the check. */
  mapSha256: string | null;
  /** Describes where `zones` came from, for messages. */
  zoneSource?: string;
  /** Require the style's canonical settings and the default prespeed cap (default true). */
  ranked?: boolean;
  /** Called after every re-simulated tick (simulate's onTick), e.g. to collect the per-tick state the API's input
   * analysis reads (apps/api/src/input-analysis.ts InputTrace). Observes only: never changes the simulation. */
  onTick?: SimOptions["onTick"];
}

export interface VerifyResult {
  valid: boolean;
  /** All problems found; the first one is the rejection reason. */
  problems: string[];
  style: string;
  /** Track the run was on, recomputed (0 = main, N = bonus N). */
  track: number;
  /** Recomputed run length in whole ticks, as the old tick timer counted it (0 if the run did not finish). */
  ticks: number;
  /** Seconds: timeMs / 1000. */
  time: number;
  /**
   * The ranked score: the run's sub-tick time (start-zone exit to end-zone entry, run-timing.ts) in whole
   * milliseconds, recomputed here and never read from the replay. 0 if the run did not finish.
   */
  timeMs: number;
  /** How timeMs was measured (stored with the run for audits), null if the run did not finish. */
  timing: RunTiming | null;
  startTick: number;
  endTick: number;
  totalTicks: number;
  checkpointsMatch: boolean;
  checkpointsChecked: number;
  firstMismatchTick: number | null;
  finalStateMatches: boolean;
  final: PlayerState;
  stats: { jumps: number; strafes: number; sync: number; perf: number };
  simMs: number;
  /**
   * Rules 1 replays: the run as its replay timed it (start on leaving the zone). `ticks` / `time` / `startTick` /
   * `endTick` / `stats` are then the run retimed with the current start-zone rules (sim.ts SimResult.retimed), which
   * is what the boards rank.
   */
  rules1?: { ticks: number; startTick: number; endTick: number; timeMs: number };
  /** Segmented runs: the checkpoint loads on the stitched path (replay.segments), each proven a saved state. Absent: none. */
  segmentLoads?: number;
}

/** Result for a replay whose simulation stopped early (a desync): invalid, nothing timed. */
function unsimulatedResult(style: string, problems: string[], sim: SimResult, simMs: number): VerifyResult {
  return {
    valid: false, problems, style, track: 0, ticks: 0, time: 0, timeMs: 0, timing: null, startTick: 0, endTick: 0, totalTicks: sim.ticks,
    checkpointsMatch: false, checkpointsChecked: 0, firstMismatchTick: null, finalStateMatches: false,
    final: sim.final, stats: { jumps: 0, strafes: 0, sync: 0, perf: 0 }, simMs,
  };
}

/** Result for a replay that can't be re-simulated at all. */
function unsimulated(core: Core, problems: string[], style: string): VerifyResult {
  return {
    valid: false, problems, style, track: 0, ticks: 0, time: 0, timeMs: 0, timing: null, startTick: 0, endTick: 0, totalTicks: 0,
    checkpointsMatch: false, checkpointsChecked: 0, firstMismatchTick: null, finalStateMatches: false,
    final: core.state(), stats: { jumps: 0, strafes: 0, sync: 0, perf: 0 }, simMs: 0,
  };
}

export function verifyReplay(core: Core, replay: Replay, zones: readonly Zone[], opts: VerifyOptions): VerifyResult {
  const v = beginVerify(core, replay, zones, opts);
  if ("result" in v) return v.result;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  v.run.step();
  return concludeVerify(replay, v.problems, v.run.result(), now() - t0);
}

export interface SlicedVerifyOptions extends VerifyOptions {
  /** Ticks per slice (default 20000, about 0.2 s of simulation). */
  sliceTicks?: number;
  /**
   * Awaited between slices with the ticks simulated so far: the place to yield to the event loop, report progress, or
   * measure time. The core must not be used by anything else meanwhile.
   */
  between: (done: number, total: number) => Promise<void>;
}

/**
 * verifyReplay in slices: the same checks, the same ticks in the same order, so the same result; `between` runs after
 * every slice but the last. The API's queue consumer uses it so a long replay can report progress and doesn't hold the
 * isolate for seconds at a time (apps/api/src/verify.ts).
 */
export async function verifyReplaySliced(core: Core, replay: Replay, zones: readonly Zone[], opts: SlicedVerifyOptions): Promise<VerifyResult> {
  const v = beginVerify(core, replay, zones, opts);
  if ("result" in v) return v.result;
  const slice = Math.max(1, opts.sliceTicks ?? 20_000);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  let stoppedAt: number | null = null;
  for (;;) {
    v.run.step(slice);
    if (v.run.done) break;
    // A desynced replay is rejected whatever comes after, so the rest isn't simulated (security hotfix 2026-10-21,
    // audit H3: a fake replay carrying a million ticks costs one slice past its first mismatch, not all of them).
    if (v.run.desynced) {
      stoppedAt = v.run.ticksDone;
      break;
    }
    await opts.between(v.run.ticksDone, v.run.n);
  }
  // simMs includes the time spent in `between` (Workers freeze clocks during code: apps/api/src/verify.ts measures its own).
  return concludeVerify(replay, v.problems, v.run.result(), now() - t0, stoppedAt);
}

/** The checks before simulating, then a SimRun ready to step (or the result when the replay can't be simulated). */
function beginVerify(core: Core, replay: Replay, zones: readonly Zone[], opts: VerifyOptions): { result: VerifyResult } | { problems: string[]; run: SimRun } {
  const h = replay.header;
  const problems: string[] = [];
  const style = replayStyle(h);
  const def = styleDef(style);
  const ranked = opts.ranked ?? true;

  if (opts.mapSha256 !== null && opts.mapSha256 !== h.mapSha256) {
    problems.push(`map sha256 mismatch (replay ${h.mapSha256.slice(0, 12)}, server ${opts.mapSha256.slice(0, 12)})`);
  }
  if (!def) problems.push(`unknown style ${style}`);
  else if (def.autohop !== h.settings.autohop) problems.push(`style ${def.name} ${def.autohop ? "requires" : "forbids"} autohop`);
  const styleProblem = styleReplayProblem(h);
  if (styleProblem) problems.push(styleProblem);
  // Checkpoint loads that rewind the run are Segmented's rule; any other style's run is one continuous attempt.
  if (replay.segments?.length && !isSegmented(style)) problems.push(`${replay.segments.length} segment load(s) in a ${def?.name ?? style} run: only Segmented runs load checkpoints`);
  const physics = replayPhysics(h);
  if (!isPhysicsVersion(physics)) {
    // Not simulable by this build (a newer client's replay, or a forged field): reject without simulating.
    problems.unshift(`unknown physics version ${physics}`);
    return { result: unsimulated(core, problems, style) };
  }
  // Re-timed with the replay's own start-zone rules (timer.ts TIMER_RULES_*; which ones a submission may use is the
  // API's policy, apps/api/src/runs.ts `timerRulesAllowed`).
  const rules = replayTimerRules(h);
  if (!isTimerRules(rules)) {
    problems.unshift(`unknown timer rules ${rules}`);
    return { result: unsimulated(core, problems, style) };
  }
  if (ranked) {
    const canonical = STYLES[style];
    if (!canonical || !settingsEqual(canonical, h.settings)) problems.push(`non-standard physics settings for style ${style}`);
    if (h.prespeedCap !== stylePrespeedCap(style)) problems.push(`non-standard prespeed cap ${h.prespeedCap}`);
    // Weapon commands (physics v7): ranked runs may only ask for what bhop servers give (weapon-rules.ts).
    const gun = disallowedCommand(replay.buttons);
    if (gun) problems.push(`weapon command for ${gun.weapon} at tick ${gun.tick}: ranked runs only allow ${RANKED_COMMAND_WEAPONS.join(", ")}`);
  }
  if (!zonesEqual(zones, h.zones)) problems.push(`zones differ from ${opts.zoneSource ?? "authoritative zones"}`);
  if (h.spawn && !restartPointAllowed(h.spawn.position, zones)) {
    problems.push(`restart point (${h.spawn.position.map((v) => v.toFixed(1)).join(", ")}) is not in a start zone`);
  }
  // The recorded point must be where the core really starts the run, standing on a floor (restart.ts). Probes on the
  // core; SimRun resets it again below.
  const spawnProblem = h.spawn ? restartPointProblem(core, h.settings, h.spawn) : null;
  if (spawnProblem) problems.push(spawnProblem);
  if (h.spawn && !restartNamesAllowed(h.map, h.spawn)) {
    problems.push(`restart names (targetname "${h.spawn.targetname ?? ""}", classname "${h.spawn.classname ?? ""}") are not ${h.map}'s restart names`);
  }

  return { problems, run: new SimRun(core, replay, zones, opts.onTick ? { onTick: opts.onTick } : {}) };
}

/** The verdict from a finished simulation. */
function concludeVerify(replay: Replay, problems: string[], sim: SimResult, simMs: number, stoppedAt: number | null = null): VerifyResult {
  const h = replay.header;
  const style = replayStyle(h);
  const def = styleDef(style);
  if (sim.styleViolations > 0) {
    const c = sim.firstViolation!;
    const n = `${sim.styleViolations} command${sim.styleViolations === 1 ? "" : "s"}`;
    problems.unshift(
      // Assisted styles compute the air movement (styles.ts): a recorded command must equal the computed one.
      `style violation: ${def?.auto ? `${n} differ from the movement ${def.name} computes` : `${n} use keys ${def?.name ?? style} blocks`} ` +
        `(first at tick ${sim.firstViolationTick}: forward ${c.forward}, side ${c.side}, buttons 0x${c.buttons.toString(16)})`,
    );
  }

  const finished = sim.endTick > 0 && sim.timer.status === "finished";
  const ticks = finished ? sim.endTick - sim.startTick : 0;
  const timing = finished ? sim.timer.timing() : null;
  const timeMs = timing?.ms ?? 0;
  const last = replay.checkpoints[replay.checkpoints.length - 1];
  const finalStateMatches =
    !!last && last.tick === sim.ticks && [0, 1, 2].every((i) => Object.is(last.position[i], sim.final.position[i]) && Object.is(last.velocity[i], sim.final.velocity[i]));

  // Segmented (research/SEGMENTED.md): the commands are the stitched path, and each recorded load must restore exactly
  // the state the re-simulation reaches at its tick, i.e. one the run reached and saved there.
  const seg = sim.segments;
  if (seg && seg.mismatchTick !== null) {
    problems.push(`segment load at tick ${seg.mismatchTick} restores a state this run never saved (not the run's position and velocity at that tick)`);
  } else if (seg && stoppedAt === null && seg.checked < (replay.segments?.length ?? 0)) {
    problems.push(`${(replay.segments?.length ?? 0) - seg.checked} segment load(s) after the replay's last tick`);
  }
  if (!sim.checkpointsMatch) problems.push(`desync: checkpoint mismatch at tick ${sim.firstMismatchTick}`);
  if (stoppedAt !== null) {
    // Stopped at the first desync (verifyReplaySliced): the finish checks would only describe the unsimulated rest.
    problems.push(`not simulated past tick ${stoppedAt} of ${h.totalTicks} after the desync`);
    return { ...unsimulatedResult(style, problems, sim, simMs), checkpointsChecked: sim.checkpointsChecked, firstMismatchTick: sim.firstMismatchTick };
  }
  if (!finalStateMatches) problems.push("final state does not match final checkpoint");
  if (!finished) problems.push("run did not finish (end zone never reached)");
  if (finished && (sim.startTick !== h.startTick || sim.endTick !== h.endTick)) {
    problems.push(`claimed ticks ${h.startTick}..${h.endTick} != recomputed ${sim.startTick}..${sim.endTick}`);
  }
  if (finished && sim.track !== (h.track ?? 0)) problems.push(`claimed track ${h.track} != recomputed track ${sim.track}`);
  if (finished && sim.track > 0 && style !== BONUS_STYLE) problems.push(`bonus runs are ${styleDef(BONUS_STYLE)!.name} style only (replay style ${style})`);
  if (finished && sim.ticks !== sim.endTick) problems.push(`replay continues ${sim.ticks - sim.endTick} ticks past the finish`);

  // Rules 1 replays are ranked by the current start-zone rules: the same inputs and physics, timed from the last valid
  // ground start (a mid-air exit counts from its takeoff). A run with no such start doesn't count.
  const rt = sim.retimed;
  let ranked = { track: sim.track, ticks, timeMs, timing, startTick: sim.startTick, endTick: sim.endTick, timer: sim.timer };
  let rules1: VerifyResult["rules1"];
  if (rt && finished) {
    rules1 = { ticks, startTick: sim.startTick, endTick: sim.endTick, timeMs };
    if (rt.endTick > 0 && rt.timer.status === "finished" && rt.track === sim.track && rt.endTick === sim.endTick) {
      const n = rt.endTick - rt.startTick;
      const t = rt.timer.timing();
      ranked = { track: rt.track, ticks: n, timeMs: t?.ms ?? 0, timing: t, startTick: rt.startTick, endTick: rt.endTick, timer: rt.timer };
    } else {
      problems.push(`no valid start under the current start-zone rules (timer rules 1 run, ${rt.endTick > 0 ? `retimed ${rt.startTick}..${rt.endTick} track ${rt.track}` : "never started"})`);
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    style,
    track: ranked.track,
    ticks: ranked.ticks,
    time: ranked.timeMs / 1000,
    timeMs: ranked.timeMs,
    timing: ranked.timing,
    startTick: ranked.startTick,
    endTick: ranked.endTick,
    totalTicks: sim.ticks,
    checkpointsMatch: sim.checkpointsMatch,
    checkpointsChecked: sim.checkpointsChecked,
    firstMismatchTick: sim.firstMismatchTick,
    finalStateMatches,
    final: sim.final,
    stats: { jumps: ranked.timer.jumps, strafes: ranked.timer.strafes, sync: ranked.timer.syncPercent(), perf: ranked.timer.perfPercent() },
    simMs,
    ...(rules1 ? { rules1 } : {}),
    ...(replay.segments?.length ? { segmentLoads: replay.segments.length } : {}),
  };
}
