// The website's third-person bunny (player/bunny/model.ts BunnyModel: the CS:S animation, the bank, the leg layer and
// the ears) posed through a scripted run that touches every leg-layer case, at mixed frame rates. actor_pose_tests.cpp
// poses the native State through the same frames and compares the skinning matrices.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { StudioData } from "../../web/src/player/studio/data";
import { BunnyModel } from "../../web/src/player/bunny/model";
import type { PlayerPose } from "../../web/src/player/model";

const JUMP_SPEED = 301.993;
const GRAVITY = 800;
const HOP_SECONDS = (2 * JUMP_SPEED) / GRAVITY;
const FRAME_SECONDS = [1 / 60, 1 / 144, 1 / 90, 1 / 240, 1 / 60, 1 / 120];
const BONES_EVERY = 3;
const OUTFIT = "outfit-cream";

// The floor the ground probe sees around the start: a gentle wave, so planted feet follow a slope. Below the drop
// there's no floor within the probe's reach and the feet use their own plane.
const FLOOR = { waveX: 1.5, waveY: 0.8, periodX: 37, periodY: 23 };
const DROP_Z = -335;
function floorAt(x: number, y: number): number {
  return FLOOR.waveX * Math.sin(x / FLOOR.periodX) + FLOOR.waveY * Math.cos(y / FLOOR.periodY);
}
function probe(x: number, y: number, z: number): number | null {
  const ground = floorAt(x, y);
  return ground <= z && ground >= z - 48 ? ground : null;
}

interface Player {
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
  ladder: boolean;
  water: number;
  side: number;
}

interface Segment {
  name: string;
  seconds: number;
  // Sets the player for time t (s) into the segment; `dt` is this frame's step.
  step: (p: Player, t: number, dt: number) => void;
}

const forward = (p: Player, speed: number) => {
  const a = (p.yaw * Math.PI) / 180;
  p.vel[0] = Math.cos(a) * speed;
  p.vel[1] = Math.sin(a) * speed;
};
const onGround = (p: Player, speed: number) => {
  forward(p, speed);
  p.vel[2] = 0;
  p.grounded = true;
  p.ladder = false;
  p.water = 0;
};
const ballistic = (p: Player, t: number, speed: number, base: number) => {
  forward(p, speed);
  p.grounded = false;
  p.vel[2] = JUMP_SPEED - GRAVITY * t;
  p.pos[2] = base + JUMP_SPEED * t - (GRAVITY / 2) * t * t;
};
const hop = (name: string, speed: number, base: () => number, extra?: (p: Player, t: number) => void): Segment => ({
  name,
  seconds: HOP_SECONDS,
  step: (p, t) => {
    ballistic(p, t, speed, base());
    extra?.(p, t);
  },
});
const stand = (name: string, seconds: number): Segment => ({ name, seconds, step: (p) => onGround(p, 0) });
const turn = (name: string, seconds: number, degreesPerSecond: number): Segment => ({
  name,
  seconds,
  step: (p, _t, dt) => {
    onGround(p, 0);
    p.yaw += degreesPerSecond * dt;
  },
});
const crouched = (name: string, seconds: number, speed: number, down: boolean): Segment => ({
  name,
  seconds,
  step: (p) => {
    onGround(p, speed);
    p.crouched = down;
  },
});
const slowDown = (name: string, seconds: number, from: number): Segment => ({
  name,
  seconds,
  step: (p, t) => onGround(p, from * (1 - t / seconds)),
});
// The height the air strafes start from (where the push lift ended).
let strafeBase = 0;

const segments: Segment[] = [
  stand("stand", 2.6),
  turn("turn on the spot", 1, 120),
  turn("quick turn back", 0.25, -480),
  { name: "walk", seconds: 1.2, step: (p) => onGround(p, 130) },
  { name: "run", seconds: 1, step: (p) => onGround(p, 250) },
  slowDown("stop", 0.4, 250),
  stand("stopped", 0.6),
  hop("jump", 0, () => 0),
  stand("landed", 0.8),
  {
    name: "drop",
    seconds: 732 / GRAVITY,
    step: (p, t) => {
      forward(p, 280);
      p.grounded = false;
      p.vel[2] = -GRAVITY * t;
      p.pos[2] = Math.max(DROP_Z, -(GRAVITY / 2) * t * t);
    },
  },
  { name: "drop contact", seconds: 0.004, step: (p) => onGround(p, 280) },
  hop("bhop out", 280, () => DROP_Z),
  slowDown("slide", 0.4, 280),
  stand("stood", 0.6),
  crouched("crouch walk", 1, 80, true),
  crouched("crouch idle", 0.5, 0, true),
  hop(
    "crouch jump",
    0,
    () => DROP_Z,
    (p) => {
      p.crouched = true;
    },
  ),
  crouched("uncrouch", 0.5, 0, false),
  {
    name: "ladder",
    seconds: 1.3,
    step: (p, t) => {
      forward(p, 0);
      p.grounded = false;
      p.ladder = true;
      p.vel[2] = t < 1 ? 150 : 0;
    },
  },
  {
    name: "swim",
    seconds: 1.2,
    step: (p) => {
      p.ladder = false;
      p.water = 2;
      p.grounded = false;
      forward(p, 80);
      p.vel[2] = 20;
    },
  },
  {
    name: "push lift",
    seconds: 0.6,
    step: (p) => {
      p.water = 0;
      forward(p, 40);
      p.grounded = false;
      p.vel[2] = 250;
      strafeBase = p.pos[2];
    },
  },
];
// Air strafes: three hops with one-frame ground contacts, the view sweeping and the strafe key alternating.
for (let i = 0; i < 3; i++) {
  segments.push(
    hop(
      `strafe hop ${i + 1}`,
      600,
      () => strafeBase,
      (p, t) => {
        p.yaw += Math.sin(t * Math.PI * 4) * 3;
        p.side = Math.sin(t * Math.PI * 4) > 0 ? 450 : -450;
      },
    ),
  );
  segments.push({
    name: `bhop contact ${i + 1}`,
    seconds: 0.004,
    step: (p) => {
      onGround(p, 600);
      p.side = 0;
    },
  });
}
segments.push(stand("final stand", 1.6));

