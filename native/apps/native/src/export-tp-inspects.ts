// Build-only authored knife-local tracks. The runtime resolves gestures against each live posed elbow/hand.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectKnifeTrack } from "../../web/src/viewmodel/inspects/third";
import { inspectSetFor } from "../../web/src/viewmodel/inspects/index";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { TP_CARROT } from "../../web/src/viewmodel/knives/ctx";
// The authored bayonet hold uses performance.now() for idle wrist sway. Freeze it while
// baking / comparing knife-local tracks so wall-clock timing cannot change the asset.
Object.defineProperty(performance, "now", { value: () => 0, configurable: true });
Math.random = () => 0;
const output = resolve(process.argv[2] ?? "target/native-assets");
const knives = Object.fromEntries(
  KNIVES.map((knife) => {
    const def = knife.id === "carrot" ? null : knife,
      set = inspectSetFor(def);
    return [
      knife.id,
      {
        tp: knife.tp ?? TP_CARROT,
        maxLoops: set.spec.maxLoops ?? 6,
        clips: set.clips.map((c) => {
          const tr = inspectKnifeTrack(c, def);
          return {
            len: c.len,
            enter: c.enter,
            exit: c.exit,
            open: c.open,
            loop: c.loop ?? null,
            n: tr.n,
            q: Array.from(tr.q),
            p: Array.from(tr.p),
          };
        }),
      },
    ];
  }),
);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "tp-inspects.json"), JSON.stringify({ version: 1, knives }));
console.log(`Native third-person inspect tracks: ${Object.keys(knives).length} knives, exact live-pose gesture solver`);
