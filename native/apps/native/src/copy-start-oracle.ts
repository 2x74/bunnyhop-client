// The native recorder supplies the fixtures; the pinned web code decides their starts and verifies the copied runs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeBsp, SURF_NOLIGHT, type MapSource } from "../../../tools/tutorial/bsp";
import { Core } from "../../web/src/core";
import { decodeReplay, encodeReplay } from "../../web/src/replay";
import { runStartPoint } from "../../web/src/copy-start";
import { resolveStartPoint } from "../../web/src/start-point";
import { verifyReplay } from "../../web/src/verifier";
const directory = Bun.argv[2];
if (!directory) throw new Error("Pass the native Copy start fixture directory");
if (Bun.argv.includes("--map")) {
  await mkdir(directory, { recursive: true });
  const source: MapSource = {
    worldspawn: {},
    boxes: [
      { min: [-544, -544, -32], max: [2080, 544, 0], tex: "tools/toolsnodraw" },
      { min: [-544, -544, 0], max: [-512, 544, 512], tex: "tools/toolsnodraw" },
      { min: [2048, -544, 0], max: [2080, 544, 512], tex: "tools/toolsnodraw" },
      { min: [-512, -544, 0], max: [2048, -512, 512], tex: "tools/toolsnodraw" },
      { min: [-512, 512, 0], max: [2048, 544, 512], tex: "tools/toolsnodraw" },
      { min: [-544, -544, 512], max: [2080, 544, 544], tex: "tools/toolsnodraw" },
    ],
    materials: { "tools/toolsnodraw": { width: 32, height: 32, reflectivity: [0.5, 0.5, 0.5], flags: SURF_NOLIGHT } },
    brushEntities: [],
    points: [{ classname: "info_player_start", origin: "10 20 100", angles: "0 45 0" }],
    seeds: [[10, 20, 100]],
    lighting: { sunDir: [0, 0, -1], sun: [0, 0, 0], sky: [0, 0, 0], bounce: [0, 0, 0], luxel: 64, skyRays: 1 },
  };
  await writeFile(join(directory, "fixture.bsp"), writeBsp(source).bsp);
  process.exit(0);
}
const core = await Core.create(await readFile("apps/web/src/wasm/bunnyhop_core.wasm"));
const map = await readFile(join(directory, "fixture.bsp"));
core.loadMap(map);
const cases: Record<string, unknown>[] = [];
for (const file of ["saved.bhr", "walked.bhr", "bonus.bhr", "tiny-yaw.bhr"]) {
  const replay = await decodeReplay(await readFile(join(directory, file)));
  const result = runStartPoint(core, replay, replay.header.zones, "fixture");
  if (!result.ok) throw new Error(`${file}: ${result.reason}`);
  if (!resolveStartPoint(core, replay.header.settings, "fixture", result.track, result.point, replay.header.zones))
    throw new Error(`${file}: the point failed the shared restart check`);
  cases.push({ file, ...result });
  if (Bun.argv.includes("--verify-copied")) {
    const copied = await decodeReplay(await readFile(join(directory, "copied-" + file)));
    const verdict = verifyReplay(core, copied, copied.header.zones, { mapSha256: copied.header.mapSha256 });
    if (!verdict.valid) throw new Error(`${file} copied run: ${JSON.stringify(verdict)}`);
  }
}
const source = await decodeReplay(await readFile(join(directory, "saved.bhr")));
const laterCheckpoint = source.checkpoints.findIndex((checkpoint) => checkpoint.tick > source.header.startTick + 1);
if (laterCheckpoint < 0) throw new Error("The fixture needs a checkpoint after the start");
const mutations = [
  {
    file: "zero-interval-desynced.bhr",
    replay: {
      ...source,
      header: { ...source.header, checkpointInterval: 0 },
      checkpoints: source.checkpoints.map((checkpoint, index) =>
        index === laterCheckpoint
          ? {
              ...checkpoint,
              position: [checkpoint.position[0] + 10, ...checkpoint.position.slice(1)] as [number, number, number],
            }
          : checkpoint,
      ),
    },
  },
  { file: "other-map.bhr", replay: { ...source, header: { ...source.header, map: "other" } } },
  { file: "never-started.bhr", replay: { ...source, header: { ...source.header, startTick: 0 } } },
  {
    file: "desynced.bhr",
    replay: {
      ...source,
      checkpoints: source.checkpoints.map((checkpoint, index) =>
        index === 0
          ? {
              ...checkpoint,
              position: [checkpoint.position[0] + 10, ...checkpoint.position.slice(1)] as [number, number, number],
            }
          : checkpoint,
      ),
    },
  },
];
for (const { file, replay } of mutations) {
  await writeFile(join(directory, file), await encodeReplay(replay));
  const result = runStartPoint(core, replay, source.header.zones, "fixture");
  if (result.ok) throw new Error(`${file}: the invalid start was accepted`);
  cases.push({ file, track: source.header.track, ...result });
}
await writeFile(join(directory, "expected.json"), JSON.stringify(cases, null, 2));
core.dispose();
console.log(
  `Copy start: ${cases.length} web/native cases${Bun.argv.includes("--verify-copied") ? ", four copied runs verify" : ""}`,
);
