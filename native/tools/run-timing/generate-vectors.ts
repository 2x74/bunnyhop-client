// Regenerate with: bun tools/run-timing/generate-vectors.ts
// The vendored web implementation is the oracle; fixtures never duplicate its arithmetic.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as timing from "../../apps/web/src/run-timing";
import { RunTimer } from "../../apps/web/src/timer";
import type { TimingPath, TimingSegment } from "../../apps/web/src/timing-trace";
import type { Zone } from "../../apps/web/src/zones";
import type { TickState } from "../../apps/web/src/core";

const vec = (x: number, y = 0, z = 0): [number, number, number] => [Math.fround(x), Math.fround(y), Math.fround(z)];
const zone: Zone = { kind: "start", mins: vec(0, -10, 0), maxs: vec(10, 10, 100) };
const segment = (from: number, to: number, t0 = 0, t1 = 1, discrete = false): TimingSegment =>
  ({ from: vec(from), to: vec(to), t0, t1, discrete, mins: vec(-16, -16), maxs: vec(16, 16, 72) });
const paths: (TimingPath | null)[] = [null,
  { version: 2, unsupported: null, segments: [segment(-50, 50)] },
  { version: 2, unsupported: null, segments: [segment(-50, 0, 0, .25), segment(0, 50, .25)] },
  { version: 2, unsupported: null, segments: [segment(-50, 50, 0, 0, true), segment(50, 50)] },
  { version: 2, unsupported: "solver", segments: [segment(-50, 50)] },
  { version: 2, unsupported: null, segments: [segment(-50, 0, 0, .25), segment(1, 50, .25)] },
  { version: 2, unsupported: null, segments: [segment(-50, 50, .1)] },
  { version: 2, unsupported: null, segments: [segment(-50, 50, 0, 1, true)] },
  { version: 2, unsupported: null, segments: [] },
];
const crossings: unknown[] = [];
for (const path of paths) {
  for (const to of [vec(50), vec(0), vec(50, 0, 1000)]) {
    for (const from of [vec(-50), null]) {
      for (const crouched of [false, true]) {
        const movement = timing.movement(path, from, to, crouched);
        crossings.push({ path, from, to, crouched, zones: [zone],
          complete: !!timing.completePath(path, to, crouched),
          entry: timing.entryCrossing(movement, [zone]), exit: timing.exitCrossing(movement, [zone]) });
      }
    }
  }
}
// Keep the destination inside the zone to exercise accepted-path entry, plus overlapping start zones.
for (let i = 0; i < 64; i++) {
  const from = vec(-100 - i / 8);
  const to = vec(i % 11);
  const path: TimingPath = { version: 2, unsupported: null, segments: [{ ...segment(0, 0), from, to }] };
  const zones = [zone, { ...zone, mins: vec(-20, -10), maxs: vec(0, 10, 100) }];
  const movement = timing.movement(path, from, to, false);
  crossings.push({ path, from, to, crouched: false, zones, complete: true,
    entry: timing.entryCrossing(movement, zones), exit: timing.exitCrossing(movement, zones) });
}
const rounding: unknown[] = [];
for (const interval of [.01, Math.fround(.01), .008, 1 / 64, .015625]) {
  for (const units of [0, 1, 49999, 50000, 50001, 99999, 100000, 149999, 150000, 150001, 999999, 1000000, 123456789]) {
    rounding.push({ interval, units, ms: timing.unitsToMs(units, interval) });
  }
}
const phases = [-1, 0, .00000049, .0000005, .00000051, .1234565, .9999995, 1, 2]
  .map(phase => ({ phase, quantized: timing.quantizePhase(phase) }));
const runZones: Zone[] = [zone, { kind: "end", mins: vec(100, -10), maxs: vec(110, 10, 100) }];
const state = (tick: number, x: number, grounded = true, extra = {}): TickState =>
  ({ tick, position: vec(x), velocity: vec(0), grounded, crouched: false, onLadder: false,
    viewOffsetZ: 64, teleportAngles: vec(0), angleChange: vec(0), ...extra });
const scenarios = [
  { name: "walk-out-subtick-finish", states: [state(1, 0), state(2, 40), state(3, 90)] },
  { name: "jump-start-boundary", states: [state(1, 0), state(2, 0, false), state(3, 40, false), state(4, 90, false)], events: [0, 2, 0, 0] },
  { name: "teleport-into-finish", states: [state(1, 0), state(2, 40), state(3, 100, false, { touchPosition: vec(50), touchCrouched: false })], events: [0, 0, 1] },
  { name: "touch-finish-before-teleport", states: [state(1, 0), state(2, 40), state(3, 0, false, { touchPosition: vec(100), touchCrouched: false })], events: [0, 0, 1] },
  { name: "missing-touch-teleport-finish", states: [state(1, 0), state(2, 40), state(3, 100)], events: [0, 0, 1] },
  { name: "rearm-clears-crossings", states: [state(1, 0), state(2, 40), state(3, 0), state(4, 40), state(5, 90)] },
];
const runs = scenarios.flatMap(scenario => [1, 2].map(rules => {
  const timer = new RunTimer(runZones, Math.fround(.01), { prespeedCap: 290, rules });
  const rows = scenario.states.map((state, i) => {
    const events = scenario.events?.[i] ?? 0;
    timer.update({ forward: 0, side: 0, yaw: 0, pitch: 0, buttons: 0 }, events, state);
    return { state, events, status: timer.status, seconds: timer.time(), timing: timer.timing() };
  });
  return { name: scenario.name, rules, zones: runZones, rows };
}));
const source = readFileSync(new URL("../../apps/web/src/run-timing.ts", import.meta.url));
const result = { source: "apps/web/src/run-timing.ts", sha256: createHash("sha256").update(source).digest("hex"),
  crossings, rounding, phases, runs };
writeFileSync(new URL("../../crates/native-bridge/fixtures/run-timing.json", import.meta.url), JSON.stringify(result) + "\n");
console.log(`${crossings.length} crossings, ${rounding.length} durations, ${phases.length} phases, ${runs.length} timer scenarios`);
