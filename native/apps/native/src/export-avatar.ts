// Build-only: the website avatar editor's pose data (avatar/stage.ts GESTURES) and the knife inspect lengths its
// "Show off" pose waits on, for the native avatar renderer (avatar_stage.hpp). Read from the vendored web code so a
// re-sync brings new gestures with it.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GESTURES } from "../../web/src/avatar/stage";
import { inspectSetFor } from "../../web/src/viewmodel/inspects/index";
import { KNIVES, knifeById } from "../../web/src/viewmodel/knives/index";

const output = resolve(process.argv[2] ?? "target/native-assets");
// stage.ts script(): `inspectSetFor(knifeById(spec.knife) ?? null).clips[0]?.len`, by cosmetic id.
const inspectSeconds = Object.fromEntries(
  KNIVES.map((knife) => [knife.cosmeticId, inspectSetFor(knifeById(knife.cosmeticId) ?? null).clips[0]?.len ?? null]),
);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "avatar.json"), JSON.stringify({ version: 1, gestures: GESTURES, inspectSeconds }));
console.log(`Avatar poses: ${Object.keys(GESTURES).length} gestures, ${KNIVES.length} knife inspects -> ${output}`);
