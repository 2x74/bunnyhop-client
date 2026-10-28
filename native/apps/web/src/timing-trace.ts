/** Optional observational ABI. No client-provided trace is accepted by a verifier. */
import type { Core } from "./core";
export type Vec3 = readonly [number, number, number];
export interface TimingSegment {
  discrete?: boolean;
  from: Vec3; to: Vec3; t0: number; t1: number;
  mins: Vec3; maxs: Vec3;
}
export interface TimingPath {
  version: 1 | 2;
  segments: TimingSegment[];
  unsupported: string | null;
}
interface TimingExports {
  memory: WebAssembly.Memory;
  timing_path_version?: () => number;
  timing_observe?: (enabled: number) => void;
  timing_path?: () => number;
  timing_path_ptr?: () => number;
  timing_path_reason?: () => number;
  scratch_str_ptr: () => number;
}
const exportsOf = (core: Core) => (core as unknown as { x: TimingExports }).x;
export function observeTiming(core: Core, enabled: boolean): void {
  const x = exportsOf(core);
  if (x.timing_path_version?.() !== 2 || !x.timing_observe) throw Error("unsupported timing trace ABI");
  x.timing_observe(+enabled);
}
export function timingPath(core: Core): TimingPath {
  const x = exportsOf(core);
  if (x.timing_path_version?.() !== 2 || !x.timing_path || !x.timing_path_ptr || !x.timing_path_reason) throw Error("unsupported timing trace ABI");
  const len = x.timing_path();
  if (len < 1 || (len - 1) % 15 || len > 1 + 15 * 32) throw Error("malformed timing trace length");
  const data = new Float64Array(x.memory.buffer, x.timing_path_ptr(), len).slice();
  if (!data.every(Number.isFinite)) throw Error("nonfinite timing trace data");
  if (data[0] === 0) throw Error("timing observation absent");
  if (data[0] !== 1 && data[0] !== 2) throw Error("invalid timing trace status");
  const n = x.timing_path_reason();
  const reason = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.scratch_str_ptr(), n));
  const segments: TimingSegment[] = [];
  for (let i = 1; i < len; i += 15) {
    const vec = (offset: number): Vec3 => [data[i + offset], data[i + offset + 1], data[i + offset + 2]];
    if (data[i+14] !== 0 && data[i+14] !== 1) throw Error("invalid timing segment kind");
    segments.push({ discrete: data[i+14] === 1, t0: data[i], t1: data[i + 1], from: vec(2), to: vec(5), mins: vec(8), maxs: vec(11) });
  }
  return { version: 2, segments, unsupported: data[0] === 2 ? reason || "unsupported-path" : null };
}

/**
 * Ranked timing (run-timing.ts): observe the accepted path of every step on this core. Sticky until the next map load;
 * sim.ts beforeStep calls it before every step. Observation never changes the simulation (crates/core/tests/
 * timing_path.rs, tools/timing/identity.ts). False on a build without the ABI: crossings then use straight traces.
 */
export function startObserving(core: Core): boolean {
  const x = exportsOf(core);
  if (x.timing_path_version?.() !== 2 || !x.timing_observe) return false;
  x.timing_observe(observing ? 1 : 0);
  return observing;
}

let observing = true;
/** Tools only (tools/timing/identity.ts): simulate without observation, for the identity comparison. */
export function setRankedObservation(on: boolean): void {
  observing = on;
}

const sources = new WeakMap<Core, () => TimingPath | null>();
/** A lazy reader of the last step's path (RunTimer.pathSource): null when absent or malformed (straight traces then). */
export function pathSource(core: Core): () => TimingPath | null {
  let source = sources.get(core);
  if (!source) {
    source = () => {
      try {
        return timingPath(core);
      } catch {
        return null;
      }
    };
    sources.set(core, source);
  }
  return source;
}
