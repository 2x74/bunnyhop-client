// The website's hop effects (player/hop-fx.ts spawnHop, player/hop-layer.ts HopEmitter) on fixed inputs:
// hop_effects_tests.cpp makes the same bursts from the same seeds and must write the same records, and finds the same
// floor round a hop on a synthetic block.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeHopEffects } from "./export-hop-effects";
import { HOP_FX, hopSeed, spawnHop, type HopSpawn } from "../../web/src/player/hop-fx";
import { HopEmitter } from "../../web/src/player/hop-layer";

const spawns: HopSpawn[] = [
  {
    x: 120.4,
    y: 64.03,
    z: -310.7,
    vx: 480,
    vz: -150,
    t: 12.375,
    slot: 3,
    quality: 1,
    motion: 1,
    tint: [0.9, 0.5, 0.05],
    tint2: [0.2, 0.4, 1],
    alpha: 1,
    reach: null,
    slope: null,
  },
  {
    x: -40.5,
    y: 0.03,
    z: 18,
    vx: 0,
    vz: 0,
    t: 3.5,
    slot: 0,
    quality: 0.5,
    motion: 0.35,
    tint: [1, 1, 1],
    tint2: [0.1, 0.9, 0.3],
    alpha: 0.55,
    reach: [96, 20.5, 14.25, 96, 9, 96, 33, 96],
    slope: [0.125, -0.25],
  },
];
const bursts = [];
for (const [id, def] of Object.entries(HOP_FX))
  for (const spawn of spawns) {
    const seed = hopSeed(spawn.x, spawn.z, spawn.t);
    const records: number[][] = [];
    spawnHop(def, spawn, seed, (r) => records.push(Array.from(r)));
    bursts.push({ id, spawn, seed, records });
  }

// A block: floor at z 0 over x -20 .. 30, y -50 .. 50, a ramp up to the +y side beyond, and a lower floor at -40
// everywhere else (a probe only sees 48 units down).
function ground(x: number, y: number): number {
  if (x >= -20 && x <= 30 && y >= -50 && y <= 50) return 0;
  if (x >= -20 && x <= 30 && y > 50 && y <= 90) return (y - 50) * 0.5;
  return -40;
}
const probe = (x: number, y: number, z: number): number | null => {
  const g = ground(x, y);
  return g <= z && g >= z - 48 ? g : null;
};
const places = [];
for (const [x, y] of [
  [0, 0],
  [26, 0],
  [33, 10],
  [-22, -48],
  [5, 47],
  [5, 70],
]) {
  const emitter = new HopEmitter();
  emitter.probe = probe;
  const internals = emitter as unknown as {
    reach(x: number, y: number, z: number): Float32Array | null;
    settle(reach: ArrayLike<number>, x: number, y: number, z: number): boolean;
    slope: Float32Array;
    moved: Float64Array;
  };
  const z = ground(x, y) < -1 ? 0 : ground(x, y);
  const reach = Array.from(internals.reach(x, y, z)!);
  const slope = Array.from(internals.slope);
  const moved = internals.settle(reach, x, y, z) ? Array.from(internals.moved) : null;
  places.push({ x, y, z, reach, slope, moved });
}

// The recipes as the native build exports them, beside the oracle (hop-fx.json).
await writeHopEffects(dirname(process.argv[2]));
await writeFile(process.argv[2], JSON.stringify({ bursts, places }));
