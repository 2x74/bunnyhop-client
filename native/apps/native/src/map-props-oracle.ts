// Test-only oracle: poses a small made-up studio model with the website's bone setup (player/studio/pose.ts) and plays
// it with map-props.ts sequenceAt, and moves textures with texture-scroll.ts, so src/map_props_tests.cpp can ask the
// C++ ports the same questions. The model has a parent chain, looping and one-shot sequences, a pose-parameter blend,
// an autolayer, delta and post-delta layers, a one-frame sequence and an activity. No value here reaches the app.
import { writeFileSync } from "node:fs";
import type { Core } from "../../web/src/core";
import { sequenceAt, type SequenceSource } from "../../web/src/map-props";
import { StudioData, type StudioInfo } from "../../web/src/player/studio/data";
import { BoneSetup, concat34To44 } from "../../web/src/player/studio/pose";
import { animationFrame, scrollOffset } from "../../web/src/texture-scroll";

const BONES = 3;
const LOOPING = 0x1;
const DELTA = 0x4;
const POST = 0x10;

/** A small deterministic generator, so the model is the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalised(q: number[]): number[] {
  const length = Math.sqrt(q.reduce((sum, v) => sum + v * v, 0));
  return q.map((v) => v / length);
}

/** Frames x bones x 7 samples: rotations that turn over the animation, positions that drift. */
function animation(frames: number, seed: number, delta: boolean): Float32Array {
  const random = generator(seed);
  const out = new Float32Array(frames * BONES * 7);
  for (let f = 0; f < frames; f++)
    for (let b = 0; b < BONES; b++) {
      const angle = (delta ? 0.3 : 1.2) * (random() - 0.5) + f * 0.05 * (b + 1);
      const axis = normalised([random() - 0.5, random() - 0.5, random() + 0.2]);
      const s = Math.sin(angle / 2);
      const q = normalised([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]);
      const at = (f * BONES + b) * 7;
      out.set(q, at);
      out.set([random() * 4 - 2 + f * 0.1, random() * 4 - 2, (delta ? 0 : 8 * b) + random()], at + 4);
    }
  return out;
}

const animations = [
  { name: "idle", fps: 30, flags: 0, frames: 31, samples: animation(31, 1, false) },
  { name: "open", fps: 10, flags: 0, frames: 21, samples: animation(21, 2, false) },
  { name: "fly", fps: 20, flags: 0, frames: 11, samples: animation(11, 3, false) },
  { name: "wave", fps: 10, flags: DELTA, frames: 5, samples: animation(5, 4, true) },
  { name: "lean_left", fps: 15, flags: 0, frames: 3, samples: animation(3, 5, false) },
  { name: "lean_right", fps: 15, flags: 0, frames: 3, samples: animation(3, 6, false) },
  { name: "pose", fps: 30, flags: 0, frames: 1, samples: animation(1, 7, false) },
];

const random = generator(99);
const bone = (name: string, parent: number) => {
  const quat = normalised([random() - 0.5, random() - 0.5, random() - 0.5, 1]);
  const pos = [random() * 6 - 3, random() * 6 - 3, 10 * (parent + 1)];
  const poseToBone = [1, 0, 0, -pos[0], 0, 1, 0, -pos[1], 0, 0, 1, -pos[2] * (parent + 2)];
  return { name, parent, pos, quat, poseToBone, flags: 0 };
};

type Layer = StudioInfo["seqs"][number]["layers"][number];
const sequence = (
  name: string,
  flags: number,
  anims: number[],
  extra: Partial<StudioInfo["seqs"][number]> = {},
): StudioInfo["seqs"][number] => ({
  name,
  activity: "",
  actWeight: 0,
  flags,
  fadeIn: 0.2,
  fadeOut: 0.2,
  groupSize: [1, 1],
  params: [-1, -1],
  paramStart: [0, 0],
  paramEnd: [0, 0],
  anims,
  weights: [1, 1, 1],
  poseKeys: [],
  layers: [] as Layer[],
  ...extra,
});

