// Test-only oracle: runs the web closest-position search (apps/web/src/closest-pos.ts) over the routes of its own test
// file and records every answer, so src/closest_pos_tests.cpp can ask the C++ port the same questions. No generated
// value is used by the native application. The search is IEEE-exact arithmetic, so the answers must match to the bit.
import { writeFileSync } from "node:fs";
import { ClosestPos, formatSpeedDiff } from "../../web/src/closest-pos";
import { EVENT_TELEPORTED } from "../../web/src/core";
import { FRAME_STRIDE } from "../../web/src/sim";

const INTERVAL = Math.fround(0.01);
type Position = [number, number, number];
/** A position to find, or "reset" for a restart. */
type Op = Position | "reset";

function route(n: number, at: (t: number) => Position): Float32Array {
  const frames = new Float32Array((n + 1) * FRAME_STRIDE);
  for (let t = 0; t <= n; t++) frames.set(at(t), t * FRAME_STRIDE);
  return frames;
}

const posOf = (frames: Float32Array, t: number): Position => [
  frames[t * FRAME_STRIDE],
  frames[t * FRAME_STRIDE + 1],
  frames[t * FRAME_STRIDE + 2],
];

/** Every `step` ticks of the route from `from` to `to`, moved by `offset`. */
function follow(frames: Float32Array, from: number, to: number, step: number, offset: Position = [0, 0, 0]): Op[] {
  const ops: Op[] = [];
  for (let t = from; t <= to; t += step) {
    const [x, y, z] = posOf(frames, t);
    ops.push([x + offset[0], y + offset[1], z + offset[2]]);
  }
  return ops;
}

interface Options {
  start?: number;
  end?: number;
  events?: Uint8Array;
  /** Route frames built before the first question: all of them, or none (the search scans). */
  built?: boolean;
  /** Route frames built between questions, as the game does per rendered frame. */
  slice?: number;
}

function ask(name: string, frames: Float32Array, ops: Op[], o: Options = {}) {
  const start = o.start ?? 0;
  const end = o.end ?? frames.length / FRAME_STRIDE - 1;
  const search = new ClosestPos(frames, start, end, INTERVAL, o.events);
  if (o.built ?? true) search.build();
  const answers = ops.map((op) => {
    if (o.slice) search.build(o.slice);
    if (op === "reset") {
      search.reset();
      return null;
    }
    const found = search.find(op[0], op[1], op[2]);
    return { found, tick: search.tick, dist: search.dist, speed: search.speed, ready: search.ready };
  });
  return {
    name,
    frames: Array.from({ length: frames.length / FRAME_STRIDE }, (_, t) => posOf(frames, t)).flat(),
    start,
    end,
    interval: INTERVAL,
    events: o.events ? Array.from(o.events, (bits) => (bits & EVENT_TELEPORTED ? 1 : 0)) : null,
    built: o.built ?? true,
    slice: o.slice ?? 0,
    ops,
    answers,
  };
}

/** A square loop of `lap` ticks, `laps` times, on the flat. */
const loop = (laps: number, lap = 1200) =>
  route(laps * lap, (t) => {
    const u = ((t % lap) / lap) * 4;
    const s = 1800 * (u % 1);
    return u < 1 ? [s, 0, 0] : u < 2 ? [1800, s, 0] : u < 3 ? [1800 - s, 1800, 0] : [0, 1800 - s, 0];
  });

function randomQuestions(frames: Float32Array, count: number): Op[] {
  let seed = 12345;
  const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const last = frames.length / FRAME_STRIDE - 1;
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = posOf(frames, Math.floor(r() * last));
    ops.push([x + r() * 800 - 400, y + r() * 800 - 400, z + r() * 200 - 100]);
  }
  return ops;
}