const SNAP_SEGMENT = "strafe hop 1";
const SWINGS = [1, 4];

async function loadStudio(root: string): Promise<StudioData> {
  const manifest = JSON.parse(await readFile(`${root}/actor-animations.json`, "utf8"));
  const raw = await readFile(`${root}/actor-animations.bin`);
  const bytes = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const core = {
    studioInfo: () => JSON.stringify(manifest.info),
    studioVertices: () => new Float32Array(),
    studioIndices: () => new Uint32Array(),
    studioAnim: (_: number, anim: number) => {
      const length = manifest.info.anims[anim].frames * manifest.info.bones.length * 7;
      return bytes.slice(manifest.offsets[anim], manifest.offsets[anim] + length);
    },
  };
  return new StudioData(core as unknown as ConstructorParameters<typeof StudioData>[0], 1);
}

interface ModelInside {
  S: Float32Array;
  yaw: number;
  seed: number;
  bodyBank: { bank: number };
  legs: { mode: string; steps: number; pelvisDrop: number; plant: number; feetWorld: Float64Array };
}

function run(data: StudioData) {
  const model = new BunnyModel({ outfit: OUTFIT, style: "solid" }, undefined, data);
  model.setGroundProbe(probe);
  const inside = model as unknown as ModelInside;
  const p: Player = {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    yaw: 30,
    pitch: 0,
    crouched: false,
    grounded: true,
    ladder: false,
    water: 0,
    side: 0,
  };
  const frames = [];
  let time = 0,
    last = 0,
    index = 0;
  for (const segment of segments) {
    // A teleport: the website snaps on a jump this far by itself; both sides are told.
    let snap = index === 0 || segment.name === SNAP_SEGMENT;
    if (segment.name === SNAP_SEGMENT) {
      p.pos = [p.pos[0] + 400, p.pos[1] + 400, p.pos[2]];
    }
    for (let t = 0; t < segment.seconds; index++) {
      const dt = FRAME_SECONDS[index % FRAME_SECONDS.length];
      segment.step(p, t, dt);
      p.pitch = 12 * Math.sin(time * 0.7);
      const attack = SWINGS.some((at) => time < at && time + dt >= at) ? 1 : 0;
      if (snap) model.snap();
      const pose: PlayerPose = {
        visualTime: time,
        // As the core reports them: in float.
        position: p.pos.map(Math.fround),
        velocity: p.vel.map(Math.fround),
        yaw: p.yaw,
        pitch: p.pitch,
        crouched: p.crouched,
        grounded: p.grounded,
        sidemove: p.side,
        attack,
        ladder: p.ladder,
        water: p.water,
      };
      model.setState(pose);
      model.update(time - last);
      const legs = inside.legs;
      frames.push({
        segment: segment.name,
        time,
        snap,
        pose,
        feetYaw: inside.yaw,
        bank: inside.bodyBank.bank,
        mode: legs.mode,
        steps: legs.steps,
        pelvisDrop: legs.pelvisDrop,
        plant: legs.plant,
        feet: Array.from(legs.feetWorld),
        skin: index % BONES_EVERY === 0 ? Array.from(inside.S) : null,
      });
      snap = false;
      last = time;
      for (let k = 0; k < 3; k++) p.pos[k] += p.vel[k] * dt;
      time += dt;
      t += dt;
    }
  }
  return { seed: inside.seed, outfit: OUTFIT, floor: FLOOR, frames };
}

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("usage: actor-pose-oracle.ts ASSETS OUTPUT");
const result = existsSync(`${root}/actor-animations.json`) ? run(await loadStudio(root)) : null;
await writeFile(output, JSON.stringify(result));
