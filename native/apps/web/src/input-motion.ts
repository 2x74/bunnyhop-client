/** Validate observed child deltas, never infer a hardware sampling distribution from an aggregate. */
import type { MotionSample } from './mouse-filter';
export interface ValidatedMotion { reports: readonly MotionSample[]; quality: 'children' | 'parent'; reason: string }
export function validateMotion(parent: MotionSample, children: ArrayLike<MotionSample> | null, capacity: number): ValidatedMotion {
  const fallback = (reason: string): ValidatedMotion => ({reports:[parent], quality:'parent', reason});
  if (!Number.isFinite(parent.movementX) || !Number.isFinite(parent.movementY)) return {reports:[], quality:'parent', reason:'nonfinite-parent'};
  if (!Number.isFinite(parent.timeStamp)) return fallback('nonfinite-parent-time');
  if (!children?.length) return fallback('no-children');
  if (!Number.isInteger(children.length) || children.length > capacity) return fallback('child-limit');
  let x = 0, y = 0, previous = -Infinity;
  const reports: MotionSample[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!c || !Number.isFinite(c.movementX) || !Number.isFinite(c.movementY) || !Number.isFinite(c.timeStamp) || c.timeStamp < previous || c.timeStamp > parent.timeStamp) return fallback('invalid-child');
    previous = c.timeStamp; x += c.movementX; y += c.movementY;
    reports.push({movementX:c.movementX, movementY:c.movementY, timeStamp:c.timeStamp});
  }
  // Only floating-point arithmetic noise is tolerated, not a missing fractional report.
  const close = (a:number,b:number) => Math.abs(a-b) <= Number.EPSILON * 16 * Math.max(1,Math.abs(a),Math.abs(b));
  if (!close(x,parent.movementX) || !close(y,parent.movementY)) return fallback('sum-mismatch');
  return {reports, quality:'children', reason:'validated'};
}
