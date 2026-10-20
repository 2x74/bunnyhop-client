// Small 3x4 (row-major, like player/studio/pose.ts) helpers for the viewmodel.

import type { V3 } from "../player/bunny/rig";

const D2R = Math.PI / 180;

/** Source AngleMatrix(pitch, yaw, roll) (degrees) + origin: columns are forward, left, up. */
export function angleMatrix(pitch: number, yaw: number, roll: number, ox: number, oy: number, oz: number, out: Float32Array | number[], o = 0): void {
  const sp = Math.sin(pitch * D2R), cp = Math.cos(pitch * D2R);
  const sy = Math.sin(yaw * D2R), cy = Math.cos(yaw * D2R);
  const sr = Math.sin(roll * D2R), cr = Math.cos(roll * D2R);
  out[o] = cp * cy;
  out[o + 4] = cp * sy;
  out[o + 8] = -sp;
  out[o + 1] = sr * sp * cy - cr * sy;
  out[o + 5] = sr * sp * sy + cr * cy;
  out[o + 9] = sr * cp;
  out[o + 2] = cr * sp * cy + sr * sy;
  out[o + 6] = cr * sp * sy - sr * cy;
  out[o + 10] = cr * cp;
  out[o + 3] = ox;
  out[o + 7] = oy;
  out[o + 11] = oz;
}

/** Rotation by `angle` (radians) about unit `axis` through `pivot`. */
export function rotAbout(axis: ArrayLike<number>, angle: number, pivot: ArrayLike<number>, out: Float32Array | number[], o = 0): void {
  const [x, y, z] = [axis[0], axis[1], axis[2]];
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const r00 = t * x * x + c, r01 = t * x * y - s * z, r02 = t * x * z + s * y;
  const r10 = t * x * y + s * z, r11 = t * y * y + c, r12 = t * y * z - s * x;
  const r20 = t * x * z - s * y, r21 = t * y * z + s * x, r22 = t * z * z + c;
  const px = pivot[0], py = pivot[1], pz = pivot[2];
  out[o] = r00, out[o + 1] = r01, out[o + 2] = r02, out[o + 3] = px - (r00 * px + r01 * py + r02 * pz);
  out[o + 4] = r10, out[o + 5] = r11, out[o + 6] = r12, out[o + 7] = py - (r10 * px + r11 * py + r12 * pz);
  out[o + 8] = r20, out[o + 9] = r21, out[o + 10] = r22, out[o + 11] = pz - (r20 * px + r21 * py + r22 * pz);
}

/** 3x4 from basis columns and origin. */
export function fromAxes(x: V3, y: V3, z: V3, p: V3, out: Float32Array | number[], o = 0): void {
  out[o] = x[0], out[o + 1] = y[0], out[o + 2] = z[0], out[o + 3] = p[0];
  out[o + 4] = x[1], out[o + 5] = y[1], out[o + 6] = z[1], out[o + 7] = p[1];
  out[o + 8] = x[2], out[o + 9] = y[2], out[o + 10] = z[2], out[o + 11] = p[2];
}

export function identity(out: Float32Array | number[], o = 0): void {
  for (let k = 0; k < 12; k++) out[o + k] = k === 0 || k === 5 || k === 10 ? 1 : 0;
}

/** Rotation part applied to a direction. */
export function rotate(m: ArrayLike<number>, o: number, d: ArrayLike<number>): V3 {
  return [m[o] * d[0] + m[o + 1] * d[1] + m[o + 2] * d[2], m[o + 4] * d[0] + m[o + 5] * d[1] + m[o + 6] * d[2], m[o + 8] * d[0] + m[o + 9] * d[1] + m[o + 10] * d[2]];
}

export const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Ease from a to b as t goes t0 -> t1 (smoothstep). */
export const ramp = (t: number, t0: number, t1: number) => smooth((t - t0) / (t1 - t0));
