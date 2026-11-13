// What the map physics worker (map-physics-worker.ts) does with its one physics-only core: the self-check of a finished
// run (selfcheck.ts) and the re-simulation of a race ghost (ghost.ts). DOM-free, so tests run it without a worker.
//
// Both are the same calls the main thread made before (verifyReplay as the server's verifier, simulate with frames as
// the ghosts' aux core), on a core loaded the same way (loadMapPhysics, the registered prop collision models). Jobs run
// one at a time: each re-simulation resets the core and runs to its end before the next starts.

import type { Core } from "./core";
import { decodeReplay } from "./replay";
import { simulate } from "./sim";
import { verifyReplay } from "./verifier";

export type PhysicsJob = { type: "check"; id: number; replay: Uint8Array } | { type: "ghost"; id: number; replay: Uint8Array };

export type CheckReply = { id: number; valid: boolean; firstMismatchTick: number | null; problems: string[]; simMs: number };

/** A ghost's re-simulation (ghost.ts GhostData's simulated part, and what loadSyncedPB / addReplay check). */
export interface GhostSim {
  frames: Float32Array;
  frameEvents?: Uint8Array;
  startTick: number;
  endTick: number;
  track: number;
  checkpointsMatch: boolean;
  firstMismatchTick: number | null;
  /** The run's splits: [index, ticks since start]. */
  splits: [number, number][];
}

export type GhostReply = { id: number; ghost: GhostSim };

export type PhysicsReply = CheckReply | GhostReply | { id: number; error: string };

/** Runs jobs in order on `core`; each reply comes with the buffers to transfer. */
export function physicsJobs(core: () => Promise<Core>): (job: PhysicsJob) => Promise<{ reply: PhysicsReply; transfer: Transferable[] }> {
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (job: PhysicsJob): Promise<{ reply: PhysicsReply; transfer: Transferable[] }> => {
    try {
      const c = await core();
      const replay = await decodeReplay(job.replay);
      if (job.type === "check") {
        // The run's own zones: this checks the client against itself (determinism), the server checks the pinned zones.
        const r = verifyReplay(c, replay, replay.header.zones, { mapSha256: null, ranked: true });
        return { reply: { id: job.id, valid: r.valid, firstMismatchTick: r.firstMismatchTick, problems: r.problems.slice(0, 3), simMs: r.simMs }, transfer: [] };
      }
      const sim = simulate(c, replay, replay.header.zones, { frames: true });
      const ghost: GhostSim = {
        frames: sim.frames!,
        frameEvents: sim.frameEvents,
        startTick: sim.startTick,
        endTick: sim.endTick,
        track: sim.track,
        checkpointsMatch: sim.checkpointsMatch,
        firstMismatchTick: sim.firstMismatchTick,
        splits: sim.timer.splits.map((s) => [s.index, s.ticks]),
      };
      return { reply: { id: job.id, ghost }, transfer: [ghost.frames.buffer, ...(ghost.frameEvents ? [ghost.frameEvents.buffer] : [])] };
    } catch (err) {
      return { reply: { id: job.id, error: String((err as Error)?.message ?? err) }, transfer: [] };
    }
  };
  return (job) => {
    const p = queue.then(() => run(job));
    queue = p;
    return p;
  };
}
