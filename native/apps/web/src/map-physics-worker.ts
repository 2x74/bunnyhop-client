// Map physics worker (map-physics.ts): one physics-only core for the map, off the main thread, for the self-check of
// finished runs and the race ghosts' re-simulations (physics-jobs.ts).
//
// Messages in:  { type: "init", wasm, bsp, physics }   once per map (the BSP as a Blob, the registered prop collision
//                                                       models)
//               PhysicsJob                              { type: "check" | "ghost", id, replay } (gzip .bhr bytes)
// Messages out: PhysicsReply                            { id, ... } | { id, error }

import { Core, registerPhysicsContent } from "./core";
import { physicsJobs, type PhysicsJob } from "./physics-jobs";

type InMsg = { type: "init"; wasm: Uint8Array<ArrayBuffer>; bsp: Blob; physics: [string, Uint8Array][] } | PhysicsJob;

const ctx = self as unknown as { onmessage: ((e: MessageEvent<InMsg>) => void) | null; postMessage(m: unknown, transfer?: Transferable[]): void };
let core: Promise<Core> | null = null;
const run = physicsJobs(() => core ?? Promise.reject(new Error("not initialised")));

ctx.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    registerPhysicsContent(m.physics);
    core = (async () => {
      const c = await Core.create(m.wasm);
      await c.loadMapPhysicsStream(m.bsp.stream(), m.bsp.size);
      return c;
    })();
    core.catch(() => {}); // reported by the job that awaits it
    return;
  }
  const { reply, transfer } = await run(m);
  ctx.postMessage(reply, transfer);
};
