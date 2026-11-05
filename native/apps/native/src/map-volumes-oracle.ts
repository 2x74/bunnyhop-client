// The website's map volumes (player/map-volumes.ts) on every BSP in a folder: the ladder boxes, the simulation's
// water at points in and around the water leaves and across the map, water levels, ladder gaps, and other players'
// ladder guess along scripted paths onto and past the ladders. map_volumes_tests.cpp reads the same BSPs with the
// C++ port and compares. A folder without BSPs writes an empty list (the test then skips).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LadderGuess, ladderGap, volumesOf, waterLevelAt, type MapVolumes } from "../../web/src/player/map-volumes";

const WATER = 0x30;
const WATER_LEAVES = 40;
const POINTS_PER_LEAF = 25;
const MAP_POINTS = 600;
const LEAF_MARGIN = 8;
const GUESS_LADDERS = 3;
const FRAME_SECONDS = [0.01, 1 / 144, 1 / 60, 0.013, 1 / 240];

/**
 * The website's own fixture points (test/map-volumes.test.ts), when those maps are here: bhop_mist_3's WR swims, then
 * climbs out on a ladder; bhop_lost_world's WR falls through render water the movement doesn't see.
 */
const FIXTURE_POINTS: Record<string, number[][]> = {
  "bhop_mist_3.bsp": [
    [-163.26, -1744.13, -1388.85],
    [-183.21, -1736.74, -1727.97],
    [-200.62, -1695.5, -1713.82],
    [-214.89, -1625.05, -1667.81],
    [-216.16, -1617.24, -1650.71],
    [-216.26, -1617.24, -1658.33],
    [-215.47, -1617.24, -1624.15],
    [-213.07, -1617.24, -1568.76],
  ],
  "bhop_lost_world.bsp": [[395.49, 45.93, -177.55]],
};

/** A small seeded generator (mulberry32), so the points are the same every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The world's bounds (model 0) and the water leaves' bounds, read from the BSP's lumps. */
function bounds(bsp: Uint8Array): { world: number[]; leaves: number[][] } {
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const lump = (i: number) => ({ ofs: dv.getInt32(8 + i * 16, true), len: dv.getInt32(12 + i * 16, true) });
  const models = lump(14),
    leafs = lump(10);
  const world = [0, 4, 8, 12, 16, 20].map((k) => dv.getFloat32(models.ofs + k, true));
  const size = dv.getInt32(4, true) <= 19 ? 56 : 32;
  const leaves: number[][] = [];
  for (let i = 0; i < Math.floor(leafs.len / size); i++) {
    const o = leafs.ofs + i * size;
    if (!(dv.getInt32(o, true) & WATER)) continue;
    leaves.push([8, 10, 12, 14, 16, 18].map((k) => dv.getInt16(o + k, true)));
  }
  return { world, leaves };
}

function inBox(box: number[], margin: number, next: () => number): number[] {
  return [0, 1, 2].map((k) => box[k] - margin + (box[k + 3] - box[k] + 2 * margin) * next());
}

function waterSamples(v: MapVolumes, bsp: Uint8Array, name: string, next: () => number) {
  const { world, leaves } = bounds(bsp);
  const points: number[][] = [...(FIXTURE_POINTS[name] ?? [])];
  const step = Math.max(1, Math.floor(leaves.length / WATER_LEAVES));
  for (let i = 0; i < leaves.length; i += step)
    for (let k = 0; k < POINTS_PER_LEAF; k++) points.push(inBox(leaves[i], LEAF_MARGIN, next));
  for (let k = 0; k < MAP_POINTS; k++) points.push(inBox(world, 0, next));
  return points.map((p) => ({
    p: p.map(Math.fround),
    water: v.water ? v.water(Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])) : false,
    standing: waterLevelAt(p.map(Math.fround), 64, false, v),
    crouched: waterLevelAt(p.map(Math.fround), 46, true, v),
    gap: Math.min(1e6, ladderGap(p.map(Math.fround), false, v)),
  }));
}

/**
 * A player walking up to a ladder's side, climbing it at a ladder's steady speed, then strafing off it and falling,
 * with the frame times varying. Positions and velocities in float, as the room's interpolated frames are.
 */
function guessPath(v: MapVolumes, box: number[]) {
  const guess = new LadderGuess();
  const steps = [];
  const y = (box[1] + box[4]) / 2;
  let x = box[0] - 16 - 30,
    z = box[2] + 10,
    vx = 100,
    vz = 0,
    time = 0,
    phase = "approach",
    phaseTime = 0;
  for (let i = 0; i < 260; i++) {
    const dt = FRAME_SECONDS[i % FRAME_SECONDS.length];
    if (phase === "approach" && x + 16 >= box[0] - 1) ((phase = "climb"), (phaseTime = 0), (vx = 0));
    if (phase === "climb" && phaseTime > 0.6) ((phase = "strafe off"), (phaseTime = 0), (vx = -250), (vz = 0));
    if (phase === "climb") vz = 200;
    else if (phase === "strafe off") vz -= 800 * dt;
    const pos = [x, y, z].map(Math.fround),
      vel = [vx, 0, vz].map(Math.fround);
    const on = guess.update(pos, vel, false, false, time, v);
    steps.push({ time, pos, vel, on });
    x += vx * dt;
    z += vz * dt;
    time += dt;
    phaseTime += dt;
  }
  return steps;
}

function mapOracle(path: string) {
  const bsp = new Uint8Array(readFileSync(path));
  const v = volumesOf(bsp);
  const next = random(0x5eed);
  return {
    path,
    hasWater: v.water !== null,
    ladders: v.ladders,
    samples: waterSamples(v, bsp, basename(path), next),
    guesses: v.ladders.slice(0, GUESS_LADDERS).map((box) => guessPath(v, box)),
  };
}

const [folder, output] = process.argv.slice(2);
if (!folder || !output) throw new Error("usage: map-volumes-oracle.ts MAPS OUTPUT");
const maps = existsSync(folder)
  ? readdirSync(folder)
      .filter((name) => name.endsWith(".bsp"))
      .sort()
      .map((name) => join(folder, name))
  : [];
await writeFile(output, JSON.stringify(maps.map(mapOracle)));
