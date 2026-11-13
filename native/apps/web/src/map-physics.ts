// The map's second physics core, in a worker (map-physics-worker.ts): the self-check of finished runs (selfcheck.ts)
// and the race ghosts' re-simulations (ghost.ts) share it. Started on the first job, so a page that never needs one
// (no ghost, no finished run) never loads the map a second time. The main thread never builds a second core.

import { physicsContent } from "./core";
import type { MapFile } from "./content/map-file";
import type { GhostSim, PhysicsJob, PhysicsReply } from "./physics-jobs";
import type { SelfCheckResult } from "./selfcheck";

export type { GhostSim } from "./physics-jobs";

/** Starts a self-check when the main thread is idle, within 2 s (as before: the run's upload goes first). */
const whenIdle = (fn: () => void) => ("requestIdleCallback" in globalThis ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 50));

const TIMEOUT_MS = 120_000;

/** The self-check's problem when it was skipped (`checkOnlyIfRunning`). */
export const LOW_MEMORY_SKIP = "skipped: big map on a low-memory device";

export class MapPhysics {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (r: PhysicsReply) => void>();

  /**
   * `start`: jobs wait for it (main.ts: the end of the loading screen), so the worker's core never loads while the main
   * core and the map's bytes are still being built from. `physics`: the prop collision models (default: the page's
   * registered ones, core.ts physicsContent).
   */
  constructor(private o: { wasmBytes: Uint8Array; bsp: Pick<MapFile, "blob">; start?: Promise<unknown>; checkOnlyIfRunning?: boolean; physics?: [string, Uint8Array][] }) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./map-physics-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<PhysicsReply>) => this.pending.get(e.data.id)?.(e.data);
    w.onerror = (e) => {
      // The worker couldn't load (old browser, CSP): every waiting job reports it, the next one tries afresh.
      const error = `worker: ${e.message || "failed to start"}`;
      for (const [id, done] of [...this.pending]) done({ id, error });
      w.terminate();
      this.worker = null;
    };
    // The map as a Blob (passed by reference, streamed into the worker's core there: no copy of it on either JS heap),
    // and the prop collision models registered from hosted content (core.ts), so the worker simulates what the live
    // run did.
    w.postMessage({ type: "init", wasm: this.o.wasmBytes, bsp: this.o.bsp.blob(), physics: this.o.physics ?? physicsContent() });
    return (this.worker = w);
  }

  /** Posts a job (a check when the main thread is idle); never rejects (failures come back as `{ error }`). */
  private ask(type: PhysicsJob["type"], replay: Uint8Array, timeout: string): Promise<PhysicsReply> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      });
      const post = () => {
        try {
          this.ensure().postMessage({ type, id, replay } satisfies PhysicsJob);
        } catch (e) {
          this.pending.get(id)?.({ id, error: String((e as Error)?.message ?? e) });
        }
      };
      // (The time limit runs from the start: a slow map load doesn't use it up.)
      void (this.o.start ?? Promise.resolve()).then(() => {
        timer = setTimeout(() => this.pending.get(id)?.({ id, error: timeout }), TIMEOUT_MS);
        if (type === "check") whenIdle(post);
        else post();
      });
    });
  }

  /** Re-simulates gzip .bhr bytes with the server's verifier; never rejects (problems come back as selfCheck "error"). */
  async check(replay: Uint8Array): Promise<SelfCheckResult> {
    // A big map on a low-memory device (low-memory.ts): not a second load of the map just for this.
    if (this.o.checkOnlyIfRunning && !this.worker) return { selfCheck: "na", problems: [LOW_MEMORY_SKIP] };
    const r = await this.ask("check", replay, "self-check timed out");
    if ("error" in r) return { selfCheck: "error", problems: [r.error] };
    if (!("valid" in r)) return { selfCheck: "error", problems: ["unexpected reply"] };
    return {
      selfCheck: r.valid ? "ok" : "mismatch",
      ...(r.firstMismatchTick !== null ? { firstMismatchTick: r.firstMismatchTick } : {}),
      ...(r.problems.length ? { problems: r.problems } : {}),
      checkMs: Math.round(r.simMs),
    };
  }

  /** A ghost's frames from gzip .bhr bytes (simulate with frames, the replay's own zones). Rejects on failure. */
  async ghost(replay: Uint8Array): Promise<GhostSim> {
    const r = await this.ask("ghost", replay, "ghost re-simulation timed out");
    if ("error" in r) throw new Error(r.error);
    if (!("ghost" in r)) throw new Error("unexpected reply");
    return r.ghost;
  }
}
