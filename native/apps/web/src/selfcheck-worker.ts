// Self-check worker (selfcheck.ts): re-simulates a finished run's replay with the verifier the server uses, on a
// physics-only sim instance of its own, off the main thread so it never costs the game a frame.
//
// Messages in:  { type: "init", wasm, bsp, physics }   once per map (the BSP and the registered prop collision models)
//               { type: "check", id, replay }           gzip .bhr bytes
// Messages out: { id, valid, firstMismatchTick, problems, simMs } | { id, error }

import { Core, registerPhysicsContent } from "./core";
import { decodeReplay } from "./replay";
import { verifyReplay } from "./verifier";

type InMsg =
  | { type: "init"; wasm: Uint8Array<ArrayBuffer>; bsp: Uint8Array; physics: [string, Uint8Array][] }
  | { type: "check"; id: number; replay: Uint8Array };

const ctx = self as unknown as { onmessage: ((e: MessageEvent<InMsg>) => void) | null; postMessage(m: unknown): void };
let core: Promise<Core> | null = null;

ctx.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    registerPhysicsContent(m.physics);
    core = (async () => {
      const c = await Core.create(m.wasm);
      c.loadMapPhysics(m.bsp);
      return c;
    })();
    core.catch(() => {}); // reported by the check that awaits it
    return;
  }
  try {
    if (!core) throw new Error("not initialised");
    const c = await core;
    const replay = await decodeReplay(m.replay);
    // The run's own zones: this checks the client against itself (determinism), the server checks the pinned zones.
    const r = verifyReplay(c, replay, replay.header.zones, { mapSha256: null, ranked: true });
    ctx.postMessage({ id: m.id, valid: r.valid, firstMismatchTick: r.firstMismatchTick, problems: r.problems.slice(0, 3), simMs: r.simMs });
  } catch (err) {
    ctx.postMessage({ id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