const wander = route(5000, (t) => [Math.sin(t / 90) * 2000, t * 3, Math.abs(Math.sin(t / 30)) * 50]);
const big = route(20011, (t) => [Math.sin(t / 700) * 5000 + t / 3, Math.cos(t / 500) * 5000, Math.sin(t / 200) * 200]);
const straight = route(1000, (t) => [t * 6, 0, 0]);
const threeLaps = loop(3);
const twoLaps = loop(2);
const nudged = loop(2);
for (let t = 1200; t <= 2400; t++) nudged[t * FRAME_STRIDE + 1] += 30;
const spiral = route(4000, (t) => [Math.cos(t / 63.66) * 700, Math.sin(t / 63.66) * 700, t * 0.75]);
const spiralLine = follow(spiral, 0, 4000, 4).map((op) => {
  const [x, y, z] = op as Position;
  const r = Math.hypot(x, y);
  return [x * (1 - 150 / r), y * (1 - 150 / r), z] as Position;
});
const teleporting = route(2000, (t) => (t <= 1000 ? [t * 6, 0, 0] : [t * 6, 20000, 500]));
const shortTeleport = route(100, (t) => (t <= 50 ? [t, 0, 0] : [t + 150, 0, 0]));
const shortEvents = new Uint8Array(101);
shortEvents[51] = EVENT_TELEPORTED;
const stages = route(6000, (t) => [t * 6, Math.sin(t / 50) * 60, 0]);
const stoodStill = route(1000, (t) =>
  t < 300 ? [t * 6, 0, 0] : t < 700 ? [1800, 0, 0] : [1800 + (t - 700) * 6, 0, 0],
);
const curved = route(4000, (t) => [t * 6, Math.sin(t / 40) * 100, 0]);
const long = route(50000, (t) => [Math.sin(t / 300) * 3000, t / 2, 0]);
const flat = route(2000, (t) => [t * 6, 0, 0]);

const cases = [
  ask("straight run", straight, [[600, 20, 0], [603, 0, 0], ...follow(straight, 0, 1000, 7)]),
  ask("identical run", wander, follow(wander, 0, 5000, 4)),
  ask("index, far and near", big, randomQuestions(big, 600)),
  ask("scan until built", curved, follow(curved, 0, 4000, 8, [5, 30, 0]), { built: false }),
  ask("built in slices", long, [...follow(long, 0, 50000, 25), "reset", ...follow(long, 0, 2000, 4)], { slice: 256 }),
  ask("loop, three laps off the line", threeLaps, follow(threeLaps, 0, 3600, 4, [40, 40, 0])),
  ask("a later lap passes closer", nudged, follow(twoLaps, 0, 1100, 4, [0, 30, 0])),
  ask("levels over each other", spiral, spiralLine),
  ask("the ghost's teleport", teleporting, follow(teleporting, 0, 2000, 4, [0, 10, 0])),
  ask("right after the ghost's teleport", teleporting, [posOf(teleporting, 996), posOf(teleporting, 1001)]),
  ask("a short teleport by its event", shortTeleport, [posOf(shortTeleport, 51), posOf(shortTeleport, 50)], {
    events: shortEvents,
  }),
  ask("a short teleport without its event", shortTeleport, [posOf(shortTeleport, 51), posOf(shortTeleport, 50)]),
  ask("your teleports", stages, [
    ...follow(stages, 0, 3000, 4),
    posOf(stages, 1000),
    posOf(stages, 1004),
    posOf(stages, 5500),
  ]),
  ask("the ghost stood still", stoodStill, [...follow(stoodStill, 0, 299, 4), [1800, 0, 0], [1860, 0, 0]]),
  ask("far off the route", flat, [
    [0, 0, 0],
    [600, 612, 0],
    [9000, 10, 0],
  ]),
  ask("height counts double", straight, [
    [600, 0, 266],
    [600, 0, 246],
  ]),
  ask("restart on a loop", twoLaps, [...follow(twoLaps, 0, 2000, 4), "reset", posOf(twoLaps, 8)]),
  ask(
    "a bonus between its ticks",
    straight,
    [
      [100, 0, 0],
      [3000, 0, 0],
      [5900, 0, 0],
      [4800, 0, 0],
    ],
    { start: 500, end: 800 },
  ),
  ask(
    "one frame",
    route(0, () => [5, 5, 5]),
    [[5, 5, 5]],
    { start: 0, end: 0 },
  ),
  ask(
    "an end past the route",
    route(40, (t) => [t, 0, 0]),
    [[40, 0, 0]],
    { end: 999 },
  ),
];

const out = process.argv[2];
if (!out) throw new Error("usage: closest_pos_oracle.ts <output.json>");
writeFileSync(
  out,
  JSON.stringify({
    cases,
    speedText: [42.4, -17.6, 0, -0.4, -0.5, 0.5, 2.5, -2.5, 1234.49, -1234.51].map((value) => ({
      value,
      text: formatSpeedDiff(value),
    })),
  }),
);
const total = cases.reduce((n, c) => n + c.answers.filter(Boolean).length, 0);
console.log(`Closest position oracle: ${cases.length} routes, ${total} answers`);
