// Actual original RunnerModel, executed without a renderer; inspect its animated Three bone transforms.
import { writeFile } from "node:fs/promises";
import { Matrix4 } from "three";
import { RunnerModel } from "./runner-web-reference";
import type { PlayerPose } from "../../web/src/player/model";
const previous = Math.random;
Math.random = () => 0;
const model = new RunnerModel();
let seed = 0x12345678;
Math.random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const impl = model as any,
  frames: any[] = [],
  perm = [2, 0, 1];
let previousTime = -1,
  seconds = 0;
try {
  for (let f = 0; f < 1200; f++) {
    const part = Math.floor(f / 100),
      snap = f === 0 || f === 475 || f === 850;
    seconds = f === 850 ? 1 : seconds + (f % 37 === 0 ? 0 : f % 113 === 0 ? 0.14 : 1 / 60);
    const dt = previousTime < 0 || seconds < previousTime ? 0 : Math.min(0.1, seconds - previousTime);
    previousTime = seconds;
    const speed = [0, 80, 250, 450, 200, 180, 0, 280, 120, 350, 0, 220][part],
      angle = f * 0.7,
      air = part === 3 || part === 4 || part === 7 || part === 9,
      duck = part === 4 || part === 5 || part === 6;
    const velocity = [
      Math.cos((angle * Math.PI) / 180) * speed,
      Math.sin((angle * Math.PI) / 180) * speed,
      air ? 300 - (f % 100) * 8 : 0,
    ];
    const input = {
      position: [f * 0.8, f % 17, air ? Math.max(0, 40 - Math.abs(50 - (f % 100))) : 0],
      velocity,
      yaw: part === 8 ? 179 + (f % 20) * 1.2 : angle + Math.sin(f * 0.04) * 70,
      pitch: Math.sin(f * 0.024) * 88,
      grounded: !air,
      crouched: duck,
      sidemove: f % 80 < 40 ? -450 : 450,
      hasVelocity: part !== 11,
    };
    const state: PlayerPose = { ...input, velocity: input.hasVelocity ? velocity : undefined, visualTime: seconds };
    if (snap || (dt === 0 && f === 850)) model.snap();
    model.setState(state);
    model.update(dt);
    // Remove only the root's world placement. Body squash and every animated bone stay in the measured result.
    model.root.position.set(0, 0, 0);
    model.root.rotation.set(0, 0, 0);
    model.root.updateMatrixWorld(true);
    const expected = new Float32Array(20 * 12);
    for (let i = 0; i < 20; i++) {
      const m = new Matrix4().multiplyMatrices(impl.bones[i].matrixWorld, impl.skeleton.boneInverses[i]).elements;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) expected[i * 12 + r * 4 + c] = m[perm[c] * 4 + perm[r]];
        expected[i * 12 + r * 4 + 3] = m[12 + perm[r]];
      }
    }
    frames.push({
      time: seconds,
      snap,
      input,
      bodyYaw: impl.bodyYaw,
      phase: impl.phase,
      expected: Array.from(expected),
    });
  }
} finally {
  Math.random = previous;
  model.dispose();
}
await writeFile(process.argv[2] ?? "/tmp/native-runner-oracle.json", JSON.stringify(frames));
console.log(`${frames.length} original runner oracle frames`);
