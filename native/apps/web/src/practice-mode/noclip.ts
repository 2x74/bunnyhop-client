// Practice mode noclip, CS:S `noclip` feel: fly where you look with the movement keys, jump to rise, duck to go slower.
// The flight is computed here (CS:S CGameMovement::FullNoClipMove with sv_noclipspeed 5, sv_noclipaccelerate 5,
// sv_friction 4, sv_maxspeed 320: top speed 1600 u/s, the same as the vendored movement code's noclip mode); the core
// only gets the resulting position each tick (crates/core/src/game/practice.rs), so the map keeps running around you.
// Never used by replay re-simulation or the verifier. DOM-free (apps/api/test/practice.test.ts runs it).

import type { Core } from "../core";

/** sv_noclipspeed: multiplies the command and sv_maxspeed. */
export const NOCLIP_SPEED = 5;
/** sv_noclipaccelerate. */
export const NOCLIP_ACCELERATE = 5;
const MAX_SPEED = 320;
const FRICTION = 4;
/** Duck slows the flight to a quarter (CS:S halves it with +speed; a quarter is easier to place exactly). */
export const NOCLIP_DUCK_FACTOR = 0.25;
/** Upward command while jump is held (cl_upspeed, the same as cl_forwardspeed here). */
const UP_MOVE = 450;
/** Out of the world: the core kills the player past this (game.rs OUT_OF_WORLD = MAX_COORDINATE - 80). */
const WORLD_LIMIT = 16384 - 80 - 1;

export interface NoclipInput {
  forwardmove: number;
  sidemove: number;
  yaw: number;
  pitch: number;
  /** Jump held: rise. */
  up: boolean;
  /** Duck held: slower. */
  slow: boolean;
}

export interface NoclipState {
  position: [number, number, number];
  velocity: [number, number, number];
}

/** One tick of noclip flight (mutates and returns `s`). */
export function noclipMove(s: NoclipState, cmd: NoclipInput, dt: number): NoclipState {
  const yr = (cmd.yaw * Math.PI) / 180;
  const pr = (cmd.pitch * Math.PI) / 180;
  const sy = Math.sin(yr), cy = Math.cos(yr), sp = Math.sin(pr), cp = Math.cos(pr);
  // AngleVectors: forward follows the pitch (look down to dive); right stays level.
  const forward = [cp * cy, cp * sy, -sp];
  const right = [sy, -cy, 0];
  const maxSpeed = MAX_SPEED * NOCLIP_SPEED;
  const factor = cmd.slow ? NOCLIP_SPEED * NOCLIP_DUCK_FACTOR : NOCLIP_SPEED;
  const fmove = cmd.forwardmove * factor;
  const smove = cmd.sidemove * factor;
  const wish = [forward[0] * fmove + right[0] * smove, forward[1] * fmove + right[1] * smove, forward[2] * fmove + (cmd.up ? UP_MOVE * factor : 0)];
  const len = Math.hypot(wish[0], wish[1], wish[2]);
  const dir = len > 0 ? wish.map((v) => v / len) : [0, 0, 0];
  const wishSpeed = Math.min(len, cmd.slow ? maxSpeed * NOCLIP_DUCK_FACTOR : maxSpeed);
  const v = s.velocity;
  // Accelerate (surface friction 1).
  const current = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
  const add = wishSpeed - current;
  if (add > 0) {
    const accel = Math.min(NOCLIP_ACCELERATE * dt * wishSpeed, add);
    for (let i = 0; i < 3; i++) v[i] += accel * dir[i];
  }
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (speed < 1) {
    v[0] = v[1] = v[2] = 0;
    return s;
  }
  // Bleed off speed: at least a quarter of the top speed's worth, so letting go stops quickly.
  const control = Math.max(speed, maxSpeed * 0.25);
  const scale = Math.max(0, speed - control * FRICTION * dt) / speed;
  for (let i = 0; i < 3; i++) {
    v[i] *= scale;
    s.position[i] = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, s.position[i] + v[i] * dt));
  }
  return s;
}

interface PracticeExports {
  practice_noclip_tick?: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => number;
  practice_noclip_exit?: (x: number, y: number, z: number, vx: number, vy: number, vz: number, yaw: number, pitch: number) => number;
}

const exportsOf = (core: Core) => (core as unknown as { x: PracticeExports }).x;

/** This wasm build has the practice noclip exports. */
export function hasNoclip(core: Core): boolean {
  const e = exportsOf(core);
  return typeof e.practice_noclip_tick === "function" && typeof e.practice_noclip_exit === "function";
}

/** One world tick with the player held at the noclip position. Returns the core's event bits. */
export function noclipTick(core: Core, s: NoclipState): number {
  const p = s.position, v = s.velocity;
  return exportsOf(core).practice_noclip_tick?.(p[0], p[1], p[2], v[0], v[1], v[2]) ?? 0;
}

/**
 * Leaves noclip at the current position keeping the velocity; if the hull is stuck there the core looks for free space
 * nearby along the view. Returns "standing" | "crouched" | "stuck".
 */
export function noclipExit(core: Core, s: NoclipState, yaw: number, pitch: number): "standing" | "crouched" | "stuck" {
  const p = s.position, v = s.velocity;
  const r = exportsOf(core).practice_noclip_exit?.(p[0], p[1], p[2], v[0], v[1], v[2], yaw, pitch) ?? 0;
  return r === 1 ? "standing" : r === 2 ? "crouched" : "stuck";
}
