// Offline negative fixtures using the existing web BHR encoder. Never touches
// the input replay or a production cache. Run with Bun, input BHR and output dir.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeRaw, encodeRaw } from "../../web/src/replay";

const [input, output] = Bun.argv.slice(2);
if (!input || !output || !resolve(output).startsWith("/tmp/bunnyhop-pb-worker-"))
  throw new Error("usage: bun menu_pb_test_fixtures.ts COMPLETED.bhr /tmp/bunnyhop-pb-worker-NAME");
await mkdir(output, { recursive: true });
const bytes = await readFile(input);
const source = decodeRaw(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
if (source.header.totalTicks <= 128 || source.header.endTick <= source.header.startTick)
  throw new Error("fixture source must be a completed run longer than 128 ticks");
for (const name of ["checkpoint", "incomplete", "tiny-interval", "wrong-map"]) {
  const replay = structuredClone(source);
  if (name === "checkpoint") replay.checkpoints = [{ tick: 1, position: [1e6, 1e6, 1e6], velocity: [0, 0, 0] }];
  if (name === "incomplete") replay.header.endTick = 0;
  if (name === "wrong-map") replay.header.mapSha256 = "00".repeat(32);
  if (name === "tiny-interval") {
    replay.header.settings.tickInterval = 1e-12;
    replay.checkpoints = [];
  }
  await writeFile(join(output, `${name}.bhr`), gzipSync(encodeRaw(replay)));
}
