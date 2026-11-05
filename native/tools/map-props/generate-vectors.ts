// Golden vectors for native random animators (apps/native/src/map_props_tests.cpp, crates/native-bridge map_props.rs).
//
// Runs the web's RandomAnimator, seededRandom and hashSeed (the vendored apps/web/src/map-props.ts) over fixed seeds,
// sequence tables and times, and the map fingerprint render.ts seeds them with over a fixed entity list. The C++ and
// Rust ports must match exactly.
//
// Usage: bun tools/map-props/generate-vectors.ts [--out apps/native/src/map_props_vectors.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { hashSeed, RandomAnimator, seededRandom, type RandomSequenceSource } from "../../apps/web/src/map-props";

const { values } = parseArgs({
  options: { out: { type: "string", default: "apps/native/src/map_props_vectors.json" } },
});

const randoms = [0, 1, 0xdeadbeef, 0xffffffff].map((seed) => {
  const next = seededRandom(seed);
  return { seed, values: Array.from({ length: 6 }, () => next()) };
});

const hashes = [
  ["models/plar/butterfly.mdl", 0],
  ["models/antosha/bhop_retrowave/coin.mdl", 0x9e3779b1],
  ["", 7],
  ["café ☕ 🐇", 3],
].map(([text, n]) => ({ text, n, hash: hashSeed(text as string, n as number) }));

// Entities as the core lists them (key / value pairs in order), read the way core.ts `entities()` reads the wasm's
// entity text: one tab-separated `key=value` line each, empty lines dropped, the last of a repeated key kept.
const entityPairs: [string, string][][] = [
  [
    ["classname", "worldspawn"],
    ["mapversion", "12"],
  ],
  [],
  [
    ["classname", "prop_dynamic"],
    ["targetname", "fly"],
    ["origin", "1 2 3"],
    ["targetname", "fly2"],
  ],
  [
    ["origin", "-5 0.5 7"],
    ["classname", "info_player_start"],
  ],
  [
    ["Classname", "light"],
    ["origin", "0 0 0"],
  ],
];
const entities = entityPairs
  .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("\t"))
  .filter(Boolean)
  .map((line) =>
    Object.fromEntries(line.split("\t").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])),
  );
const mapSeed = hashSeed(
  entities.map((e) => `${e.classname ?? ""}|${e.targetname ?? ""}|${e.origin ?? ""}`).join("\n"),
);

interface Table {
  cps: number[];
  looping: boolean[];
  idle: { seq: number; weight: number }[];
}
const tables: Table[] = [
  // Two looping idles and a one-shot, weighted 1 / 3 / 2.
  {
    cps: [1, 0.5, 2.5],
    looping: [true, false, true],
    idle: [
      { seq: 0, weight: 1 },
      { seq: 1, weight: 3 },
      { seq: 2, weight: 2 },
    ],
  },
  // A negative weight keeps the current sequence while it plays.
  {
    cps: [0.8, 1.6],
    looping: [true, true],
    idle: [
      { seq: 1, weight: -2 },
      { seq: 0, weight: 1 },
    ],
  },
  // No idle sequence: sequence 0 at rate 1.
  { cps: [1.25], looping: [false], idle: [] },
];
const source = (t: Table): RandomSequenceSource => ({
  cps: (s) => t.cps[s],
  looping: (s) => t.looping[s],
  idle: () => t.idle,
});
const times = [0, 0.05, 0.3, 1.2, 2.95, 3, 5.5, 9.99, 14.2, 30, 61.7, 4.1, 0.2, 125];
const animators = [
  { seed: 12345, min: 2, max: 6, table: 0 },
  { seed: 999, min: 0, max: 0, table: 0 },
  { seed: 4242, min: 1.5, max: 1.5, table: 1 },
  { seed: 7, min: 5, max: 10, table: 2 },
].map((a) => {
  const animator = new RandomAnimator(a.seed, a.min, a.max, source(tables[a.table]));
  const out: [number, number] = [0, 0];
  return {
    ...a,
    at: times.map((time) => {
      animator.at(time, out);
      return { time, sequence: out[0], cycle: out[1] };
    }),
  };
});

writeFileSync(
  values.out!,
  JSON.stringify({ randoms, hashes, entityPairs, mapSeed, tables, animators }, null, 1) + "\n",
);
console.log(`map props vectors: ${animators.length} animators, written to ${values.out}`);