const info: StudioInfo = {
  path: "models/oracle/prop.mdl",
  name: "oracle",
  version: 48,
  eye: [0, 0, 0],
  hull: [
    [0, 0, 0],
    [0, 0, 0],
  ],
  includes: [],
  bones: [bone("root", -1), bone("arm", 0), bone("hand", 1)],
  attachments: [],
  poseParams: [
    { name: "move_x", flags: 0, start: -1, end: 1, loop: 0 },
    { name: "body_yaw", flags: 0, start: -180, end: 180, loop: 360 },
  ],
  anims: animations.map(({ name, fps, flags, frames }) => ({ name, fps, flags, frames })),
  seqs: [
    sequence("idle", LOOPING, [0], { activity: "ACT_IDLE", actWeight: 1 }),
    sequence("open", 0, [1]),
    sequence("fly", LOOPING, [2], {
      activity: "ACT_IDLE",
      actWeight: 3,
      layers: [{ seq: 4, pose: -1, flags: 0, start: 0.1, peak: 0.3, tail: 0.7, end: 0.9 }],
    }),
    sequence("still", 0, [6]),
    sequence("wave", DELTA | LOOPING, [3], { weights: [0, 1, 0.5] }),
    sequence("lean", LOOPING, [4, 5], { groupSize: [2, 1], params: [0, -1], paramStart: [-1, 0], paramEnd: [1, 0] }),
    sequence("wave_post", DELTA | POST, [3]),
  ],
  materials: [],
  groups: [],
  vertexCount: 0,
  indexCount: 0,
};

const core = {
  studioInfo: () => JSON.stringify(info),
  studioVertices: () => new Float32Array(),
  studioIndices: () => new Uint32Array(),
  studioAnim: (_: number, a: number) => animations[a].samples,
};
const data = new StudioData(core as unknown as Core, 1);
const setup = new BoneSetup(data);

/** Skinning matrices of every bone (3x4 row-major, from three.js's column-major 4x4). */
function skin(seq: number, cycle: number): number[] {
  setup.initPose();
  setup.accumulate(seq, cycle, 1);
  const world = setup.buildMatrices();
  const four = new Float32Array(16);
  const out: number[] = [];
  for (let b = 0; b < BONES; b++) {
    concat34To44(world, b * 12, data.poseToBone, b * 12, four, 0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out.push(four[c * 4 + r]);
  }
  return out;
}

const poses: { sequence: number; cycle: number; matrices: number[] }[] = [];
for (let seq = 0; seq < info.seqs.length; seq++)
  for (const cycle of [0, 0.05, 0.25, 0.5, 0.71, 0.999, 1, 1.4, -0.3])
    poses.push({ sequence: seq, cycle, matrices: skin(seq, cycle) });

const rates = info.seqs.map((_, seq) => setup.cycleRate(seq));

// sequenceAt by sequence name (activities are checked separately in the C++ test).
const source: SequenceSource = {
  lookup: (name) => data.seq(name),
  cps: (seq) => rates[seq],
  looping: (seq) => data.seqs[seq].looping,
};
const states = [
  { anim: "idle", defaultAnim: "idle", base: 0, since: 0, rate: 1 },
  { anim: "open", defaultAnim: "idle", base: 0, since: 10, rate: 1 },
  { anim: "open", defaultAnim: "", base: 0, since: 10, rate: 1 },
  { anim: "fly", defaultAnim: "fly", base: 4, since: 4, rate: 2 },
  { anim: "fly", defaultAnim: "fly", base: 4.3, since: 5, rate: 0 },
  { anim: "open", defaultAnim: "fly", base: 1.25, since: 3, rate: -0.5 },
  { anim: "nope", defaultAnim: "idle", base: 0, since: 0, rate: 1 },
  { anim: "", defaultAnim: "", base: 0, since: 0, rate: 1 },
  { anim: "STILL", defaultAnim: "", base: 0, since: 0, rate: 1 },
];
const times = [0, 0.01, 0.37, 1, 3.75, 10, 11, 12.25, 13.9, 30, 123.456];
const shown = states.map((state) => ({
  state,
  at: times.map((time) => {
    const out: [number, number] = [0, 0];
    sequenceAt(state, time, 7, source, out);
    return { time, sequence: out[0], cycle: out[1] };
  }),
}));

const scrolls = [
  { rate: 1.5, angle: -90 },
  { rate: 0.25, angle: 0 },
  { rate: 0.02, angle: 33.3 },
  { rate: -3, angle: 180 },
].map((scroll) => ({ ...scroll, at: times.map((time) => ({ time, offset: scrollOffset(scroll, time) })) }));
const flipbooks = [
  { rate: 15, noWrap: false, frames: 8 },
  { rate: 30, noWrap: true, frames: 8 },
  { rate: 7.5, noWrap: false, frames: 1 },
  { rate: 24, noWrap: false, frames: 256 },
].map((book) => ({ ...book, at: times.map((time) => ({ time, frame: animationFrame(book, book.frames, time) })) }));

const output = process.argv[2] ?? "map-props-oracle.json";
writeFileSync(
  output,
  JSON.stringify({
    info,
    animations: animations.map((a) => [...a.samples]),
    rates,
    poses,
    shown,
    scrolls,
    flipbooks,
  }),
);
console.log(`map props oracle: ${poses.length} poses, ${shown.length} states, written to ${output}`);
