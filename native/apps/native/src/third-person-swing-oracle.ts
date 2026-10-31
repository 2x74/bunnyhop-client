// The website's knife attack on the third-person model: its fire layer (player/studio/animstate.ts) in every stance
// against the same stance without a swing, and what its viewer (viewer/viewer.ts) and ghosts (ghost.ts) play from a
// replay's trailer. third_person_swing_tests.cpp replays all of it on the native code.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { StudioData } from "../../web/src/player/studio/data";
import { BoneSetup } from "../../web/src/player/studio/pose";
import { CsAnimState } from "../../web/src/player/studio/animstate";
import { cosmeticBetween, inspectBetween, type CosmeticEvent } from "../../web/src/replay";

const FRAMES = 240;
const SWING_FRAME = 20;
const SECOND_SWING_FRAME = 45;
const AIRBORNE_ELAPSED_LIMIT = 2;
const REPLAY_LIVE_TICKS = 30;
const GHOST_LIVE_TICKS = 50;
const ARM_BONES = ["R_UpperArm", "R_Forearm", "R_Hand", "L_Hand"].map((name) => `ValveBiped.Bip01_${name}`);

interface Stance {
  name: string;
  velocity: [number, number, number];
  ducking: boolean;
  onGround: boolean;
  swings: number[];
}

const stances: Stance[] = [
  { name: "idle", velocity: [0, 0, 0], ducking: false, onGround: true, swings: [SWING_FRAME] },
  { name: "walk", velocity: [120, 0, 0], ducking: false, onGround: true, swings: [SWING_FRAME] },
  { name: "run", velocity: [240, 60, 0], ducking: false, onGround: true, swings: [SWING_FRAME] },
  { name: "crouch idle", velocity: [0, 0, 0], ducking: true, onGround: true, swings: [SWING_FRAME] },
  { name: "crouch walk", velocity: [70, 0, 0], ducking: true, onGround: true, swings: [SWING_FRAME] },
  { name: "air", velocity: [300, 0, 100], ducking: false, onGround: false, swings: [SWING_FRAME] },
  {
    name: "swing again",
    velocity: [0, 0, 0],
    ducking: false,
    onGround: true,
    swings: [SWING_FRAME, SECOND_SWING_FRAME],
  },
];

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

function secondsPerFrame(frame: number): number {
  return frame % 2 ? 1 / 144 : 1 / 60;
}

function matricesOf(world: ArrayLike<number>, bones: number[]): number[] {
  return bones.flatMap((bone) => Array.from({ length: 12 }, (_, k) => world[bone * 12 + k]));
}

function stepAnimation(anim: CsAnimState, bones: BoneSetup, stance: Stance, frame: number, time: number): Float32Array {
  const input = {
    vel: stance.velocity,
    eyeYaw: 25,
    eyePitch: 10,
    ducking: stance.ducking,
    onGround: stance.onGround,
    jumped: false,
  };
  const snap = frame === 0;
  if (snap) {
    anim.reset(time);
    if (!stance.onGround) {
      const elapsed = (301.993 - stance.velocity[2]) / 800;
      if (elapsed >= 0 && elapsed < AIRBORNE_ELAPSED_LIMIT) anim.startAirborne(elapsed);
    }
  }
  anim.update(snap ? 0 : secondsPerFrame(frame), input, snap ? time : undefined);
  anim.apply();
  return bones.buildMatrices();
}

function fireStance(data: StudioData, stance: Stance, tracked: number[]) {
  const swungBones = new BoneSetup(data);
  const swung = new CsAnimState(data, swungBones);
  const plainBones = new BoneSetup(data);
  const plain = new CsAnimState(data, plainBones);
  const hand = data.bone("ValveBiped.Bip01_R_Hand");
  const frames = [];
  let time = 0;
  for (let frame = 0; frame < FRAMES; frame++) {
    time += secondsPerFrame(frame);
    const shot = stance.swings.includes(frame);
    if (shot) swung.fire();
    const world = stepAnimation(swung, swungBones, stance, frame, time);
    const control = stepAnimation(plain, plainBones, stance, frame, time);
    const handOffset = Math.hypot(
      world[hand * 12 + 3] - control[hand * 12 + 3],
      world[hand * 12 + 7] - control[hand * 12 + 7],
      world[hand * 12 + 11] - control[hand * 12 + 11],
    );
    const fireActive = (swung as unknown as { fireSeq: number }).fireSeq >= 0;
    frames.push({ time, shot, fireActive, handOffset, world: matricesOf(world, tracked) });
  }
  return { ...stance, frames };
}

const trailer: CosmeticEvent[] = [
  { tick: 10, kind: 1 },
  { tick: 30, kind: 2 },
  { tick: 31, kind: 1 },
  { tick: 70, kind: 2 },
  { tick: 100, kind: 1 },
  { tick: 150, kind: 2 },
];
const inspects: CosmeticEvent[] = [
  { tick: 20, kind: 1 },
  { tick: 22, kind: 3 },
  { tick: 26, kind: 2 },
  { tick: 40, kind: 4 },
];

// Every tick, a frame spanning several, a frame repeating a tick, a gap too wide for playback, a seek back.
const viewerFrames = [0, 1, 2, 5, 9, 11, 11, 12, 21, 25, 27, 29, 32, 33, 45, 69, 71, 72, 120, 121, 60, 61, 69, 71];
const ghostFrames = [0, 0.5, 1.25, 5, 9.5, 11.75, 12, 21, 25, 27, 29, 32, 45, 69.5, 71, 72, 123, 124, 150, 151];

function viewerExpected() {
  let shown = -1;
  return viewerFrames.map((tick) => {
    const contiguous = shown >= 0 && tick > shown && tick - shown < REPLAY_LIVE_TICKS;
    const attack = contiguous ? cosmeticBetween(trailer, shown, tick) : 0;
    const inspect = contiguous ? inspectBetween(inspects, shown, tick) : { sig: 0, held: false };
    shown = tick;
    return { tick, attack, inspect: inspect.sig, held: inspect.held };
  });
}

function ghostExpected() {
  let last = -1;
  return ghostFrames.map((tick) => {
    const live = last >= 0 && tick > last && tick - last < GHOST_LIVE_TICKS;
    const attack = live ? cosmeticBetween(trailer, Math.floor(last), Math.floor(tick)) : 0;
    const inspect = live ? inspectBetween(inspects, Math.floor(last), Math.floor(tick)) : { sig: 0, held: false };
    last = tick;
    return { tick, attack, inspect: inspect.sig, held: inspect.held };
  });
}

const root = process.argv[2];
const output = process.argv[3];
let fire = null;
if (existsSync(`${root}/actor-animations.json`)) {
  const data = await loadStudio(root);
  const tracked = ARM_BONES.map((name) => data.bone(name));
  fire = { bones: tracked, stances: stances.map((stance) => fireStance(data, stance, tracked)) };
}
await writeFile(output, JSON.stringify({ fire, trailer, inspects, viewer: viewerExpected(), ghost: ghostExpected() }));
