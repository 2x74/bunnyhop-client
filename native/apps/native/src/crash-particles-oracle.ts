import { writeFileSync } from "node:fs";
import {
  CRASH_BSP_SHA,
  particleBirths,
  sampleCrashParticle,
  crashTrailShape,
} from "../../web/src/map-effects/crash-explosions";
import definitions from "../../web/src/map-effects/crash-particles.json";

const rows = [];
for (const system of Object.keys(definitions)) {
  for (const seed of [0, 1, 977, 0xffffffff]) {
    for (const index of [0, 7, 511]) {
      for (const age of [-0.1, 0, 0.01, 0.1, 0.25, 0.5, 1, 2, 3]) {
        for (const angles of [
          [0, 0, 0],
          [-90, 0, 0],
          [10, 20, 30],
        ]) {
          const sample = sampleCrashParticle(system, index, age, seed, angles);
          rows.push({
            system,
            seed,
            index,
            age,
            angles,
            sample,
            trailShape: sample && crashTrailShape(system, sample, age),
          });
        }
      }
    }
  }
}
const births = Object.fromEntries(Object.keys(definitions).map((name) => [name, particleBirths(name)]));
writeFileSync(process.argv[2], JSON.stringify({ bspSha256: CRASH_BSP_SHA, definitions, births, rows }));
