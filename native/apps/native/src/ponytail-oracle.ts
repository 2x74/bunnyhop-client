// The website's ponytail pendulum (player/hat-fx.ts advancePonytail) over a fixed movement stream; the C++ port replays
// the same stream and must land on the same angles.
import { writeFile } from "node:fs/promises";
import { advancePonytail, ponytailMotion } from "../../web/src/player/hat-fx";

interface Step {
  velocity: [number, number, number];
  yaw: number;
  dt: number;
  snap: boolean;
  length: number;
}

/** The built tail, then longer ones up to the slider's top (300%, past where the frequency stops slowing). */
function tailLength(step: number): number {
  if (step < 300) return 1;
  if (step < 400) return 1.6;
  return step < 500 ? 2.8 : 3;
}

function movementStream(): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < 600; i++) {
    const seconds = i / 120;
    const airborne = Math.floor(seconds * 2) % 2 === 1;
    const speed = Math.min(1200, i * 4);
    const yaw = 40 * Math.sin(seconds * 3);
    const velocity: [number, number, number] = [
      speed * Math.cos((yaw * Math.PI) / 180),
      speed * Math.sin((yaw * Math.PI) / 180),
      airborne ? 280 - 800 * (seconds % 0.5) : 0,
    ];
    steps.push({ velocity, yaw, dt: i % 7 === 0 ? 1 / 30 : 1 / 144, snap: i === 300, length: tailLength(i) });
  }
  return steps;
}

const steps = movementStream();
const motion = ponytailMotion();
const angles: [number, number][] = [];
for (const step of steps) {
  advancePonytail(motion, step.velocity, step.yaw, step.dt, step.snap, false, step.length);
  angles.push([motion.pitch, motion.side]);
}
await writeFile(process.argv[2], JSON.stringify({ steps, angles }));
