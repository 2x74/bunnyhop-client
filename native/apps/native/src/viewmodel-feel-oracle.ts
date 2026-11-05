// The website's first-person feel over a fixed stream of frames: the knife viewmodel's ViewFeel, the gun's GunMotion,
// the in-eye EyeFeel, the knife hand's HandIdle and the gun hands' grip idle (GunAnimator overlays). The frames mix
// frame lengths, running, bhops with one-tick ground touches, a hard fall, crouching, strafes and a 180 degree snap.
// viewmodel_feel_tests.cpp replays the same stream on the C++ port and compares every frame.
import { writeFile } from "node:fs/promises";
import { ViewFeel, type FeelInput } from "../../web/src/viewmodel/feel";
import { EyeFeel } from "../../web/src/viewmodel/eye-feel";
import { HandIdle } from "../../web/src/viewmodel/idle";
import { GunMotion } from "../../web/src/viewmodel/guns/motion";
import { GunAnimator } from "../../web/src/viewmodel/guns/anim";
import { gunById } from "../../web/src/viewmodel/guns/index";
import type { Arm } from "../../web/src/viewmodel/inspects/kit";

const FRAMES = 900;
const FRAME_SECONDS = [1 / 30, 1 / 144, 1 / 60, 1 / 240, 1 / 97];
const PIVOT = [12.5, -4.75, -6.25];
const RESET_FRAME = 450;

/** The movement on frame `f`: a run, then bhops, a hard fall, crouching and a snap around. */
function inputAt(f: number): FeelInput & { dt: number } {
  const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
  const t = f / 100;
  const bhop = f >= 200 && f < 500;
  const falling = f >= 560 && f < 600;
  const speed = f < 100 ? 0 : f < 200 ? 250 : bhop ? 400 + f * 1.6 : 320;
  const yaw = 30 + 140 * Math.sin(t * 1.7) + (f >= 700 ? 180 : 0);
  const grounded = bhop ? f % 37 === 0 : !falling;
  const vz = bhop ? (grounded ? 0 : 290 - (f % 37) * 16) : falling ? -40 * (f - 560) : 0;
  const landed = bhop && f % 37 === 0 && f > 200 ? -300 : f === 600 ? -1250 : f === 650 ? -700 : 0;
  return {
    dt,
    velocity: [speed * Math.cos(yaw / 57.3), speed * Math.sin(yaw / 57.3), vz],
    grounded,
    viewOffsetZ: f >= 620 && f < 680 ? 46 : 64,
    sidemove: bhop ? (Math.floor(f / 18) % 2 ? 450 : -450) : 0,
    yaw,
    pitch: 20 * Math.sin(t * 0.9) - 5,
    landed,
  };
}

const viewFeel = new ViewFeel();
const rifle = new GunMotion();
const pistol = new GunMotion();
const eye = new EyeFeel();
const eyeOff = new EyeFeel();
const frames = [];
let clock = 0;
for (let f = 0; f < FRAMES; f++) {
  const input = inputAt(f);
  clock += input.dt;
  const V = viewFeel.update(input.dt, input, 0.5, 1, clock);
  const def = gunById("ak47")!;
  // A seek mid-run: nothing carried over (the idle drift's clock, ground contact, the strafe filter).
  if (f === RESET_FRAME) rifle.reset();
  rifle.bob = 0.5;
  rifle.update(input.dt, def, input, PIVOT);
  pistol.bob = 1;
  pistol.sway = 0.6;
  pistol.update(input.dt, gunById("usp")!, f % 3 ? input : null, PIVOT);
  const speed = Math.hypot(input.velocity[0], input.velocity[1]);
  eye.update(input.dt, input.landed, speed + (f >= 300 && f < 420 ? 400 : 0), true, true);
  eyeOff.update(input.dt, input.landed, speed, false, f >= 400);
  frames.push({
    ...input,
    velocity: Array.from(input.velocity),
    feel: Array.from(V),
    rifle: Array.from(rifle.M),
    pistol: Array.from(pistol.M),
    pistolInput: f % 3 !== 0,
    eye: [eye.z, eye.fov],
    eyeOff: [eyeOff.z, eyeOff.fov],
  });
}

/** Stands in for the inspect kit's Arm and keeps what HandIdle asked of it. */
function recordingArm() {
  const seen = { flex: 0, deviation: 0, index: 0, pinky: 0 };
  const arm = {
    wrist: (_W: Float32Array, flex: number, deviation: number) => {
      seen.flex = flex;
      seen.deviation = deviation;
    },
    frame: () => ({}),
    curl: (_W: Float32Array, finger: string, curl: number[]) => {
      if (finger === "index") seen.index = -curl[0];
      if (finger === "pinky") seen.pinky = -curl[0];
    },
  };
  return { arm: arm as unknown as Arm, seen };
}

const handIdle = new HandIdle();
const hand = [];
let handClock = 0;
for (let f = 0; f < 700; f++) {
  const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
  handClock += dt;
  const idle = !(f >= 120 && f < 160) && !(f >= 400 && f < 405);
  const amount = f < 500 ? 1 : 0.6;
  handIdle.update(dt, idle);
  const { arm, seen } = recordingArm();
  handIdle.apply(new Float32Array(12), arm, handClock, amount);
  hand.push({ dt, idle, amount, clock: handClock, ...seen });
}

// The grip idle over a USP: quiet, a shot, quiet, a reload (its end settles the support hand), quiet.
const anim = new GunAnimator(gunById("usp")!);
anim.settle();
const grip = [];
for (let f = 0; f < 1200; f++) {
  const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
  let event = "";
  if (f === 300) {
    anim.fire();
    event = "shot";
  } else if (f === 500) {
    anim.reload(1.2, false);
    event = "reload";
  } else if (f === 800) {
    anim.dryFire();
    event = "dry";
  }
  anim.update(dt);
  grip.push({ dt, event, clip: anim.clip, indexOff: anim.pose.indexOff, leftOpen: anim.pose.leftOpen });
}

await writeFile(
  process.argv[2] ?? "viewmodel-feel-oracle.json",
  JSON.stringify({ pivot: PIVOT, resetFrame: RESET_FRAME, frames, hand, grip }),
);
