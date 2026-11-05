import { writeFileSync } from "node:fs";
import * as THREE from "three";
import { FlybyCam, EyeSmoother, directShots, type SpectatorTarget } from "./replay_camera_web_reference";
import { ChaseCam } from "../../web/src/viewer/cameras";

// A corridor with a ceiling for some of the frames: the chase cam pulls in at once, waits once the way clears, and
// cranes up (as far as the ceiling allows) when it's cramped. replay_camera_tests.cpp traces the same walls.
const CORRIDOR = { from: 30, to: 80, halfWidth: 48, ceiling: 120 };
function corridorTrace(a: ArrayLike<number>, b: ArrayLike<number>, radius: number): number {
  const wall = CORRIDOR.halfWidth - radius,
    roof = CORRIDOR.ceiling - radius;
  let fraction = 1;
  const dy = b[1] - a[1],
    dz = b[2] - a[2];
  if (dy > 0 && b[1] > wall) fraction = Math.min(fraction, (wall - a[1]) / dy);
  if (dy < 0 && b[1] < -wall) fraction = Math.min(fraction, (-wall - a[1]) / dy);
  if (dz > 0 && b[2] > roof) fraction = Math.min(fraction, (roof - a[2]) / dz);
  return Math.min(1, Math.max(0, fraction));
}
const output = process.argv[2];
if (!output) throw new Error("output JSON path required");
const camera = new THREE.PerspectiveCamera(),
  chase = new ChaseCam(),
  flyby = new FlybyCam(),
  eye = new EyeSmoother();
const frames: { state: SpectatorTarget; chase: number[]; flyby: number[]; eyeError: number }[] = [];
for (let i = 0; i < 120; i++) {
  const state: SpectatorTarget = {
    pos: [i * 3, Math.sin(i * 0.05) * 40, Math.abs(Math.sin(i * 0.08)) * 25],
    vel: [300, Math.cos(i * 0.05) * 20, 0],
    viewZ: i >= 40 && i < 70 ? 46 : 64,
    yaw: i < 60 ? 350 : i * 0.8,
    pitch: Math.sin(i * 0.1) * 30,
    crouched: i >= 40 && i < 70,
    grounded: i % 20 === 0,
  };
  const err = eye.update(state, 0.01);
  const walls = i >= CORRIDOR.from && i < CORRIDOR.to;
  chase.update(camera, state, 0.01, (a, b, r) => (walls ? corridorTrace(a, b, r) : 1), err);
  const c = [camera.position.x, -camera.position.z, camera.position.y];
  flyby.update(camera, state, 0.01, null);
  frames.push({ state, chase: c, flyby: [camera.position.x, -camera.position.z, camera.position.y], eyeError: err });
}
const n = 1800,
  pos = new Float32Array((n + 1) * 3),
  flags = new Uint8Array(n + 1);
for (let i = 0; i <= n; i++) {
  pos[i * 3] = i * 2;
  pos[i * 3 + 1] = Math.sin(i * 0.01) * 200;
  pos[i * 3 + 2] = i % 100 < 50 ? 20 : 0;
}
flags[750] = 4;
const shots = directShots({ n, tickrate: 100, pos, flags } as never, 0, n, null);
writeFileSync(output, JSON.stringify({ frames, shots, n, corridor: CORRIDOR }));
