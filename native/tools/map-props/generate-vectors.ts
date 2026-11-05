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
function fingerprint(pairsList: [string, string][][]): number {
  const entities = pairsList
    .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("\t"))
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(line.split("\t").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])),
    );
  return hashSeed(entities.map((e) => `${e.classname ?? ""}|${e.targetname ?? ""}|${e.origin ?? ""}`).join("\n"));
}
const mapSeed = fingerprint(entityPairs);

// The release's golden case (apps/web/test/map-props.test.ts "RandomAnimation golden vectors"): a thumper as entity 7
// of a two-entity map, seeded as render.ts seeds every random animator.
const RANDOM_ENTITY_MULTIPLIER = 0x9e3779b1;
const GOLDEN_ENTITY = 7;
const GOLDEN_MODEL = "models/props_combine/combinethumper002.mdl";
const goldenPairs: [string, string][][] = [
  [["classname", "worldspawn"]],
  [
    ["classname", "prop_dynamic"],
    ["targetname", "thumper"],
    ["origin", "-267 -308 -9312"],
  ],
];
const goldenMapSeed = fingerprint(goldenPairs);
const golden = {
  entityPairs: goldenPairs,
  mapSeed: goldenMapSeed,
  entity: GOLDEN_ENTITY,
  model: GOLDEN_MODEL,
  seed: hashSeed(GOLDEN_MODEL, goldenMapSeed ^ Math.imul(GOLDEN_ENTITY + 1, RANDOM_ENTITY_MULTIPLIER)),
};

const randoms = [0, 1, 0xdeadbeef, 0xffffffff, golden.seed].map((seed) => {
  const next = seededRandom(seed);
  return { seed, values: Array.from({ length: 6 }, () => next()) };
});

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
  // The golden case's model: idles 1 and 2 weighted 1 / 3, the second one-shot.
  {
    cps: [1, 0.5, 0.25],
    looping: [true, true, false],
    idle: [
      { seq: 1, weight: 1 },
      { seq: 2, weight: 3 },
    ],
  },
];
const source = (t: Table): RandomSequenceSource => ({
  cps: (s) => t.cps[s],
  looping: (s) => t.looping[s],
  idle: () => t.idle,
});
const times = [0, 0.05, 0.3, 1.2, 2.95, 3, 5.5, 9.99, 14.2, 30, 61.7, 4.1, 0.2, 125];
const goldenTimes = [0, 2, 4, 6, 9, 13, 20, 30, 60];
const animators = [
  { seed: 12345, min: 2, max: 6, table: 0, times },
  { seed: 999, min: 0, max: 0, table: 0, times },
  { seed: 4242, min: 1.5, max: 1.5, table: 1, times },
  { seed: 7, min: 5, max: 10, table: 2, times },
  { seed: golden.seed, min: 2, max: 5, table: 3, times: goldenTimes },
].map(({ times: at, ...a }) => {
  const animator = new RandomAnimator(a.seed, a.min, a.max, source(tables[a.table]));
  const out: [number, number] = [0, 0];
  return {
    ...a,
    at: at.map((time) => {
      animator.at(time, out);
      return { time, sequence: out[0], cycle: out[1] };
    }),
  };
});

writeFileSync(
  values.out!,
  JSON.stringify({ randoms, hashes, entityPairs, mapSeed, golden, tables, animators }, null, 1) + "\n",
);
console.log(`map props vectors: ${animators.length} animators, written to ${values.out}`);
